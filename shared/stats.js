// SIGMA ABYSS — stat math.
//
// The 7 base stats + level + equipped gear → a full combat-ready derived
// sheet. This is the ONLY module that knows the stat formulas, so combat,
// loot, progression and the UI all agree on what a build is worth.
// Formula coefficients are the local K table; cross-cutting numbers stay
// in constants.js.

import {
  BUILD_PRESETS,
  SPIRIT_BASE,
  SPIRIT_PER_INT,
  START_STATS,
  STAT_KEYS,
  STAT_MAX,
  STAT_MIN,
} from "./constants.js";
import { diseaseMods } from "./diseases.js";
import { factionCombatMods } from "./factions.js";
import { healthMods } from "./health.js";
import { inspirationOverride } from "./inspirations.js";
import { equippedSetBonuses, setModsForBonuses } from "./item-sets.js";
import { breakOverride } from "./mental-breaks.js";
import { passiveMods } from "./passive-tree.js";
import { talentMods } from "./skill-talents.js";
import { auraMods, skillCombatMods, spiritCostOf } from "./skills.js";
import { traitMods } from "./traits.js";
import { WEAPON_FAMILIES, weaponAttackBonus } from "./weapons.js";

const K = {
  hpBase: 60,
  hpPerVit: 9,
  hpPerLevel: 6,
  atkBase: 6,
  atkPerStr: 1.7,
  defBase: 4,
  defPerResolve: 1.5,
  critBase: 0.03,
  critPerLuck: 0.006,
  critCap: 0.75,
  critMultBase: 1.5,
  critMultPerInt: 0.018,
  spdBase: 1.0,
  spdPerAgi: 0.035,
  dodgePerAgi: 0.0045,
  dodgeCap: 0.6,
  overloadPerInt: 0.003,
  overloadCap: 0.4, // chance of a bonus double-hit
  lootQtyPerGreed: 0.04,
  rarityPerGreed: 0.012,
  rarityPerLuck: 0.016,
  dangerPerGreed: 0.02,
  dangerReducePerResolve: 0.011,
  dangerMultMin: 0.35,
  deathSavePerResolve: 0.004,
  deathSaveCap: 0.25,
  hiddenPerLuck: 0.003,
  hiddenCap: 0.3,
};

const clampStat = (n) => Math.min(STAT_MAX, Math.max(STAT_MIN, Math.round(n || 0)));

// ── Active build set (Project Ascendant Inc6 — dual specialization) ─────
// A character carries an active combat profile ("A" or "B"). The CANONICAL
// invariant is that the ACTIVE set's data always lives in the top-level
// fields: `run.gear` (active gear) + `character.{passives,passiveStart,
// reserved,position,skillTalents}`. The INACTIVE set's data is parked in
// `character.setB` (account-side build identity) + `run.gearB` (run-side gear,
// so permadeath erases both loadouts equally — gear never crosses the
// run/account line). A swap is a pure between-tick data shuffle (see
// swapBuildSet); it NEVER runs mid-tick, so derive() reads a fixed set for the
// whole encounter and the rng stream is unshifted.
//
// activeBuild() returns the active set's build fields. It reads the top-level
// (canonical) fields, so for EVERY pre-Inc6 character (no setB, activeSet "A")
// it returns exactly the legacy fields → derive() output stays byte-identical.
// No rng draw — a pure read of account/run state.
export function activeBuild(character, run = null) {
  const r = run || character?.run || null;
  return {
    set: character?.activeSet === "B" ? "B" : "A",
    gear: r?.gear || null,
    passives: character?.passives || [],
    passiveStart: character?.passiveStart || null,
    reserved: character?.reserved || [],
    position: character?.position || "mid",
    skillTalents: character?.skillTalents || null,
  };
}

// A blank 7-stat accumulator.
function zeroStats() {
  const o = {};
  for (const k of STAT_KEYS) o[k] = 0;
  return o;
}

// Sum the base-stat affixes off every equipped item.
export function gearBaseStats(gear) {
  const acc = zeroStats();
  if (!gear) return acc;
  for (const slot of Object.keys(gear)) {
    const item = gear[slot];
    if (!item || !Array.isArray(item.affixes)) continue;
    for (const a of item.affixes) {
      if (a && STAT_KEYS.includes(a.stat)) acc[a.stat] += a.value || 0;
    }
  }
  return acc;
}

// Sum the flat combat-mod affixes (non-base-stat affixes) off equipped gear.
export function gearMods(gear) {
  const m = {
    hp: 0,
    atk: 0,
    def: 0,
    crit: 0,
    critMult: 0,
    speed: 0,
    dodge: 0,
    lootQty: 0,
    rarity: 0,
  };
  if (!gear) return m;
  for (const slot of Object.keys(gear)) {
    const item = gear[slot];
    if (!item || !Array.isArray(item.affixes)) continue;
    for (const a of item.affixes) {
      if (a && a.stat in m) m[a.stat] += a.value || 0;
    }
  }
  return m;
}

// base stats + gear base-stat affixes, clamped.
export function effectiveStats(run) {
  const base = run?.stats || START_STATS;
  const g = gearBaseStats(run?.gear);
  const out = {};
  for (const k of STAT_KEYS) out[k] = clampStat((base[k] || 0) + g[k]);
  return out;
}

// Every legendary/mythic effect id on equipped gear (combat.js reads these).
export function gearEffects(gear) {
  const out = [];
  if (!gear) return out;
  for (const slot of Object.keys(gear)) {
    const it = gear[slot];
    if (it?.effect) out.push(it.effect);
  }
  return out;
}

// Incoming damage is multiplied by this (defense → diminishing mitigation).
export function damageMul(defense) {
  return 100 / (100 + Math.max(0, defense));
}

// Weapon-family-specific trait atk multiplier — Brawler boosts fists,
// Bookworm boosts staves, etc.
function familyAtkMul(tMods, weaponFamily) {
  const key =
    weaponFamily === "fists"
      ? "atkMulFists"
      : weaponFamily === "sword"
        ? "atkMulSword"
        : weaponFamily === "greatsword"
          ? "atkMulGreatsword"
          : weaponFamily === "dagger"
            ? "atkMulDagger"
            : weaponFamily === "staff"
              ? "atkMulStaff"
              : weaponFamily === "bow"
                ? "atkMulBow"
                : weaponFamily === "axe"
                  ? "atkMulAxe"
                  : weaponFamily === "spear"
                    ? "atkMulSpear"
                    : weaponFamily === "wand"
                      ? "atkMulWand"
                      : null;
  return key ? tMods[key] || 1 : 1;
}

// The full derived sheet. Run is the load-bearing input; `character` is
// optional but unlocks trait + skill + disease + injury + mental-break +
// inspiration modifiers when provided. Server + client both pass the
// character whenever it is in scope so the buffs apply consistently.
export function derive(run, character = null) {
  // Resolve the ACTIVE build set (Inc6 dual spec). The active set's gear is the
  // run's canonical `gear` and its passives/reserved/skillTalents are the
  // canonical top-level character fields, so for a single-loadout character
  // (no setB / activeSet "A") `b` mirrors exactly the legacy reads below and
  // derive() output is byte-identical. No rng draw; the set is fixed before the
  // caller (delveTick) restores the rng stream.
  const b = activeBuild(character, run);
  const s = effectiveStats(run);
  const mods = gearMods(run?.gear);
  const effects = gearEffects(run?.gear);
  const lvl = Math.max(1, run?.level || 1);
  const weapon = run?.gear?.weapon || null;
  const wFamily = weapon?.family || "fists";
  const wPlus = weapon?.plus | 0;
  const wFam = WEAPON_FAMILIES[wFamily] || WEAPON_FAMILIES.fists;

  const traits = character?.traits || [];
  const tMods = traitMods(traits);
  const dMods = diseaseMods(run);
  const hMods = healthMods(run);
  const sMods = skillCombatMods(character?.skills, wFamily);
  // Faction allegiance shaper (persistent-world layer). Returns EXACT
  // identity (×1 / +0) when the character has no faction or is rank 0, so
  // this line is a no-op for every pre-faction character and `derive`
  // output stays byte-identical (IEEE754: x×1===x, x+0===x) — the
  // back-compat guarantee the determinism canary (smoke) relies on.
  const fMods = factionCombatMods(
    character?.faction || null,
    character?.factionRep || null,
    run?.zone || null,
  );
  // Persistent-world combat shapers: faction + prestige talents + item sets.
  // Each returns EXACT identity (×1 / +0) when empty, and `mmo` composes them
  // so derive output stays byte-identical for any character without these —
  // the determinism back-compat the smoke canary guards.
  const tlMods = talentMods(b.skillTalents);
  const setMods = setModsForBonuses(equippedSetBonuses(run?.gear));
  // Aura/minion/totem reservation buffs (Project Ascendant Inc7).
  // Returns EXACT identity (×1/+0) when character.reserved is empty/null,
  // so derive() stays byte-identical for unreserved characters — the same
  // pattern as talentMods/setModsForBonuses/factionCombatMods.
  // No rng draw — pure function of character account state.
  const aMods = auraMods(b.reserved);
  // Passive tree allocation (Project Ascendant Inc4 — the PoE-style web).
  // Returns EXACT identity (×1/+0 on every key) when character.passives is
  // empty/absent, so derive() stays byte-identical for un-allocated characters
  // — the same firewall as talentMods/auraMods/setModsForBonuses. No rng draw:
  // a pure function of the (account-side) allocated-id list. Folds into the
  // `mmo` composition below (multiplicative *Mul, additive *Add) and into the
  // spirit / dodge / crit-mult accumulators.
  const pMods = passiveMods(b.passives);
  // Faction territory conquest bonus: server precomputes run._factionZoneMod
  // (a ±fraction) from world zone ownership and injects it as DATA, so stats.js
  // imports no store (master §M4). 0/undefined → ×1 → byte-identical.
  const zoneMod = 1 + (run?._factionZoneMod || 0);
  const mmo = {
    hpMul: fMods.hpMul * tlMods.hpMul * setMods.hpMul * aMods.hpMul * pMods.hpMul,
    atkMul: fMods.atkMul * tlMods.atkMul * setMods.atkMul * zoneMod * aMods.atkMul * pMods.atkMul,
    defMul: fMods.defMul * tlMods.defMul * setMods.defMul * zoneMod * aMods.defMul * pMods.defMul,
    speedMul: tlMods.speedMul * setMods.speedMul * pMods.speedMul,
    critAdd: fMods.critAdd + tlMods.critAdd + setMods.critAdd + aMods.critAdd + pMods.critAdd,
    lootRarityAdd:
      fMods.lootRarityAdd + tlMods.lootRarityAdd + setMods.lootRarityAdd + pMods.lootRarityAdd,
    lootQtyAdd: fMods.lootQtyAdd + tlMods.lootQtyAdd + setMods.lootQtyAdd + pMods.lootQtyAdd,
    dangerMul: fMods.dangerMul * tlMods.dangerMul * setMods.dangerMul * pMods.dangerMul,
    // aura + passive dodge add — applied to the dodge accumulator below.
    auraDodgeAdd: aMods.dodgeAdd + pMods.dodgeAdd,
    // passive crit-multiplier + flat-spirit adds — applied to those accumulators.
    passiveCritMultAdd: pMods.critMultAdd,
    passiveSpiritAdd: pMods.spiritAdd,
  };
  const breakMods = breakOverride(run);
  const inspMods = inspirationOverride(run);

  let maxHp = K.hpBase + s.vit * K.hpPerVit + lvl * K.hpPerLevel + mods.hp;
  let attack =
    K.atkBase +
    s.str * K.atkPerStr +
    mods.atk +
    weaponAttackBonus(s, wFamily, wPlus) +
    sMods.atkAdd;
  let defense = K.defBase + s.resolve * K.defPerResolve + mods.def;

  // Legendary stat-shaping effects (behavioural effects stay in combat.js).
  if (effects.includes("glass")) {
    attack *= 1.45;
    maxHp *= 0.62;
  }
  if (effects.includes("juggernaut")) {
    maxHp *= 1.4;
    attack *= 0.82;
  }

  // Trait shapers (multiplicative). Faction mods stack here too (identity
  // when faction===null → byte-identical for pre-faction characters).
  maxHp *= tMods.hpMul * dMods.hpMul * hMods.hpMul * mmo.hpMul;
  attack *= tMods.atkMul * familyAtkMul(tMods, wFamily) * dMods.atkMul * hMods.atkMul * mmo.atkMul;
  defense *= (tMods.defMul || 1) * dMods.defMul * hMods.defMul * mmo.defMul;
  // Mental-break override (active for a few encounters).
  if (breakMods) {
    attack *= breakMods.atkMul;
    defense *= breakMods.defMul;
  }
  // Inspiration override (rare positive temporary buff).
  if (inspMods) {
    attack *= inspMods.atkMul;
  }

  const critChance = Math.min(
    K.critCap,
    Math.max(
      0,
      K.critBase +
        s.luck * K.critPerLuck +
        mods.crit +
        (wFam.critMul || 0) +
        (tMods.critAdd || 0) +
        sMods.critAdd +
        mmo.critAdd +
        (breakMods ? 0 : 0) +
        (inspMods?.critAdd || 0) +
        hMods.critAdd,
    ),
  );
  let critMult =
    K.critMultBase +
    s.int * K.critMultPerInt +
    mods.critMult +
    (tMods.critMultAdd || 0) +
    mmo.passiveCritMultAdd;
  if (breakMods?.critMultAdd) critMult += breakMods.critMultAdd;
  let speed =
    (K.spdBase + s.agi * K.spdPerAgi + mods.speed) *
    (wFam.speedMul || 1) *
    (tMods.speedMul || 1) *
    dMods.speedMul *
    hMods.speedMul *
    mmo.speedMul;
  if (breakMods) speed *= breakMods.speedMul;
  if (inspMods) speed *= inspMods.speedMul;
  speed = Math.max(0.3, speed);

  let dodge =
    s.agi * K.dodgePerAgi +
    mods.dodge +
    (tMods.dodgeAdd || 0) +
    sMods.dodgeAdd +
    dMods.dodgeAdd +
    mmo.auraDodgeAdd;
  if (breakMods) dodge += breakMods.dodgeAdd;
  if (inspMods) dodge += inspMods.dodgeAdd;
  dodge = Math.min(K.dodgeCap, Math.max(0, dodge));

  const overload = Math.min(K.overloadCap, s.int * K.overloadPerInt + sMods.overloadAdd);
  let lootQty =
    1 +
    s.greed * K.lootQtyPerGreed +
    mods.lootQty +
    sMods.lootQtyAdd +
    (tMods.lootQtyAdd || 0) +
    mmo.lootQtyAdd;
  if (inspMods?.lootQtyAdd) lootQty += inspMods.lootQtyAdd;
  let lootRarity =
    s.greed * K.rarityPerGreed +
    s.luck * K.rarityPerLuck +
    mods.rarity +
    (tMods.lootRarityAdd || 0) +
    mmo.lootRarityAdd;
  if (inspMods?.lootRarityAdd) lootRarity += inspMods.lootRarityAdd;
  const dangerMult = Math.max(
    K.dangerMultMin,
    (1 + s.greed * K.dangerPerGreed - s.resolve * K.dangerReducePerResolve) *
      (tMods.dangerMul || 1) *
      sMods.dangerMul *
      mmo.dangerMul,
  );
  const deathSave = Math.min(K.deathSaveCap, s.resolve * K.deathSavePerResolve);
  const hiddenChance = Math.min(K.hiddenCap, s.luck * K.hiddenPerLuck);

  // Spirit Pool — pure additive formula, no rng draw, exact-identity (+0)
  // when int=0. Passive-tree flat spirit (mmo.passiveSpiritAdd) folds in here
  // and is floored at 0 so Blood Magic's pool-removal keystone (a large
  // negative spiritAdd) collapses the pool to 0 rather than going negative.
  // When no passives are allocated passiveSpiritAdd is +0 → byte-identical.
  const spirit = Math.max(
    0,
    Math.round(SPIRIT_BASE + s.int * SPIRIT_PER_INT + mmo.passiveSpiritAdd),
  );
  // Spirit used by active reservations (Project Ascendant Inc7).
  // Exact-identity (+0) when character.reserved is empty — spiritCostOf([]) === 0.
  // No rng draw. The pool enforces spiritUsed ≤ spirit via validate.js.
  const spiritUsed = spiritCostOf(b.reserved);

  return {
    maxHp: Math.round(maxHp),
    attack: Math.max(1, attack),
    defense,
    critChance,
    critMult,
    speed,
    dodge,
    overload,
    lootQty: Math.max(1, lootQty),
    lootRarity,
    dangerMult,
    deathSave,
    hiddenChance,
    effects,
    spirit,
    spiritUsed,
    // Pass-through overrides combat.js + progression.js care about.
    breakMods,
    inspMods,
    traitFlags: {
      immuneCurse: !!tMods.immuneCurse,
    },
    incomingMul: breakMods?.incomingMul || 1,
  };
}

// Distribute `points` across START_STATS by a build preset's weights —
// used by the one-click respec templates. Returns a fresh stats object.
export function distributeByPreset(presetKey, points) {
  const preset = BUILD_PRESETS[presetKey];
  const out = { ...START_STATS };
  if (!preset || points <= 0) return out;
  const weight = preset.weight;
  let total = 0;
  for (const k of Object.keys(weight)) total += weight[k];
  if (total <= 0) return out;
  let spent = 0;
  const keys = Object.keys(weight);
  for (const k of keys) {
    const give = Math.floor(points * (weight[k] / total));
    out[k] = clampStat(out[k] + give);
    spent += give;
  }
  // Remainder to the heaviest-weighted stat so no points vanish.
  let heavy = keys[0];
  for (const k of keys) if (weight[k] > weight[heavy]) heavy = k;
  out[heavy] = clampStat(out[heavy] + (points - spent));
  return out;
}

// Total stat points a character has ever earned (for respec accounting).
export function spentPoints(stats) {
  let n = 0;
  for (const k of STAT_KEYS) n += (stats?.[k] || 0) - START_STATS[k];
  return Math.max(0, n);
}
