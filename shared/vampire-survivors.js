// SIGMA ABYSS — the Vampire-Survivors combat layer (deterministic).
//
// A full VS-style auto-fire weapon system bolted onto the auto-battler.
// EVERYTHING here is PURE: no Math.random, no Date.now, no timers. The few
// numeric draws (gem positions, magnetize) are plain arithmetic so the live
// client and the offline simulator stay byte-identical. The whole layer is
// GATED on a character having a weapon loadout — a sigma with no VS weapons
// never enters any of this code, draws ZERO rng, and is byte-identical to a
// pre-VS character (the determinism firewall).
//
// Wiring (see shared/progression.js delveTick + shared/combat.js):
//   • resolveEncounter() fires a weapon VOLLEY each combat tick (fireWeaponVolley).
//   • delveTick(), AFTER the rng-state save, spawns XP gems from the tick's
//     kills, magnetizes them toward the player, grants XP on pickup, and — when
//     the encounter would have been a death — converts it to a FAINT (lose the
//     active weapon) instead of permadeath.
//
// Contract for the overlay/UI slices: docs/vampire-survivors-contract.md.

// ── Tunables ──────────────────────────────────────────────────────────
// One clearly-labeled block. Tune drop rates / damage / faint rate here.
export const VS_TUNABLES = Object.freeze({
  // Loadout
  maxWeaponSlots: 6, // how many weapons a sigma can carry at once

  // Weapons (damage model). A weapon's per-hit damage is:
  //   round(fighter.attack * weapon.damage * weapon.fireRate * weaponBaseScale)
  // (× evolvedMult when the weapon has evolved). fireRate folds the VS "shots
  // per second" feel into one deterministic per-tick multiplier.
  weaponBaseScale: 0.6,
  evolvedMult: 1.7, // evolved weapons hit this much harder than their base form

  // Gems (the XP pickup). Gem value is the run XP (the "Sigma token" economy)
  // granted on pickup. Gems spawn at the dying enemy's arena position and
  // magnetize toward the player at the center.
  arenaRadius: 6, // enemies/gems spawn on a ring this far from the player
  gemBaseValue: 4, // base XP per gem
  gemValuePerThreat: 2, // + this per point of enemy threat
  gemEliteMult: 3, // elite gems are worth this much more
  gemBossMult: 9, // boss gems are worth this much more
  gemPickupRadius: 1.6, // collected once within this distance of the player
  gemMagnetStep: 0.6, // distance a gem travels toward the player per frame
  gemMagnetFramesPerTick: 6, // magnetize frames resolved per delveTick
  gemMaxLive: 64, // hard cap on persisted in-flight gems

  // Faint (the VS soft-death). When a VS player's HP hits 0 they FAINT rather
  // than permadie: they lose their ACTIVE weapon (re-acquirable) and stand back
  // up at this HP fraction before retreating to town.
  faintReviveHpFrac: 0.5,
});

// ── Weapon catalog (10 auto-fire types — VS-style, no manual aim) ──────
// kind     — flavour/targeting family (for the overlay to render).
// fireRate — per-tick damage multiplier (higher = fires more often).
// damage   — multiple of the fighter's attack per hit.
// count    — base number of distinct enemies a volley touches.
// pierce   — extra enemies a shot passes through (adds to touched count).
// area     — "all" = hits every live enemy (aura/nova); else a number/0.
// returns  — boomerang-style: each hit lands twice.
// tags     — synergy tags (used by the evolution matrix + UI grouping).
export const WEAPON_CATALOG = Object.freeze([
  {
    id: "whip",
    name: "Whip",
    kind: "arc",
    fireRate: 1.0,
    damage: 0.9,
    count: 1,
    pierce: 1,
    area: 0,
    returns: false,
    tags: ["physical", "melee"],
    desc: "Sweeping arc to the side; hits the two nearest foes.",
  },
  {
    id: "wand",
    name: "Magic Wand",
    kind: "projectile",
    fireRate: 1.0,
    damage: 1.0,
    count: 1,
    pierce: 0,
    area: 0,
    returns: false,
    tags: ["arcane", "ranged"],
    desc: "Bolt that auto-seeks the nearest enemy.",
  },
  {
    id: "knife",
    name: "Throwing Knife",
    kind: "pierce",
    fireRate: 1.4,
    damage: 0.7,
    count: 2,
    pierce: 2,
    area: 0,
    returns: false,
    tags: ["physical", "ranged"],
    desc: "Fast knives that pierce straight through a line of foes.",
  },
  {
    id: "garlic",
    name: "Garlic Aura",
    kind: "aura",
    fireRate: 0.7,
    damage: 0.45,
    count: 1,
    pierce: 0,
    area: "all",
    returns: false,
    tags: ["holy", "aura"],
    desc: "Damaging aura that pulses around you, hitting everything close.",
  },
  {
    id: "bible",
    name: "Orbiting Tome",
    kind: "orbit",
    fireRate: 0.85,
    damage: 0.8,
    count: 3,
    pierce: 1,
    area: 0,
    returns: false,
    tags: ["holy", "orbit"],
    desc: "Tomes orbit you, striking foes that drift into them.",
  },
  {
    id: "nova",
    name: "Frost Nova",
    kind: "area",
    fireRate: 0.5,
    damage: 1.3,
    count: 1,
    pierce: 0,
    area: "all",
    returns: false,
    tags: ["arcane", "area"],
    desc: "Periodic burst that detonates across the whole screen.",
  },
  {
    id: "beam",
    name: "Lance Beam",
    kind: "beam",
    fireRate: 0.6,
    damage: 1.6,
    count: 1,
    pierce: 3,
    area: 0,
    returns: false,
    tags: ["arcane", "beam"],
    desc: "A heavy beam that lances through a row of enemies.",
  },
  {
    id: "boomerang",
    name: "Boomerang",
    kind: "boomerang",
    fireRate: 0.9,
    damage: 0.9,
    count: 1,
    pierce: 1,
    area: 0,
    returns: true,
    tags: ["physical", "ranged"],
    desc: "Returns to you, hitting on the way out and the way back.",
  },
  {
    id: "fireball",
    name: "Fireball",
    kind: "projectile",
    fireRate: 0.7,
    damage: 1.1,
    count: 1,
    pierce: 0,
    area: 2,
    returns: false,
    tags: ["fire", "ranged"],
    desc: "Explodes on impact, splashing nearby foes.",
  },
  {
    id: "lightning",
    name: "Lightning Ring",
    kind: "strike",
    fireRate: 0.85,
    damage: 1.05,
    count: 2,
    pierce: 0,
    area: 0,
    returns: false,
    tags: ["lightning", "ranged"],
    desc: "Random bolts smite scattered enemies.",
  },
]);

export const WEAPON_BY_ID = Object.freeze(Object.fromEntries(WEAPON_CATALOG.map((w) => [w.id, w])));
export const WEAPON_IDS = Object.freeze(WEAPON_CATALOG.map((w) => w.id));

// ── Synergy / evolution matrix (complete) ──────────────────────────────
// VS-style: a base weapon + a partner (another WEAPON or an allocated PASSIVE
// keystone) evolves into a stronger weapon. `requires` is decidable purely
// from the loadout + the character's allocated passive ids. `stats` overrides
// the base weapon's combat fields for the resolved (evolved) form. Keystone
// ids come from shared/passive-tree.js (KEYSTONE_IDS).
export const EVOLUTIONS = Object.freeze([
  // ── weapon + weapon ──
  {
    id: "bloody_tear",
    name: "Bloody Tear",
    base: "whip",
    requires: { weapon: "garlic" },
    stats: { damage: 1.6, count: 1, pierce: 2, area: "all", returns: false },
    desc: "Whip + Garlic Aura — a vampiric sweep that drains the whole pack.",
  },
  {
    id: "holy_wand",
    name: "Holy Wand",
    base: "wand",
    requires: { weapon: "bible" },
    stats: { damage: 1.4, count: 3, pierce: 0, area: 0, returns: false },
    fireRate: 1.3,
    desc: "Magic Wand + Orbiting Tome — fires a relentless triple bolt.",
  },
  {
    id: "thousand_edge",
    name: "Thousand Edge",
    base: "knife",
    requires: { weapon: "nova" },
    stats: { damage: 1.2, count: 5, pierce: 5, area: 0, returns: false },
    desc: "Throwing Knife + Frost Nova — an unending storm of piercing blades.",
  },
  {
    id: "soul_eater",
    name: "Soul Eater",
    base: "garlic",
    requires: { weapon: "boomerang" },
    stats: { damage: 1.0, count: 1, pierce: 0, area: "all", returns: false },
    fireRate: 1.2,
    desc: "Garlic Aura + Boomerang — a hungry aura that feeds on every soul.",
  },
  {
    id: "unholy_vespers",
    name: "Unholy Vespers",
    base: "bible",
    requires: { weapon: "beam" },
    stats: { damage: 1.4, count: 4, pierce: 2, area: 0, returns: false },
    desc: "Orbiting Tome + Lance Beam — searing scripture that pierces ranks.",
  },
  {
    id: "hellfire",
    name: "Hellfire",
    base: "nova",
    requires: { weapon: "fireball" },
    stats: { damage: 2.2, count: 1, pierce: 0, area: "all", returns: false },
    desc: "Frost Nova + Fireball — a screen-wide detonation of flame.",
  },
  {
    id: "death_ray",
    name: "Death Ray",
    base: "beam",
    requires: { weapon: "lightning" },
    stats: { damage: 2.4, count: 1, pierce: 6, area: 0, returns: false },
    desc: "Lance Beam + Lightning Ring — a beam that erases a whole column.",
  },
  {
    id: "returning_storm",
    name: "Returning Storm",
    base: "boomerang",
    requires: { weapon: "whip" },
    stats: { damage: 1.4, count: 2, pierce: 2, area: 0, returns: true },
    desc: "Boomerang + Whip — twin blades that carve out and back.",
  },
  {
    id: "phoenix",
    name: "Phoenix",
    base: "fireball",
    requires: { weapon: "wand" },
    stats: { damage: 1.6, count: 2, pierce: 0, area: 3, returns: false },
    desc: "Fireball + Magic Wand — homing firebirds that burst on contact.",
  },
  {
    id: "thunderbolt",
    name: "Thunderbolt",
    base: "lightning",
    requires: { weapon: "knife" },
    stats: { damage: 1.4, count: 4, pierce: 0, area: 0, returns: false },
    desc: "Lightning Ring + Throwing Knife — forked bolts that chain the field.",
  },
  // ── weapon + passive (keystone) ──
  {
    id: "glass_lance",
    name: "Glass Lance",
    base: "wand",
    requires: { passive: "ks_glass_cannon" },
    stats: { damage: 2.0, count: 1, pierce: 4, area: 0, returns: false },
    desc: "Magic Wand + Glass Cannon keystone — a brittle, devastating spear.",
  },
  {
    id: "solar_flare",
    name: "Solar Flare",
    base: "nova",
    requires: { passive: "ks_avatar_of_fire" },
    stats: { damage: 2.6, count: 1, pierce: 0, area: "all", returns: false },
    desc: "Frost Nova + Avatar of Fire keystone — the sky itself ignites.",
  },
  {
    id: "sanguine_aura",
    name: "Sanguine Aura",
    base: "garlic",
    requires: { passive: "ks_blood_magic" },
    stats: { damage: 1.5, count: 1, pierce: 0, area: "all", returns: false },
    fireRate: 1.1,
    desc: "Garlic Aura + Blood Magic keystone — a crimson tide of life-theft.",
  },
]);

// ── Loadout helpers ────────────────────────────────────────────────────

// Coerce a raw weapon-id list to a valid, unique, slot-capped loadout. PURE.
export function normalizeLoadout(weaponIds) {
  if (!Array.isArray(weaponIds)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of weaponIds) {
    const id = typeof raw === "string" ? raw : null;
    if (!id || seen.has(id) || !WEAPON_BY_ID[id]) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= VS_TUNABLES.maxWeaponSlots) break;
  }
  return out;
}

// Which evolutions a loadout (+ allocated passives) currently triggers. PURE.
export function activeEvolutions(weaponIds, passives = []) {
  const ids = new Set(normalizeLoadout(weaponIds));
  const pset = new Set(Array.isArray(passives) ? passives : []);
  const out = [];
  for (const ev of EVOLUTIONS) {
    if (!ids.has(ev.base)) continue;
    const req = ev.requires || {};
    if (req.weapon && !ids.has(req.weapon)) continue;
    if (req.passive && !pset.has(req.passive)) continue;
    out.push(ev);
  }
  return out;
}

// Resolve a stored loadout (+ passives) to the effective weapon SPECS used by
// the volley, applying any triggered evolutions. Returns { specs, evolutions,
// ids }. When several evolutions share a base, the first in EVOLUTIONS wins
// (deterministic). PURE.
export function resolveLoadout(weaponIds, passives = []) {
  const ids = normalizeLoadout(weaponIds);
  const evos = activeEvolutions(ids, passives);
  const evoByBase = new Map();
  for (const ev of evos) if (!evoByBase.has(ev.base)) evoByBase.set(ev.base, ev);
  const specs = ids.map((id) => {
    const base = WEAPON_BY_ID[id];
    const ev = evoByBase.get(id);
    if (!ev) return { ...base, baseId: id, evolved: false };
    return {
      ...base,
      ...ev.stats,
      fireRate: ev.fireRate != null ? ev.fireRate : base.fireRate,
      id: ev.id,
      baseId: id,
      name: ev.name,
      evolved: true,
    };
  });
  return { specs, evolutions: evos.map((e) => e.id), ids };
}

// Static payload for GET /api/weapon-catalog (the contract surface). PURE.
export function weaponCatalogPayload() {
  return {
    tunables: VS_TUNABLES,
    maxSlots: VS_TUNABLES.maxWeaponSlots,
    weapons: WEAPON_CATALOG,
    evolutions: EVOLUTIONS,
  };
}

// ── Volley resolution (called from combat.js per tick) ─────────────────
// Returns { hits: [{ idx, wid, dmg }], totalDmg }. `idx` is the enemy's _idx
// in the live array. PURE — draws NO rng. Damage variance is intentionally
// omitted to keep the stream byte-identical; tune feel via VS_TUNABLES.
export function fireWeaponVolley(specs, fighter, live, _tick = 0) {
  const hits = [];
  let totalDmg = 0;
  if (!Array.isArray(specs) || !specs.length || !Array.isArray(live) || !live.length) {
    return { hits, totalDmg };
  }
  const atk = Math.max(1, fighter?.attack || 1);
  for (const w of specs) {
    const per = Math.max(
      1,
      Math.round(
        atk *
          w.damage *
          w.fireRate *
          VS_TUNABLES.weaponBaseScale *
          (w.evolved ? VS_TUNABLES.evolvedMult : 1),
      ),
    );
    // A numeric `area` (fireball/phoenix splash) adds extra touched foes on top
    // of count + pierce; "all" hits the whole field (aura/nova).
    const splash = typeof w.area === "number" && w.area > 0 ? w.area : 0;
    const touch =
      w.area === "all"
        ? live.length
        : Math.min(live.length, (w.count || 1) + (w.pierce || 0) + splash);
    for (let i = 0; i < touch; i += 1) {
      const e = live[i % live.length];
      let dmg = per;
      if (w.returns) dmg *= 2; // out + back
      dmg = Math.max(1, Math.round(dmg));
      hits.push({ idx: e._idx, wid: w.id, dmg });
      totalDmg += dmg;
    }
  }
  return { hits, totalDmg };
}

// ── Gems (the XP pickup) ───────────────────────────────────────────────
const GOLDEN_ANGLE = 2.399963229728653; // radians — deterministic ring scatter

function round2(n) {
  return Math.round(n * 100) / 100;
}

// XP value a killed enemy's gem is worth (the "Sigma token" economy). PURE.
export function gemValue(enemy) {
  let v = VS_TUNABLES.gemBaseValue + (enemy?.threat || 1) * VS_TUNABLES.gemValuePerThreat;
  if (enemy?.kind === "elite") v *= VS_TUNABLES.gemEliteMult;
  else if (enemy?.kind === "boss") v *= VS_TUNABLES.gemBossMult;
  return Math.max(1, Math.round(v));
}

// Spawn one XP gem per killed enemy at a deterministic arena-ring position.
// Mutates run.gems (capped) + run.gemSeq. PURE (no rng). Returns the spawned.
export function spawnGemsForKills(run, killed, tickIdx) {
  if (!run) return [];
  if (!Array.isArray(run.gems)) run.gems = [];
  let seq = run.gemSeq | 0;
  const spawned = [];
  for (const enemy of killed || []) {
    const ang = GOLDEN_ANGLE * (seq + 1);
    const r = VS_TUNABLES.arenaRadius * (0.55 + (seq % 5) * 0.09);
    const gem = {
      id: `g${tickIdx | 0}_${seq}`,
      x: round2(Math.cos(ang) * r),
      y: round2(Math.sin(ang) * r),
      value: gemValue(enemy),
    };
    if (run.gems.length < VS_TUNABLES.gemMaxLive) run.gems.push(gem);
    spawned.push(gem);
    seq += 1;
  }
  run.gemSeq = seq;
  return spawned;
}

// Magnetize in-flight gems toward the player (center 0,0) and collect any that
// reach the pickup radius. Mutates run.gems (collected removed). Returns
// { collected, xp }. PURE (no rng) — fixed-step toward the origin.
export function advanceGems(run) {
  if (!run || !Array.isArray(run.gems) || !run.gems.length) return { collected: [], xp: 0 };
  const {
    gemMagnetStep: step,
    gemPickupRadius: radius,
    gemMagnetFramesPerTick: frames,
  } = VS_TUNABLES;
  const collected = [];
  let xp = 0;
  for (let f = 0; f < frames; f += 1) {
    for (const g of run.gems) {
      if (g._done) continue;
      const d = Math.hypot(g.x, g.y);
      if (d <= radius) {
        g._done = true;
        collected.push({ id: g.id, value: g.value });
        xp += g.value;
        continue;
      }
      const k = step / d;
      g.x = round2(g.x - g.x * k);
      g.y = round2(g.y - g.y * k);
    }
  }
  run.gems = run.gems.filter((g) => !g._done);
  return { collected, xp };
}

// One delveTick of the gem economy: spawn from this tick's kills, then
// magnetize + collect. Returns a compact report. Mutates run.gems. PURE.
// `_character` is accepted for call-site symmetry (future per-character magnet
// bonuses) but unused today.
export function harvestVsTick(_character, run, killed, tickIdx) {
  spawnGemsForKills(run, killed, tickIdx);
  const adv = advanceGems(run);
  return {
    collectedXp: adv.xp,
    collected: adv.collected.length,
    liveGems: run.gems.length,
  };
}

// Live gem snapshot for the combat overlay (id, pos, target, value). The
// target is always the player at the center. PURE (read-only).
export function gemSnapshot(run) {
  const gems = Array.isArray(run?.gems) ? run.gems : [];
  return gems.slice(0, VS_TUNABLES.gemMaxLive).map((g) => ({
    id: g.id,
    x: g.x,
    y: g.y,
    tx: 0,
    ty: 0,
    value: g.value,
  }));
}

// ── Faint (the VS soft-death) ──────────────────────────────────────────
// On a faint the character loses their ACTIVE weapon (re-acquirable), which
// frees a slot for a different combo. Deterministic. Mutates the character.
// Returns { lostWeapon, activeWeapon, weapons }.
export function applyFaint(character) {
  const weapons = Array.isArray(character?.weapons) ? character.weapons.slice() : [];
  if (!weapons.length) {
    character.lostWeapon = null;
    character.fainted = (character.fainted | 0) + 1;
    return { lostWeapon: null, activeWeapon: null, weapons: [] };
  }
  const active =
    character.activeWeapon && weapons.includes(character.activeWeapon)
      ? character.activeWeapon
      : weapons[0];
  const idx = weapons.indexOf(active);
  if (idx >= 0) weapons.splice(idx, 1);
  character.weapons = weapons;
  character.lostWeapon = active;
  character.activeWeapon = weapons[0] || null;
  character.fainted = (character.fainted | 0) + 1;
  return { lostWeapon: active, activeWeapon: character.activeWeapon, weapons: weapons.slice() };
}
