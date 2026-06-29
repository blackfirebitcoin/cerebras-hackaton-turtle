// SIGMA ABYSS — Agent Realm world map.
//
// Pure, dual-runtime data + helpers (ESM, .js imports, no Node builtins, no
// DOM) — same portability contract as the rest of `shared/`. It is the static
// overworld the API agents traverse: an 11×11 grid of tiles, each carrying a
// `content` descriptor the action handlers key off (move onto a `monster` tile
// then `fight`; onto a `resource` tile then `gather`; onto the `oracle` tile to
// claim inference HITs). Modelled on ArtifactsMMO's map/tile content system.
//
// The grid is intentionally small and hand-placed so an agent can learn the
// whole world from one /api/agent/world fetch and route deterministically.

import { AGENT_WORLD_H, AGENT_WORLD_W } from "./constants.js";

// ── Monster definitions (fight targets) ──────────────────────────────────
// Kept independent of shared/enemies.js (which is sigma/delve-flavoured) so the
// agent realm balances on its own simple curve: hp/attack/xp/gold by level.
export const AGENT_MONSTERS = {
  chrome_rat: {
    code: "chrome_rat",
    name: "Chrome Rat",
    level: 1,
    hp: 28,
    attack: 5,
    xp: 8,
    gold: 4,
    drop: "rat_tail",
  },
  void_slime: {
    code: "void_slime",
    name: "Void Slime",
    level: 3,
    hp: 60,
    attack: 9,
    xp: 18,
    gold: 9,
    drop: "slime_gel",
  },
  abyss_crawler: {
    code: "abyss_crawler",
    name: "Abyss Crawler",
    level: 6,
    hp: 120,
    attack: 16,
    xp: 38,
    gold: 20,
    drop: "crawler_chitin",
  },
  hollow_knight: {
    code: "hollow_knight",
    name: "Hollow Knight",
    level: 10,
    hp: 240,
    attack: 28,
    xp: 80,
    gold: 48,
    drop: "hollow_plate",
  },
  sigma_wraith: {
    code: "sigma_wraith",
    name: "Sigma Wraith",
    level: 15,
    hp: 460,
    attack: 44,
    xp: 170,
    gold: 110,
    drop: "wraith_essence",
  },
};

// ── Resource definitions (gather targets) ────────────────────────────────
export const AGENT_RESOURCES = {
  chrome_vein: {
    code: "chrome_vein",
    name: "Chrome Vein",
    skill: "mining",
    level: 1,
    xp: 6,
    drop: "chrome_ore",
  },
  void_timber: {
    code: "void_timber",
    name: "Void Timber",
    skill: "woodcutting",
    level: 1,
    xp: 6,
    drop: "void_log",
  },
  data_pool: {
    code: "data_pool",
    name: "Data Pool",
    skill: "fishing",
    level: 3,
    xp: 9,
    drop: "data_shard",
  },
  ether_bloom: {
    code: "ether_bloom",
    name: "Ether Bloom",
    skill: "alchemy",
    level: 5,
    xp: 14,
    drop: "ether_petal",
  },
};

// ── Workshops (craft sites; skill must match the recipe) ──────────────────
export const AGENT_WORKSHOPS = {
  forge: { code: "forge", skill: "mining" },
  lab: { code: "lab", skill: "alchemy" },
};

// ── Craft recipes: code -> { skill, level, ingredients:{drop:qty}, xp } ────
export const AGENT_RECIPES = {
  chrome_ingot: {
    code: "chrome_ingot",
    skill: "mining",
    level: 1,
    station: "forge",
    ingredients: { chrome_ore: 3 },
    xp: 12,
    value: 18,
  },
  void_plank: {
    code: "void_plank",
    skill: "woodcutting",
    level: 1,
    station: "forge",
    ingredients: { void_log: 3 },
    xp: 12,
    value: 16,
  },
  ether_tonic: {
    code: "ether_tonic",
    skill: "alchemy",
    level: 5,
    station: "lab",
    ingredients: { ether_petal: 2, data_shard: 1 },
    xp: 30,
    value: 60,
    heal: 60,
  },
};

// Hand-placed tile contents keyed "x,y". Anything unlisted is empty ground
// (walkable, no content). One oracle, one bank, two workshops, a spread of
// monsters (easy near town, harder at the edges) and resources.
const PLACED = {
  "5,5": { type: "town", code: "spawn" },
  "5,4": { type: "oracle", code: "oracle" }, // the Bazaar — claim inference HITs here
  "4,5": { type: "bank", code: "bank" },
  "6,5": { type: "workshop", code: "forge" },
  "5,6": { type: "workshop", code: "lab" },
  // monsters
  "5,2": { type: "monster", code: "chrome_rat" },
  "7,3": { type: "monster", code: "chrome_rat" },
  "2,4": { type: "monster", code: "void_slime" },
  "8,6": { type: "monster", code: "void_slime" },
  "1,8": { type: "monster", code: "abyss_crawler" },
  "9,9": { type: "monster", code: "hollow_knight" },
  "0,0": { type: "monster", code: "sigma_wraith" },
  // resources
  "3,2": { type: "resource", code: "chrome_vein" },
  "7,7": { type: "resource", code: "void_timber" },
  "2,9": { type: "resource", code: "data_pool" },
  "9,1": { type: "resource", code: "ether_bloom" },
};

export function inBounds(x, y) {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < AGENT_WORLD_W &&
    y >= 0 &&
    y < AGENT_WORLD_H
  );
}

export function manhattan(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

// Content descriptor at a tile, or null for empty ground / out of bounds.
export function contentAt(x, y) {
  if (!inBounds(x, y)) return null;
  return PLACED[`${x},${y}`] || null;
}

// Full map snapshot for the /api/agent/world endpoint — array of
// { x, y, content } for every non-empty tile, plus the catalogs an agent
// needs to plan (monsters/resources/recipes).
export function worldSnapshot() {
  const tiles = Object.entries(PLACED).map(([k, content]) => {
    const [x, y] = k.split(",").map(Number);
    return { x, y, content };
  });
  return {
    width: AGENT_WORLD_W,
    height: AGENT_WORLD_H,
    tiles,
    monsters: AGENT_MONSTERS,
    resources: AGENT_RESOURCES,
    recipes: AGENT_RECIPES,
    workshops: AGENT_WORKSHOPS,
  };
}
