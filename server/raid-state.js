// SIGMA ABYSS — raid engagement state.
//
// Tracks which chatters are "engaged" against the active raid boss. An
// engaged chatter's chat messages drive raid damage at a cadence
// controlled by their weapon's speedMul (dagger → almost every line,
// greatsword → every third line). The boss counter-attacks each landed
// swing — that's how !fight has real risk.
//
// Cleared at startRaid / endRaid by the caller in server.js.

import { WEAPON_FAMILIES } from "../shared/weapons.js";

// Map<login, { ticks, perSwing, weaponLabel, family }>
const engaged = new Map();

// Translate weaponMul → "chats per swing". 1.0 → 3, dagger 1.35 → 2,
// hammer 0.85 → 4, greatsword 0.8 → 4. Floor 1 (a faster-than-base
// fantasy weapon would hit every line).
export function chatsPerSwing(speedMul) {
  const mul = Number(speedMul) > 0 ? Number(speedMul) : 1.0;
  return Math.max(1, Math.round(3 / mul));
}

export function engage(login, weapon) {
  const key = String(login || "").toLowerCase();
  if (!key) return null;
  const family = weapon?.family || "fists";
  const fam = WEAPON_FAMILIES[family] || WEAPON_FAMILIES.fists;
  const entry = {
    ticks: 0,
    perSwing: chatsPerSwing(fam.speedMul),
    weaponLabel: fam.label,
    family,
  };
  engaged.set(key, entry);
  return entry;
}

export function disengage(login) {
  const key = String(login || "").toLowerCase();
  if (!key) return false;
  return engaged.delete(key);
}

export function isEngaged(login) {
  const key = String(login || "").toLowerCase();
  return engaged.has(key);
}

export function get(login) {
  const key = String(login || "").toLowerCase();
  return engaged.get(key) || null;
}

// Increment the per-chatter tick counter by N chat lines and return how
// many swings should fire. `entry.ticks` is reset to the remainder.
export function consumeChatTicks(login, lines = 1) {
  const key = String(login || "").toLowerCase();
  const entry = engaged.get(key);
  if (!entry) return 0;
  entry.ticks += Math.max(1, Number(lines) || 1);
  const swings = Math.floor(entry.ticks / entry.perSwing);
  entry.ticks = entry.ticks - swings * entry.perSwing;
  return swings;
}

export function clear() {
  engaged.clear();
}

export function logins() {
  return [...engaged.keys()];
}

export function size() {
  return engaged.size;
}
