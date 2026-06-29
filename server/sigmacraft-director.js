// Sigmacraft Director / game-master lane (integrate-this PR9). ONE world-level
// brain that watches world pressure and proposes BOUNDED public beats — quest
// beats, rumors, danger pulses, summaries — off the 3s tick critical path, in its
// own supervised loop (NEVER its own world timer). It owns no authority: proposals
// are validated at the trust boundary (server/validate.js: vDirectorProposals) and
// only ever set narrative text + (for quest_beat) the PUBLIC objective. The tick
// (server/sigmacraft.js advance) translates accepted proposals into events; loot,
// XP, death, and market stay entirely outside the Director.
//
// Determinism: the deterministic fallback is the DEFAULT and uses the SAME pure
// FNV selection (choose/stableIndex from shared/sigmacraft.js) as the generator, so
// it's reproducible and socket-free in tests. Live Gemma is env-gated (DIRECTOR_LIVE
// =1 && GEMMA_URL) and DEFERRED (callGemma throws) — see PR-D wiring.
//
// Quiescence: Director output is ambient + regenerable (the objective re-proposes
// on restart), so it lives IN-MEMORY ONLY. propose() never putWorldState's, and the
// tick's director-consume never raises the persist signal — an idle/player-less
// world stays write-quiescent (PSU power safety; see the NPC lane for the same rule).

import {
  DIRECTOR_BEAT_COOLDOWN_TICKS,
  DIRECTOR_KINDS,
  MAX_DIRECTOR_QUEUE,
  choose,
  stableIndex,
} from "../shared/sigmacraft.js";
import { vDirectorProposals } from "./validate.js";
import { createLlmClient } from "./llm.js";

// Curated beat tables. `{place}` is filled with a deterministically chosen tile
// name so the same world-state always yields the same beat text.
const QUEST_BEATS = [
  { questId: "ash_shrine", stageId: "ash_shrine_stage_2", title: "Embers at the Ash Shrine", text: "Cold fire flickers on the shrine steps near {place}. Find the keeper before dusk." },
  { questId: "bandit_tithe", stageId: "bandit_tithe_stage_1", title: "The Bandit Tithe", text: "A warband has set a toll on the roads by {place}. Break it or pay it." },
  { questId: "deep_hunger", stageId: "deep_hunger_stage_1", title: "The Deep Hunger", text: "Something under {place} has not eaten in a long age, and it is waking." },
  { questId: "lost_caravan", stageId: "lost_caravan_stage_1", title: "The Lost Caravan", text: "A merchant caravan never reached {place}. Their lantern still burns somewhere." },
];
const RUMORS = [
  "Travelers swear the road past {place} glows green after midnight.",
  "A child in town drew a map of {place} no one taught her.",
  "They say a crowned figure was seen walking out of {place}, against the dark.",
  "Wells near {place} have started running with cold, clean water again.",
];
const DANGER_LINES = [
  "The watch has closed the gate toward {place}; do not travel alone.",
  "Beasts are massing in {place}. The danger is rising.",
  "Smoke over {place} — the kind that does not come from hearths.",
];
const SUMMARIES = [
  "The realm holds its breath after a quiet turn.",
  "Old debts are being called in across the marches.",
  "Word spreads from town to town; the world feels watched.",
];

function highDangerTiles(map) {
  const tiles = Object.values(map?.tiles || {});
  const ranked = tiles.filter((t) => (t.danger || 0) >= 3).sort((a, b) => (b.danger || 0) - (a.danger || 0));
  return ranked.length ? ranked : tiles;
}

// Deterministic fallback proposal from world pressure + tick. Pure given the world.
export function makeDirectorFallbackProposal(world) {
  const s = world?.sigmacraft;
  if (!s?.map) return null;
  const seed = `${s.realmId || "sigmacraft"}:director:${s.tick || 0}`;
  const dangerTiles = highDangerTiles(s.map);
  const place = choose(dangerTiles, `${seed}:place`) || s.map.tiles?.[s.map.townTileId];
  const placeName = place?.name || "the marches";
  const targetTileId = place?.id;

  // Bias toward a quest beat when the objective is still the default opener or on a
  // rotation cadence; otherwise rotate rumor/danger/summary deterministically.
  const isDefaultObjective = (s.objective?.stageId || "") === "ash_shrine_stage_1";
  const wantQuest = isDefaultObjective || stableIndex(`${seed}:wantquest`, 3) === 0;

  if (wantQuest) {
    const beat = choose(QUEST_BEATS, `${seed}:quest`);
    return {
      kind: "quest_beat",
      id: `dir_quest_${s.tick || 0}`,
      questId: beat.questId,
      stageId: beat.stageId,
      title: beat.title,
      text: beat.text.replace("{place}", placeName),
      targetTileId,
      source: "fallback",
    };
  }
  const lane = choose(["rumor", "danger", "summary"], `${seed}:lane`);
  const table = lane === "rumor" ? RUMORS : lane === "danger" ? DANGER_LINES : SUMMARIES;
  const text = choose(table, `${seed}:${lane}`).replace("{place}", placeName);
  return {
    kind: lane,
    id: `dir_${lane}_${s.tick || 0}`,
    title: "",
    text,
    targetTileId: lane === "summary" ? undefined : targetTileId,
    source: "fallback",
  };
}

// Live Gemma hook (Phase D). Reached only when DIRECTOR_LIVE=1 AND the shared
// Cerebras seam is available; default OFF ⇒ never invoked, so tests stay
// socket-free. The seam adds the timeout + breaker. Output is mapped to the SAME
// bounded proposal shape and still passes vDirectorProposals, so a malformed beat
// is dropped (→ fallback) and the Director still owns no authority.
async function callGemma(world, llm) {
  const s = world?.sigmacraft;
  if (!s?.map) return null;
  const dangerTiles = highDangerTiles(s.map)
    .slice(0, 5)
    .map((t) => `${t.id} (${t.name}, danger ${t.danger})`)
    .join(", ");
  const system =
    "You are the game-master of a fantasy realm. Reply ONLY with compact JSON: " +
    '{"kind": "quest_beat"|"rumor"|"danger"|"summary", "title": string<=80, "text": string<=200, ' +
    '"questId": string, "stageId": string, "targetTileId": string}. ' +
    "questId/stageId only for quest_beat; targetTileId must be one of the listed tiles or omitted. " +
    "You set narrative + the public objective ONLY — never loot, xp, death, or rewards. No prose, no markdown.";
  const user =
    `Realm ${s.realmId}, tick ${s.tick || 0}. Current objective: ${s.objective?.title}. ` +
    `High-danger tiles: ${dangerTiles || "none"}. ` +
    `Recent events: ${(s.recentEvents || []).slice(-4).map((e) => e.text).join(" | ") || "none"}. ` +
    "Propose ONE bounded public beat that keeps the realm legible and tense.";
  const reply = await llm.chat({ system, user, json: true, maxTokens: 300 });
  const kind = DIRECTOR_KINDS.includes(reply?.kind) ? reply.kind : "rumor";
  const proposal = {
    kind,
    id: `dir_${kind}_${s.tick || 0}`,
    title: String(reply?.title || "").slice(0, 80),
    text: String(reply?.text || "").slice(0, 200),
    source: "gemma",
  };
  if (reply?.targetTileId && s.map.tiles[String(reply.targetTileId)]) {
    proposal.targetTileId = String(reply.targetTileId);
  }
  if (kind === "quest_beat") {
    proposal.questId = String(reply?.questId || "quest").slice(0, 40);
    proposal.stageId = String(reply?.stageId || "stage").slice(0, 40);
  }
  return proposal;
}

function ensureDirectorState(s) {
  if (!Array.isArray(s.directorQueue)) s.directorQueue = [];
  if (!s.gameMaster || typeof s.gameMaster !== "object") {
    s.gameMaster = { status: "idle", lastBeatTick: 0, lastBeatKind: null, beats: 0 };
  }
}

export function attachDirector({ store, env = process.env, llm = createLlmClient({ env }) } = {}) {
  const live = env.DIRECTOR_LIVE === "1";

  async function propose() {
    const world = store.getWorldState();
    if (!world?.sigmacraft?.map) return false;
    const s = world.sigmacraft;
    ensureDirectorState(s);
    const tick = s.tick || 0;

    // Pacing: don't pile up. Skip when the queue is full or a fresh beat was
    // proposed within the cooldown window (keeps feed writes bounded).
    if (s.directorQueue.length >= MAX_DIRECTOR_QUEUE) return false;
    if (s.directorQueue.length > 0 && tick - (s.gameMaster.lastBeatTick || 0) < DIRECTOR_BEAT_COOLDOWN_TICKS) {
      return false;
    }

    let proposal = null;
    try {
      proposal =
        live && llm.available()
          ? await callGemma(world, llm)
          : makeDirectorFallbackProposal(world);
    } catch {
      proposal = makeDirectorFallbackProposal(world); // hard fallback on any model failure
    }
    if (!proposal) return false;

    const clean = vDirectorProposals([proposal])[0]; // trust boundary; drops if malformed
    if (!clean) return false;

    s.directorQueue.push(clean);
    s.gameMaster.status = "proposing";
    s.gameMaster.lastBeatTick = tick;
    s.gameMaster.lastBeatKind = clean.kind;
    // Ambient/regenerable → IN-MEMORY ONLY. No store.putWorldState here (idle
    // quiescence; the persist signal lives in advance(), gated to player intents).
    return true;
  }

  return { propose, makeDirectorFallbackProposal };
}
