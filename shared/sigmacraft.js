// Sigmacraft — the fantasy-MMO projection layer over the existing SIGMA ABYSS
// shared world. This module is deterministic and dual-runtime (browser + node):
// no Node built-ins, no DOM, no Date, no Math.random. It only reads existing
// world/zone state and projects bounded read models + validates intent shapes.
// Authoritative mutation lives in server/sigmacraft.js under the world tick.
//
// Design rule (integrate-this §"don't create a parallel world"): Sigmacraft does
// NOT generate its own map or NPCs. "Places" ARE the existing zones; movement is
// gated by the same unlockedZones() rule the delve world already uses.

import { ZONES, ZONE_BY_ID, TOWN_ID, unlockedZones } from "./zones.js";

export const SIGMACRAFT_SCHEMA = "sigmacraft.world.v1";
export const SIGMACRAFT_REALM_ID = "sigmacraft_alpha";

// Player/agent intent kinds. Mapped onto existing primitives server-side.
export const SIGMACRAFT_INTENT_KINDS = Object.freeze(["move", "rest", "talk"]);

// Bounds the tick resolver and queue honour (integrate-this §"three-second tick
// budget"): cap intents processed per tick, carry overflow forward.
export const MAX_SIGMACRAFT_PENDING_INTENTS = 128;
export const MAX_SIGMACRAFT_TICK_INTENTS = 16;
export const MAX_SIGMACRAFT_RECENT_EVENTS = 40;

// One active public quest stage to start (integrate-this first-slice §9).
export const DEFAULT_SIGMACRAFT_OBJECTIVE = Object.freeze({
  questId: "ash_shrine",
  stageId: "ash_shrine_stage_1",
  title: "The Ash Shrine Has Gone Quiet",
  prompt: "Travel the danger zones and find why the shrine fell silent.",
});

// Fresh Sigmacraft section seeded under world.json. Pointers + bounded queues
// only — never a duplicate of durable account state or run state.
export function createSigmacraftState() {
  return {
    schema: SIGMACRAFT_SCHEMA,
    realmId: SIGMACRAFT_REALM_ID,
    tick: 0,
    pendingIntents: [],
    recentEvents: [],
    actorPlaces: {},
    objective: { ...DEFAULT_SIGMACRAFT_OBJECTIVE },
    // VCS account POINTERS only (token -> {vcsAccountId, snapshotVersion,
    // twitchLogin, identitySource, verified}). Never durable account state.
    vcsAccounts: {},
  };
}

function placeFromZone(zone) {
  if (!zone) return null;
  return {
    id: zone.id,
    name: zone.name,
    tier: zone.tier ?? 0,
    safe: Boolean(zone.safe),
    flavor: zone.flavor || "",
  };
}

// The zone an actor is currently standing in for Sigmacraft purposes. Falls back
// to the character's live zone, then town.
export function sigmacraftActorZoneId(sigmacraft, character) {
  const token = character?.token || character?.id || null;
  const tracked = token ? sigmacraft?.actorPlaces?.[token] : null;
  return tracked || character?.zoneId || character?.zone || TOWN_ID;
}

// Bounded list of valid actions from the actor's current place. Movement targets
// are the actor's unlocked zones (same gate as the delve world) plus town.
export function sigmacraftValidActions(character, currentZoneId) {
  const unlocked = new Set([TOWN_ID, ...unlockedZones(character).map((z) => z.id)]);
  const actions = [];
  for (const zone of ZONES) {
    if (zone.id === currentZoneId || !unlocked.has(zone.id)) continue;
    actions.push({ kind: "move", targetId: zone.id, label: `Travel to ${zone.name}` });
  }
  actions.push({ kind: "rest", label: "Rest" });
  return actions.slice(0, 24);
}

// Cheap read model for browser/agent/CLI consumers. Pure projection — never
// mutates. `character` may be null (anonymous/observer).
export function projectSigmacraftSnapshot(world, character = null) {
  const sigmacraft = world?.sigmacraft || createSigmacraftState();
  const token = character?.token || character?.id || null;
  const currentZoneId = sigmacraftActorZoneId(sigmacraft, character);
  const place = placeFromZone(ZONE_BY_ID[currentZoneId] || ZONE_BY_ID[TOWN_ID]);
  const pending = Array.isArray(sigmacraft.pendingIntents)
    ? sigmacraft.pendingIntents.find((intent) => intent.token === token) || null
    : null;
  return {
    schema: "sigmacraft.snapshot.v1",
    realmId: sigmacraft.realmId || SIGMACRAFT_REALM_ID,
    worldTick: sigmacraft.tick || 0,
    actorId: token,
    place,
    objective: sigmacraft.objective || null,
    validActions: character ? sigmacraftValidActions(character, currentZoneId) : [],
    pendingIntent: pending ? { kind: pending.kind, targetId: pending.targetId || null } : null,
    recentEvents: (sigmacraft.recentEvents || []).slice(-8),
  };
}
