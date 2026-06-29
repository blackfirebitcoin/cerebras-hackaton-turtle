// SIGMA ABYSS — procedural loot.
//
// Every drop is rolled deterministically from a passed-in RNG: a base
// item per slot, a weighted rarity, a set of affixes whose magnitude
// scales with item level, and — at Legendary and above — a named
// gameplay-altering effect. itemPower() collapses an item to one number
// so the UI can show upgrade arrows and auto-sort the stash.

import { GEAR_SLOTS, RARITIES, RARITY_AFFIXES, RARITY_RANK, RARITY_WEIGHT } from "./constants.js";
import { familyForBase } from "./weapons.js";

// ── Legendary+ effects ────────────────────────────────────────────────
// `glass` / `juggernaut` reshape the stat sheet (handled in stats.js).
// The rest are behavioural and resolved inside combat.js.
export const EFFECTS = {
  bloodthirst: { name: "Bloodthirst", desc: "Heal for a slice of all damage you deal." },
  vampire: { name: "Vampire", desc: "Heal a chunk of Max HP on every kill." },
  berserk: { name: "Berserk", desc: "The lower your HP, the harder you hit." },
  glass: { name: "Glass", desc: "+45% Attack, but -38% Max HP." },
  juggernaut: { name: "Juggernaut", desc: "+40% Max HP, but -18% Attack." },
  midas: { name: "Midas Touch", desc: "Every kill coughs up bonus gold." },
  executioner: { name: "Executioner", desc: "Huge bonus damage to low-HP foes." },
  lucky_seven: { name: "Lucky Seven", desc: "Every 7th strike is a guaranteed crit." },
  thornmail: { name: "Thornmail", desc: "Reflect a portion of damage taken." },
  second_wind: { name: "Second Wind", desc: "Once per delve, survive a lethal blow." },
};
export const EFFECT_IDS = Object.keys(EFFECTS);

// ── Word banks for procedural names ───────────────────────────────────
const BASE_NOUNS = {
  weapon: [
    // existing
    "Cleaver",
    "Hexblade",
    "Coilgun",
    "Ruin Edge",
    "Wrecker",
    "Fang",
    // axe
    "Axe",
    "Hatchet",
    "Waraxe",
    // spear
    "Spear",
    "Glaive",
    "Halberd",
    // wand
    "Wand",
    "Scepter",
    "Orb",
  ],
  armor: ["Plate", "Hauberk", "Carapace", "Trenchcoat", "Warvest", "Shroud"],
  ring: ["Band", "Signet", "Loop", "Coil", "Knuckle"],
  relic: ["Idol", "Skull", "Sigil", "Reliquary", "Effigy"],
  charm: ["Die", "Coin", "Talisman", "Token", "Trinket"],
};
const PREFIX_WORD = {
  str: "Brutal",
  agi: "Swift",
  vit: "Stalwart",
  int: "Arcane",
  resolve: "Iron",
  hp: "Vital",
  atk: "Vicious",
  def: "Bulwark",
};
const SUFFIX_WORD = {
  luck: "Fortune",
  greed: "Avarice",
  crit: "the Edge",
  critMult: "Ruin",
  speed: "Haste",
  dodge: "the Ghost",
  lootQty: "the Hoard",
  rarity: "the Jackpot",
};
// Legendary+ items get a heavier, unique-sounding title.
const MYTH_TITLES = [
  "Worldender",
  "the Last Sigma",
  "Abyssheart",
  "the Hollow Crown",
  "Doomdrinker",
  "the Final Run",
  "Kingsbane",
  "the Permadeath",
];

// ── Affix pool ────────────────────────────────────────────────────────
// `pct` affixes are fractional (crit chance, haste); the rest are flats.
const AFFIX_POOL = [
  { stat: "str", kind: "prefix", base: 2, per: 1.05 },
  { stat: "agi", kind: "prefix", base: 2, per: 1.05 },
  { stat: "vit", kind: "prefix", base: 2, per: 1.1 },
  { stat: "int", kind: "prefix", base: 2, per: 1.0 },
  { stat: "resolve", kind: "prefix", base: 2, per: 1.0 },
  { stat: "luck", kind: "suffix", base: 2, per: 0.85 },
  { stat: "greed", kind: "suffix", base: 2, per: 0.85 },
  { stat: "hp", kind: "prefix", base: 12, per: 6.5 },
  { stat: "atk", kind: "prefix", base: 3, per: 1.55 },
  { stat: "def", kind: "prefix", base: 3, per: 1.35 },
  { stat: "crit", kind: "suffix", base: 0.02, per: 0.0055, pct: true },
  { stat: "critMult", kind: "suffix", base: 0.08, per: 0.018, pct: true },
  { stat: "speed", kind: "suffix", base: 0.04, per: 0.011, pct: true },
  { stat: "dodge", kind: "suffix", base: 0.02, per: 0.0045, pct: true },
  { stat: "lootQty", kind: "suffix", base: 0.05, per: 0.018, pct: true },
  { stat: "rarity", kind: "suffix", base: 0.03, per: 0.011, pct: true },
];

// Slots bias toward thematically-fitting affixes but anything can roll.
const SLOT_BIAS = {
  weapon: ["atk", "str", "crit", "critMult"],
  armor: ["hp", "def", "vit", "resolve"],
  ring: ["crit", "speed", "agi", "int"],
  relic: ["int", "resolve", "critMult", "atk"],
  charm: ["luck", "greed", "lootQty", "rarity"],
};

function shortId(rng) {
  return rng.int(0, 0x7fffffff).toString(36);
}

// Weighted rarity pick. `bias` (zone tier + enemy bonus + player's
// lootRarity) bends the curve toward the top tiers.
export function rollRarity(rng, bias = 0) {
  const entries = RARITIES.map((r) => {
    const w = RARITY_WEIGHT[r] * (1 + bias * 0.5 * RARITY_RANK[r]);
    return [r, w];
  });
  return rng.weighted(entries);
}

function rollAffix(rng, slot, ilvl, qualityFloor) {
  // 55% chance to pull from this slot's themed shortlist.
  let pick;
  const bias = SLOT_BIAS[slot] || [];
  if (bias.length && rng.chance(0.55)) {
    const stat = rng.pick(bias);
    pick = AFFIX_POOL.find((a) => a.stat === stat) || rng.pick(AFFIX_POOL);
  } else {
    pick = rng.pick(AFFIX_POOL);
  }
  const q = Math.max(qualityFloor, rng.quality());
  let value = pick.base + pick.per * ilvl * q;
  value = pick.pct ? Math.round(value * 1000) / 1000 : Math.max(1, Math.round(value));
  return { stat: pick.stat, kind: pick.kind, value, pct: !!pick.pct };
}

// Build the display name from the item's ALREADY-ROLLED `base` noun — never
// re-roll a fresh noun here. The base drives the HUD weapon badge + family, so
// a name from a different noun (a "Hexblade" base shown as "Vicious Coilgun")
// makes the item impossible to recognise across surfaces. Same noun everywhere.
function nameFor(base, rarity, affixes, rng) {
  const noun = base || "Relic";
  if (RARITY_RANK[rarity] >= RARITY_RANK.legendary) {
    return `${noun}, ${rng.pick(MYTH_TITLES)}`;
  }
  const pre = affixes.find((a) => a.kind === "prefix" && PREFIX_WORD[a.stat]);
  const suf = affixes.find((a) => a.kind === "suffix" && SUFFIX_WORD[a.stat]);
  let name = noun;
  if (pre) name = `${PREFIX_WORD[pre.stat]} ${name}`;
  if (suf) name = `${name} of ${SUFFIX_WORD[suf.stat]}`;
  return name;
}

// The starter weapon every fresh run equips. Common, zero affixes, zero
// power → it contributes nothing to derive() (mods.atk stays 0, so the
// fighter's attack still resolves through atkBase + str·atkPerStr). The
// point is presence: chatters now SEE a weapon in their gear slot
// instead of an empty fist, and !loot/!sigma can name what they're
// holding. Item power stays 0 so it cannot displace real loot.
export function bareFists() {
  return {
    id: "starter-fists",
    slot: "weapon",
    base: "Fists",
    rarity: "common",
    ilvl: 1,
    affixes: [],
    effect: null,
    name: "Bare Fists",
    power: 0,
    value: 0,
    starter: true,
    family: "fists",
    plus: 0,
  };
}

// Build one concrete item.
export function makeItem({ slot, rarity, ilvl, rng }) {
  const rank = RARITY_RANK[rarity];
  const affixCount = RARITY_AFFIXES[rarity];
  const qualityFloor = Math.min(0.85, rank * 0.12);
  const affixes = [];
  for (let i = 0; i < affixCount; i++) {
    affixes.push(rollAffix(rng, slot, ilvl, qualityFloor));
  }
  // Legendary+ rolls a behavioural effect.
  let effect = null;
  if (rank >= RARITY_RANK.legendary) {
    effect = rng.pick(EFFECT_IDS);
  }
  const base = rng.pick(BASE_NOUNS[slot] || ["Relic"]);
  const item = {
    id: `${slot}-${rarity}-${shortId(rng)}`,
    slot,
    base,
    rarity,
    ilvl,
    affixes,
    effect,
    name: nameFor(base, rarity, affixes, rng),
    // Economy/binding (master §3.6): RNG drops are freely tradeable; crafted
    // + faction-exclusive items are bound by the server. setId null unless the
    // drop belongs to a faction set.
    bound: "unbound",
    setId: null,
  };
  if (slot === "weapon") {
    item.family = familyForBase(base);
    item.plus = 0;
  }
  item.power = itemPower(item);
  item.value = sellValue(item);
  return item;
}

// Reroll ONE affix on an existing item (the §3.2 rune-crafting action).
// Picks a random affix to regenerate (or adds the first if the item has
// none), then recomputes power + value. Pure: the caller supplies the rng
// — the server passes a server-only rng so this never touches run.rngState
// (account-side action, offline-sim-safe). Returns {affix, index} or null.
export function rerollOneAffix(item, rng) {
  if (!item?.slot) return null;
  const rank = RARITY_RANK[item.rarity] || 0;
  const qualityFloor = Math.min(0.85, rank * 0.12);
  if (!Array.isArray(item.affixes)) item.affixes = [];
  const affixes = item.affixes;
  const fresh = rollAffix(rng, item.slot, item.ilvl || 1, qualityFloor);
  let index;
  if (affixes.length === 0) {
    affixes.push(fresh);
    index = 0;
  } else {
    index = rng.int(0, affixes.length - 1);
    affixes[index] = fresh;
  }
  item.power = itemPower(item);
  item.value = sellValue(item);
  return { affix: fresh, index };
}

// One drop. Random slot unless pinned.
export function rollDrop({ rng, level, depth = 0, bias = 0, slot = null }) {
  const s = slot || rng.pick(GEAR_SLOTS);
  const rarity = rollRarity(rng, bias);
  const ilvl = Math.max(1, Math.round(level + depth * 0.6 + bias * 1.5 + rng.float(-1, 2)));
  return makeItem({ slot: s, rarity, ilvl, rng });
}

// Collapse an item to a single comparable number (UI arrows + auto-sort).
const POWER_WEIGHT = {
  str: 2.2,
  agi: 2.2,
  vit: 2.0,
  int: 2.0,
  resolve: 2.0,
  luck: 1.8,
  greed: 1.6,
  hp: 0.45,
  atk: 1.7,
  def: 1.3,
  crit: 220,
  critMult: 90,
  speed: 140,
  dodge: 200,
  lootQty: 70,
  rarity: 130,
};
export function itemPower(item) {
  if (!item) return 0;
  let p = (RARITY_RANK[item.rarity] || 0) * 14;
  for (const a of item.affixes || []) {
    p += (a.value || 0) * (POWER_WEIGHT[a.stat] || 1);
  }
  if (item.effect) p += 40;
  if (item.slot === "weapon" && item.plus) p += item.plus * 18;
  return Math.round(p);
}

export function sellValue(item) {
  if (!item) return 0;
  const rank = RARITY_RANK[item.rarity] || 0;
  const affixN = (item.affixes || []).length;
  return Math.max(
    1,
    Math.round((item.ilvl + rank * 9) * (1 + affixN * 0.55) + (item.effect ? 60 : 0)),
  );
}

// Positive → `a` is the upgrade over `b` for that slot.
export function comparePower(a, b) {
  return itemPower(a) - itemPower(b);
}

// ── Raid boss drops ──────────────────────────────────────────────────
// One hand-authored item per spawnable boss. The last-hit chatter gets
// this guaranteed when the shared raid HP falls to 0 (see endRaid in
// server.js). Slots are spread across the gear grid so consecutive
// boss kills don't all land in the same slot.
export const RAID_BOSS_DROPS = {
  goblin_king: {
    name: "Crown of the Goblin King",
    base: "Crown",
    slot: "relic",
    rarity: "mythic",
    effect: "midas",
    flavor: "Stolen from the throne of greed itself.",
    affixes: [
      { stat: "luck", kind: "suffix", value: 18, pct: false },
      { stat: "greed", kind: "suffix", value: 22, pct: false },
      { stat: "lootQty", kind: "suffix", value: 0.24, pct: true },
      { stat: "rarity", kind: "suffix", value: 0.2, pct: true },
      { stat: "crit", kind: "suffix", value: 0.08, pct: true },
    ],
  },
  hollow_druid: {
    name: "Druid's Curse",
    base: "Stave",
    slot: "weapon",
    rarity: "mythic",
    effect: "bloodthirst",
    flavor: "A staff that feeds on what it slays.",
    affixes: [
      { stat: "int", kind: "prefix", value: 24, pct: false },
      { stat: "atk", kind: "prefix", value: 32, pct: false },
      { stat: "critMult", kind: "suffix", value: 0.5, pct: true },
      { stat: "speed", kind: "suffix", value: 0.18, pct: true },
      { stat: "resolve", kind: "prefix", value: 16, pct: false },
    ],
  },
  chrome_centurion: {
    name: "Chrome Carapace",
    base: "Carapace",
    slot: "armor",
    rarity: "mythic",
    effect: "juggernaut",
    flavor: "Forged from the centurion's broken shell.",
    affixes: [
      { stat: "vit", kind: "prefix", value: 26, pct: false },
      { stat: "def", kind: "prefix", value: 36, pct: false },
      { stat: "hp", kind: "prefix", value: 280, pct: false },
      { stat: "resolve", kind: "prefix", value: 20, pct: false },
      { stat: "dodge", kind: "suffix", value: 0.1, pct: true },
    ],
  },
  catacomb_tyrant: {
    name: "Tyrant's Signet",
    base: "Signet",
    slot: "ring",
    rarity: "mythic",
    effect: "executioner",
    flavor: "A ring that smells of old crowns and curses.",
    affixes: [
      { stat: "str", kind: "prefix", value: 24, pct: false },
      { stat: "crit", kind: "suffix", value: 0.16, pct: true },
      { stat: "critMult", kind: "suffix", value: 0.6, pct: true },
      { stat: "speed", kind: "suffix", value: 0.16, pct: true },
      { stat: "atk", kind: "prefix", value: 24, pct: false },
    ],
  },
  hollow_sigma: {
    name: "Hollow Sigma's Sigil",
    base: "Sigil",
    slot: "charm",
    rarity: "oneofone",
    effect: "lucky_seven",
    flavor: "The mark of the one who outlived everyone.",
    affixes: [
      { stat: "luck", kind: "suffix", value: 32, pct: false },
      { stat: "greed", kind: "suffix", value: 32, pct: false },
      { stat: "rarity", kind: "suffix", value: 0.32, pct: true },
      { stat: "lootQty", kind: "suffix", value: 0.32, pct: true },
      { stat: "crit", kind: "suffix", value: 0.12, pct: true },
      { stat: "critMult", kind: "suffix", value: 0.6, pct: true },
    ],
  },
};

// Forge the guaranteed last-hit item for a raid boss. Scales item level
// off the killer so a fresh L1 chatter doesn't get a too-powerful piece
// (still rare/strong, but the affixes ride a sensible ilvl).
export function forgeRaidDrop(bossId, killerLevel = 1) {
  const def = RAID_BOSS_DROPS[bossId];
  if (!def) return null;
  const ilvl = Math.max(15, Math.round(Math.max(1, killerLevel) * 1.5 + 8));
  const item = {
    id: `raid-${bossId}-${Date.now().toString(36)}`,
    slot: def.slot,
    base: def.base,
    rarity: def.rarity,
    ilvl,
    affixes: def.affixes.map((a) => ({ ...a })),
    effect: def.effect,
    name: def.name,
    flavor: def.flavor,
    raidDrop: bossId,
  };
  if (def.slot === "weapon") {
    item.family = familyForBase(def.base);
    // Raid weapons drop pre-upgraded so the boss kill feels like a real
    // class unlock, not just another piece of trash to fold.
    item.plus = 3;
  }
  item.power = itemPower(item);
  // Raid drops vendor for double so a duplicate is still meaningful.
  item.value = sellValue(item) * 2;
  return item;
}

// Human-readable affix line, e.g. "+14 Strength" / "+6.2% Crit".
const AFFIX_LABEL = {
  str: "Strength",
  agi: "Agility",
  vit: "Vitality",
  int: "Intellect",
  resolve: "Resolve",
  luck: "Luck",
  greed: "Greed",
  hp: "Max HP",
  atk: "Attack",
  def: "Defense",
  crit: "Crit Chance",
  critMult: "Crit Power",
  speed: "Haste",
  dodge: "Evasion",
  lootQty: "Loot Quantity",
  rarity: "Loot Fortune",
};
export function affixText(a) {
  if (!a) return "";
  const label = AFFIX_LABEL[a.stat] || a.stat;
  if (a.pct) return `+${(a.value * 100).toFixed(1)}% ${label}`;
  return `+${a.value} ${label}`;
}
