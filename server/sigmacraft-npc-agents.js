// Gemma NPC proposal lane (integrate-this PR7), scaled to the 200-agent
// Sigmacraft overworld. Server-only: runs in its own supervised 15s loop, NEVER
// in the 3s world-tick critical path, NEVER imported by shared/.
//
// The planner PROPOSES bounded controller state (a goal, a line, one move/talk
// step) for a batch of overworld NPCs per cycle; it cannot mutate the world
// directly. Proposals pass the validate.js trust boundary and are stored under
// world.sigmacraft.npcAgents[npcId]; a later world tick consumes bounded effects
// (server/sigmacraft.js). The default planner is a DETERMINISTIC, zero-network
// fallback. Live Gemma is env-gated and deferred (see callGemma).

import { NPC_PLAN_REUSE_TICKS, MAX_NPC_AGENT_INCIDENTS, MAX_NPC_AGENT_GOALS } from "../shared/sigmacraft.js";
import { vNpcProposals } from "./validate.js";
import { createLlmClient } from "./llm.js";

// FNV-1a — deterministic, zero-IO seed from a string.
function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A real tile-graph neighbour of the NPC's current tile, biased toward where
// actors are (hub pull), tie-broken deterministically by seed. Falls back to
// staying put.
function adjacentTileId(tileId, world, seed) {
  const tiles = world?.sigmacraft?.map?.tiles || {};
  const here = tiles[tileId];
  const exits = (here?.exits || []).filter((id) => tiles[id]);
  if (!exits.length) return tileId;
  const places = world?.sigmacraft?.actorPlaces || {};
  const pop = (tid) => Object.values(places).filter((v) => v === tid).length;
  let best = exits[0];
  let bestPop = -1;
  for (const id of exits) {
    const n = pop(id);
    if (n > bestPop) { best = id; bestPop = n; }
  }
  return bestPop > 0 ? best : exits[seed % exits.length];
}

// Deterministic ambient lines per archetype (no Date/Math.random). <=140 chars.
const ARCHETYPE_LINES = {
  adventurer: ["Trouble on the road? Point me at it.", "Renown won't earn itself.", "Stay close — the reaches bite."],
  crafter: ["Good steel takes patience.", "I need better ore than this.", "A work order won't fill itself."],
  bandit: ["Mind your purse on this road.", "Patrols are thin tonight.", "This shortcut belongs to us."],
  merchant: ["Fair prices for honest coin.", "I need guards before the roads close.", "Buy low, friend — the toll's rising."],
  guard: ["Move along, keep the road clear.", "Bandit sign near the crossing.", "The watch holds — for now."],
  scout: ["Danger two ridges east.", "I read weather and worse.", "Follow my markers, not the easy path."],
  mystic: ["The omens are uneasy.", "Old spirits stir near the shrine.", "A riddle for safe passage?"],
};
function archetypeLine(rec, seed) {
  const pool = ARCHETYPE_LINES[rec?.archetype] || ["..."];
  return pool[seed % pool.length].slice(0, 140);
}
function goalFor(rec, seed) {
  const goals = Array.isArray(rec?.goals) && rec.goals.length ? rec.goals : ["tend the reaches"];
  return String(goals[seed % goals.length]).slice(0, 96);
}

// Pure given (npcId, world) — the always-on default. No Date/Math.random.
export function makeNpcFallbackProposal(npcId, world) {
  const rec = world?.sigmacraft?.overworldNpcs?.[npcId];
  if (!rec) return null;
  const tick = world?.sigmacraft?.tick || 0;
  const seed = stableHash(`${npcId}:${tick}:${rec.tileId}`);
  // Roamers (adventurer/scout/bandit/merchant) wander more than settled folk.
  const roamer = ["adventurer", "scout", "bandit", "merchant"].includes(rec.archetype);
  const wantsMove = roamer ? seed % 2 === 0 : seed % 3 === 0;
  const step = wantsMove
    ? { kind: "move", targetId: adjacentTileId(rec.tileId, world, seed) }
    : { kind: "talk", targetId: npcId };
  const goal = goalFor(rec, seed);
  return {
    npcId,
    currentGoal: goal,
    dialogueLine: archetypeLine(rec, seed),
    step,
    memoryPatch: {
      goals: [{ text: goal }],
      recentIncidents: [{ summary: `near ${rec.tileId}`, tick }],
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

// Live Gemma hook (Phase D). Reached only when NPC_PLANNER_LIVE=1 AND the shared
// Cerebras seam is available (key set + breaker closed); default OFF ⇒ never
// invoked, so tests stay socket-free. The seam caps concurrency over the 200-agent
// fan-out and trips to fallback on provider failure. Output is mapped to the SAME
// bounded proposal shape and still passes vNpcProposals + apply-time adjacency, so
// a hallucinated move can never teleport an NPC — at worst it degrades to "talk".
async function callGemma(npcId, world, llm) {
  const s = world?.sigmacraft;
  const rec = s?.overworldNpcs?.[npcId];
  if (!rec) return null;
  const tiles = s?.map?.tiles || {};
  const here = tiles[rec.tileId];
  const exits = (here?.exits || []).filter((id) => tiles[id]);
  const exitDesc = exits.map((id) => `${id} (${tiles[id]?.name})`).join(", ") || "none";
  const system =
    "You control ONE NPC in a fantasy realm. Reply ONLY with compact JSON: " +
    '{"goal": string<=80, "line": string<=140, "action": "move" or "talk", "target": string}. ' +
    "For action=move, target MUST be exactly one of the listed exit tile ids. " +
    "For action=talk, omit target. No prose, no markdown.";
  const user =
    `NPC ${rec.name} (${rec.archetypeLabel || rec.archetype}, faction ${rec.faction}). ` +
    `Persona: ${rec.persona}. At tile ${rec.tileId} (${here?.name}, danger ${here?.danger ?? "?"}). ` +
    `Exits: ${exitDesc}. Goals: ${(rec.goals || []).join("; ")}. ` +
    "Choose the next bounded action and a short in-character line.";
  const reply = await llm.chat({ system, user, json: true, maxTokens: 200 });
  const tick = s.tick || 0;
  const target = String(reply?.target || "");
  const step =
    reply?.action === "move" && exits.includes(target)
      ? { kind: "move", targetId: target }
      : { kind: "talk", targetId: npcId }; // invalid/absent move target degrades to talk
  const goal = String(reply?.goal || goalFor(rec, tick)).slice(0, 96);
  return {
    npcId,
    currentGoal: goal,
    dialogueLine: String(reply?.line || "").slice(0, 140),
    step,
    memoryPatch: {
      goals: [{ text: goal }],
      recentIncidents: [{ summary: `near ${rec.tileId}`, tick }],
      summaryPointer: `${npcId}#rolling`,
    },
    source: "gemma",
  };
}

export function attachNpcPlanner({ store, env = process.env, llm = createLlmClient({ env }) } = {}) {
  const live = env.NPC_PLANNER_LIVE === "1";
  const envMax = Number(env.SIGMACRAFT_NPC_MAX_PER_CYCLE);

  async function planOne(npcId, world) {
    let proposal = null;
    try {
      // Live only when explicitly enabled AND the seam is currently available;
      // otherwise the deterministic fallback (no network) — same default as PR7.
      proposal =
        live && llm.available()
          ? await callGemma(npcId, world, llm)
          : makeNpcFallbackProposal(npcId, world);
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

    const ordered = Object.keys(s.overworldNpcs || {}).sort();
    if (!ordered.length) return;
    // Auto-size the batch so the whole population refreshes within the reuse
    // window (e.g. 200 / 5 = 40 per 15s cycle) rather than ~50 min at 1/cycle.
    const maxPerCycle = Math.max(1, envMax > 0 ? envMax : Math.ceil(ordered.length / NPC_PLAN_REUSE_TICKS));
    const start = ((s.npcCursor % ordered.length) + ordered.length) % ordered.length;
    let planned = 0;
    for (let i = 0; i < ordered.length && planned < maxPerCycle; i++) {
      const id = ordered[(start + i) % ordered.length];
      const existing = s.npcAgents[id]?.plan;
      // Skip an NPC still proceeding on a fresh, unconsumed plan (reuse window).
      if (existing && tick - (existing.plannedAtTick || 0) < NPC_PLAN_REUSE_TICKS && !existing.consumed) {
        continue;
      }
      if (await planOne(id, world)) {
        planned += 1;
        s.npcCursor = (ordered.indexOf(id) + 1) % ordered.length;
      }
    }
    // NPC plans are ambient and regenerable from seed, so they live in-memory
    // ONLY. store.getWorldState() hands out the live world ref, so planOne's
    // writes are already visible to the fast lane and snapshots. We deliberately
    // do NOT putWorldState here: persisting ambient NPC churn every planner cycle
    // would rewrite world.json on an idle/player-less server and defeat idle
    // quiescence (the persist signal lives in advance(), gated to player intents —
    // see server/sigmacraft.js). A future option is a throttled 60s checkpoint on
    // the legacy lane if NPC memory ever needs to survive restart.
  }

  return { plan };
}
