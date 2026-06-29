// Sigmacraft authoritative lane. Runs as a FAST sub-advancer (every base tick,
// ~3s) under the single supervised world tick — never its own timer. It resolves
// bounded, already-validated intents and emits world events. No Gemma, no
// network, no blocking IO here (integrate-this §"three-second tick budget").
//
// Validation happens at the trust boundary (server/validate.js + the enqueue
// path) so this resolver can trust intent SHAPE; it still re-checks that target
// zones exist before mutating.

import {
  MAX_SIGMACRAFT_PENDING_INTENTS,
  MAX_SIGMACRAFT_TICK_INTENTS,
  MAX_SIGMACRAFT_RECENT_EVENTS,
  MAX_NPC_EFFECTS_PER_TICK,
  MAX_DIRECTOR_EFFECTS_PER_TICK,
  NPC_SUPPLY_CAP,
  NPC_MOOD_MIN,
  NPC_MOOD_MAX,
  createSigmacraftState,
  deriveNextStep,
  seedSigmacraftOverworld,
  tileSupportsAction,
} from "../shared/sigmacraft.js";

const clampMood = (v) => Math.max(NPC_MOOD_MIN, Math.min(NPC_MOOD_MAX, v));

function ensureState(world) {
  if (!world.sigmacraft || typeof world.sigmacraft !== "object") {
    world.sigmacraft = createSigmacraftState();
  }
  const s = world.sigmacraft;
  if (!Array.isArray(s.pendingIntents)) s.pendingIntents = [];
  if (!Array.isArray(s.recentEvents)) s.recentEvents = [];
  if (!s.actorPlaces || typeof s.actorPlaces !== "object") s.actorPlaces = {};
  if (!s.vcsAccounts || typeof s.vcsAccounts !== "object") s.vcsAccounts = {};
  if (!s.npcAgents || typeof s.npcAgents !== "object") s.npcAgents = {};
  if (!Number.isFinite(s.npcCursor)) s.npcCursor = 0;
  if (!Number.isFinite(s.npcConsumeCursor)) s.npcConsumeCursor = 0;
  if (!Array.isArray(s.directorQueue)) s.directorQueue = [];
  if (!s.gameMaster || typeof s.gameMaster !== "object") {
    s.gameMaster = { status: "idle", lastBeatTick: 0, lastBeatKind: null, beats: 0 };
  }
  // Heal/migrate the overworld map + population for pre-overworld worlds.
  seedSigmacraftOverworld(s, s.realmId || "sigmacraft_alpha");
  return s;
}

// Does any NPC still have an agenda to walk? (cursor not yet past the end)
function hasActiveNpcAgenda(sigmacraft) {
  const agents = sigmacraft?.npcAgents;
  if (!agents) return false;
  for (const a of Object.values(agents)) {
    const p = a?.plan;
    if (p?.agenda && Array.isArray(p.agenda) && (p.cursor || 0) < p.agenda.length) return true;
  }
  return false;
}

function appendEvent(sigmacraft, tick, text) {
  sigmacraft.recentEvents.push({ tick, text });
  const overflow = sigmacraft.recentEvents.length - MAX_SIGMACRAFT_RECENT_EVENTS;
  if (overflow > 0) sigmacraft.recentEvents.splice(0, overflow);
}

// Stable, NON-reversible short label for public events — never leak raw token
// bytes into the snapshot/feed (FNV-1a → base36, 4 chars).
function actorName(token) {
  let h = 0x811c9dc5;
  const s = String(token || "anon");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `Wanderer ${(h >>> 0).toString(36).slice(-4)}`;
}

// Queue a validated intent for the next tick. One pending intent per actor +
// idempotent nonce de-dup. Returns the queue status for the response.
export function enqueueSigmacraftIntent(world, token, intent) {
  const sigmacraft = ensureState(world);
  // Idempotency: a resubmit of the same non-empty nonce returns the existing
  // queued status without re-queuing (de-dup, integrate-this PR5).
  const nonce = intent?.nonce || "";
  const existing = sigmacraft.pendingIntents.find((p) => p.token === token);
  if (existing && nonce && existing.nonce === nonce) {
    return { status: "queued", resolvesAfterWorldTick: (sigmacraft.tick || 0) + 1, deduped: true };
  }
  sigmacraft.pendingIntents = sigmacraft.pendingIntents.filter((p) => p.token !== token);
  if (sigmacraft.pendingIntents.length >= MAX_SIGMACRAFT_PENDING_INTENTS) {
    return { status: "rejected", reason: "queue_full" };
  }
  sigmacraft.pendingIntents.push({ token, ...intent });
  return { status: "queued", resolvesAfterWorldTick: (sigmacraft.tick || 0) + 1 };
}

// FAST sub-advancer: (ctx) => boolean. The boolean is the PERSIST signal: true
// IFF this tick produced a player-driven, durable mutation that must reach
// world.json. NPC ambient churn (planner output + overworldNpcs movement) is
// deterministically regenerable from seed, so it advances the in-memory world for
// live viewers but NEVER raises the dirty flag. Otherwise a player-less server —
// where the 15s planner keeps manufacturing fresh plans — would rewrite world.json
// every ~3s forever instead of reaching a quiescent steady state (write
// amplification / PSU power safety; integrate-this §"three-second tick budget").
export function advance(ctx) {
  const world = ctx?.world;
  if (!world) return false;
  const sigmacraft = world.sigmacraft;
  // Idle fast path: nothing pending, no NPC plan, no director beat → no work at all.
  const hasPending = Array.isArray(sigmacraft?.pendingIntents) && sigmacraft.pendingIntents.length > 0;
  const hasDirectorWork = Array.isArray(sigmacraft?.directorQueue) && sigmacraft.directorQueue.length > 0;
  if (!sigmacraft || (!hasPending && !hasActiveNpcAgenda(sigmacraft) && !hasDirectorWork)) {
    return false;
  }
  ensureState(world);
  sigmacraft.tick = (sigmacraft.tick || 0) + 1;
  const tick = sigmacraft.tick;
  // Only player-driven mutations make the world dirty; NPC ambient effects don't.
  let dirty = false;

  // Mirror each resolved event into the existing capped feed.json (Captain's
  // Log path) as well as the in-world ring buffer (integrate-this step 10).
  // `emit` is for PLAYER-driven narration → persists. `emitAmbient` is for
  // NPC/director flavor → live in the ring + feed but NEVER forces a disk write, so
  // an idle/player-less server stays write-quiescent on feed.json/players.json too
  // (the disk analogue of the world.json idle guard; PSU power safety).
  const emit = (text) => {
    appendEvent(sigmacraft, tick, text);
    ctx?.store?.pushFeed?.({ kind: "narrative", name: "Sigmacraft", detail: text });
  };
  const emitAmbient = (text) => {
    appendEvent(sigmacraft, tick, text);
    ctx?.store?.pushFeed?.({ kind: "narrative", name: "Sigmacraft", detail: text }, { persist: false });
  };

  const tiles = sigmacraft.map?.tiles || {};
  const batch = sigmacraft.pendingIntents.splice(0, MAX_SIGMACRAFT_TICK_INTENTS);
  // Draining queued player intents IS a durable mutation (the splice removed them
  // from the persisted queue; a move rewrites actorPlaces) → persist this tick.
  if (batch.length) dirty = true;
  for (const intent of batch) {
    const token = intent.token;
    if (intent.kind === "move") {
      // Apply-time existence + adjacency re-check (the stateless boundary can't
      // prove the tile graph): the destination must be an exit of the current tile.
      const from = sigmacraft.actorPlaces[token] || sigmacraft.map?.townTileId;
      const fromTile = tiles[from];
      const dest = tiles[intent.targetId];
      if (!dest || !fromTile || !fromTile.exits.includes(dest.id)) {
        emit(`${actorName(token)} could not find that road.`);
        continue;
      }
      sigmacraft.actorPlaces[token] = dest.id;
      emit(`${actorName(token)} traveled to ${dest.name}.`);
    } else if (intent.kind === "rest") {
      const here = tiles[sigmacraft.actorPlaces[token]];
      emit(`${actorName(token)} rested${here ? ` at ${here.name}` : ""}.`);
    } else if (intent.kind === "talk") {
      emit(`${actorName(token)} traded word with the locals.`);
    }
  }

  // TACTICAL LAYER: cascade each active NPC's strategic agenda into ONE concrete
  // primitive this tick (integrate-this PR-C). Agendas were proposed + validated OFF
  // the tick (server/sigmacraft-npc-agents.js); here we DERIVE the next step
  // (deriveNextStep: walk toward the objective tile, or perform the action on
  // arrival) and apply its bounded effect on REAL npc state — tileId / supplies /
  // moodValue — never player loot/XP/death/market. Deterministic, bounded
  // (MAX_NPC_EFFECTS_PER_TICK), zero-network. Re-checks adjacency + tile support, so
  // a bad agenda can't teleport or do an unsupported action. Ambient ⇒ not `dirty`.
  const npcIds = Object.keys(sigmacraft.npcAgents)
    .filter((id) => {
      const p = sigmacraft.npcAgents[id]?.plan;
      return p?.agenda && Array.isArray(p.agenda) && (p.cursor || 0) < p.agenda.length;
    })
    .sort();
  if (npcIds.length) {
    // Own cursor (NOT the planner's npcCursor) so the two lanes never collide.
    let cursor = ((sigmacraft.npcConsumeCursor || 0) % npcIds.length + npcIds.length) % npcIds.length;
    const applyCount = Math.min(MAX_NPC_EFFECTS_PER_TICK, npcIds.length);
    for (let i = 0; i < applyCount; i++) {
      const id = npcIds[(cursor + i) % npcIds.length];
      const agent = sigmacraft.npcAgents[id];
      const rec = sigmacraft.overworldNpcs?.[id];
      if (!rec) { agent.plan.cursor = agent.plan.agenda.length; continue; }
      const npcName = rec.name || id;
      const step = deriveNextStep(rec, agent.plan.agenda, agent.plan.cursor || 0, tiles);
      const here = tiles[rec.tileId];
      // Terminal actions re-check tile support at apply time (deriveNextStep already
      // gates this; the redundant guard keeps the apply path honest as defense-in-depth).
      const supported = step.kind === "move" || step.kind === "talk" || tileSupportsAction(here, step.kind);
      switch (supported ? step.kind : "noop") {
        case "move": {
          // BFS already returns an adjacent hop; re-check adjacency as defense.
          const dest = tiles[step.targetId];
          if (dest && here && here.exits.includes(dest.id)) {
            rec.tileId = dest.id;
            emitAmbient(`${npcName} traveled to ${dest.name}.`);
          }
          break;
        }
        case "gather":
          rec.supplies = Math.min(NPC_SUPPLY_CAP, (rec.supplies || 0) + 1);
          emitAmbient(`${npcName} gathered supplies${here ? ` in ${here.name}` : ""}.`);
          break;
        case "fight":
          rec.moodValue = clampMood((rec.moodValue ?? 50) + 4);
          emitAmbient(`${npcName} clashed with danger${here ? ` in ${here.name}` : ""}.`);
          break;
        case "rest":
          rec.moodValue = clampMood((rec.moodValue ?? 50) + 8);
          emitAmbient(`${npcName} rested${here ? ` at ${here.name}` : ""}.`);
          break;
        case "craft":
          if ((rec.supplies || 0) > 0) {
            rec.supplies -= 1;
            rec.moodValue = clampMood((rec.moodValue ?? 50) + 3);
            emitAmbient(`${npcName} crafted something${here ? ` at ${here.name}` : ""}.`);
          } else {
            emitAmbient(`${npcName} lacks supplies to craft${here ? ` at ${here.name}` : ""}.`);
          }
          break;
        case "talk":
          if (agent.plan.dialogueLine) {
            appendEvent(sigmacraft, tick, `${npcName}: ${agent.plan.dialogueLine}`);
            ctx?.store?.pushFeed?.({ kind: "npc_dialogue", name: npcName, detail: agent.plan.dialogueLine }, { persist: false });
          }
          break;
        default:
          break; // "noop" — arrived / skipped / unsupported objective
      }
      if (step.objectiveComplete) agent.plan.cursor = (agent.plan.cursor || 0) + 1;
    }
    sigmacraft.npcConsumeCursor = (cursor + applyCount) % npcIds.length;
  }

  // Consume up to MAX_DIRECTOR_EFFECTS_PER_TICK validated game-master beats
  // (integrate-this PR9). The Director owns NO authority: a quest_beat updates the
  // PUBLIC objective; every kind surfaces a narrative event. Proposals were already
  // validated OFF the tick by server/sigmacraft-director.js. Ambient/regenerable →
  // never sets `dirty` (idle quiescence), same rule as the NPC lane.
  if (Array.isArray(sigmacraft.directorQueue) && sigmacraft.directorQueue.length) {
    const beats = sigmacraft.directorQueue.splice(0, MAX_DIRECTOR_EFFECTS_PER_TICK);
    const gm =
      sigmacraft.gameMaster ||
      (sigmacraft.gameMaster = { status: "idle", lastBeatTick: 0, lastBeatKind: null, beats: 0 });
    for (const beat of beats) {
      if (beat.kind === "quest_beat") {
        sigmacraft.objective = {
          questId: beat.questId || sigmacraft.objective?.questId || "",
          stageId: beat.stageId || sigmacraft.objective?.stageId || "",
          title: beat.title || sigmacraft.objective?.title || "",
          prompt: beat.text || sigmacraft.objective?.prompt || "",
        };
        emitAmbient(`Director: ${beat.title || beat.text}`);
      } else {
        emitAmbient(beat.text || beat.title || "The realm stirs.");
      }
      gm.beats = (gm.beats || 0) + 1;
      gm.lastBeatKind = beat.kind;
    }
    gm.status = sigmacraft.directorQueue.length ? "proposing" : "idle";
  }
  return dirty;
}
