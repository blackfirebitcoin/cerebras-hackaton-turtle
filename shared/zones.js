// SIGMA ABYSS — the persistent world map.
//
// One safe hub + five escalating danger zones. Higher tier = more XP,
// rarer loot, and danger that climbs faster — the core risk/reward dial.
// Zone access is gated by the account's `highestLevel` record, so dying
// never locks you out of a zone you already earned.

import { DEPTH_MAX } from "./constants.js";

export const TOWN_ID = "town";

export const ZONES = [
  {
    id: "town",
    name: "Ironhollow",
    tier: 0,
    minLevel: 1,
    safe: true,
    flavor: "The last lit place. Banks, the black market, the garage, the arcane lab.",
    xpMult: 0,
    lootBias: 0,
    dangerMult: 0,
    enemies: [],
    elites: [],
    boss: null,
  },
  {
    id: "goblin_warrens",
    name: "Goblin Warrens",
    tier: 1,
    minLevel: 1,
    flavor: "Damp tunnels. Easy kills — and the thieves that empty your pockets.",
    xpMult: 1.0,
    lootBias: 0,
    dangerMult: 0.85,
    enemies: ["goblin", "goblin_thief", "skeleton", "wolf", "boar", "bandit"],
    elites: ["cursed_gambler"],
    boss: "goblin_king",
  },
  {
    id: "cursed_forest",
    name: "Cursed Forest",
    tier: 2,
    minLevel: 8,
    flavor: "The trees remember. Hexers and bone things walk between them.",
    xpMult: 1.5,
    lootBias: 1,
    dangerMult: 1.0,
    enemies: ["skeleton", "rogue_wizard", "goblin_thief", "imp", "wolf", "troll"],
    elites: ["bone_colossus", "cursed_gambler", "werewolf"],
    boss: "hollow_druid",
  },
  {
    id: "infernal_highway",
    name: "Infernal Highway",
    tier: 3,
    minLevel: 18,
    flavor: "A burning road that never ends. Chrome, chains, and engine-roar.",
    xpMult: 2.2,
    lootBias: 2,
    dangerMult: 1.2,
    enemies: ["cursed_biker", "corrupted_knight", "imp", "bandit", "troll"],
    elites: ["infernal_champion", "ogre"],
    boss: "chrome_centurion",
  },
  {
    id: "demon_catacombs",
    name: "Demon Catacombs",
    tier: 4,
    minLevel: 32,
    flavor: "Kings are buried here. So are the gamblers who bet against them.",
    xpMult: 3.2,
    lootBias: 3,
    dangerMult: 1.45,
    enemies: ["corrupted_knight", "imp", "abyss_crawler", "rogue_wizard", "troll"],
    elites: ["infernal_champion", "abyss_hunter", "ogre"],
    boss: "catacomb_tyrant",
  },
  {
    id: "abyss_ruins",
    name: "Abyss Ruins",
    tier: 5,
    minLevel: 50,
    flavor: "The bottom of everything. Whatever survived down here is hunting you.",
    xpMult: 4.6,
    lootBias: 4,
    dangerMult: 1.7,
    enemies: ["abyss_crawler", "corrupted_knight", "cursed_biker"],
    elites: ["abyss_hunter", "bone_colossus", "infernal_champion", "werewolf"],
    boss: "hollow_sigma",
  },
];

export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));
export const ZONE_IDS = ZONES.map((z) => z.id);
export const DANGER_ZONE_IDS = ZONES.filter((z) => !z.safe).map((z) => z.id);

export function zoneById(id) {
  return ZONE_BY_ID[id] || ZONE_BY_ID.town;
}

// Zones the account may deploy to, gated by its all-time highest level.
export function unlockedZones(character) {
  const reach = Math.max(1, character?.highestLevel || character?.run?.level || 1);
  return ZONES.filter((z) => !z.safe && z.minLevel <= reach);
}

// The toughest zone the character has earned access to.
export function recommendedZone(character) {
  const open = unlockedZones(character);
  return open.length ? open[open.length - 1] : ZONE_BY_ID.goblin_warrens;
}

export function maxDepthFor() {
  return DEPTH_MAX;
}
