// Gemma NPC proposal lane (integrate-this PR7) — ported from the standalone
// slice onto the REAL npc-defs.js NPCs. Server-only: runs in its own supervised
// 15s loop, NEVER in the 3s world-tick critical path, NEVER imported by shared/.
//
// The planner PROPOSES bounded controller state (a goal, a line, one move/talk
// step) for one NPC per cycle; it cannot mutate the world directly. Proposals
// pass the validate.js trust boundary and are stored under
// world.sigmacraft.npcAgents[npcId]; a later world tick consumes ONE bounded
// effect (server/sigmacraft.js). The default planner is a DETERMINISTIC,
// zero-network fallback (the same always-on path the slice uses when no live
// model is configured). Live Gemma is env-gated and deferred (see callGemma).

import { NPCS, NPC_IDS, npcLine } from "../shared/npc-defs.js";
import { ZONES, ZONE_BY_ID } from "../shared/zones.js";
import { NPC_PLAN_REUSE_TICKS, MAX_NPC_AGENT_INCIDENTS, MAX_NPC_AGENT_GOALS } from "../shared/sigmacraft.js";
import { vNpcProposals } from "./validate.js";

// FNV-1a — deterministic, zero-IO seed from a string (ported from the slice).
function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A tier±1 neighbour of the NPC's zone, biased toward where players are (the
// "hub pull"), tie-broken deterministically by seed. Falls back to staying put.
function adjacentZoneId(zoneId, world, seed) {
  const here = ZONE_BY_ID[zoneId];
  if (!here) return zoneId;
  const candidates = ZONES.filter((z) => Math.abs((z.tier ?? 0) - (here.tier ?? 0)) === 1).map((z) => z.id).sort();
  if (!candidates.length) return zoneId;
  const places = world?.sigmacraft?.actorPlaces || {};
  const pop = (zid) => Object.values(places).filter((v) => v === zid).length;
  let best = candidates[0];
  let bestPop = -1;
  for (const id of candidates) {
    const n = pop(id);
    if (n > bestPop) { best = id; bestPop = n; }
  }
  // If nobody is anywhere nearby, rotate deterministically by seed.
  return bestPop > 0 ? best : candidates[seed % candidates.length];
}

function dispositionForMood(mood) {
  const m = Number.isFinite(mood) ? mood : 50;
  if (m < 30) return "hostile";
  if (m < 55) return "neutral";
  if (m < 80) return "friendly";
  return "ally";
}

function goalForPhase(def, phase) {
  const role = def?.role || "duties";
  const map = {
    resting: "Rest and keep an eye on the road",
    working: `Tend to ${role} work`,
    wandering: "Wander the reaches, gathering news",
    trading: "Drive a hard bargain with passing delvers",
  };
  return (map[phase] || `See to ${role}`).slice(0, 96);
}

// Pure given (npcId, world) — the always-on default. No Date/Math.random.
export function makeNpcFallbackProposal(npcId, world) {
  const def = NPCS[npcId];
  if (!def) return null;
  const rec = world?.npcs?.[npcId] || {
    zoneId: def.homeZone,
    schedulePhase: "resting",
    moodValue: 50,
  };
  const tick = world?.sigmacraft?.tick || 0;
  const phase = rec.schedulePhase || "resting";
  const seed = stableHash(`${npcId}:${tick}:${rec.zoneId}:${phase}`);
  const wantsMove = phase === "wandering" || seed % 3 === 0;
  const step = wantsMove
    ? { kind: "move", targetId: adjacentZoneId(rec.zoneId, world, seed) }
    : { kind: "talk", targetId: npcId };
  const line = npcLine(npcId, dispositionForMood(rec.moodValue), seed).replace(/\{name\}/g, "traveler");
  const goal = goalForPhase(def, phase);
  return {
    npcId,
    currentGoal: goal,
    dialogueLine: line,
    step,
    memoryPatch: {
      goals: [{ text: goal }],
      recentIncidents: [{ summary: `${phase} near ${rec.zoneId}`, tick }],
      summaryPointer: `${npcId}#rolling`,
    },
    source: "fallback",
  };
}

// Merge a validated proposal into stored controller state; roll + cap memory.
function mergePlan(existing, clean, tick) {
  const prevMem = existing?.memory || {};
  const incidents = [
    ...(Array.isArray(prevMem.recentIncidents) ? prevMem.recentIncidents : []),
    ...clean.memoryPatch.recentIncidents,
  ].slice(-MAX_NPC_AGENT_INCIDENTS);
  return {
    plan: {
      step: clean.step,
      currentGoal: clean.currentGoal,
      dialogueLine: clean.dialogueLine,
      source: clean.source,
      plannedAtTick: tick,
      consumed: false,
    },
    memory: {
      goals: clean.memoryPatch.goals.slice(0, MAX_NPC_AGENT_GOALS),
      recentIncidents: incidents,
      summaryPointer: clean.memoryPatch.summaryPointer || prevMem.summaryPointer || `${clean.npcId}#rolling`,
    },
  };
}

// Live Gemma hook — DEFERRED in PR7. Only ever reached when NPC_PLANNER_LIVE=1
// AND GEMMA_URL is set; default OFF ⇒ never invoked, so tests are socket-free.
async function callGemma(_npcId, _world, _env) {
  throw new Error("npc live planner not wired (PR7 ships the deterministic fallback)");
}

export function attachNpcPlanner({ store, env = process.env } = {}) {
  const live = env.NPC_PLANNER_LIVE === "1" && !!env.GEMMA_URL;
  const maxPerCycle = Math.max(1, Number(env.SIGMACRAFT_NPC_MAX_PER_CYCLE) || 1);

  async function planOne(npcId, world) {
    let proposal = null;
    try {
      proposal = live ? await callGemma(npcId, world, env) : makeNpcFallbackProposal(npcId, world);
    } catch {
      proposal = makeNpcFallbackProposal(npcId, world); // hard fallback on any model failure
    }
    if (!proposal) return false;
    const clean = vNpcProposals([proposal])[0]; // trust boundary; drops if malformed
    if (!clean) return false;
    const s = world.sigmacraft;
    s.npcAgents[clean.npcId] = mergePlan(s.npcAgents[clean.npcId], clean, s.tick || 0);
    return true;
  }

  async function plan() {
    const world = store.getWorldState();
    if (!world?.sigmacraft) return;
    const s = world.sigmacraft;
    if (!s.npcAgents || typeof s.npcAgents !== "object") s.npcAgents = {};
    if (!Number.isFinite(s.npcCursor)) s.npcCursor = 0;
    const tick = s.tick || 0;

    const ordered = NPC_IDS.slice().sort();
    const start = ((s.npcCursor % ordered.length) + ordered.length) % ordered.length;
    let wrote = false;
    let planned = 0;
    for (let i = 0; i < ordered.length && planned < maxPerCycle; i++) {
      const id = ordered[(start + i) % ordered.length];
      const existing = s.npcAgents[id]?.plan;
      // Skip an NPC still proceeding on a fresh plan (reuse window).
      if (existing && tick - (existing.plannedAtTick || 0) < NPC_PLAN_REUSE_TICKS && !existing.consumed) {
        continue;
      }
      if (await planOne(id, world)) {
        wrote = true;
        planned += 1;
        s.npcCursor = (ordered.indexOf(id) + 1) % ordered.length;
      }
    }
    if (wrote) store.putWorldState(world);
  }

  return { plan };
}
