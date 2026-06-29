// SIGMA ABYSS — the auto-battler.
//
// resolveEncounter() runs one fight to completion: deterministic, every
// roll drawn from the passed-in RNG, so the live client and the offline
// simulator produce byte-identical outcomes. It returns an event log
// (for combat-view.js to animate) plus the bookkeeping progression.js
// needs to apply. It mutates only the `inventory` array it is handed
// (the `steal` enemy special) and reports everything else as a result.

import { AILMENTS, artAilment, detectCombo, familyTrigger, weaponAilment } from "./ailments.js";
import { MAX_HIT_FRAC } from "./constants.js";
import { damageMul } from "./stats.js";
import { fireWeaponVolley } from "./vampire-survivors.js";
import { artChance, unlockedArts } from "./weapons.js";

const MAX_TICKS = 100;

// Pick the fighter's target from the live enemies per the AI's priority.
// `forceTarget` (set by mental-break overrides) trumps the AI choice:
//   "strongest" → highest-threat / highest-attack foe (murderous_rage)
//   "weakest"   → lowest hp (death_wish flavour)
function pickTarget(live, priority, forceTarget = null) {
  if (live.length === 1) return live[0];
  if (forceTarget === "strongest") {
    return live.reduce((a, b) => (b.threat * 100 + b.attack > a.threat * 100 + a.attack ? b : a));
  }
  if (forceTarget === "weakest") {
    return live.reduce((a, b) => (b.hp < a.hp ? b : a));
  }
  switch (priority) {
    case "lowest_hp":
      return live.reduce((a, b) => (b.hp < a.hp ? b : a));
    case "highest_threat":
      return live.reduce((a, b) => (b.threat * 100 + b.attack > a.threat * 100 + a.attack ? b : a));
    case "elites_last": {
      const rank = (e) => (e.kind === "boss" ? 2 : e.kind === "elite" ? 1 : 0);
      return live.reduce((a, b) => {
        const ra = rank(a),
          rb = rank(b);
        if (ra !== rb) return rb < ra ? b : a;
        return b.hp < a.hp ? b : a;
      });
    }
    default:
      return live[0];
  }
}

export function resolveEncounter({ fighter, enemies, ai, rng, inventory = [] }) {
  const events = [];
  const effects = fighter.effects || [];
  const has = (e) => effects.includes(e);
  const breakMods = fighter.breakMods || null;
  const _inspMods = fighter.inspMods || null;
  const traits = new Set(fighter.traits || []);
  const incomingMul = fighter.incomingMul || 1;

  // Weapon arts are family-gated techniques unlocked by upgrade tier.
  // They fire probabilistically on top of a normal swing — never instead
  // of one, so they read as bonus drama rather than replacing the basic
  // combat loop. fighter.weaponFamily / weaponPlus are added by derive
  // callers in delveTick; default to the fists ladder when missing.
  const wFamily = fighter.weaponFamily || "fists";
  const wPlus = fighter.weaponPlus | 0;
  const arts = unlockedArts(wFamily, wPlus);
  const artProc = artChance(wPlus);
  const stagger = { enemyIdx: -1, ticksLeft: 0 };

  // ── Ailment system (Inc 2) ──────────────────────────────────────────
  // wAilment is the spec for the ailment THIS weapon family can inflict,
  // or null when the family applies none (sword/greatsword/bow/spear).
  // It is resolved ONCE here, PURE (no rng). The proc die is rolled later
  // ONLY when wAilment is non-null — so a non-ailment weapon draws ZERO
  // extra rng and stays byte-identical to pre-Inc2. wFamilyTrigger is the
  // elemental trigger a basic swing carries (fire for spellcasters) for
  // combo detection — also pure.
  const wAilment = weaponAilment(wFamily, wPlus);
  const wFamilyTrigger = familyTrigger(wFamily);
  // Per-enemy ailment state: _idx → Map<ailmentId, {stacks, ttl, srcAtk}>.
  // srcAtk pins the attacker's attack at apply-time so DoT pulses are
  // deterministic regardless of later buff/debuff drift.
  const ailing = new Map();

  // Apply (or refresh) an ailment on a live enemy. PURE bookkeeping — no
  // rng. Refresh resets ttl and bumps stacks (capped). Emits an event.
  const applyAilment = (enemyIdx, id, srcAtk) => {
    const def = AILMENTS[id];
    if (!def) return;
    let m = ailing.get(enemyIdx);
    if (!m) {
      m = new Map();
      ailing.set(enemyIdx, m);
    }
    const cur = m.get(id);
    if (cur) {
      cur.stacks = Math.min(5, cur.stacks + 1);
      cur.ttl = def.ttl;
      cur.srcAtk = srcAtk;
    } else {
      m.set(id, { stacks: def.stacks, ttl: def.ttl, srcAtk });
    }
    events.push({ t: "ailment", src: -1, tgt: enemyIdx, id, stacks: m.get(id).stacks });
  };

  const enemyAilmentIds = (enemyIdx) => {
    const m = ailing.get(enemyIdx);
    return m ? [...m.keys()] : [];
  };

  // Try to detonate a combo on `target` from a hit carrying `trigger`.
  // Returns the bonus damage dealt to the PRIMARY target (0 if no combo)
  // so the caller can fold it into its own dmg accounting. Fully
  // deterministic: combo detection reads existing ailment state; the AOE
  // arc target is chosen as the first OTHER live foe (stable order, NO
  // rng draw — per the determinism firewall, combos add no uncontrolled
  // draw). `baseDmg` is the pre-combo damage of the triggering hit.
  const tryCombo = (target, trigger, baseDmg, live) => {
    if (!trigger || baseDmg <= 0) return 0;
    const combo = detectCombo(trigger, enemyAilmentIds(target._idx));
    if (!combo) return 0;
    // Bonus = the extra damage above the base hit (mul includes the 1.0).
    const total = Math.max(1, Math.round(baseDmg * combo.mul));
    const bonus = total - baseDmg;
    target.hp -= bonus;
    events.push({
      t: "combo",
      src: -1,
      tgt: target._idx,
      id: combo.id,
      name: combo.label,
      amt: total,
      bonus,
    });
    // AOE arc / spread to one other live foe (deterministic pick).
    if (combo.aoe && live && live.length > 1) {
      const other = live.find((x) => x !== target && x.hp > 0);
      if (other) {
        const arc = Math.max(1, Math.round(bonus * combo.aoe));
        other.hp -= arc;
        events.push({ t: "combo-arc", src: -1, tgt: other._idx, id: combo.id, amt: arc });
        if (combo.spread) applyAilment(other._idx, combo.spread, fighter.attack * atkMul);
        if (other.hp <= 0) {
          onKill(other);
          const k = live.indexOf(other);
          if (k >= 0) live.splice(k, 1);
        }
      }
    }
    // Spend the consumed ailment (shatter/electrocute/steam boil off).
    if (combo.consumes) {
      const m = ailing.get(target._idx);
      if (m) m.delete(combo.requires);
    }
    return bonus;
  };

  let hp = fighter.hp;
  let potions = fighter.potions || 0;
  const maxHp = fighter.maxHp;

  let atkMul = 1; // hex debuff stacks here
  let cursed = false; // a gambler's curse: crit/dodge off, +dmg taken
  let hitCount = 0; // for lucky_seven
  let usedSecondWind = false;
  let usedDeathSave = false;

  const stolen = [];
  const killed = [];
  let xpGained = 0;
  let goldGained = 0;

  // Live working copies — never mutate the caller's enemy objects.
  const live = enemies.map((e, i) => ({ ...e, _idx: i, ap: 0 }));
  let outcome = "win";
  let ticks = 0;

  const fighterDmg = (target) => {
    hitCount++;
    let dmg = fighter.attack * atkMul * rng.float(0.9, 1.1);
    if (has("berserk")) dmg *= 1 + (1 - hp / maxHp) * 0.8;
    if (has("executioner") && target.hp / target.maxHp < 0.25) dmg *= 1.85;
    const forcedCrit = has("lucky_seven") && hitCount % 7 === 0;
    const crit = !cursed && (forcedCrit || rng.chance(fighter.critChance));
    if (crit) dmg *= fighter.critMult;
    dmg *= damageMul(target.defense);
    dmg = Math.max(1, Math.round(dmg));
    return { dmg, crit };
  };

  const onKill = (enemy) => {
    killed.push(enemy);
    xpGained += enemy.xpValue || 0;
    if (has("vampire")) hp = Math.min(maxHp, hp + maxHp * 0.12);
    if (has("midas")) goldGained += rng.int(4, 13) * (enemy.threat || 1);
    // Trait: cannibal heals 9% of maxHp per kill.
    if (traits.has("cannibal")) hp = Math.min(maxHp, hp + Math.round(maxHp * 0.09));
    // Trait: bloodlust — small heal + trivial dmg buff (sheet already
    // gives the atk%; this is the heal pulse).
    if (traits.has("bloodlust")) hp = Math.min(maxHp, hp + Math.round(maxHp * 0.04));
    events.push({ t: "kill", src: -1, tgt: enemy._idx });
  };

  // Fire one weapon art at `target`. Mutates target.hp + the live array
  // via onKill/splice if the art kills. Returns true if any damage landed.
  const fireArt = (target, live) => {
    if (!arts.length) return false;
    const art = rng.pick(arts);
    let dmg = 0;
    let extraHits = 0;
    // Deferred so it enters the event log AFTER the primary art event — the FX
    // timeline assigns wall-clock order by push order, and a splash logged
    // first flashes the bystander ~280 ms before the hero's wind-up. Capturing
    // it here changes only presentation order; RNG draws + hp are untouched.
    let artSplashEvent = null;
    const elite = target.kind === "elite" || target.kind === "boss";
    switch (art.id) {
      case "flurry":
      case "seven_fold_cut":
      case "rain_of_arrows": {
        const hits = art.id === "seven_fold_cut" ? 4 : art.id === "rain_of_arrows" ? 3 : 2;
        for (let i = 0; i < hits; i++) {
          const o = fighterDmg(target);
          target.hp -= o.dmg;
          dmg += o.dmg;
          extraHits += 1;
          if (target.hp <= 0) break;
        }
        break;
      }
      case "riposte":
      case "pierce": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 1.55);
        target.hp -= dmg;
        break;
      }
      case "gale_slash": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 1.25);
        target.hp -= dmg;
        if (live.length > 1) {
          const others = live.filter((x) => x !== target);
          const splash = others[Math.floor(rng.float(0, others.length))];
          if (splash) {
            const s = Math.round(o.dmg * 0.6);
            splash.hp -= s;
            artSplashEvent = { t: "art-splash", src: -1, tgt: splash._idx, amt: s, name: art.name };
          }
        }
        break;
      }
      case "meteor_slam":
      case "earthshatter":
      case "comet":
      case "void_ray":
      case "moonveil": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 2.0);
        target.hp -= dmg;
        break;
      }
      case "starscourge": {
        for (let i = 0; i < 3; i++) {
          const o = fighterDmg(target);
          target.hp -= o.dmg;
          dmg += o.dmg;
          if (target.hp <= 0) break;
        }
        extraHits = 2;
        break;
      }
      case "shadow_step": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * fighter.critMult * 1.1);
        target.hp -= dmg;
        break;
      }
      case "eclipse_dance": {
        for (let i = 0; i < 2; i++) {
          const o = fighterDmg(target);
          const d = Math.round(o.dmg * fighter.critMult);
          target.hp -= d;
          dmg += d;
          if (target.hp <= 0) break;
        }
        break;
      }
      case "mirage_shot": {
        for (let i = 0; i < 2; i++) {
          const o = fighterDmg(target);
          target.hp -= o.dmg;
          dmg += o.dmg;
          if (target.hp <= 0) break;
        }
        const finisher = Math.round(fighter.attack * atkMul * 1.1 * fighter.critMult);
        target.hp -= finisher;
        dmg += finisher;
        extraHits = 2;
        break;
      }
      case "stagger_blow":
      case "pressure_palm": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 1.25);
        target.hp -= dmg;
        stagger.enemyIdx = target._idx;
        stagger.ticksLeft = 1;
        break;
      }
      case "godslayer_smite": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * (elite ? 3.2 : 1.6));
        target.hp -= dmg;
        break;
      }
      case "rannis_dark_moon": {
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 1.8);
        target.hp -= dmg;
        // Cold: foe loses next swing.
        stagger.enemyIdx = target._idx;
        stagger.ticksLeft = 1;
        break;
      }
      // ── axe arts ───────────────────────────────────────────────────
      case "rend": {
        // Bleed: deal base damage then 3 stacking DoT pulses (simulated
        // as 3 extra hits at 35% base each — no rng draws, deterministic).
        const o = fighterDmg(target);
        dmg = o.dmg;
        target.hp -= dmg;
        for (let _t = 0; _t < 3; _t++) {
          const bleed = Math.max(1, Math.round(fighter.attack * atkMul * 0.35));
          target.hp -= bleed;
          dmg += bleed;
          if (target.hp <= 0) break;
        }
        break;
      }
      case "execute": {
        const o = fighterDmg(target);
        // Bonus damage vs low-HP foes (< 30% HP).
        const execMul = target.hp / (target.maxHp || target.hp || 1) < 0.3 ? 2.8 : 1.4;
        dmg = Math.round(o.dmg * execMul);
        target.hp -= dmg;
        break;
      }
      case "bloodfrenzy": {
        // Bleed + frenzy: base hit + 3 bleed ticks like rend.
        const o = fighterDmg(target);
        dmg = o.dmg;
        target.hp -= dmg;
        for (let _t = 0; _t < 3; _t++) {
          const bleed = Math.max(1, Math.round(fighter.attack * atkMul * 0.38));
          target.hp -= bleed;
          dmg += bleed;
          if (target.hp <= 0) break;
        }
        break;
      }
      // ── spear arts ─────────────────────────────────────────────────
      case "lunge": {
        // Gap-close: 25% bonus on first strike.
        const o = fighterDmg(target);
        dmg = Math.round(o.dmg * 1.25);
        target.hp -= dmg;
        break;
      }
      case "impale": {
        // Pin: 2 hits, each ignores dodge (simulated as full-damage hits).
        for (let _t = 0; _t < 2; _t++) {
          const o = fighterDmg(target);
          dmg += o.dmg;
          target.hp -= o.dmg;
          if (target.hp <= 0) break;
        }
        break;
      }
      case "cyclone_thrust": {
        // Hit ALL live enemies for full damage.
        const o = fighterDmg(target);
        dmg = o.dmg;
        target.hp -= dmg;
        for (const other of live) {
          if (other === target || other.hp <= 0) continue;
          const os = fighterDmg(other);
          other.hp -= os.dmg;
          dmg += os.dmg;
          if (other.hp <= 0) {
            onKill(other);
            const k = live.indexOf(other);
            if (k >= 0) live.splice(k, 1);
          }
        }
        break;
      }
      // ── wand arts ──────────────────────────────────────────────────
      case "spell_echo": {
        // Repeat the hit once (echo).
        const o1 = fighterDmg(target);
        const o2 = fighterDmg(target);
        dmg = o1.dmg + o2.dmg;
        target.hp -= dmg;
        extraHits = 1;
        break;
      }
      case "overload_surge": {
        // Triple overload: 3× the overload hit at once.
        const o = fighterDmg(target);
        dmg = o.dmg;
        target.hp -= dmg;
        for (let _t = 0; _t < 3; _t++) {
          const surge = Math.max(1, Math.round(fighter.attack * atkMul * rng.float(0.9, 1.1)));
          target.hp -= surge;
          dmg += surge;
          extraHits++;
          if (target.hp <= 0) break;
        }
        break;
      }
      case "arcane_torrent": {
        // 5 rapid arcane bolts; last is guaranteed crit.
        for (let _t = 0; _t < 4; _t++) {
          const o = fighterDmg(target);
          target.hp -= o.dmg;
          dmg += o.dmg;
          extraHits++;
          if (target.hp <= 0) break;
        }
        if (target.hp > 0) {
          const finalDmg = Math.max(1, Math.round(fighter.attack * atkMul * fighter.critMult));
          target.hp -= finalDmg;
          dmg += finalDmg;
          extraHits++;
        }
        break;
      }
      default: {
        const o = fighterDmg(target);
        dmg = o.dmg;
        target.hp -= dmg;
      }
    }
    events.push({
      t: "art",
      src: -1,
      tgt: target._idx,
      name: art.name,
      id: art.id,
      amt: dmg,
      hits: extraHits,
    });
    // Splash logs after the primary so the bystander flashes WITH the strike.
    if (artSplashEvent) events.push(artSplashEvent);
    if (has("bloodthirst") && dmg > 0) hp = Math.min(maxHp, hp + Math.round(dmg * 0.06));

    // ── Art-driven ailments + combos (deterministic — no rng) ─────────
    // An art may carry a combo TRIGGER (shatter/lightning/fire) and/or
    // APPLY an ailment. Detonate the combo on the still-living target
    // FIRST (so a shatter cashes in an existing chill), then stamp the
    // art's own ailment. All pure lookups + state reads → no new draw,
    // so an art with no ailment payload is byte-identical to before.
    const aSpec = artAilment(art.id);
    if (aSpec && dmg > 0) {
      if (aSpec.trigger && target.hp > 0) {
        tryCombo(target, aSpec.trigger, dmg, live);
      }
      if (aSpec.apply && target.hp > 0) {
        applyAilment(target._idx, aSpec.apply, fighter.attack * atkMul);
        if (AILMENTS[aSpec.apply].skipTurn) {
          stagger.enemyIdx = target._idx;
          stagger.ticksLeft = 1;
        }
      }
    }

    if (target.hp <= 0) {
      onKill(target);
      const k = live.indexOf(target);
      if (k >= 0) live.splice(k, 1);
    }
    return dmg > 0;
  };

  while (ticks < MAX_TICKS) {
    ticks++;

    // ── Mental-break stun: lose this whole encounter to the daze. ─────
    if (breakMods?.stunPerEncounter && rng.chance(breakMods.stunPerEncounter)) {
      events.push({ t: "stun", src: -1, id: breakMods.id });
      // The break id lets combat-view render an "is dazed" overlay; the
      // foes still get their swing.
    } else if (live.length && hp / maxHp <= ai.fleeHpFrac && !breakMods?.immortal) {
      // ── Between-action checks: flee / potion ──────────────────────
      events.push({ t: "flee", src: -1 });
      outcome = "flee";
      break;
    }

    // Potion logic — breakMods can force-greed or block.
    const wantsPotion = breakMods?.potionGreedy ? hp < maxHp : hp / maxHp <= ai.potionHpFrac;
    if (wantsPotion && potions > 0 && !breakMods?.noPotions) {
      potions--;
      const heal = Math.round(maxHp * 0.45);
      hp = Math.min(maxHp, hp + heal);
      events.push({ t: "potion", src: -1, amt: heal });
    }

    // ── Fighter acts ──────────────────────────────────────────────────
    // A stun consumed the action this tick — let the foes swing.
    const stunned = !!breakMods?.stunPerEncounter && events[events.length - 1]?.t === "stun";
    let fAp = stunned ? 0 : fighter.speed;
    while (fAp >= 1 && live.length) {
      fAp -= 1;
      const target = pickTarget(
        live,
        breakMods?.ignoreAi ? "lowest_hp" : ai.targetPriority,
        breakMods?.forceTarget || null,
      );
      const { dmg, crit } = fighterDmg(target);
      target.hp -= dmg;
      events.push({ t: "hit", src: -1, tgt: target._idx, amt: dmg, crit });
      if (has("bloodthirst")) hp = Math.min(maxHp, hp + Math.round(dmg * 0.08));

      // ── Combo detonation (deterministic — no rng draw) ──────────────
      // If this swing carries an elemental trigger (spellcaster fire) and
      // the target already wears a matching ailment, detonate before any
      // fresh proc lands. Reads existing state only.
      if (wFamilyTrigger && target.hp > 0) {
        tryCombo(target, wFamilyTrigger, dmg, live);
      }

      // ── Weapon-family ailment proc (GATED rng draw) ─────────────────
      // The ONLY new die in the basic loop, and it is rolled ONLY when the
      // family applies an ailment. Non-ailment families (sword/bow/etc.)
      // have wAilment === null and draw NOTHING here — byte-identical to
      // pre-Inc2. The draw slots AFTER the hit + combo, BEFORE overload,
      // in a stable order, and before the rngState save in delveTick.
      if (wAilment && target.hp > 0 && rng.chance(wAilment.procChance)) {
        applyAilment(target._idx, wAilment.id, fighter.attack * atkMul);
        // A fresh STUN steals the foe's next action — reuse the stagger
        // skip-turn primitive (post-rng, deterministic).
        if (AILMENTS[wAilment.id].skipTurn) {
          stagger.enemyIdx = target._idx;
          stagger.ticksLeft = 1;
        }
      }

      // ── Effect-gated elemental coatings (deterministic — no rng) ─────
      // Legendary effects that aura a Wet / Chilled coat onto every hit.
      // Gated behind has(...) exactly like bloodthirst → when the effect
      // is absent NOTHING runs and NO draw happens (byte-identical). These
      // apply unconditionally on a landed hit (no proc roll), so even
      // present they add zero rng draws. They set up the Wet→Lightning and
      // Chilled→Shatter combos through real gear.
      if (target.hp > 0 && has("soak")) {
        applyAilment(target._idx, "wet", fighter.attack * atkMul);
      }
      if (target.hp > 0 && has("frostbrand")) {
        applyAilment(target._idx, "chilled", fighter.attack * atkMul);
      }

      // Overload — Intellect can sneak in a bonus strike.
      if (target.hp > 0 && rng.chance(fighter.overload)) {
        const o = fighterDmg(target);
        target.hp -= o.dmg;
        events.push({ t: "overload", src: -1, tgt: target._idx, amt: o.dmg, crit: o.crit });
      }

      // Weapon art (post-hit, only if foe still up so the art has a
      // target). Procs against the same target the basic strike picked.
      if (target.hp > 0 && arts.length && rng.chance(artProc)) {
        fireArt(target, live);
      }

      if (target.hp <= 0) {
        onKill(target);
        const k = live.indexOf(target);
        if (k >= 0) live.splice(k, 1);
      }
    }

    // ── Vampire-Survivors auto-fire volley (gated; pure, NO rng draw) ──
    // Weapons fire automatically every tick AFTER the fighter's basic swings.
    // Gated on a resolved loadout (fighter.weapons) — a sigma with no VS
    // weapons enters NOTHING here and draws NO rng, so the stream stays
    // byte-identical. Volley damage is pure arithmetic (see fireWeaponVolley).
    if (fighter.weapons?.length && live.length) {
      const volley = fireWeaponVolley(fighter.weapons, fighter, live, ticks);
      for (const h of volley.hits) {
        const e = live.find((x) => x._idx === h.idx);
        if (!e || e.hp <= 0) continue;
        e.hp -= h.dmg;
        events.push({ t: "weapon", src: -1, tgt: e._idx, wid: h.wid, amt: h.dmg });
        if (e.hp <= 0) {
          onKill(e);
          const k = live.indexOf(e);
          if (k >= 0) live.splice(k, 1);
        }
      }
    }

    if (!live.length) {
      outcome = "win";
      break;
    }

    // ── Ailment upkeep: DoT pulses + ttl decay (deterministic) ────────
    // Runs at the head of the enemy phase, before any foe acts. Burning /
    // Bleeding deal damage-over-time scaled by the attacker's pinned
    // attack; every ailment ages out by one tick. PURE — no rng draw, so
    // a fight with no ailments in flight is byte-identical to before.
    // Iterate a snapshot because DoT can kill (mutating `live`).
    for (const enemy of [...live]) {
      const m = ailing.get(enemy._idx);
      if (!m || !m.size) continue;
      for (const [id, st] of [...m]) {
        const def = AILMENTS[id];
        if (def.dot) {
          const tick = Math.max(
            1,
            Math.round((st.srcAtk || fighter.attack) * def.dotFrac * st.stacks),
          );
          enemy.hp -= tick;
          events.push({ t: "ailment-tick", src: -1, tgt: enemy._idx, id, amt: tick });
        }
        st.ttl -= 1;
        if (st.ttl <= 0) m.delete(id);
      }
      if (!m.size) ailing.delete(enemy._idx);
      if (enemy.hp <= 0) {
        onKill(enemy);
        const k = live.indexOf(enemy);
        if (k >= 0) live.splice(k, 1);
      }
    }
    if (!live.length) {
      outcome = "win";
      break;
    }

    // ── Enemies act ───────────────────────────────────────────────────
    for (const enemy of live) {
      // Staggered foe loses this round; the stagger consumes one tick.
      if (stagger.ticksLeft > 0 && enemy._idx === stagger.enemyIdx) {
        events.push({ t: "stagger", src: enemy._idx });
        stagger.ticksLeft -= 1;
        if (stagger.ticksLeft <= 0) stagger.enemyIdx = -1;
        continue;
      }
      let eAp = enemy.speed;
      while (eAp >= 1) {
        eAp -= 1;

        // Fighter dodge (curse zeroes it out).
        if (!cursed && rng.chance(fighter.dodge)) {
          events.push({ t: "miss", src: enemy._idx, tgt: -1 });
          continue;
        }

        let dmg = enemy.attack * rng.float(0.9, 1.1) * damageMul(fighter.defense);
        if (cursed) dmg *= 1.08;
        // Mental-break (e.g. insult_spree) ramps incoming damage.
        if (incomingMul !== 1) dmg *= incomingMul;
        // Alpha-strike cap — no single swing exceeds MAX_HIT_FRAC of maxHp, so
        // an over-levelled elite/boss can't one-shot through the flee window.
        // Pure clamp on the already-rolled (post-rng) damage → no rng draw.
        dmg = Math.max(1, Math.min(Math.round(dmg), Math.round(maxHp * MAX_HIT_FRAC)));
        hp -= dmg;
        events.push({ t: "enemyhit", src: enemy._idx, tgt: -1, amt: dmg });

        // Thornmail reflect can finish a wounded enemy.
        if (has("thornmail")) {
          const ref = Math.max(1, Math.round(dmg * 0.15));
          enemy.hp -= ref;
          events.push({ t: "reflect", src: -1, tgt: enemy._idx, amt: ref });
          if (enemy.hp <= 0) {
            onKill(enemy);
            const k = live.indexOf(enemy);
            if (k >= 0) live.splice(k, 1);
          }
        }

        // Enemy specials fire on a landed hit.
        if (enemy.special === "steal" && inventory.length && rng.chance(0.5)) {
          const idx = rng.int(0, inventory.length - 1);
          const item = inventory.splice(idx, 1)[0];
          if (item) {
            stolen.push(item);
            events.push({ t: "steal", src: enemy._idx, item: item.name });
          }
        } else if (enemy.special === "hex") {
          atkMul = Math.max(0.45, atkMul * 0.9);
          enemy.hexStacks = (enemy.hexStacks || 0) + 1;
          events.push({ t: "hex", src: enemy._idx });
        } else if (enemy.special === "curse" && !cursed && !fighter.immuneCurse) {
          cursed = true;
          events.push({ t: "curse", src: enemy._idx });
        }

        // ── Post-hit panic flee ─────────────────────────────────────
        // React to the swing that JUST landed. The only other flee check is
        // the pre-fighter one at the top of the tick, tested against the HP
        // you ENTERED the tick with — so without this, a hit that knocks you
        // into the flee band lets the NEXT swing kill you before the brain
        // ever reacts. That is the core "I die with no warning" bug. Bailing
        // here ends the encounter as a retreat (delveTick maps 'flee' →
        // retreat-to-town: lose the haul, KEEP the run). Pure post-rng check.
        if (hp > 0 && live.length && hp / maxHp <= ai.fleeHpFrac && !breakMods?.immortal) {
          events.push({ t: "flee", src: -1 });
          outcome = "flee";
          break;
        }

        // ── Fighter death checks ────────────────────────────────────
        if (hp <= 0) {
          // Fugue break: immortal for the duration. Pin HP at 1.
          if (breakMods?.immortal) {
            hp = 1;
            events.push({ t: "fugue", src: -1 });
          } else if (has("second_wind") && !usedSecondWind) {
            usedSecondWind = true;
            hp = Math.round(maxHp * 0.25);
            events.push({ t: "secondwind", src: -1, amt: hp });
          } else if (!usedDeathSave && rng.chance(fighter.deathSave)) {
            usedDeathSave = true;
            hp = Math.round(maxHp * 0.18);
            events.push({ t: "deathsave", src: -1, amt: hp });
          } else {
            events.push({ t: "death", src: enemy._idx });
            outcome = "death";
            break;
          }
        }
      }
      if (outcome === "death" || outcome === "flee") break;
    }
    if (outcome === "death" || outcome === "flee") break;
  }

  if (ticks >= MAX_TICKS && outcome === "win" && live.length) {
    // Stalemate — disengage rather than loop forever.
    outcome = "flee";
    events.push({ t: "flee", src: -1 });
  }

  return {
    outcome, // 'win' | 'flee' | 'death'
    events,
    hpAfter: Math.max(0, Math.round(hp)),
    potionsAfter: potions,
    xpGained,
    goldGained,
    kills: killed.length,
    killed, // enemy objects — progression rolls loot from these
    stolen, // items already removed from `inventory`
    ticks,
  };
}
