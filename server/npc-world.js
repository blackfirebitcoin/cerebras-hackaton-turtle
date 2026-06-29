// SIGMA ABYSS — NPC interaction (master design §3.3 / 07-npc.md, [A7]).
//
// Server handlers for the !greet / !ask verbs. Each interaction decays then
// updates the player's relationship with the NPC (npc-memory), then returns a
// disposition-appropriate line (npc-defs). The Oracle-Bazaar-driven generative
// dialogue path (buildNpcOraclePrompt → oracle HIT → finalize) is specced in
// 07-npc.md and left as a follow-up; M6 ships the deterministic template path.

import { NPC_IDS, NPCS, npcById, npcLine } from "../shared/npc-defs.js";
import {
  dispositionBucket,
  dispositionLabel,
  freshRelationship,
  rememberEpisode,
} from "../shared/npc-memory.js";

// Resolve a chat arg to an npc id (exact id, or first word of the display name).
export function resolveNpcId(raw) {
  if (!raw) return null;
  const key = String(raw)
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
  if (NPC_IDS.includes(key)) return key;
  return NPC_IDS.find((id) => NPCS[id].name.toLowerCase().split(/\s+/)[0] === key) || null;
}

// kind ∈ "greet" | "ask". Mutates + persists the player; returns a line.
export function handleNpcInteract(ctx, kind) {
  const { token, character, store } = ctx;
  const now = Number.isFinite(ctx?.now) ? ctx.now : 0;
  const npcId = resolveNpcId(ctx.body?.npc);
  const npc = npcById(npcId);
  if (!npc) return { ok: false, error: "unknown_npc", npcs: NPC_IDS };
  if (!character.npcRelationships || typeof character.npcRelationships !== "object") {
    character.npcRelationships = {};
  }
  const rel = character.npcRelationships[npcId] || freshRelationship(now);
  rememberEpisode(rel, kind === "ask" ? "ask" : "greet", now);
  character.npcRelationships[npcId] = rel;
  store.putPlayer(token, character);

  const bucket = dispositionBucket(rel.score);
  const line = npcLine(npcId, bucket, (now ^ (character.seed || 1)) >>> 0 || 1).replace(
    "{name}",
    character.name,
  );
  return {
    ok: true,
    npc: npc.name,
    npcId,
    line,
    disposition: dispositionLabel(rel.score),
    score: rel.score,
  };
}

// Public NPC snapshot for GET /api/world/npc/:id (overlay + chat).
export function npcSnapshot(world, npcId) {
  const def = npcById(npcId);
  if (!def) return null;
  const w = world?.npcs?.[npcId] || null;
  return {
    id: def.id,
    name: def.name,
    factionId: def.factionId,
    role: def.role,
    homeZone: def.homeZone,
    schedulePhase: w?.schedulePhase || def.schedule[0],
    mood: w?.moodValue ?? 50,
  };
}
