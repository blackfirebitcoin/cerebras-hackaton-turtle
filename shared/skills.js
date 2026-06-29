// SIGMA ABYSS — RimWorld skills with passions.
//
// Eight combat-adjacent skills. Each carries:
//   level    0..20      — actual proficiency
//   xp       0..n       — progress into the next level
//   passion  0|1|2      — interest level (none / single flame / double flame)
//
// Passion is a learning multiplier (RimWorld feel: +75% for single,
// +150% for double). Passions are rolled at character creation and
// persist for life. Skill levels also persist — they belong to the
// ACCOUNT, not the run, so permadeath does not wipe years of practice
// (mirroring how a pawn keeps skills through a colony reload).
//
// Pure ESM, dual-runtime.

import { makeRng, mixSeed } from "./rng.js";

export const SKILLS = {
  melee: {
    name: "Melee",
    blurb: "Cuts and bludgeons. Boosts attack with sword/greatsword/dagger.",
    spiritCost: null, // Inc2: active skills will draw from spirit pool
  },
  ranged: {
    name: "Ranged",
    blurb: "Bow shots and thrown blades. Boosts crit chance.",
    spiritCost: null,
  },
  magic: {
    name: "Magic",
    blurb: "Channels Intellect. Boosts staff damage + overload.",
    spiritCost: null,
  },
  survival: {
    name: "Survival",
    blurb: "Reads weather, finds water. Reduces danger climb.",
    spiritCost: null,
  },
  looting: {
    name: "Looting",
    blurb: "Spots the good stuff. Bumps loot quantity.",
    spiritCost: null,
  },
  bargaining: {
    name: "Bargaining",
    blurb: "Talks the merchant up. Improves sell value.",
    spiritCost: null,
  },
  stealth: { name: "Stealth", blurb: "Moves quiet. Adds dodge.", spiritCost: null },
  social: {
    name: "Social",
    blurb: "Holds the group together. Resists mental break.",
    spiritCost: null,
  },
};

export const SKILL_IDS = Object.keys(SKILLS);
export const SKILL_LEVEL_MAX = 20;
export const PASSION_FLAMES = [0, 1, 2];

// XP-to-next-level curve. RimWorld's curve climbs fast at first then
// plateaus; mirror that shape — early levels are cheap, mastery is hard.
export function xpForSkillLevel(level) {
  if (level <= 0) return 1000;
  return Math.round(1000 + level * level * 250);
}

// Learning multiplier from a passion flame.
export function passionMul(flames) {
  return flames >= 2 ? 2.5 : flames === 1 ? 1.75 : 1.0;
}

// ── Initial roll ──────────────────────────────────────────────────────
// At character creation we roll one passion-2 (double flame), two
// passion-1 (single flame), and leave the rest at zero. RimWorld pawns
// frequently have ~3 passions; we let the seed pick which skills they
// fall on. Pure: deterministic by seed.
export function rollSkills(seed) {
  const rng = makeRng(mixSeed(seed >>> 0, 0xfeed51a7));
  const ids = SKILL_IDS.slice();
  // Knuth shuffle.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const out = {};
  for (const id of SKILL_IDS) out[id] = { level: 0, xp: 0, passion: 0 };
  if (ids[0]) out[ids[0]].passion = 2;
  if (ids[1]) out[ids[1]].passion = 1;
  if (ids[2]) out[ids[2]].passion = 1;
  return out;
}

// Apply backstory skill bonuses at character creation. Bonuses are
// quoted in raw XP — pour them in and let levels cascade.
export function applyBackstoryXp(skills, bonuses, traitSkillMul = 1) {
  if (!skills || !bonuses) return;
  for (const id of Object.keys(bonuses)) {
    if (!SKILLS[id]) continue;
    grantSkillXp(skills, id, bonuses[id] * traitSkillMul);
  }
}

// Bank `amount` XP into one skill, cascading level-ups. `amount` is
// pre-multiplied (passion + trait skillXpMul applied by the caller).
export function grantSkillXp(skills, id, amount) {
  if (!skills?.[id] || amount <= 0) return { leveled: false, levels: 0 };
  const s = skills[id];
  if (s.level >= SKILL_LEVEL_MAX) return { leveled: false, levels: 0 };
  s.xp += Math.round(amount);
  let levels = 0;
  while (s.level < SKILL_LEVEL_MAX && s.xp >= xpForSkillLevel(s.level)) {
    s.xp -= xpForSkillLevel(s.level);
    s.level += 1;
    levels += 1;
  }
  if (s.level >= SKILL_LEVEL_MAX) s.xp = 0;
  return { leveled: levels > 0, levels, newLevel: s.level };
}

// Convenience: grant XP with passion baked in. Caller still applies
// trait skillXpMul (it varies per character).
export function grantWithPassion(skills, id, baseAmount, traitMul = 1) {
  const s = skills?.[id];
  if (!s) return { leveled: false, levels: 0 };
  return grantSkillXp(skills, id, baseAmount * passionMul(s.passion) * traitMul);
}

// ── Reservable skills (Project Ascendant Inc7 — Spirit Reservation + Aura Buffs) ──
//
// Auras/minions/totems reserve a portion of the Spirit Pool permanently for
// the duration of a delve. Reserving one means the character always benefits
// from its buff — no active use needed — but the reserved spirit is unavailable
// for other purposes.
//
// spiritCost   How much of the pool this reservation consumes.
// buff         The combat-sheet delta applied by derive() when reserved.
//              All keys are additive (+ 0 when absent) or multiplicative (× 1
//              when absent) — EXACT-IDENTITY when `reserved` is empty or the
//              skill is not reserved, so derive() stays byte-identical for
//              unreserved characters.
// kind         "aura" | "minion" | "totem" — informational for the UI.
// desc         Player-facing description.
//
// Buff magnitude is deliberately modest: a single aura adds ~10-15% in one
// dimension at the cost of 25-50 spirit (pool is 50 + 1.5×int, so a starting
// int-5 sigma has 57.5 ≈ 57 spirit — barely enough for Fire Aura alone).
// High-int builds unlock multi-aura loadouts.

export const RESERVABLE_SKILLS = {
  fire_aura: {
    name: "Fire Aura",
    kind: "aura",
    spiritCost: 25,
    desc: "Wreathed in flames. +12% attack, +8% fire-flavoured crit chance.",
    buff: {
      atkMul: 1.12,
      critAdd: 0.08,
    },
  },
  ice_aura: {
    name: "Ice Aura",
    kind: "aura",
    spiritCost: 25,
    desc: "Glacial shell. +15% defense, +5% dodge.",
    buff: {
      defMul: 1.15,
      dodgeAdd: 0.05,
    },
  },
  wolf_companion: {
    name: "Wolf Companion",
    kind: "minion",
    spiritCost: 35,
    desc: "A spectral wolf flanks your attacks. +14% attack.",
    buff: {
      atkMul: 1.14,
    },
  },
  summon_skeleton: {
    name: "Summon Skeleton",
    kind: "minion",
    spiritCost: 40,
    desc: "A skeletal warrior absorbs blows for you. +10% max HP.",
    buff: {
      hpMul: 1.1,
    },
  },
  guardian_totem: {
    name: "Guardian Totem",
    kind: "totem",
    spiritCost: 50,
    desc: "An ethereal totem guards the area. +20% max HP, +8% defense.",
    buff: {
      hpMul: 1.2,
      defMul: 1.08,
    },
  },
};

export const RESERVABLE_SKILL_IDS = Object.keys(RESERVABLE_SKILLS);

// Exact-identity object returned when no reservations are active. Same
// pattern as talentMods / setModsForBonuses / factionCombatMods — the
// determinism firewall: x×1===x, x+0===x (IEEE 754).
const AURA_IDENTITY = Object.freeze({
  hpMul: 1,
  atkMul: 1,
  defMul: 1,
  critAdd: 0,
  dodgeAdd: 0,
});

// Aggregate the combat-sheet mods of every RESERVED aura/minion/totem.
// Returns EXACT identity (×1 / +0) when `reserved` is empty/null, so
// derive() output is byte-identical for unreserved characters.
// No rng — pure function of account state.
export function auraMods(reserved) {
  if (!reserved || (Array.isArray(reserved) ? reserved.length === 0 : true)) {
    return AURA_IDENTITY;
  }
  const ids = Array.isArray(reserved) ? reserved : [];
  let any = false;
  const out = { hpMul: 1, atkMul: 1, defMul: 1, critAdd: 0, dodgeAdd: 0 };
  for (const id of ids) {
    const skill = RESERVABLE_SKILLS[id];
    if (!skill) continue;
    any = true;
    const b = skill.buff;
    if (b.hpMul) out.hpMul *= b.hpMul;
    if (b.atkMul) out.atkMul *= b.atkMul;
    if (b.defMul) out.defMul *= b.defMul;
    if (b.critAdd) out.critAdd += b.critAdd;
    if (b.dodgeAdd) out.dodgeAdd += b.dodgeAdd;
  }
  return any ? out : AURA_IDENTITY;
}

// Compute total spirit consumed by a list of reserved skill ids.
// Returns 0 when `reserved` is empty/null — exact-identity (+0) for
// unreserved characters.
export function spiritCostOf(reserved) {
  if (!reserved || !Array.isArray(reserved) || reserved.length === 0) return 0;
  let total = 0;
  for (const id of reserved) {
    const skill = RESERVABLE_SKILLS[id];
    if (skill) total += skill.spiritCost;
  }
  return total;
}

// ── Read side: skill-driven combat modifiers ──────────────────────────
// Skills nudge derived stats. Mild — RimWorld values pawn flavour over
// raw power scaling — but consistent: level 20 melee is a real combat
// edge, level 0 melee is a real penalty.
export function skillCombatMods(skills, weaponFamily) {
  const mods = {
    atkAdd: 0,
    critAdd: 0,
    overloadAdd: 0,
    dodgeAdd: 0,
    lootQtyAdd: 0,
    goldMul: 1,
    breakChanceMul: 1,
    dangerMul: 1,
  };
  if (!skills) return mods;
  const meleeLvl = skills.melee?.level || 0;
  const rangedLvl = skills.ranged?.level || 0;
  const magicLvl = skills.magic?.level || 0;
  const survivalLvl = skills.survival?.level || 0;
  const lootLvl = skills.looting?.level || 0;
  const bargainLvl = skills.bargaining?.level || 0;
  const stealthLvl = skills.stealth?.level || 0;
  const socialLvl = skills.social?.level || 0;

  // Melee — flat attack add for sword-likes + axe/spear.
  if (["sword", "greatsword", "dagger", "fists", "axe", "spear"].includes(weaponFamily)) {
    mods.atkAdd += meleeLvl * 0.6;
  }
  // Ranged — crit bonus on bows/daggers.
  if (["bow", "dagger"].includes(weaponFamily)) {
    mods.critAdd += rangedLvl * 0.004;
  }
  // Magic — staff/wand scaling. Both scale off Int; wand gets a lighter bonus
  // since its family atkMul is lower than staff's.
  if (weaponFamily === "staff") {
    mods.atkAdd += magicLvl * 0.8;
    mods.overloadAdd += magicLvl * 0.0035;
  }
  if (weaponFamily === "wand") {
    mods.atkAdd += magicLvl * 0.6;
    mods.overloadAdd += magicLvl * 0.003;
    mods.critAdd += rangedLvl * 0.003; // wand has strong crit identity
  }
  // Spear — crit bonus from ranged skill (thrown-blade feel).
  if (weaponFamily === "spear") {
    mods.critAdd += rangedLvl * 0.003;
  }
  // Survival slows the danger gauge climb.
  mods.dangerMul *= Math.max(0.55, 1 - survivalLvl * 0.018);
  // Looting bumps quantity.
  mods.lootQtyAdd += lootLvl * 0.025;
  // Bargaining bumps sell value (applied at sellValue + bankAtTown).
  mods.goldMul *= 1 + bargainLvl * 0.02;
  // Stealth adds dodge.
  mods.dodgeAdd += stealthLvl * 0.005;
  // Social drops break chance.
  mods.breakChanceMul *= Math.max(0.5, 1 - socialLvl * 0.025);

  return mods;
}

// Resolve which skill earned XP this encounter and credit it. Hooked
// into delveTick(). Returns { id, levelsGained } for the feed.
export function creditEncounterSkills(skills, weaponFamily, result, traitSkillMul = 1) {
  const out = [];
  if (!skills) return out;
  // Combat skill — keyed to the weapon family.
  let combatSkill = "melee";
  if (weaponFamily === "bow") combatSkill = "ranged";
  else if (weaponFamily === "staff") combatSkill = "magic";
  else if (weaponFamily === "dagger") combatSkill = "stealth";

  const kills = result.kills || 0;
  if (kills > 0) {
    const r = grantWithPassion(skills, combatSkill, 220 * kills, traitSkillMul);
    if (r.leveled) out.push({ id: combatSkill, level: r.newLevel });
  }
  // Survival tick for surviving an encounter.
  if (result.outcome !== "death") {
    const r = grantWithPassion(skills, "survival", 110, traitSkillMul);
    if (r.leveled) out.push({ id: "survival", level: r.newLevel });
  }
  // Loot — XP per item looted (caller passes count via result.itemsLooted).
  if (result.itemsLooted) {
    const r = grantWithPassion(skills, "looting", 180 * result.itemsLooted, traitSkillMul);
    if (r.leveled) out.push({ id: "looting", level: r.newLevel });
  }
  return out;
}
