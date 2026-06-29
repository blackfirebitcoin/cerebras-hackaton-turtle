// Vibe Coder Sim — Royale High cosmetics visual spec
// Maps item_key → render config used by avatar.js / particles.js.

export const RARITY_COLOR = {
  common: "#c8d8e8",
  rare: "#a78bfa",
  royal: "#fcd34d",
  mythic: "#f472b6",
};

// Auras are animated in avatar.js drawAura(): `pulseMs` drives the breathing
// radial glow, `spin` (radians/ms) drives the rotating conic light sweep, and
// `rings` is how many expanding pulse-rings ripple outward. Higher tiers get
// faster spin + more rings so rarity reads at a glance.
export const AURA_CONFIG = {
  aura_bronze: { color: "#cd7f32", glow: 14, alpha: 0.28, pulseMs: 2200, spin: 0, rings: 0 },
  aura_silver: { color: "#c0c0c0", glow: 16, alpha: 0.32, pulseMs: 2000, spin: 0.00018, rings: 0 },
  aura_royal: { color: "#fcd34d", glow: 20, alpha: 0.42, pulseMs: 1700, spin: 0.0004, rings: 1 },
  aura_diamond: { color: "#67e8f9", glow: 24, alpha: 0.5, pulseMs: 1400, spin: 0.00072, rings: 2 },
  aura_mythic: { color: "#f472b6", glow: 32, alpha: 0.62, pulseMs: 1050, spin: 0.0011, rings: 3 },
};

export const HEAD_CONFIG = {
  bow_giant: { color: "#f9a8d4", accent: "#fbcfe8", size: 1.2, shape: "bow" },
  halo_angel: { color: "#fef9c3", accent: "#fde68a", size: 1.1, shape: "halo" },
  antlers_pastel: { color: "#d1fae5", accent: "#a7f3d0", size: 1.3, shape: "antlers" },
  crown_sun: { color: "#fcd34d", accent: "#f59e0b", size: 1.2, shape: "crown" },
  crown_moon: { color: "#c4b5fd", accent: "#8b5cf6", size: 1.2, shape: "crown" },
  unicorn_horn: { color: "#fbcfe8", accent: "#f9a8d4", size: 1.15, shape: "horn" },
  tiara_rose: { color: "#fda4af", accent: "#fb7185", size: 1.05, shape: "tiara" },
  tiara_diamond: { color: "#bae6fd", accent: "#38bdf8", size: 1.1, shape: "tiara", shimmer: true },
  // SIGMA ABYSS warrior helms + masc-coded hats — rendered via LPC_HEAD_HAT
  // below as real layered sprites, so the procedural fallback below is only
  // used by non-LPC renderers (overlay tiles, etc.).
  hat_tophat: { color: "#1a1a1a", accent: "#374151", size: 1.2, shape: "crown" },
  helm_legion: { color: "#94a3b8", accent: "#475569", size: 1.2, shape: "crown" },
  hat_pirate: { color: "#1f2937", accent: "#fbbf24", size: 1.25, shape: "crown" },
  hat_wizard: { color: "#1e1b4b", accent: "#a78bfa", size: 1.3, shape: "horn" },
  helm_viking: { color: "#a8a29e", accent: "#78716c", size: 1.3, shape: "antlers" },
  helm_barbarian: { color: "#78350f", accent: "#fbbf24", size: 1.3, shape: "crown" },
  helm_armet: { color: "#e2e8f0", accent: "#94a3b8", size: 1.2, shape: "crown", shimmer: true },
};

export const WINGS_CONFIG = {
  cape_velvet: { color: "#7c3aed", accent: "#a78bfa", spread: 0.8, shape: "cape" },
  wings_fairy: { color: "#bbf7d0", accent: "#86efac", spread: 1.2, shape: "wings", flap: true },
  wings_butterfly: {
    color: "#fde68a",
    accent: "#fbbf24",
    spread: 1.3,
    shape: "butterfly",
    flap: true,
  },
  train_silk: { color: "#fce7f3", accent: "#fbcfe8", spread: 0.9, shape: "train" },
  wings_angel: {
    color: "#f0fdf4",
    accent: "#bbf7d0",
    spread: 1.5,
    shape: "wings",
    flap: true,
    glow: "#ffffff",
  },
  wings_demon: {
    color: "#1e1b4b",
    accent: "#7c3aed",
    spread: 1.4,
    shape: "bat",
    flap: true,
    glow: "#7c3aed",
  },
  // SIGMA ABYSS battle cloaks — heavy capes layered over the masc body.
  cape_warlord: { color: "#7f1d1d", accent: "#fca5a5", spread: 1.0, shape: "cape" },
  cape_dragonhide: {
    color: "#b91c1c",
    accent: "#fbbf24",
    spread: 1.1,
    shape: "cape",
    glow: "#f59e0b",
  },
};

export const DRESS_CONFIG = {
  minigown_pastel: { primary: "#fce7f3", secondary: "#fbcfe8", cut: "mini" },
  uniform_school: { primary: "#dbeafe", secondary: "#93c5fd", cut: "midi", collar: true },
  fairy_dew: { primary: "#d1fae5", secondary: "#a7f3d0", cut: "fairy", shimmer: true },
  ballgown_mint: { primary: "#d1fae5", secondary: "#6ee7b7", cut: "ball" },
  pastelgoth: { primary: "#1e1b4b", secondary: "#c4b5fd", cut: "midi", dark: true },
  ballgown_rose: { primary: "#fce7f3", secondary: "#fda4af", cut: "ball", shimmer: true },
  princess_gold: {
    primary: "#fef3c7",
    secondary: "#fcd34d",
    cut: "ball",
    shimmer: true,
    tiara_match: true,
  },
  cyber_neon: { primary: "#0f172a", secondary: "#22d3ee", cut: "mini", neon: true },
};

export const ACCESS_CONFIG = {
  fan_lace: { color: "#fce7f3", size: 0.9, shape: "fan" },
  parasol_sun: { color: "#fef08a", accent: "#fde047", size: 1.0, shape: "parasol" },
  scepter_jewel: { color: "#fcd34d", accent: "#f59e0b", size: 1.1, shape: "scepter" },
  choker_pearl: { color: "#f0fdf4", size: 0.8, shape: "choker" },
  glasses_star: { color: "#fde68a", size: 0.85, shape: "star_glasses" },
  // SIGMA ABYSS weapons + shields — drawn procedurally by the held-prop
  // branch of drawAccessoryProp / drawLpcWeapon. No LPC weapon spritesheet
  // is synced yet (vendor/lpc-generator/spritesheets/weapon/ has them but
  // they're outside the synced subset).
  sword_iron: { color: "#cbd5e1", accent: "#64748b", size: 1.1, shape: "sword" },
  shield_buckler: { color: "#92400e", accent: "#a16207", size: 0.9, shape: "shield" },
  axe_battle: { color: "#9ca3af", accent: "#451a03", size: 1.15, shape: "axe" },
  shield_kite: { color: "#1e40af", accent: "#fcd34d", size: 1.05, shape: "shield" },
  sword_legendary: {
    color: "#fcd34d",
    accent: "#fef08a",
    size: 1.25,
    shape: "sword",
    glow: "#fde047",
  },
  runeblade: {
    color: "#a78bfa",
    accent: "#67e8f9",
    size: 1.3,
    shape: "sword",
    glow: "#a78bfa",
    shimmer: true,
  },
};

export const COMPANION_CONFIG = {
  kitten_pastel: { body: "#fce7f3", accent: "#fda4af", size: 0.6, kind: "cat" },
  puppy_pearl: { body: "#f0fdf4", accent: "#bbf7d0", size: 0.65, kind: "dog" },
  wolf_dire: { body: "#6b7280", accent: "#374151", size: 0.75, kind: "dog" },
  dragon_baby: { body: "#86efac", accent: "#4ade80", size: 0.7, kind: "dragon" },
  sparkle_orb: { body: "#f472b6", accent: "#ffffff", size: 0.55, kind: "orb", glow: true },
};

export const TRAIL_CONFIG = {
  trail_sparkle: { kind: "sparkle", color: "#fcd34d", rate: 6, ttl: 900 },
  trail_hearts: { kind: "heart", color: "#fda4af", rate: 4, ttl: 1200 },
  trail_rose: { kind: "sparkle", color: "#fb7185", rate: 5, ttl: 1000 },
  trail_starlight: { kind: "shimmer", color: "#bae6fd", rate: 8, ttl: 800 },
  trail_aurora: { kind: "glamburst", color: "#a78bfa", rate: 10, ttl: 700 },
};

export const POSE_CONFIG = {
  pose_curtsy: { id: "curtsy", frames: 6 },
  pose_finger_gun: { id: "finger_gun", frames: 4 },
  pose_twirl: { id: "twirl", frames: 8, loop: true },
  pose_flex: { id: "flex", frames: 4 },
  pose_warcry: { id: "warcry", frames: 6 },
};

export function getConfig(slot, key) {
  const tables = {
    head: HEAD_CONFIG,
    wings: WINGS_CONFIG,
    dress: DRESS_CONFIG,
    accessory: ACCESS_CONFIG,
    companion: COMPANION_CONFIG,
    trail: TRAIL_CONFIG,
    pose: POSE_CONFIG,
    aura: AURA_CONFIG,
  };
  return tables[slot]?.[key] ?? null;
}

export const SLOT_DRAW_ORDER = [
  "aura",
  "wings",
  "dress",
  "head",
  "accessory",
  "companion",
  "trail",
  "pose",
];

export const SOURCE_COLOR = {
  twitch: "#a370f7",
  youtube: "#ff6666",
  discord: "#7f8aff",
};

// Rarity → gradient stop list for cosmetic shimmer effects.
export const RARITY_GRADIENT = {
  common: ["#c8d8e8", "#e8f4f8"],
  rare: ["#a78bfa", "#c4b5fd"],
  royal: ["#fcd34d", "#fef3c7"],
  mythic: ["#f472b6", "#fb7185", "#fda4af"],
};

// Client-side mirror of the server Catalog rarities. avatar.js uses this to
// pick the avatar's "showcase rarity" (its highest-rarity equipped cosmetic)
// and drive the rarity glow halo — keeps the loadout transport key-only.
export const ITEM_RARITY = {
  // head
  bow_giant: "common",
  halo_angel: "rare",
  antlers_pastel: "rare",
  crown_sun: "royal",
  crown_moon: "royal",
  unicorn_horn: "royal",
  tiara_rose: "rare",
  tiara_diamond: "mythic",
  hat_tophat: "common",
  helm_legion: "rare",
  hat_pirate: "rare",
  hat_wizard: "rare",
  helm_viking: "royal",
  helm_barbarian: "royal",
  helm_armet: "mythic",
  // wings
  cape_velvet: "common",
  wings_fairy: "rare",
  wings_butterfly: "rare",
  train_silk: "royal",
  wings_angel: "royal",
  wings_demon: "royal",
  cape_warlord: "common",
  cape_dragonhide: "royal",
  // dress
  minigown_pastel: "common",
  uniform_school: "common",
  fairy_dew: "rare",
  ballgown_mint: "rare",
  pastelgoth: "royal",
  ballgown_rose: "royal",
  princess_gold: "mythic",
  cyber_neon: "mythic",
  // accessory
  choker_pearl: "common",
  glasses_star: "common",
  fan_lace: "common",
  parasol_sun: "rare",
  scepter_jewel: "royal",
  sword_iron: "common",
  shield_buckler: "common",
  axe_battle: "rare",
  shield_kite: "rare",
  sword_legendary: "royal",
  runeblade: "mythic",
  // companion
  kitten_pastel: "common",
  puppy_pearl: "common",
  wolf_dire: "rare",
  dragon_baby: "royal",
  sparkle_orb: "mythic",
  // trail
  trail_sparkle: "common",
  trail_hearts: "rare",
  trail_rose: "rare",
  trail_starlight: "royal",
  trail_aurora: "mythic",
  // pose
  pose_curtsy: "common",
  pose_finger_gun: "common",
  pose_flex: "common",
  pose_warcry: "rare",
  pose_twirl: "royal",
  // aura (tier-granted)
  aura_bronze: "common",
  aura_silver: "common",
  aura_royal: "rare",
  aura_diamond: "royal",
  aura_mythic: "mythic",
};

// Rarity glow-halo tuning for avatar.js drawRarityHalo(). `glow` is the base
// shadowBlur radius, `alpha` the halo opacity, `pulseMs` the breathing speed.
// `common` is intentionally absent — common cosmetics get no halo.
export const RARITY_GLOW = { rare: 11, royal: 19, mythic: 32 };
export const RARITY_HALO_ALPHA = { rare: 0.5, royal: 0.72, mythic: 0.95 };
export const RARITY_PULSE_MS = { rare: 1600, royal: 1250, mythic: 950 };

// ════════════════════════════════════════════════════════════════════
//  LPC RENDERER BRIDGE
//
//  Maps the catalog above (the Royale-High cosmetic keys) onto the layered
//  Universal-LPC paperdoll assets in client/assets/lpc/. Consumed by
//  lpc-avatar.js. The catalog keys never change — only what they render as —
//  so every existing save keeps every cosmetic it earned with zero migration.
// ════════════════════════════════════════════════════════════════════

import { nearestRampName } from "./lpc-recolor.js";

// catalog key → LPC asset id (see client/avatar/lpc-manifest.js)
const LPC_HAIR = {
  short: "hair_plain",
  long: "hair_long",
  bob: "hair_bob",
  ponytail: "hair_ponytail",
  spiky: "hair_spiked",
  afro: "hair_afro",
  pixie: "hair_pixie",
  idol: "hair_idol",
  lob: "hair_lob",
  swoop: "hair_swoop",
  curly: "hair_curly",
  bedhead: "hair_bedhead",
  curtains: "hair_curtains",
  buzzcut: "hair_buzzcut",
  halfup: "hair_halfup",
  braid: "hair_braid",
  bunches: "hair_bunches",
  wavy: "hair_wavy",
  cornrows: "hair_cornrows",
  dreads: "hair_dreads",
  dreadslong: "hair_dreadslong",
  halfmessy: "hair_halfmessy",
  bangs: "hair_bangs",
  longhawk: "hair_longhawk",
  balding: "hair_balding",
};
const LPC_HAT = {
  cap: "hat_cap",
  beanie: "hat_beanie",
  tophat: "hat_tophat",
  cowboy: "hat_bowler",
  wizard: "hat_wizard",
  bare: null,
  hood: "hat_hood",
  santa: "hat_santa",
  pirate: "hat_pirate",
  headband: "hat_headband",
  visor: "hat_visor",
  elf: "hat_elf",
  viking: "hat_helmviking",
  barbarian: "hat_helmbarbarian",
  morion: "hat_helmmorion",
  kettle: "hat_helmkettle",
  legion: "hat_helmlegion",
  norman: "hat_helmnorman",
  armet: "hat_helmarmet",
  celestial: "hat_magicceles",
  magiclarge: "hat_magiclarge",
};
const LPC_BEARD = {
  "5oclock": "beard_5oclock",
  basic: "beard_basic",
  medium: "beard_medium",
  trimmed: "beard_trimmed",
  mustache: "mustache_basic",
  handlebar: "mustache_handlebar",
  walrus: "mustache_walrus",
};
const LPC_GLASSES = {
  clear: "glasses_clear",
  sun: "glasses_sun",
  shades: "glasses_shades",
  nerd: "glasses_nerd",
  round: "glasses_round",
  monocle: "glasses_monocle",
  eyepatch: "glasses_eyepatch",
};
const LPC_EYEBROWS = { thick: "eyebrows_thick", thin: "eyebrows_thin" };
const LPC_SHIRT_STYLE = {
  longsleeve: "shirt_basic",
  shortsleeve: "shirt_shortsleeve",
  sleeveless: "shirt_sleeveless",
  vest: "shirt_vest",
};
const LPC_PANTS_STYLE = {
  pants: "pants_basic",
  shorts: "pants_shorts",
  shortshorts: "pants_shortshorts",
  leggings: "pants_leggings",
  pantaloons: "pants_pantaloons",
  formal: "pants_formal",
};
const LPC_SHOES_STYLE = {
  basic: "shoes_basic",
  boots: "shoes_boots",
  sandals: "shoes_sandals",
  slippers: "shoes_slippers",
};
const LPC_PANTS_STYLE_SKIRT = {
  skirt: "pants_skirt",
  legionskirt: "pants_legionskirt",
};
const LPC_JACKET = {
  collared: "jacket_collared",
  frock: "jacket_frock",
  trench: "jacket_trench",
  tabard: "jacket_tabard",
  santa: "jacket_santa",
};
const LPC_SHOULDERS = {
  pauldrons: "shoulders_pauldrons",
  bauldron: "shoulders_bauldron",
  epaulets: "shoulders_epaulets",
  mantal: "shoulders_mantal",
};
const LPC_BRACERS = { basic: "bracers_basic" };
const LPC_NECK = {
  chain: "neck_chain",
  beaded: "neck_beaded",
  cross: "neck_cross",
  star: "neck_star",
  scarf: "neck_scarf",
};
const LPC_BACKPACK = { basic: "backpack_basic" };
// HEAD cosmetics LPC renders as a real hat layer; the rest stay procedural props.
const LPC_HEAD_HAT = {
  crown_sun: "hat_crown",
  crown_moon: "hat_crown_moon",
  tiara_rose: "hat_tiara_rose",
  tiara_diamond: "hat_tiara",
  // SIGMA ABYSS masc head gear — each maps to a synced LPC hat sheet
  // (see /assets/lpc/ — hat_helm*, hat_tophat, hat_pirate, hat_wizard).
  hat_tophat: "hat_tophat",
  hat_pirate: "hat_pirate",
  hat_wizard: "hat_wizard",
  helm_legion: "hat_helmlegion",
  helm_viking: "hat_helmviking",
  helm_barbarian: "hat_helmbarbarian",
  helm_armet: "hat_helmarmet",
};
export const LPC_HEAD_KEYS = new Set(Object.keys(LPC_HEAD_HAT));
const LPC_WINGS = {
  wings_angel: "wings_feathered",
  wings_demon: "wings_bat",
  wings_butterfly: "wings_monarch",
  wings_fairy: "wings_pixie",
  cape_velvet: "cape_solid",
  train_silk: "cape_silk",
  // SIGMA ABYSS battle cloaks reuse the cape_solid sheet (the LPC subset
  // only ships the one cape sprite). Color comes from WINGS_CONFIG which
  // the procedural overlay tints; LPC paperdoll picks it up later when
  // the cape_solid sheet variants are synced.
  cape_warlord: "cape_warlord",
  cape_dragonhide: "cape_dragonhide",
};
// ── equipped weapon → held blade layer ────────────────────────────────
// The character's EQUIPPED weapon (run.gear.weapon, a shared/weapons.js
// family) renders as a real LPC weapon that swings with the body's slash/
// thrust frames — previously nothing drew it, so sigmas fought bare-handed
// on screen. Each melee family maps to a synced LPC weapon sheet
// (see lpc-manifest.js) and a recolour so the class reads at a glance:
//   sword      → longsword, bright steel        (big, clearly visible)
//   greatsword → longsword, dark heavy steel
//   dagger     → dagger,    pale short blade
//   hammer     → war axe,   walnut/bronze crusher
//   staff      → arcane staff, violet glow       (Sorcerer / Hexblade)
//   bow        → wooden bow                       (Marksman / Coilgun)
// Only `fists` is absent — bare fists ARE empty hands. Every other family has a
// synced sprite so any looted weapon (incl. an auto-equipped legendary) shows.
const LPC_WEAPON_BY_FAMILY = {
  sword: { assetId: "weapon_longsword", recolor: null }, // bright steel
  dagger: { assetId: "weapon_blade", recolor: { material: "cloth", ramp: "slate" } }, // pale short blade
  greatsword: { assetId: "weapon_longsword", recolor: { material: "cloth", ramp: "charcoal" } }, // dark heavy steel
  hammer: { assetId: "weapon_axe", recolor: { material: "cloth", ramp: "walnut" } }, // bronze / wood crusher
  staff: { assetId: "weapon_staff", recolor: { material: "cloth", ramp: "purple" } }, // arcane staff
  bow: { assetId: "weapon_bow", recolor: { material: "cloth", ramp: "walnut" } }, // wooden bow
  // Project Ascendant: 3 new families
  axe: { assetId: "weapon_axe", recolor: { material: "cloth", ramp: "crimson" } }, // blood-red axe
  spear: { assetId: "weapon_spear", recolor: null }, // steel spear
  wand: { assetId: "weapon_wand", recolor: { material: "cloth", ramp: "violet" } }, // violet wand
};
// A legendary-or-better weapon overrides the family tint with a gold blaze.
const LPC_WEAPON_RARITY_TINT = { material: "hair", ramp: "gold" };
const LPC_WEAPON_GOLD_RARITY = new Set(["legendary", "mythic", "oneofone"]);
function weaponBladeLayer(weapon) {
  if (!weapon) return null;
  const fam = weapon.family || "fists";
  const spec = LPC_WEAPON_BY_FAMILY[fam];
  if (!spec) return null; // fists → bare-handed sprite
  const recolor = LPC_WEAPON_GOLD_RARITY.has(weapon.rarity) ? LPC_WEAPON_RARITY_TINT : spec.recolor;
  return { assetId: spec.assetId, recolor };
}

// ── store-bought accessory weapons → the SAME in-hand LPC sprite ──────
// The SIGMA ABYSS warrior gear sold in the cosmetic shop (Catalog `accessory`
// slot) used to draw as procedural canvas props. Each now maps to a real
// equippable LPC sprite layer so a bought weapon/shield reads identically to a
// looted combat weapon. These keys are SKIPPED by drawLpcProps (no procedural
// prop) and pushed as a render layer by lpcBuild.
const LPC_ACCESSORY_WEAPON = {
  sword_iron: { assetId: "weapon_longsword", recolor: null }, // bright steel
  sword_legendary: { assetId: "weapon_longsword", recolor: LPC_WEAPON_RARITY_TINT }, // gold blaze
  axe_battle: { assetId: "weapon_axe", recolor: { material: "cloth", ramp: "walnut" } }, // bronze / wood
  runeblade: { assetId: "weapon_glowsword", recolor: { material: "cloth", ramp: "purple" } }, // arcane glow
  shield_buckler: { assetId: "shield_round", recolor: null }, // silver round shield
  shield_kite: { assetId: "shield_kite", recolor: null }, // gray kite shield
};
// Accessory keys now rendered as a real LPC layer (drawLpcProps skips its prop).
export const LPC_ACCESSORY_KEYS = new Set(Object.keys(LPC_ACCESSORY_WEAPON));
function accessoryWeaponLayer(key) {
  const spec = key && LPC_ACCESSORY_WEAPON[key];
  return spec ? { assetId: spec.assetId, recolor: spec.recolor } : null;
}

// each catalog dress maps to its own {cut × colour} LPC asset (lpc-manifest.js)
const LPC_DRESS = {
  minigown_pastel: "dress_minigown_pastel",
  uniform_school: "dress_uniform_school",
  fairy_dew: "dress_fairy_dew",
  ballgown_mint: "dress_ballgown_mint",
  pastelgoth: "dress_pastelgoth",
  ballgown_rose: "dress_ballgown_rose",
  princess_gold: "dress_princess_gold",
  cyber_neon: "dress_cyber_neon",
};

// ── colour resolution ─────────────────────────────────────────────────
const COLOR_PRESETS = {
  pale: "#f8d7b6",
  fair: "#f0c8a0",
  tan: "#d4a368",
  olive: "#b08560",
  brown: "#8b5a3c",
  deep: "#5a3a26",
  black: "#1a1a1a",
  blonde: "#e8c994",
  auburn: "#a04a1e",
  ginger: "#cc6633",
  silver: "#c8c8c8",
  white: "#f5f5f5",
  red: "#e74c3c",
  blue: "#3498db",
  green: "#2ecc71",
  yellow: "#f1c40f",
  orange: "#e67e22",
  purple: "#9b59b6",
  pink: "#ff66cc",
  cyan: "#1abc9c",
  navy: "#2c3e50",
  mint: "#a3e4d7",
  gray: "#7f8c8d",
  maroon: "#800000",
  teal: "#16a085",
  gold: "#d4af37",
  lime: "#a3ff00",
  magenta: "#d63384",
};
function resolveColor(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s) || /^#[0-9a-f]{3}$/.test(s)) return s;
  return COLOR_PRESETS[s] || null;
}
// Deterministic per-seed default ramp when a chatter never set an explicit colour.
const SKIN_RAMPS = ["light", "amber", "olive", "taupe", "bronze", "brown"];
const HAIR_RAMPS = [
  "dark_brown",
  "black",
  "chestnut",
  "blonde",
  "redhead",
  "raven",
  "light_brown",
  "dark_gray",
];
const SHIRT_RAMPS = [
  "blue",
  "red",
  "green",
  "purple",
  "teal",
  "orange",
  "maroon",
  "slate",
  "gold",
  "navy",
];
const PANTS_RAMPS = ["brown", "walnut", "charcoal", "navy", "slate", "gray", "leather"];
function seedRamp(seed, salt, list) {
  return list[Math.abs(((seed | 0) * salt) >>> 0) % list.length];
}
// A chatter's colour → LPC ramp name: explicit catalog colour wins, else seeded.
function rampFor(explicit, material, seed, salt, defaults) {
  const hex = resolveColor(explicit);
  if (hex) return nearestRampName(hex, material);
  return seedRamp(seed, salt, defaults);
}
// Optional cloth recolour for the over-shirt slots (jacket / shoulders /
// shoes / bracers / neck). Returns a recolour descriptor ONLY when the
// chatter set an explicit colour — the layer otherwise keeps its pre-baked
// LPC variant. recolorCanvas() remaps any sprite's luminance ramp, so these
// pre-coloured assets recolour cleanly with no recolorable-cut asset needed.
function clothRecolor(explicit) {
  const hex = resolveColor(explicit);
  return hex ? { material: "cloth", ramp: nearestRampName(hex, "cloth") } : null;
}

// ── lpcBuild: a pet's cosmetics → ordered LPC render layers ───────────
// Returns [{ assetId, recolor: { material, ramp } | null }]. The renderer
// (lpc-avatar.js) expands fg/bg parts and z-sorts; order here is just for reading.
export function lpcBuild(pet) {
  const c = pet?.cosmetics || {};
  const seed = pet?.seed || 1;
  const hasDress = !!(c.dress && LPC_DRESS[c.dress]);

  const skinRamp = rampFor(c.c_skin, "body", seed, 2654435761, SKIN_RAMPS);
  const hairRamp = rampFor(c.c_hair, "hair", seed, 40503, HAIR_RAMPS);
  const shirtRamp = rampFor(c.c_shirt, "cloth", seed, 2246822519, SHIRT_RAMPS);
  const pantsRamp = rampFor(c.c_pants, "cloth", seed, 3266489917, PANTS_RAMPS);

  const layers = [];
  const bodyRecolor = { material: "body", ramp: skinRamp };
  const hairRecolor = { material: "hair", ramp: hairRamp };
  if (c.backpack && LPC_BACKPACK[c.backpack]) {
    layers.push({ assetId: LPC_BACKPACK[c.backpack], recolor: null });
  }
  layers.push({ assetId: hasDress ? "body_human_female" : "body_human", recolor: bodyRecolor });
  // LPC bodies are headless — the head + eyes are their own layers, recoloured
  // to the same skin ramp so they match the body.
  layers.push({ assetId: hasDress ? "head_human_female" : "head_human", recolor: bodyRecolor });
  layers.push({ assetId: "eyes_human", recolor: null });
  if (c.eyebrows && LPC_EYEBROWS[c.eyebrows]) {
    layers.push({ assetId: LPC_EYEBROWS[c.eyebrows], recolor: hairRecolor });
  }
  const shoesId = (c.shoes_style && LPC_SHOES_STYLE[c.shoes_style]) || "shoes_basic";
  layers.push({ assetId: shoesId, recolor: clothRecolor(c.c_shoes) });
  if (hasDress) {
    layers.push({ assetId: LPC_DRESS[c.dress], recolor: null });
  } else {
    const pantsId =
      (c.pants_style && (LPC_PANTS_STYLE[c.pants_style] || LPC_PANTS_STYLE_SKIRT[c.pants_style])) ||
      "pants_basic";
    const shirtId = (c.shirt_style && LPC_SHIRT_STYLE[c.shirt_style]) || "shirt_basic";
    const pantsRecolor = pantsId === "pants_basic" ? { material: "cloth", ramp: pantsRamp } : null;
    const shirtRecolor = shirtId === "shirt_basic" ? { material: "cloth", ramp: shirtRamp } : null;
    layers.push({ assetId: pantsId, recolor: pantsRecolor });
    layers.push({ assetId: shirtId, recolor: shirtRecolor });
  }
  if (c.jacket && LPC_JACKET[c.jacket]) {
    layers.push({ assetId: LPC_JACKET[c.jacket], recolor: clothRecolor(c.c_jacket) });
  }
  if (c.bracers && LPC_BRACERS[c.bracers]) {
    layers.push({ assetId: LPC_BRACERS[c.bracers], recolor: clothRecolor(c.c_bracers) });
  }
  if (c.shoulders && LPC_SHOULDERS[c.shoulders]) {
    layers.push({ assetId: LPC_SHOULDERS[c.shoulders], recolor: clothRecolor(c.c_shoulders) });
  }
  if (c.neck && LPC_NECK[c.neck]) {
    layers.push({ assetId: LPC_NECK[c.neck], recolor: clothRecolor(c.c_neck) });
  }
  if (c.beard && LPC_BEARD[c.beard]) {
    layers.push({ assetId: LPC_BEARD[c.beard], recolor: hairRecolor });
  }
  const hairId = LPC_HAIR[c.hair_style] || (c.hair_style === undefined ? "hair_plain" : null);
  if (hairId) layers.push({ assetId: hairId, recolor: hairRecolor });

  // A `head` cosmetic that maps to a real LPC hat wins the head slot;
  // otherwise the basic hat_style takes it. (halo/bow/antlers stay props.)
  let hatId = null;
  if (c.head && LPC_HEAD_HAT[c.head]) hatId = LPC_HEAD_HAT[c.head];
  else if (c.hat_style && LPC_HAT[c.hat_style]) hatId = LPC_HAT[c.hat_style];
  if (hatId) layers.push({ assetId: hatId, recolor: null });

  if (c.glasses && LPC_GLASSES[c.glasses]) {
    layers.push({ assetId: LPC_GLASSES[c.glasses], recolor: null });
  }

  if (c.wings && LPC_WINGS[c.wings]) layers.push({ assetId: LPC_WINGS[c.wings], recolor: null });

  // Equipped weapon → animated blade in hand. Accept either an explicit
  // `pet.weapon` (combat-view passes the run's weapon) or the full character
  // shape (`pet.run.gear.weapon`) so overworld + combat callers both work.
  const wl = weaponBladeLayer(pet?.weapon || pet?.run?.gear?.weapon || null);
  if (wl) layers.push(wl);
  // A combat loadout weapon wins the hand; otherwise a store-bought accessory
  // weapon/shield is the held LPC sprite (and is skipped by drawLpcProps).
  else {
    const al = accessoryWeaponLayer(c.accessory);
    if (al) layers.push(al);
  }
  return layers;
}

// ── enemyBuild: a shared/enemies.js `lpc` spec → render layers ────────
// spec: { body:'human'|'skeleton'|'zombie', skin?, hair?, hairColor?, shirt?,
//         pants?, hat?(asset id), wings?(asset id), scale? }
export function enemyBuild(spec) {
  if (!spec) return null;
  const bodyId =
    spec.body === "skeleton"
      ? "body_skeleton"
      : spec.body === "zombie"
        ? "body_zombie"
        : "body_human";
  const bodyRecolor =
    spec.skin && bodyId !== "body_skeleton" ? { material: "body", ramp: spec.skin } : null;
  const layers = [{ assetId: bodyId, recolor: bodyRecolor }];
  // every LPC body is headless — drop the matching head (+ eyes) on it
  if (bodyId === "body_human") {
    layers.push({ assetId: "head_human", recolor: bodyRecolor });
    layers.push({ assetId: "eyes_human", recolor: null });
    layers.push({ assetId: "shoes_basic", recolor: null });
  } else if (bodyId === "body_skeleton") {
    layers.push({ assetId: "head_skeleton", recolor: null });
  } else if (bodyId === "body_zombie") {
    layers.push({ assetId: "head_zombie", recolor: bodyRecolor });
  }
  if (spec.pants)
    layers.push({ assetId: "pants_basic", recolor: { material: "cloth", ramp: spec.pants } });
  if (spec.shirt)
    layers.push({ assetId: "shirt_basic", recolor: { material: "cloth", ramp: spec.shirt } });
  if (spec.hair) {
    layers.push({
      assetId: LPC_HAIR[spec.hair] || "hair_plain",
      recolor: { material: "hair", ramp: spec.hairColor || "black" },
    });
  }
  if (spec.hat) layers.push({ assetId: spec.hat, recolor: null });
  if (spec.wings) layers.push({ assetId: spec.wings, recolor: null });
  // Armed enemy → a visible longsword layer (swings with its slash anim).
  // `weapon` is `true` for plain steel or a {material,ramp} recolour descriptor.
  if (spec.weapon) {
    layers.push({
      assetId: "weapon_longsword",
      recolor: spec.weapon === true ? null : spec.weapon,
    });
  }
  return { layers, scale: spec.scale || 1 };
}

// ── drawLpcProps: cosmetics LPC has no sprite layer for ───────────────
// The fantasy headpieces (halo / bow / antlers / horn) and held accessories
// (fan / parasol / scepter / choker / glasses) — drawn procedurally over the
// LPC paperdoll, positioned for LPC head/hand geometry. (cx, dy) is the centre
// + top of the 64-frame in screen space; `s` is the effective pixel scale.
export function drawLpcProps(ctx, cx, dy, s, pet, frameMs) {
  const c = pet?.cosmetics || {};
  const headTopY = dy + 6 * s;
  const headMidY = dy + 14 * s;

  if (c.head && !LPC_HEAD_KEYS.has(c.head)) {
    const hc = HEAD_CONFIG[c.head];
    if (hc) drawHeadProp(ctx, cx, headTopY, s, hc, frameMs);
  }
  // Accessory weapons/shields now render as a real LPC layer (see lpcBuild) —
  // only the non-weapon props (fan / parasol / scepter / choker / glasses) still
  // draw procedurally here.
  if (c.accessory && !LPC_ACCESSORY_KEYS.has(c.accessory)) {
    const ac = ACCESS_CONFIG[c.accessory];
    if (ac) drawAccessoryProp(ctx, cx, headMidY, dy, s, ac, frameMs);
  }
}

function drawHeadProp(ctx, cx, topY, s, hc, frameMs) {
  ctx.save();
  ctx.fillStyle = hc.color;
  if (hc.shape === "halo") {
    ctx.strokeStyle = hc.color;
    ctx.lineWidth = Math.max(2, 2.4 * s);
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin((frameMs || 0) / 320);
    ctx.beginPath();
    ctx.ellipse(cx, topY - 3 * s, 7.5 * s, 2.6 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (hc.shape === "bow") {
    const w = 5 * s;
    ctx.fillRect(cx - w * 1.6, topY - w * 0.5, w, w);
    ctx.fillRect(cx + w * 0.6, topY - w * 0.5, w, w);
    ctx.fillStyle = hc.accent || hc.color;
    ctx.fillRect(cx - w * 0.45, topY - w * 0.45, w * 0.9, w * 0.9);
  } else if (hc.shape === "antlers") {
    ctx.strokeStyle = hc.color;
    ctx.lineWidth = Math.max(2, 2 * s);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + dir * 4 * s, topY + 2 * s);
      ctx.lineTo(cx + dir * 9 * s, topY - 6 * s);
      ctx.moveTo(cx + dir * 6.5 * s, topY - 1.5 * s);
      ctx.lineTo(cx + dir * 11 * s, topY - 1 * s);
      ctx.stroke();
    }
  } else if (hc.shape === "horn") {
    ctx.beginPath();
    ctx.moveTo(cx - 2 * s, topY + 1 * s);
    ctx.lineTo(cx + 2 * s, topY + 1 * s);
    ctx.lineTo(cx, topY - 8 * s);
    ctx.closePath();
    ctx.fill();
    if (hc.accent) {
      ctx.strokeStyle = hc.accent;
      ctx.lineWidth = Math.max(1, s);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawAccessoryProp(ctx, cx, eyeY, dy, s, ac, _frameMs) {
  ctx.save();
  ctx.fillStyle = ac.color;
  if (ac.shape === "star_glasses") {
    ctx.fillRect(cx - 7 * s, eyeY - 1.5 * s, 5 * s, 3 * s);
    ctx.fillRect(cx + 2 * s, eyeY - 1.5 * s, 5 * s, 3 * s);
    ctx.fillRect(cx - 2 * s, eyeY - 0.5 * s, 4 * s, s);
  } else if (ac.shape === "choker") {
    ctx.fillRect(cx - 6 * s, dy + 24 * s, 12 * s, 2 * s);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(cx - s, dy + 24 * s, 2 * s, 2 * s);
  } else {
    // held props (fan / parasol / scepter / sword / axe / shield) — prop by the hand
    const hx = cx + 13 * s;
    const hy = dy + 32 * s;
    if (ac.shape === "parasol") {
      ctx.beginPath();
      ctx.arc(hx, hy - 6 * s, 7 * s, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(hx - 0.5 * s, hy - 6 * s, s, 12 * s);
    } else if (ac.shape === "scepter") {
      ctx.fillRect(hx - 0.6 * s, hy - 9 * s, 1.4 * s, 16 * s);
      ctx.fillStyle = ac.accent || "#fff";
      ctx.beginPath();
      ctx.arc(hx, hy - 10 * s, 2.6 * s, 0, Math.PI * 2);
      ctx.fill();
    } else if (ac.shape === "sword") {
      // Blade tip-up, crossguard at the grip. glow draws a halo behind.
      if (ac.glow) {
        ctx.save();
        ctx.shadowColor = ac.glow;
        ctx.shadowBlur = 10 * s;
      }
      ctx.fillRect(hx - 0.8 * s, hy - 16 * s, 1.6 * s, 14 * s);
      ctx.fillStyle = ac.accent || "#888";
      ctx.fillRect(hx - 3 * s, hy - 2.5 * s, 6 * s, 1.2 * s);
      ctx.fillRect(hx - 0.6 * s, hy - 2 * s, 1.2 * s, 4 * s);
      if (ac.glow) ctx.restore();
    } else if (ac.shape === "axe") {
      // Vertical haft + asymmetric blade head.
      ctx.fillRect(hx - 0.6 * s, hy - 14 * s, 1.2 * s, 18 * s);
      ctx.fillStyle = ac.color;
      ctx.beginPath();
      ctx.moveTo(hx + 0.6 * s, hy - 14 * s);
      ctx.lineTo(hx + 5 * s, hy - 12 * s);
      ctx.lineTo(hx + 5 * s, hy - 7 * s);
      ctx.lineTo(hx + 0.6 * s, hy - 9 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ac.accent || "#444";
      ctx.fillRect(hx - 1 * s, hy - 15 * s, 2 * s, 1 * s);
    } else if (ac.shape === "shield") {
      // Kite-ish shield strapped on the off-arm side of the body.
      const sx = cx - 11 * s;
      const sy = dy + 24 * s;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 4 * s, sy + 3 * s);
      ctx.lineTo(sx - 4 * s, sy + 10 * s);
      ctx.lineTo(sx, sy + 16 * s);
      ctx.lineTo(sx + 4 * s, sy + 10 * s);
      ctx.lineTo(sx + 4 * s, sy + 3 * s);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = ac.accent || "#fff";
      ctx.fillRect(sx - 0.8 * s, sy + 4 * s, 1.6 * s, 9 * s);
      ctx.fillRect(sx - 3 * s, sy + 8 * s, 6 * s, 1.6 * s);
    } else {
      // fan
      ctx.beginPath();
      ctx.moveTo(hx, hy + 4 * s);
      ctx.arc(hx, hy + 4 * s, 7 * s, -Math.PI * 0.85, -Math.PI * 0.15);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
