// SIGMA ABYSS — weapon families (the "class" system).
//
// SIGMA ABYSS is classless: a character is whatever weapon they wield.
// The equipped weapon's family decides scaling (which stat boosts your
// damage), which arts you unlock as you upgrade it, and how the HUD
// labels you on stream. Upgrading a weapon ("+N") multiplies its base
// power and unlocks the next art on its art ladder.
//
// Pure ESM, dual-runtime (browser + Node). No DOM, no Node built-ins.

// ── Families ──────────────────────────────────────────────────────────
//
// Each family has:
//   - `label`       human display name + class-ish identity.
//   - `color`       chip color on the arena HUD.
//   - `scaling`     map of stat → multiplier on raw attack (Elden Ring
//                   "scaling letters" in spirit; the higher the number
//                   the more that stat juices this weapon).
//   - `atkMul`      flat weapon-archetype damage multiplier.
//   - `speedMul`    swing speed (dagger fast, greatsword slow).
//   - `critMul`     bonus crit chance (additive).
//   - `arts`        ladder of named techniques unlocked by `plus` tier.
export const WEAPON_FAMILIES = {
  fists: {
    label: "Brawler",
    color: "#9ca3af",
    scaling: { str: 0.6, agi: 0.6 },
    atkMul: 0.85,
    speedMul: 1.1,
    critMul: 0.0,
    arts: [
      { plus: 3, id: "flurry", name: "Flurry", desc: "Extra rapid strike." },
      { plus: 6, id: "pressure_palm", name: "Pressure Palm", desc: "Heavy guard-break." },
    ],
  },
  sword: {
    label: "Swordsman",
    color: "#60a5fa",
    scaling: { str: 1.0, agi: 0.7 },
    atkMul: 1.0,
    speedMul: 1.0,
    critMul: 0.02,
    arts: [
      { plus: 3, id: "riposte", name: "Riposte", desc: "Counter — big follow-up." },
      { plus: 5, id: "gale_slash", name: "Gale Slash", desc: "Cuts twice on swing." },
      { plus: 8, id: "moonveil", name: "Moonveil", desc: "Ranged moonlight wave." },
    ],
  },
  greatsword: {
    label: "Warbreaker",
    color: "#f97316",
    scaling: { str: 1.4, vit: 0.5 },
    atkMul: 1.45,
    speedMul: 0.8,
    critMul: 0.0,
    arts: [
      { plus: 3, id: "quake", name: "Quake", desc: "Splash damage to foe." },
      { plus: 5, id: "meteor_slam", name: "Meteor Slam", desc: "Massive overhead." },
      { plus: 8, id: "starscourge", name: "Starscourge", desc: "Pulls foe back in — triple hit." },
    ],
  },
  dagger: {
    label: "Cutthroat",
    color: "#a855f7",
    scaling: { agi: 1.2, luck: 0.7 },
    atkMul: 0.75,
    speedMul: 1.35,
    critMul: 0.08,
    arts: [
      { plus: 3, id: "shadow_step", name: "Shadow Step", desc: "Reposition — next strike crits." },
      { plus: 5, id: "seven_fold_cut", name: "Seven-Fold Cut", desc: "Seven micro-stabs." },
      { plus: 8, id: "eclipse_dance", name: "Eclipse Dance", desc: "Two crits, no counter." },
    ],
  },
  staff: {
    label: "Sorcerer",
    color: "#22d3ee",
    scaling: { int: 1.3, luck: 0.5 },
    atkMul: 0.95,
    speedMul: 0.9,
    critMul: 0.04,
    arts: [
      { plus: 3, id: "comet", name: "Comet", desc: "Magic missile." },
      { plus: 5, id: "void_ray", name: "Void Ray", desc: "Piercing beam." },
      {
        plus: 8,
        id: "rannis_dark_moon",
        name: "Ranni's Dark Moon",
        desc: "Cold burst, slow on hit.",
      },
    ],
  },
  bow: {
    label: "Marksman",
    color: "#10b981",
    scaling: { agi: 1.1, int: 0.6 },
    atkMul: 0.9,
    speedMul: 1.15,
    critMul: 0.05,
    arts: [
      { plus: 3, id: "pierce", name: "Pierce", desc: "Armor-piercing shot." },
      { plus: 5, id: "rain_of_arrows", name: "Rain of Arrows", desc: "Volley — multi-hit." },
      {
        plus: 8,
        id: "mirage_shot",
        name: "Mirage Shot",
        desc: "Triple shot, last guaranteed crit.",
      },
    ],
  },
  hammer: {
    label: "Crusher",
    color: "#eab308",
    scaling: { str: 1.2, resolve: 0.6 },
    atkMul: 1.3,
    speedMul: 0.85,
    critMul: 0.0,
    arts: [
      { plus: 3, id: "stagger_blow", name: "Stagger Blow", desc: "Foe loses next attack." },
      { plus: 5, id: "earthshatter", name: "Earthshatter", desc: "Heavy AOE crack." },
      {
        plus: 8,
        id: "godslayer_smite",
        name: "Godslayer Smite",
        desc: "Bonus damage vs elites/bosses.",
      },
    ],
  },
  axe: {
    label: "Ravager",
    color: "#f43f5e",
    scaling: { str: 1.2, agi: 0.5 },
    atkMul: 1.2,
    speedMul: 0.95,
    critMul: 0.02,
    arts: [
      { plus: 3, id: "rend", name: "Rend", desc: "Bleed: stacking DoT (3 ticks)." },
      { plus: 5, id: "execute", name: "Execute", desc: "Bonus damage vs foes below 30% HP." },
      {
        plus: 8,
        id: "bloodfrenzy",
        name: "Blood Frenzy",
        desc: "Each bleed tick grants +8% attack for the encounter.",
      },
    ],
  },
  spear: {
    label: "Lancer",
    color: "#38bdf8",
    scaling: { agi: 1.1, str: 0.6 },
    atkMul: 1.05,
    speedMul: 1.05,
    critMul: 0.03,
    arts: [
      { plus: 3, id: "lunge", name: "Lunge", desc: "Gap-close: +25% damage on first strike." },
      { plus: 5, id: "impale", name: "Impale", desc: "Pin the foe — next two hits ignore dodge." },
      {
        plus: 8,
        id: "cyclone_thrust",
        name: "Cyclone Thrust",
        desc: "Hit all enemies in pack for full damage.",
      },
    ],
  },
  wand: {
    label: "Arcanist",
    color: "#c084fc",
    scaling: { int: 1.4, luck: 0.4 },
    atkMul: 0.88,
    speedMul: 1.0,
    critMul: 0.05,
    arts: [
      {
        plus: 3,
        id: "spell_echo",
        name: "Spell Echo",
        desc: "Chance to repeat the hit instantly.",
      },
      {
        plus: 5,
        id: "overload_surge",
        name: "Overload Surge",
        desc: "Triple the overload bonus on this swing.",
      },
      {
        plus: 8,
        id: "arcane_torrent",
        name: "Arcane Torrent",
        desc: "5 rapid arcane bolts — last is a guaranteed crit.",
      },
    ],
  },
};

export const FAMILY_IDS = Object.keys(WEAPON_FAMILIES);

// ── Base-noun → family lookup ─────────────────────────────────────────
// The loot generator picks a base noun (Cleaver, Hexblade, Coilgun…)
// and we use this map to derive its family. New noun → add an entry.
// Anything unmapped falls back to `sword` — never null, so existing
// saves don't gain a "classless" weapon.
const BASE_TO_FAMILY = {
  Fists: "fists",
  // sword-ish
  Cleaver: "sword",
  "Ruin Edge": "sword",
  Fang: "sword",
  Blade: "sword",
  // greatsword-ish
  Wrecker: "greatsword",
  Greatsword: "greatsword",
  // staff / magic
  Hexblade: "staff",
  Stave: "staff",
  // ranged
  Coilgun: "bow",
  Bow: "bow",
  Longbow: "bow",
  // hammer / blunt
  Maul: "hammer",
  Hammer: "hammer",
  // dagger
  Dagger: "dagger",
  Shiv: "dagger",
  // axe — bleed / execution
  Axe: "axe",
  Hatchet: "axe",
  Waraxe: "axe",
  // spear — momentum / reposition
  Spear: "spear",
  Glaive: "spear",
  Halberd: "spear",
  // wand — spell-echo / arcane
  Wand: "wand",
  Scepter: "wand",
  Orb: "wand",
};

export function familyForBase(baseName) {
  if (!baseName) return "sword";
  return BASE_TO_FAMILY[baseName] || "sword";
}

// ── Upgrade curve ─────────────────────────────────────────────────────
// `plus` is 0..10. Each tier multiplies the weapon's effective stats.
// The cost to step from +N → +N+1 ramps polynomially so endgame upgrades
// are real prestige money sinks rather than a trivial gold dump.
export const WEAPON_PLUS_MAX = 10;

export function plusMul(plus = 0) {
  const p = Math.max(0, Math.min(WEAPON_PLUS_MAX, plus | 0));
  return 1 + p * 0.18;
}

export function upgradeCost(plus = 0) {
  const p = Math.max(0, Math.min(WEAPON_PLUS_MAX - 1, plus | 0));
  return Math.round(60 * 1.55 ** p);
}

// ── Arts ──────────────────────────────────────────────────────────────
// Which arts are CURRENTLY unlocked on this weapon.
export function unlockedArts(family, plus = 0) {
  const fam = WEAPON_FAMILIES[family];
  if (!fam) return [];
  const ladder = fam.arts || [];
  return ladder.filter((a) => plus >= a.plus);
}

// Per-tick chance an art fires in combat. Scales with `plus` so a +8
// weapon procs a lot more than a +3.
export function artChance(plus = 0) {
  const p = Math.max(0, Math.min(WEAPON_PLUS_MAX, plus | 0));
  return Math.min(0.45, 0.08 + p * 0.035);
}

// ── Scaling resolver ──────────────────────────────────────────────────
// Apply a weapon family's scaling to a raw attack value using a stats
// sheet. Returns the family-adjusted attack contribution.
//
//   weaponAttackBonus({ str: 20, agi: 12, ... }, family, plus)
//
// Pure: depends only on its arguments.
export function weaponAttackBonus(stats, family, plus = 0) {
  const fam = WEAPON_FAMILIES[family] || WEAPON_FAMILIES.fists;
  let bonus = 0;
  for (const k of Object.keys(fam.scaling)) {
    bonus += (stats?.[k] || 0) * fam.scaling[k];
  }
  return bonus * fam.atkMul * plusMul(plus);
}

// Convenience for the HUD: short scaling badge string ("STR A · AGI C").
const SCALING_LETTERS = [
  [1.3, "S"],
  [1.0, "A"],
  [0.7, "B"],
  [0.4, "C"],
  [0.0, "D"],
];
function scalingLetter(weight) {
  for (const [t, l] of SCALING_LETTERS) if (weight >= t) return l;
  return "D";
}
export function scalingBadge(family) {
  const fam = WEAPON_FAMILIES[family];
  if (!fam) return "";
  return Object.entries(fam.scaling)
    .map(([k, w]) => `${k.toUpperCase()} ${scalingLetter(w)}`)
    .join(" · ");
}

// ── HUD label ─────────────────────────────────────────────────────────
// "Hexblade +3 · Sorcerer" — what the stream sees under @user.
export function classLabel(item) {
  if (!item) return "Brawler";
  const fam = WEAPON_FAMILIES[item.family || "fists"] || WEAPON_FAMILIES.fists;
  return fam.label;
}

export function weaponDisplay(item) {
  if (!item)
    return { base: "Bare Fists", plus: 0, family: "fists", color: WEAPON_FAMILIES.fists.color };
  const family = item.family || familyForBase(item.base);
  const fam = WEAPON_FAMILIES[family] || WEAPON_FAMILIES.fists;
  return {
    base: item.base || "Fists",
    name: item.name || item.base || "Weapon",
    plus: item.plus | 0,
    family,
    color: fam.color,
    label: fam.label,
  };
}
