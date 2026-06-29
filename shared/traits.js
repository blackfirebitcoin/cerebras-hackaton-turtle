// SIGMA ABYSS — RimWorld-style personality traits.
//
// Every sigma rolls 2-3 traits at character creation. Traits are
// deterministic from the character seed — no live RNG draws — so the
// same seed always produces the same personality. Traits stack onto the
// derived combat sheet (see stats.js → traitMods), bias mood baselines,
// modulate mental-break propensity, and toggle a few combat behaviours
// (cannibal heal-on-kill, pyromaniac burn proc, etc.).
//
// Pure ESM, dual-runtime. No DOM, no Node built-ins.

import { makeRng, mixSeed } from "./rng.js";

// ── Catalogue ─────────────────────────────────────────────────────────
// Each trait declares:
//   id, name, blurb     — display
//   conflicts           — ids that can't coexist (e.g. tough + wimp)
//   weight              — roll weight (rarer flavours get smaller numbers)
//   mods                — derived-sheet adjustments (see stats.js)
//                         multiplicative (x) or additive (+)
//   moodBase            — modifier to mood baseline (50 ± this)
//   moodGainMul         — multiplier on positive thought magnitude
//   moodLossMul         — multiplier on negative thought magnitude
//   breakChanceMul      — multiplier on mental-break roll
//   breakThresholdMod   — shift the "dangerously low mood" floor
//   diseaseChance       — flat add to disease proc per tick
//   diseaseResistMul    — multiplier on disease severity climb
//   xpMul, goldMul, prestigeMul    — economy levers
//   effects             — strings appended to fighter.effects (see combat.js)
//   onKill              — special behaviours fired in combat ("cannibal", "bloodlust")
//   onHit               — special behaviours when foe lands a blow ("masochist")
export const TRAITS = {
  // ── Combat aggressives ────────────────────────────────────────────
  bloodlust: {
    id: "bloodlust",
    name: "Bloodlust",
    blurb: "Killing fuels them. Mood spikes per kill, hits harder.",
    weight: 8,
    conflicts: ["kind", "psychopath", "wimp"],
    mods: { atkMul: 1.15 },
    onKill: "bloodlust",
    moodBase: 0,
  },
  brawler: {
    id: "brawler",
    name: "Brawler",
    blurb: "Loves a punch-up. +30% damage with fists, -10% with staves.",
    weight: 10,
    conflicts: ["bookworm"],
    mods: { atkMulFists: 1.3, atkMulStaff: 0.9 },
  },
  bookworm: {
    id: "bookworm",
    name: "Bookworm",
    blurb: "Reads in the abyss. +25% magic damage, -15% melee.",
    weight: 9,
    conflicts: ["brawler"],
    mods: { atkMulStaff: 1.25, atkMulSword: 0.85, atkMulGreatsword: 0.85 },
  },
  triggerHappy: {
    id: "triggerHappy",
    name: "Trigger-Happy",
    blurb: "Swings fast, aims later. +20% speed, -10% crit.",
    weight: 10,
    conflicts: ["careful"],
    mods: { speedMul: 1.2, critAdd: -0.1 },
  },
  careful: {
    id: "careful",
    name: "Careful Shooter",
    blurb: "Lines up the strike. +12% crit, -10% speed.",
    weight: 10,
    conflicts: ["triggerHappy"],
    mods: { critAdd: 0.12, speedMul: 0.9 },
  },
  sharpshooter: {
    id: "sharpshooter",
    name: "Sharpshooter",
    blurb: "Steady hands. +8% crit, +20% crit damage.",
    weight: 6,
    mods: { critAdd: 0.08, critMultAdd: 0.2 },
  },
  hotHeaded: {
    id: "hotHeaded",
    name: "Hot-Headed",
    blurb: "Lashes out. +12% damage, breaks easier.",
    weight: 9,
    conflicts: ["stoic", "coolHeaded"],
    mods: { atkMul: 1.12 },
    breakThresholdMod: 6,
    breakChanceMul: 1.25,
  },
  stoic: {
    id: "stoic",
    name: "Stoic",
    blurb: "Nothing rattles them. -50% break chance, -5% crit.",
    weight: 7,
    conflicts: ["hotHeaded", "nervous"],
    mods: { critAdd: -0.05 },
    breakThresholdMod: -10,
    breakChanceMul: 0.5,
  },

  // ── Constitution ──────────────────────────────────────────────────
  tough: {
    id: "tough",
    name: "Tough",
    blurb: "Built like a wall. +30% Max HP.",
    weight: 8,
    conflicts: ["wimp", "asthmatic"],
    mods: { hpMul: 1.3 },
  },
  wimp: {
    id: "wimp",
    name: "Wimp",
    blurb: "Fragile. -22% Max HP, but mood recovers fast.",
    weight: 6,
    conflicts: ["tough"],
    mods: { hpMul: 0.78 },
    moodGainMul: 1.3,
  },
  asthmatic: {
    id: "asthmatic",
    name: "Asthmatic",
    blurb: "Wheezes between swings. -10% speed, -8% HP.",
    weight: 5,
    conflicts: ["tough"],
    mods: { speedMul: 0.9, hpMul: 0.92 },
  },
  ironStomach: {
    id: "ironStomach",
    name: "Iron Stomach",
    blurb: "Diseases skip them.",
    weight: 6,
    conflicts: ["sickly"],
    diseaseResistMul: 0.3,
    diseaseChance: -0.02,
  },
  sickly: {
    id: "sickly",
    name: "Sickly",
    blurb: "Catches every plague. 2x disease chance.",
    weight: 4,
    conflicts: ["ironStomach"],
    diseaseResistMul: 1.6,
    diseaseChance: 0.04,
    mods: { hpMul: 0.92 },
  },

  // ── Mood / personality ────────────────────────────────────────────
  optimist: {
    id: "optimist",
    name: "Optimist",
    blurb: "Sees the silver lining. +12 mood baseline.",
    weight: 8,
    conflicts: ["pessimist", "depressive"],
    moodBase: 12,
    moodGainMul: 1.2,
  },
  pessimist: {
    id: "pessimist",
    name: "Pessimist",
    blurb: "Knows it'll all end. -12 mood baseline.",
    weight: 7,
    conflicts: ["optimist", "sanguine"],
    moodBase: -12,
  },
  sanguine: {
    id: "sanguine",
    name: "Sanguine",
    blurb: "Mood snaps back fast.",
    weight: 7,
    conflicts: ["depressive", "pessimist"],
    moodGainMul: 1.5,
    moodLossMul: 0.7,
  },
  depressive: {
    id: "depressive",
    name: "Depressive",
    blurb: "Sticks in a slump.",
    weight: 6,
    conflicts: ["sanguine", "optimist"],
    moodGainMul: 0.6,
    moodLossMul: 1.4,
    moodBase: -6,
  },
  ironWilled: {
    id: "ironWilled",
    name: "Iron-Willed",
    blurb: "Mental breaks barely touch them.",
    weight: 6,
    conflicts: ["volatile", "nervous"],
    breakChanceMul: 0.4,
    breakThresholdMod: -8,
  },
  volatile: {
    id: "volatile",
    name: "Volatile",
    blurb: "Snaps easy — but hits like a truck when broken.",
    weight: 7,
    conflicts: ["ironWilled", "stoic"],
    breakChanceMul: 1.6,
    breakThresholdMod: 10,
    mods: { atkMul: 1.05 },
  },
  nervous: {
    id: "nervous",
    name: "Nervous",
    blurb: "Twitchy. +10% dodge, breaks easier.",
    weight: 6,
    conflicts: ["ironWilled", "stoic"],
    mods: { dodgeAdd: 0.1 },
    breakChanceMul: 1.4,
  },
  coolHeaded: {
    id: "coolHeaded",
    name: "Cool-Headed",
    blurb: "Curses slide off.",
    weight: 5,
    conflicts: ["hotHeaded"],
    immuneCurse: true,
  },

  // ── Social / morality ─────────────────────────────────────────────
  bloodthirstyPsycho: {
    id: "psychopath",
    name: "Psychopath",
    blurb: "Doesn't care who dies. Death mood-thoughts ignored.",
    weight: 5,
    conflicts: ["kind", "jealous"],
    ignoreDeathMood: true,
  },
  kind: {
    id: "kind",
    name: "Kind",
    blurb: "Generous in spirit. +8 mood baseline.",
    weight: 7,
    conflicts: ["bloodlust", "abrasive"],
    moodBase: 8,
    moodGainMul: 1.15,
  },
  abrasive: {
    id: "abrasive",
    name: "Abrasive",
    blurb: "Insults everyone. -5 mood after a fight.",
    weight: 6,
    conflicts: ["kind"],
    moodPerEncounter: -5,
  },
  jealous: {
    id: "jealous",
    name: "Jealous",
    blurb: "Resents other sigmas' wins.",
    weight: 5,
    conflicts: ["psychopath"],
    moodPerRivalWin: -6,
  },
  beautiful: {
    id: "beautiful",
    name: "Beautiful",
    blurb: "Doors open for them. +6 Luck, +5% sell value.",
    weight: 4,
    conflicts: ["ugly"],
    mods: { luckAdd: 6 },
    goldMul: 1.05,
    moodBase: 4,
  },
  ugly: {
    id: "ugly",
    name: "Ugly",
    blurb: "Cheaper at the bank, sadder at heart.",
    weight: 4,
    conflicts: ["beautiful"],
    moodBase: -6,
    goldMul: 0.95,
  },

  // ── Learning / loot ───────────────────────────────────────────────
  industrious: {
    id: "industrious",
    name: "Industrious",
    blurb: "Earns XP faster. +25% XP from kills.",
    weight: 7,
    conflicts: ["lazy", "slowLearner"],
    xpMul: 1.25,
  },
  lazy: {
    id: "lazy",
    name: "Lazy",
    blurb: "Coasts. -15% XP, +20% potion heal.",
    weight: 6,
    conflicts: ["industrious", "fastLearner"],
    xpMul: 0.85,
    potionHealMul: 1.2,
  },
  fastLearner: {
    id: "fastLearner",
    name: "Fast Learner",
    blurb: "Picks up skills quickly. +35% skill XP.",
    weight: 6,
    conflicts: ["slowLearner", "lazy"],
    skillXpMul: 1.35,
  },
  slowLearner: {
    id: "slowLearner",
    name: "Slow Learner",
    blurb: "Takes longer to master. -25% skill XP.",
    weight: 5,
    conflicts: ["fastLearner", "industrious"],
    skillXpMul: 0.75,
  },
  greedy: {
    id: "greedy",
    name: "Greedy",
    blurb: "Hoards loot, but it eats them up.",
    weight: 7,
    conflicts: ["ascetic"],
    mods: { lootRarityAdd: 0.05, lootQtyAdd: 0.05 },
    moodBase: -4,
  },
  ascetic: {
    id: "ascetic",
    name: "Ascetic",
    blurb: "Mood lifts on simple meals; less from gold.",
    weight: 5,
    conflicts: ["greedy"],
    moodPotionBonus: 4,
    goldMul: 0.95,
    moodBase: 4,
  },

  // ── Luck ──────────────────────────────────────────────────────────
  lucky: {
    id: "lucky",
    name: "Lucky",
    blurb: "Fortune favours them. +3 Luck, danger climbs slower.",
    weight: 4,
    conflicts: ["cursed"],
    mods: { luckAdd: 3, dangerMul: 0.9 },
  },
  cursed: {
    id: "cursed",
    name: "Cursed",
    blurb: "The abyss watches. Danger climbs faster, loot is richer.",
    weight: 4,
    conflicts: ["lucky", "coolHeaded"],
    mods: { dangerMul: 1.2, lootRarityAdd: 0.06 },
  },

  // ── Niche / chaotic ───────────────────────────────────────────────
  cannibal: {
    id: "cannibal",
    name: "Cannibal",
    blurb: "Heals on every kill.",
    weight: 3,
    onKill: "cannibal",
  },
  pyromaniac: {
    id: "pyromaniac",
    name: "Pyromaniac",
    blurb: "Strikes have a small chance to burn.",
    weight: 4,
    onHitProc: "pyromaniac",
  },
  masochist: {
    id: "masochist",
    name: "Masochist",
    blurb: "Pain feels good. +mood when hit, +5% defence.",
    weight: 3,
    conflicts: ["wimp"],
    mods: { defMul: 1.05 },
    onHit: "masochist",
  },
  nightowl: {
    id: "nightowl",
    name: "Nightowl",
    blurb: "Thrives in the dark. +10% speed, +5% dodge.",
    weight: 6,
    mods: { speedMul: 1.1, dodgeAdd: 0.05 },
  },
  quickSleeper: {
    id: "quickSleeper",
    name: "Quick Sleeper",
    blurb: "Banks rest faster. +60% gold/prestige while resting.",
    weight: 5,
    restMul: 1.6,
  },
};

export const TRAIT_IDS = Object.keys(TRAITS);

// Buckets so we can guarantee variety without coupling fields.
const POOLS = {
  combat: [
    "bloodlust",
    "brawler",
    "bookworm",
    "triggerHappy",
    "careful",
    "sharpshooter",
    "hotHeaded",
    "stoic",
  ],
  body: ["tough", "wimp", "asthmatic", "ironStomach", "sickly"],
  mood: [
    "optimist",
    "pessimist",
    "sanguine",
    "depressive",
    "ironWilled",
    "volatile",
    "nervous",
    "coolHeaded",
  ],
  social: ["psychopath", "kind", "abrasive", "jealous", "beautiful", "ugly"],
  earn: ["industrious", "lazy", "fastLearner", "slowLearner", "greedy", "ascetic"],
  fate: ["lucky", "cursed"],
  chaos: ["cannibal", "pyromaniac", "masochist", "nightowl", "quickSleeper"],
};

function conflictsWith(picked, candidate) {
  const def = TRAITS[candidate];
  if (!def) return true;
  const cf = new Set(def.conflicts || []);
  for (const p of picked) {
    if (cf.has(p)) return true;
    const pdef = TRAITS[p];
    if (pdef?.conflicts?.includes(candidate)) return true;
  }
  return false;
}

function weightedPick(rng, ids, picked) {
  const live = ids.filter((id) => !picked.includes(id) && !conflictsWith(picked, id));
  if (!live.length) return null;
  return rng.weighted(live.map((id) => [id, TRAITS[id].weight || 1]));
}

// Roll the personality. Pure: deterministic by `seed`. Returns 2-3 ids.
export function rollTraits(seed) {
  const rng = makeRng(mixSeed(seed >>> 0, 0xb0d1c5a7));
  const picked = [];

  // First pick: any pool weighted by its size — wider pools see more
  // first-picks than narrow ones, which feels right.
  const poolNames = Object.keys(POOLS);
  const firstPool = rng.weighted(poolNames.map((p) => [p, POOLS[p].length]));
  const first = weightedPick(rng, POOLS[firstPool], picked);
  if (first) picked.push(first);

  // Second pick: a different pool.
  const remaining = poolNames.filter((p) => p !== firstPool);
  const secondPool = rng.weighted(remaining.map((p) => [p, POOLS[p].length]));
  const second = weightedPick(rng, POOLS[secondPool], picked);
  if (second) picked.push(second);

  // 35% chance of a third trait — RimWorld feel: most pawns are 2-trait,
  // a few stand out with a third.
  if (rng.chance(0.35)) {
    const allRemaining = poolNames.filter((p) => p !== firstPool && p !== secondPool);
    const third =
      weightedPick(rng, POOLS[rng.pick(allRemaining)], picked) ||
      weightedPick(rng, TRAIT_IDS, picked);
    if (third) picked.push(third);
  }
  return picked;
}

// ── Aggregators ───────────────────────────────────────────────────────
// Stat-mod aggregation (read by stats.js → derive() at sheet time).
// Multiplicative slots stack by product; additive slots by sum.
export function traitMods(traitIds) {
  const out = {
    hpMul: 1,
    atkMul: 1,
    defMul: 1,
    speedMul: 1,
    critAdd: 0,
    critMultAdd: 0,
    dodgeAdd: 0,
    lootQtyAdd: 0,
    lootRarityAdd: 0,
    dangerMul: 1,
    luckAdd: 0,
    // Family-specific atk multipliers compose only when the equipped
    // family matches — applied in stats.js.
    atkMulFists: 1,
    atkMulSword: 1,
    atkMulGreatsword: 1,
    atkMulDagger: 1,
    atkMulStaff: 1,
    atkMulBow: 1,
    immuneCurse: false,
  };
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    if (t.mods) {
      for (const k of Object.keys(t.mods)) {
        if (k.endsWith("Mul")) out[k] = (out[k] || 1) * t.mods[k];
        else out[k] = (out[k] || 0) + t.mods[k];
      }
    }
    if (t.immuneCurse) out.immuneCurse = true;
  }
  return out;
}

// Mood baseline + thought multipliers from the personality.
export function traitMoodProfile(traitIds) {
  let base = 0;
  let gainMul = 1;
  let lossMul = 1;
  let ignoreDeathMood = false;
  let moodPerEncounter = 0;
  let moodPotionBonus = 0;
  let moodPerRivalWin = 0;
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    base += t.moodBase || 0;
    gainMul *= t.moodGainMul || 1;
    lossMul *= t.moodLossMul || 1;
    if (t.ignoreDeathMood) ignoreDeathMood = true;
    moodPerEncounter += t.moodPerEncounter || 0;
    moodPotionBonus += t.moodPotionBonus || 0;
    moodPerRivalWin += t.moodPerRivalWin || 0;
  }
  return {
    base,
    gainMul,
    lossMul,
    ignoreDeathMood,
    moodPerEncounter,
    moodPotionBonus,
    moodPerRivalWin,
  };
}

export function traitBreakProfile(traitIds) {
  let chanceMul = 1;
  let thresholdMod = 0;
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    chanceMul *= t.breakChanceMul || 1;
    thresholdMod += t.breakThresholdMod || 0;
  }
  return { chanceMul, thresholdMod };
}

export function traitDiseaseProfile(traitIds) {
  let chance = 0;
  let resistMul = 1;
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    chance += t.diseaseChance || 0;
    resistMul *= t.diseaseResistMul || 1;
  }
  return { chance, resistMul };
}

export function traitEconomy(traitIds) {
  let xpMul = 1;
  let goldMul = 1;
  let prestigeMul = 1;
  let skillXpMul = 1;
  let restMul = 1;
  let potionHealMul = 1;
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    xpMul *= t.xpMul || 1;
    goldMul *= t.goldMul || 1;
    prestigeMul *= t.prestigeMul || 1;
    skillXpMul *= t.skillXpMul || 1;
    restMul *= t.restMul || 1;
    potionHealMul *= t.potionHealMul || 1;
  }
  return { xpMul, goldMul, prestigeMul, skillXpMul, restMul, potionHealMul };
}

// Combat-side hooks (set lookups).
export function traitFlags(traitIds) {
  const hooks = { onKill: new Set(), onHit: new Set(), onHitProc: new Set() };
  for (const id of traitIds || []) {
    const t = TRAITS[id];
    if (!t) continue;
    if (t.onKill) hooks.onKill.add(t.onKill);
    if (t.onHit) hooks.onHit.add(t.onHit);
    if (t.onHitProc) hooks.onHitProc.add(t.onHitProc);
  }
  return hooks;
}

export function traitById(id) {
  return TRAITS[id] || null;
}

export function traitNames(traitIds) {
  return (traitIds || []).map((id) => TRAITS[id]?.name).filter(Boolean);
}
