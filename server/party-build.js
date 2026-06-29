// Party combatant bridge (demo P2). Turns party members into deterministic combat
// SHEETS the party-combat resolver (shared/party-combat.js, P3) consumes — so an NPC
// fights with the SAME stat machinery a player does.
//
// Players: reuse character.run + derive() directly (their real stats + gear).
// NPCs: instantiate a character/run from a FIXED FNV(npc.id) seed, bias the stat
//   spend by archetype, then derive(). The seed is the NPC id ONLY — never the live
//   moodValue/supplies (those drift every tick), so two builds of the same NPC give
//   a byte-identical sheet (testable, reproducible). Server-side: freshRun stamps a
//   startedAt (Date.now) that derive() never reads, so the SHEET stays deterministic.

import { STAT_KEYS } from "../shared/constants.js";
import { freshCharacter, freshRun } from "../shared/progression.js";
import { derive } from "../shared/stats.js";

// FNV-1a → uint32 numeric seed (freshCharacter/freshRun take numbers).
function seedOf(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Archetype combat builds: how to spend level-up points + a base level band. The
// (seed % 4) spread keeps members in a level varying but reproducible.
const ARCHETYPE_BUILD = {
  adventurer: { weights: { str: 3, vit: 2, agi: 2 }, levelBase: 5 },
  guard: { weights: { vit: 4, str: 2, resolve: 2 }, levelBase: 6 },
  bandit: { weights: { str: 3, agi: 3, luck: 1 }, levelBase: 5 },
  scout: { weights: { agi: 4, luck: 2, str: 1 }, levelBase: 4 },
  mystic: { weights: { int: 4, resolve: 2, vit: 1 }, levelBase: 5 },
  crafter: { weights: { vit: 3, str: 2, luck: 1 }, levelBase: 3 },
  merchant: { weights: { luck: 3, vit: 2, greed: 2 }, levelBase: 3 },
};
const POINTS_PER_LEVEL = 3;

function applyArchetypeBuild(run, archetype, seed) {
  const build = ARCHETYPE_BUILD[archetype] || ARCHETYPE_BUILD.adventurer;
  const level = build.levelBase + (seed % 4); // deterministic 0..3 spread
  run.level = level;
  const total = (level - 1) * POINTS_PER_LEVEL;
  const wsum = Object.values(build.weights).reduce((a, b) => a + b, 0) || 1;
  for (const [stat, w] of Object.entries(build.weights)) {
    if (STAT_KEYS.includes(stat)) run.stats[stat] = (run.stats[stat] || 0) + Math.round((total * w) / wsum);
  }
  return level;
}

// One combatant = { id, name, archetype, isPlayer, level, sheet, hp }. `sheet` is the
// full derive() output; `hp` is the live pool the resolver mutates (starts at maxHp).
export function buildNpcCombatant(npc) {
  const seed = seedOf(npc.id);
  const character = freshCharacter(seed, npc.name);
  const run = freshRun(seed, 0, null, character);
  const level = applyArchetypeBuild(run, npc.archetype || "adventurer", seed);
  const sheet = derive(run, character);
  return {
    id: npc.id,
    name: npc.name,
    archetype: npc.archetype || "adventurer",
    isPlayer: false,
    level,
    sheet,
    hp: sheet.maxHp,
  };
}

export function buildPlayerCombatant(character) {
  const run = character?.run || null;
  const sheet = derive(run, character);
  return {
    id: character?.token || character?.login || "player",
    name: character?.name || character?.login || "Hero",
    archetype: "player",
    isPlayer: true,
    level: run?.level || 1,
    sheet,
    hp: sheet.maxHp,
  };
}

// Build the full party combat roster: the leader player (if provided) + every
// recruited NPC member, each as a baked combatant. `getNpc(npcId)` resolves the
// live overworld record (for name/archetype only — NOT for sheet seeding).
export function buildPartyCombatants(party, leaderCharacter, getNpc) {
  const out = [];
  if (leaderCharacter) out.push(buildPlayerCombatant(leaderCharacter));
  for (const m of party?.members || []) {
    const npc = getNpc?.(m.npcId) || { id: m.npcId, name: m.name, archetype: m.archetype };
    out.push(buildNpcCombatant(npc));
  }
  return out;
}
