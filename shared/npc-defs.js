// SIGMA ABYSS — NPC catalog (master design §3.1, [A7]).
//
// The persistent cast of the Abyss: one figure per faction plus a neutral
// wanderer. Each has a faction, a home zone, personality traits (reused from
// the trait system), a daily schedule, and dialogue templates keyed by the
// player's relationship disposition. PURE ESM — data + deterministic helpers.

import { makeRng, mixSeed } from "./rng.js";

// epochHour = world.epoch % 24 → which schedule phase an NPC is in.
export const NPC_SCHEDULE_PHASES = ["resting", "working", "wandering", "trading"];

export const NPCS = {
  kael: {
    id: "kael",
    name: "Kael the Warden",
    factionId: "iron_veil",
    homeZone: "goblin_warrens",
    role: "quartermaster",
    traitIds: ["tough", "careful"],
    schedule: ["resting", "working", "working", "trading"],
    dialogue: {
      hostile: ["Move along. The Veil has no words for the likes of you."],
      neutral: ["State your business, delver.", "The warrens are restless today."],
      friendly: ["Good to see you standing, {name}.", "The Veil remembers your service."],
      ally: ["For the Veil, {name}. Always."],
    },
  },
  vyre: {
    id: "vyre",
    name: "Vyre of the Pact",
    factionId: "crimson_pact",
    homeZone: "cursed_forest",
    role: "warbringer",
    traitIds: ["bloodlust"],
    schedule: ["wandering", "working", "working", "wandering"],
    dialogue: {
      hostile: ["The Pact drinks from cowards too."],
      neutral: ["Blood or nothing. Which is it?"],
      friendly: ["You bleed well, {name}."],
      ally: ["The Pact's blade is yours, {name}."],
    },
  },
  mireth: {
    id: "mireth",
    name: "Mireth the Scholar",
    factionId: "void_order",
    homeZone: "infernal_highway",
    role: "loremaster",
    traitIds: ["industrious"],
    schedule: ["working", "working", "resting", "wandering"],
    dialogue: {
      hostile: ["The Void notes your ignorance."],
      neutral: ["Knowledge is the only true loot."],
      friendly: ["The patterns favor you, {name}."],
      ally: ["The Void Order opens its codex to you, {name}."],
    },
  },
  goldwyn: {
    id: "goldwyn",
    name: "Goldwyn of the Court",
    factionId: "ember_court",
    homeZone: "demon_catacombs",
    role: "merchant",
    traitIds: ["greedy"],
    schedule: ["trading", "trading", "working", "resting"],
    dialogue: {
      hostile: ["No coin, no kindness."],
      neutral: ["Everything has a price, delver."],
      friendly: ["A discount, for a valued client, {name}."],
      ally: ["The Court's coffers are open to you, {name}."],
    },
  },
  the_hollow: {
    id: "the_hollow",
    name: "The Hollow One",
    factionId: "abyssal_convergence",
    homeZone: "abyss_ruins",
    role: "oracle",
    traitIds: [],
    schedule: ["wandering", "wandering", "wandering", "wandering"],
    dialogue: {
      hostile: ["...you are not ready."],
      neutral: ["The dark asks a question of you."],
      friendly: ["You have looked into it, and it looked back."],
      ally: ["We are one, {name}. The Convergence welcomes you."],
    },
  },
};
export const NPC_IDS = Object.keys(NPCS);

export function npcById(id) {
  return NPCS[id] || null;
}

// Deterministic per-NPC trait roll seed (for procedural variety / world gen).
export function rollNpcTraits(npcId, worldSeed) {
  const npc = NPCS[npcId];
  if (!npc) return [];
  // Catalogued traits are canonical; the seed is reserved for future
  // procedural NPCs. Deterministic by (worldSeed, npcId hash).
  void makeRng(mixSeed(worldSeed >>> 0, NPC_IDS.indexOf(npcId) >>> 0));
  return [...npc.traitIds];
}

// Schedule phase for an NPC given the world's hour-of-day (epoch % 24).
export function npcSchedulePhase(npcId, epochHour) {
  const npc = NPCS[npcId];
  if (!npc) return "resting";
  const quarter = Math.floor((((epochHour % 24) + 24) % 24) / 6); // 0..3
  return npc.schedule[quarter] || "resting";
}

// Pick a dialogue line for a disposition (deterministic given a tick seed).
export function npcLine(npcId, disposition, seed = 0) {
  const npc = NPCS[npcId];
  if (!npc) return "";
  const pool = npc.dialogue[disposition] || npc.dialogue.neutral || [""];
  const rng = makeRng(seed >>> 0 || 1);
  return pool[Math.floor(rng.next() * pool.length)] || pool[0];
}
