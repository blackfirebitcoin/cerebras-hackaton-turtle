// SIGMA ABYSS — faction reputation engine (master design §3.1, [A7]).
//
// The SIDE-EFFECTING faction helpers, kept out of the pure factions.js catalog.
// applyKillRep mutates character.factionRep (account-side) deterministically —
// it draws NO rng, so calling it from delveTick after the rng-state save keeps
// offline sim in parity. PURE ESM, RNG-free.

import { FACTION_MAX_REP, factionRank, factionRepGainForKill, isRival } from "./factions.js";

export const REP_HOURLY_CAP = 50; // master §7.2 anti-farm cap

// Grant faction rep for a killing-encounter. `killKind` is the toughest thing
// killed this encounter ("boss"|"elite"|"normal"). Mutates character.factionRep
// in place; returns the rep gained (0 if no faction or out of home zone). The
// hourly cap is honoured via character.repHourBucket / repThisHour (account).
export function applyKillRep(character, zoneId, killKind, now = 0) {
  const fid = character?.faction;
  if (!fid) return 0;
  const gain = factionRepGainForKill(zoneId, fid, killKind);
  if (gain <= 0) return 0;

  // Hourly anti-farm cap (master §7.2). ONLY applied when a wall-clock `now`
  // is supplied (server-side). The deterministic delve path passes now=0 →
  // no wall-clock dependency → offline sim stays in parity (the cap is an
  // anti-abuse measure, not a sim-critical one).
  let applied = gain;
  if (now > 0) {
    const hour = Math.floor(now / 3_600_000);
    if (character.repHourBucket !== hour) {
      character.repHourBucket = hour;
      character.repThisHour = 0;
    }
    applied = Math.min(gain, Math.max(0, REP_HOURLY_CAP - (character.repThisHour || 0)));
    if (applied <= 0) return 0;
    character.repThisHour = (character.repThisHour || 0) + applied;
  }

  if (!character.factionRep || typeof character.factionRep !== "object") character.factionRep = {};
  character.factionRep[fid] = Math.min(FACTION_MAX_REP, (character.factionRep[fid] || 0) + applied);
  character.factionRank = factionRank(character.factionRep[fid]);
  return applied;
}

// Loot/danger bias from holding (or contesting) a zone. Pure scalar — feeds the
// encounter pool / loot bias, NOT run.danger directly (master §C20).
export function encounterBias(character, worldZone) {
  if (!character?.faction || !worldZone) return 0;
  const owner = worldZone.conquestOwner;
  if (!owner) return 0;
  if (owner === character.faction) return 1; // home turf — slightly richer pulls
  if (isRival(owner, character.faction)) return -1; // hostile turf — leaner
  return 0;
}

// Has a faction's weekly kill total crossed the war-declaration threshold?
export function checkWarThreshold(factionState, threshold = 1000) {
  return (factionState?.weeklyKills || 0) >= threshold;
}

// Aggregate per-faction weekly kills from a player list (for the war board).
export function aggregateKillsForWar(players) {
  const out = {};
  for (const c of players) {
    const fid = c?.faction;
    if (!fid) continue;
    out[fid] = (out[fid] || 0) + (c.lifetimeKills || 0);
  }
  return out;
}
