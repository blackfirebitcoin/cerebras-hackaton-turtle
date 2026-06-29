// Agentic NPC planner (integrate-this PR-C), scaled to the 200-agent Sigmacraft
// overworld. Server-only: runs in its own supervised 15s loop, NEVER in the 3s
// world-tick critical path, NEVER imported by shared/.
//
// TWO-LAYER PLANNING:
//   • STRATEGIC (here, off-tick): propose a goal + an AGENDA — an ordered list of
//     grounded objectives, each a real action (move/talk/gather/fight/rest/craft)
//     at a real tile. Gemma (live) or a deterministic fallback (default).
//   • TACTICAL (server/sigmacraft.js, on-tick): cascade the agenda into ONE concrete
//     primitive per tick (walk toward the objective's tile via BFS, then perform the
//     action when arrived), advancing the agenda cursor as objectives complete.
//
// The planner cannot mutate the world; proposals pass the validate.js trust boundary
// (vNpcProposals) and are stored under world.sigmacraft.npcAgents[npcId]. The tick
// re-checks tile existence/adjacency, so a hallucinated agenda can never teleport.

import {
  MAX_NPC_AGENDA_STEPS,
  MAX_NPC_AGENT_GOALS,
  MAX_NPC_AGENT_INCIDENTS,
  choose,
  tileSupportsAction,
} from "../shared/sigmacraft.js";
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

// Strategic agenda templates: an archetype's routine as a sequence of action kinds.
// Each kind is resolved to a real, supporting target tile at build time.
const ARCHETYPE_AGENDA = {
  adventurer: ["fight", "rest", "talk"],
  crafter: ["gather", "craft", "talk"],
  bandit: ["fight", "rest"],
  merchant: ["move", "talk", "rest"],
  guard: ["fight", "rest"],
  scout: ["gather", "talk"],
  mystic: ["talk", "rest"],
};

function manhattan(a, b) {
  return Math.abs((a?.x ?? 0) - (b?.x ?? 0)) + Math.abs((a?.y ?? 0) - (b?.y ?? 0));
}

// Pick a real tile id that SUPPORTS `kind` (so the objective is grounded), biased
// toward tiles near `fromTile`, tie-broken deterministically by seed.
function targetTileForAction(tiles, fromTile, kind, seed) {
  const all = Object.values(tiles);
  let pool;
  if (kind === "rest" || kind === "craft" || kind === "talk") {
    pool = all.filter((t) => t.type === "town" || t.type === "city");
  } else if (kind === "move") {
    pool = all.filter((t) => t.type === "town" || t.type === "city");
  } else {
    pool = all.filter((t) => tileSupportsAction(t, kind)); // gather / fight
  }
  if (!pool.length) pool = all;
  // Nearness bias: prefer the closer half so journeys stay reasonable.
  const near = pool
    .map((t) => ({ t, d: manhattan(fromTile, t) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(3, Math.ceil(pool.length / 2)))
    .map((x) => x.t);
  return choose(near, `${seed}:${kind}`).id;
}

// Build a deterministic, grounded agenda for an NPC. Each objective = an action at a
// real supporting tile. PURE given (rec, tiles, seed).
function buildFallbackAgenda(rec, tiles, seed) {
  const here = tiles[rec.tileId];
  const seq = (ARCHETYPE_AGENDA[rec?.archetype] || ["talk", "rest"]).slice(0, MAX_NPC_AGENDA_STEPS);
  return seq.map((kind, i) => ({ kind, targetTileId: targetTileForAction(tiles, here, kind, `${seed}:${i}`) }));
}

// Pure given (npcId, world) — the always-on default. No Date/Math.random.
export function makeNpcFallbackProposal(npcId, world) {
  const s = world?.sigmacraft;
  const rec = s?.overworldNpcs?.[npcId];
  if (!rec) return null;
  const tiles = s?.map?.tiles || {};
  const tick = s?.tick || 0;
  const seed = stableHash(`${npcId}:${tick}:${rec.tileId}`);
  const goal = goalFor(rec, seed);
  return {
    npcId,
    currentGoal: goal,
    dialogueLine: archetypeLine(rec, seed),
    agenda: buildFallbackAgenda(rec, tiles, seed),
    memoryPatch: {
      goals: [{ text: goal }],
      recentIncidents: [{ summary: `near ${rec.tileId}`, tick }],
      summaryPointer: `${npcId}#rolling`,
    },
    source: "fallback",
  };
}

// Merge a validated proposal into stored controller state. A NEW agenda resets the
// cursor to 0 (the tick walks it from the top); memory rolls + caps.
function mergePlan(existing, clean, tick) {
  const prevMem = existing?.memory || {};
  const incidents = [
    ...(Array.isArray(prevMem.recentIncidents) ? prevMem.recentIncidents : []),
    ...clean.memoryPatch.recentIncidents,
  ].slice(-MAX_NPC_AGENT_INCIDENTS);
  return {
    plan: {
      goal: clean.currentGoal,
      agenda: clean.agenda,
      cursor: 0,
      dialogueLine: clean.dialogueLine,
      source: clean.source,
      plannedAtTick: tick,
    },
    memory: {
      goals: clean.memoryPatch.goals.slice(0, MAX_NPC_AGENT_GOALS),
      recentIncidents: incidents,
      summaryPointer: clean.memoryPatch.summaryPointer || prevMem.summaryPointer || `${clean.npcId}#rolling`,
    },
  };
}

// A short list of nearby, grounded candidate tiles for the live prompt, so Gemma
// picks REAL ids (one or two of each relevant type, nearest first).
function nearbyTileMenu(rec, tiles) {
  const here = tiles[rec.tileId];
  const pick = (pred, n) =>
    Object.values(tiles)
      .filter(pred)
      .map((t) => ({ t, d: manhattan(here, t) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => `${x.t.id} (${x.t.type})`);
  return [
    ...pick((t) => tileSupportsAction(t, "fight"), 2),
    ...pick((t) => tileSupportsAction(t, "gather"), 2),
    ...pick((t) => t.type === "town" || t.type === "city", 2),
  ].join(", ");
}

// Live Gemma hook (Phase D). Reached only when NPC_PLANNER_LIVE=1 AND the shared
// Cerebras seam is available; default OFF ⇒ never invoked, so tests stay socket-free.
// Asks for a STRATEGIC agenda; the reply is mapped to the bounded agenda shape and
// still passes vNpcProposals + the tick's apply-time re-checks (no teleport, no
// unsupported action — the tactical layer degrades any bad objective safely).
async function callGemma(npcId, world, llm) {
  const s = world?.sigmacraft;
  const rec = s?.overworldNpcs?.[npcId];
  if (!rec) return null;
  const tiles = s?.map?.tiles || {};
  const here = tiles[rec.tileId];
  const menu = nearbyTileMenu(rec, tiles);
  const system =
    "You are ONE NPC in a fantasy realm. Plan a short AGENDA — 2 to 4 steps the NPC " +
    "will pursue over time. Reply ONLY with compact JSON: " +
    '{"goal": string<=80, "line": string<=140, "agenda": [{"action": one of ' +
    '"move"|"talk"|"gather"|"fight"|"rest"|"craft", "target": tileId}]}. ' +
    "Each target MUST be a tile id from the provided list. gather=wilds/dungeon/ruins, " +
    "fight=dangerous tiles, rest/craft=town/city. No prose, no markdown.";
  const user =
    `NPC ${rec.name} (${rec.archetypeLabel || rec.archetype}, faction ${rec.faction}). ` +
    `Persona: ${rec.persona}. At ${rec.tileId} (${here?.name}). Supplies ${rec.supplies ?? 0}, mood ${rec.moodValue ?? 50}. ` +
    `Nearby tiles you may target: ${menu || "none"}. Long-term goals: ${(rec.goals || []).join("; ")}. ` +
    "Plan an agenda that fits this character.";
  const reply = await llm.chat({ system, user, json: true, maxTokens: 320 });
  const tick = s.tick || 0;
  const rawAgenda = Array.isArray(reply?.agenda) ? reply.agenda : [];
  const agenda = rawAgenda
    .slice(0, MAX_NPC_AGENDA_STEPS)
    .map((o) => {
      const kind = o?.action;
      const targetTileId = o?.target;
      const step = { kind };
      if (typeof targetTileId === "string" && tiles[targetTileId]) step.targetTileId = targetTileId;
      return step;
    });
  const goal = String(reply?.goal || goalFor(rec, tick)).slice(0, 96);
  // If the model gave nothing usable, fall back to a grounded agenda.
  const finalAgenda = agenda.length ? agenda : buildFallbackAgenda(rec, tiles, stableHash(`${npcId}:${tick}`));
  return {
    npcId,
    currentGoal: goal,
    dialogueLine: String(reply?.line || "").slice(0, 140),
    agenda: finalAgenda,
    memoryPatch: {
      goals: [{ text: goal }],
      recentIncidents: [{ summary: `near ${rec.tileId}`, tick }],
      summaryPointer: `${npcId}#rolling`,
    },
    source: "gemma",
  };
}

// Does this agent still have an agenda to pursue? (cursor not yet past the end)
function agendaInProgress(plan) {
  return !!plan?.agenda && Array.isArray(plan.agenda) && Number.isFinite(plan.cursor) && plan.cursor < plan.agenda.length;
}

export function attachNpcPlanner({ store, env = process.env, llm = createLlmClient({ env }) } = {}) {
  const live = env.NPC_PLANNER_LIVE === "1";
  const envMax = Number(env.SIGMACRAFT_NPC_MAX_PER_CYCLE);

  async function planOne(npcId, world) {
    let proposal = null;
    try {
      proposal =
        live && llm.available()
          ? await callGemma(npcId, world, llm)
          : makeNpcFallbackProposal(npcId, world);
    } catch {
      proposal = makeNpcFallbackProposal(npcId, world); // hard fallback on any model failure
    }
    if (!proposal) return false;
    const clean = vNpcProposals([proposal])[0]; // trust boundary; drops if malformed
    if (!clean || !clean.agenda.length) return false; // an empty agenda is no plan
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

    const ordered = Object.keys(s.overworldNpcs || {}).sort();
    if (!ordered.length) return;
    // Auto-size the batch. With multi-tick agendas an NPC only re-plans when its
    // agenda is exhausted, so this caps how many fresh agendas we mint per cycle.
    const maxPerCycle = Math.max(1, envMax > 0 ? envMax : Math.ceil(ordered.length / 5));
    const start = ((s.npcCursor % ordered.length) + ordered.length) % ordered.length;
    let planned = 0;
    for (let i = 0; i < ordered.length && planned < maxPerCycle; i++) {
      const id = ordered[(start + i) % ordered.length];
      // Skip an NPC that's still walking its current agenda — let it finish.
      if (agendaInProgress(s.npcAgents[id]?.plan)) continue;
      if (await planOne(id, world)) {
        planned += 1;
        s.npcCursor = (ordered.indexOf(id) + 1) % ordered.length;
      }
    }
    // Ambient + regenerable ⇒ IN-MEMORY ONLY. No store.putWorldState here: persisting
    // agenda churn every cycle would rewrite world.json on an idle/player-less server
    // and defeat idle quiescence (the persist signal lives in advance(), gated to
    // player intents — see server/sigmacraft.js).
  }

  return { plan };
}
