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
import { NPCS } from "./npc-defs.js";

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
    enemies: Array.isArray(zone.enemies) ? zone.enemies.slice(0, 4) : [],
  };
}

// The zone an actor is currently standing in for Sigmacraft purposes. An explicit
// viewer token (the WS/intent token) wins, then the character's tracked place,
// then the character's live zone, then town.
export function sigmacraftActorZoneId(sigmacraft, character, token = null) {
  const key = token || character?.token || character?.id || null;
  const tracked = key ? sigmacraft?.actorPlaces?.[key] : null;
  return tracked || character?.zoneId || character?.zone || TOWN_ID;
}

// World-map read model: every zone with reachability for the current actor.
function projectZones(character, currentZoneId) {
  const unlocked = new Set([TOWN_ID, ...unlockedZones(character).map((z) => z.id)]);
  return ZONES.map((zone) => ({
    id: zone.id,
    name: zone.name,
    tier: zone.tier ?? 0,
    safe: Boolean(zone.safe),
    current: zone.id === currentZoneId,
    unlocked: character ? unlocked.has(zone.id) : false,
  }));
}

// Who else is in the actor's current zone — existing NPCs (no parallel world) and
// other player actors — for the side-scrolling scene. Bounded.
function projectOccupants(world, sigmacraft, currentZoneId, selfToken) {
  const out = [];
  for (const npc of Object.values(world?.npcs || {})) {
    if (npc.zoneId !== currentZoneId) continue;
    out.push({
      id: npc.id,
      kind: "npc",
      name: NPCS[npc.id]?.name || npc.id,
      faction: npc.factionId || null,
      mood: Number.isFinite(npc.moodValue) ? npc.moodValue : 50,
    });
    if (out.length >= 16) break;
  }
  for (const [tok, zid] of Object.entries(sigmacraft?.actorPlaces || {})) {
    if (zid !== currentZoneId || tok === selfToken) continue;
    out.push({ id: tok.slice(-4), kind: "player", name: `Wanderer ${tok.slice(-4)}` });
    if (out.length >= 24) break;
  }
  return out;
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
export function projectSigmacraftSnapshot(world, character = null, opts = {}) {
  const sigmacraft = world?.sigmacraft || createSigmacraftState();
  const token = opts.token || character?.token || character?.id || null;
  const currentZoneId = sigmacraftActorZoneId(sigmacraft, character, token);
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
    zones: projectZones(character, currentZoneId),
    occupants: projectOccupants(world, sigmacraft, currentZoneId, token),
    objective: sigmacraft.objective || null,
    validActions: character ? sigmacraftValidActions(character, currentZoneId) : [],
    pendingIntent: pending ? { kind: pending.kind, targetId: pending.targetId || null } : null,
    recentEvents: (sigmacraft.recentEvents || []).slice(-8),
  };
}
