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
  createSigmacraftState,
  seedSigmacraftOverworld,
} from "../shared/sigmacraft.js";

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
  // Heal/migrate the overworld map + population for pre-overworld worlds.
  seedSigmacraftOverworld(s, s.realmId || "sigmacraft_alpha");
  return s;
}

// Is there an unconsumed NPC plan waiting to surface?
function hasUnconsumedNpcPlan(sigmacraft) {
  const agents = sigmacraft?.npcAgents;
  if (!agents) return false;
  for (const a of Object.values(agents)) {
    if (a?.plan && !a.plan.consumed) return true;
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

// FAST sub-advancer: (ctx) => boolean. Returns true IFF it mutated world state,
// so the tick loop only persists on real changes. On an idle world it bumps
// nothing and writes nothing — avoiding ~20x world.json write amplification at
// the 3s base cadence (integrate-this §"three-second tick budget").
export function advance(ctx) {
  const world = ctx?.world;
  if (!world) return false;
  const sigmacraft = world.sigmacraft;
  // Idle fast path: no pending player intents AND no unconsumed NPC plan → no
  // mutation, no dirty flag (avoids ~20x world.json write amplification).
  const hasPending = Array.isArray(sigmacraft?.pendingIntents) && sigmacraft.pendingIntents.length > 0;
  if (!sigmacraft || (!hasPending && !hasUnconsumedNpcPlan(sigmacraft))) {
    return false;
  }
  ensureState(world);
  sigmacraft.tick = (sigmacraft.tick || 0) + 1;
  const tick = sigmacraft.tick;

  // Mirror each resolved event into the existing capped feed.json (Captain's
  // Log path) as well as the in-world ring buffer (integrate-this step 10).
  const emit = (text) => {
    appendEvent(sigmacraft, tick, text);
    ctx?.store?.pushFeed?.({ kind: "narrative", name: "Sigmacraft", detail: text });
  };

  const tiles = sigmacraft.map?.tiles || {};
  const batch = sigmacraft.pendingIntents.splice(0, MAX_SIGMACRAFT_TICK_INTENTS);
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

  // Consume up to MAX_NPC_EFFECTS_PER_TICK bounded NPC effects (integrate-this
  // PR7, scaled for the 200-agent overworld). Proposals were produced + validated
  // OFF the tick by server/sigmacraft-npc-agents.js; here we only apply a
  // re-checked tile move OR surface the line. Deterministic (cursor rotation),
  // bounded, zero-network. Overworld NPCs live in sigmacraft.overworldNpcs.
  const npcIds = Object.keys(sigmacraft.npcAgents)
    .filter((id) => sigmacraft.npcAgents[id]?.plan && !sigmacraft.npcAgents[id].plan.consumed)
    .sort();
  if (npcIds.length) {
    // Own cursor (NOT the planner's npcCursor) so the two lanes never collide.
    let cursor = ((sigmacraft.npcConsumeCursor || 0) % npcIds.length + npcIds.length) % npcIds.length;
    const applyCount = Math.min(MAX_NPC_EFFECTS_PER_TICK, npcIds.length);
    for (let i = 0; i < applyCount; i++) {
      const id = npcIds[(cursor + i) % npcIds.length];
      const agent = sigmacraft.npcAgents[id];
      const rec = sigmacraft.overworldNpcs?.[id];
      const npcName = rec?.name || id;
      if (agent.plan.step?.kind === "move") {
        const dest = tiles[agent.plan.step.targetId];
        const fromTile = tiles[rec?.tileId];
        if (dest && fromTile && fromTile.exits.includes(dest.id) && rec) {
          rec.tileId = dest.id;
          emit(`${npcName} moved to ${dest.name}.`);
        }
      } else if (agent.plan.dialogueLine) {
        appendEvent(sigmacraft, tick, `${npcName}: ${agent.plan.dialogueLine}`);
        ctx?.store?.pushFeed?.({ kind: "npc_dialogue", name: npcName, detail: agent.plan.dialogueLine });
      }
      agent.plan.consumed = true;
    }
    sigmacraft.npcConsumeCursor = (cursor + applyCount) % npcIds.length;
  }
  return true;
}
