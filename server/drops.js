// SIGMA ABYSS — agent-session drops pool.
//
// When a coding agent (claude-code, cursor, codex, …) spawns a session,
// something rains onto the arena: monsters, items, or XP orbs. Drops sit
// at arena coordinates with a TTL; chatters claim one by chatting (any
// real chat line via /api/chat-ping). First-in-first-out so a single
// active chatter can't sweep the whole pool — every chat line takes the
// oldest open drop. Drops awarded to a chatter persist to their
// character (gold added, XP added via gainXp, item dropped into
// inventory or vendored if full).

import crypto from "node:crypto";
import { INVENTORY_MAX } from "../shared/constants.js";
import { rollDrop } from "../shared/loot.js";
import { ensureStarterGear, gainXp } from "../shared/progression.js";
import { makeRng } from "../shared/rng.js";
import * as store from "./store.js";

// Default arena is 1920×1080; we keep drops away from the very edges so
// they're visible even on letterboxed embeds.
const ARENA_W = 1920;
const _ARENA_H = 1080;
const DROP_X_MIN = 120;
const DROP_X_MAX = ARENA_W - 120;
const DROP_Y_MIN = 220;
const DROP_Y_MAX = 820;

// Tunables. Override via env on a case-by-case basis.
const DROP_TTL_MS = Number(process.env.MMO_DROP_TTL_MS) || 90_000;
const DROP_POOL_MAX = Number(process.env.MMO_DROP_POOL_MAX) || 20;

// Pool: ordered by createdAt, oldest-first.
const pool = [];

function nowMs() {
  return Date.now();
}
function newId() {
  return `drop_${crypto.randomBytes(6).toString("hex")}`;
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pickCoord() {
  return {
    x: randInt(DROP_X_MIN, DROP_X_MAX),
    y: randInt(DROP_Y_MIN, DROP_Y_MAX),
  };
}

function publicDrop(d) {
  return {
    id: d.id,
    kind: d.kind,
    x: d.x,
    y: d.y,
    value: d.value,
    name: d.name || null,
    rarity: d.rarity || null,
    slot: d.slot || null,
    createdAt: d.createdAt,
    expiresAt: d.createdAt + DROP_TTL_MS,
  };
}

function pruneOldest() {
  while (pool.length > DROP_POOL_MAX) pool.shift();
}

// ── Spawners ──────────────────────────────────────────────────────────
// Each builds and pushes one drop. Returns the public shape.

// Tiny per-kill loot: always 1 xp blob, 1-in-3 a gold blob too. Sized
// to read as "you killed something" without polluting the open-drop
// pool — chat-driven kills can be very frequent.
export function spawnKillReward({ foeMaxHp = 60 } = {}) {
  const spawned = [];
  const xpVal = Math.max(8, Math.round(foeMaxHp * 0.25 + Math.random() * 12));
  spawned.push(spawnXp(xpVal));
  if (Math.random() < 0.33) {
    const goldVal = Math.max(5, Math.round(foeMaxHp * 0.15 + Math.random() * 20));
    spawned.push(spawnGold(goldVal));
  }
  return spawned;
}

function spawnXp(value) {
  const c = pickCoord();
  const drop = { id: newId(), kind: "xp", value: Math.max(1, value | 0), createdAt: nowMs(), ...c };
  pool.push(drop);
  pruneOldest();
  return publicDrop(drop);
}

function spawnGold(value) {
  const c = pickCoord();
  const drop = {
    id: newId(),
    kind: "gold",
    value: Math.max(1, value | 0),
    createdAt: nowMs(),
    ...c,
  };
  pool.push(drop);
  pruneOldest();
  return publicDrop(drop);
}

function spawnItem(itemLevel) {
  // rollDrop uses a deterministic RNG; for one-shot loot rolls we seed
  // off the system RNG so two simultaneous sessions don't produce the
  // same loot table.
  const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 0 || 1;
  const rng = makeRng(seed);
  const item = rollDrop({ rng, level: Math.max(1, itemLevel | 0) });
  if (!item) return null;
  const c = pickCoord();
  const drop = {
    id: newId(),
    kind: "item",
    value: item.value || 0,
    item,
    name: item.name,
    rarity: item.rarity,
    slot: item.slot,
    createdAt: nowMs(),
    ...c,
  };
  pool.push(drop);
  pruneOldest();
  return publicDrop(drop);
}

// ── Session event composer ────────────────────────────────────────────
// Given a session intensity (driven by viewer count + agent kind),
// returns the drops to spawn this round.

// Pure XP rain — heavier count, no items. Used by the xp_burst flavor.
export function spawnXpBurst({ intensity = 1 } = {}) {
  const k = Math.max(0.4, Math.min(4, Number(intensity) || 1));
  const xpCount = Math.round(2 + k * 1.5);
  const spawned = [];
  for (let i = 0; i < xpCount; i += 1) {
    spawned.push(spawnXp(12 + randInt(0, Math.round(30 * k))));
  }
  return spawned;
}

export function spawnSessionDrops({ intensity = 1, itemLevel = 5 } = {}) {
  // intensity ~1 = small drop, ~4 = pretty heavy. Clamp.
  const k = Math.max(0.4, Math.min(4, Number(intensity) || 1));
  const xpCount = Math.round(1 + k); // 2–5
  const goldCount = Math.round(1 + k * 0.5); // 1–3
  const itemCount = Math.max(1, Math.round(k * 0.5)); // 1–2

  const spawned = [];
  for (let i = 0; i < xpCount; i += 1) {
    spawned.push(spawnXp(8 + randInt(0, Math.round(20 * k))));
  }
  for (let i = 0; i < goldCount; i += 1) {
    spawned.push(spawnGold(15 + randInt(0, Math.round(45 * k))));
  }
  for (let i = 0; i < itemCount; i += 1) {
    const d = spawnItem(itemLevel);
    if (d) spawned.push(d);
  }
  return spawned;
}

// ── Claim ─────────────────────────────────────────────────────────────
// Caller (chat-ping handler) hands us a login. We resolve their persisted
// character, take the oldest open drop, apply it, persist. Returns the
// claim summary or null if there's nothing to claim / character missing.

// Apply a specific drop to a chatter's character. Caller is responsible
// for having removed the drop from `pool` already. Returns `{drop, login,
// summary}` on success, or `null` if the chatter has no sigma yet.
function applyDrop(key, drop) {
  const tok = store.getTokenByTwitch(key);
  if (!tok) return null;
  const rec = store.getPlayer(tok);
  if (!rec?.character) return null;
  ensureStarterGear(rec.character);

  let summary;
  if (drop.kind === "xp") {
    let levelsGained = 0;
    let newLevel = rec.character.run?.level || 1;
    if (rec.character.run && rec.character.run.alive !== false) {
      const r = gainXp(rec.character.run, drop.value);
      levelsGained = r.levelsGained || 0;
      newLevel = r.newLevel || newLevel;
    }
    summary = { kind: "xp", value: drop.value, levelsGained, newLevel };
  } else if (drop.kind === "gold") {
    rec.character.gold = (rec.character.gold || 0) + drop.value;
    summary = { kind: "gold", value: drop.value, gold: rec.character.gold };
  } else if (drop.kind === "item") {
    const inv = rec.character.run?.inventory;
    if (Array.isArray(inv) && inv.length < INVENTORY_MAX) {
      inv.push(drop.item);
      summary = {
        kind: "item",
        stored: "inventory",
        name: drop.item.name,
        rarity: drop.item.rarity,
        slot: drop.item.slot,
        effect: drop.item.effect || null,
      };
    } else {
      rec.character.gold = (rec.character.gold || 0) + (drop.item.value || 0);
      summary = {
        kind: "item",
        stored: "sold",
        name: drop.item.name,
        rarity: drop.item.rarity,
        slot: drop.item.slot,
        effect: drop.item.effect || null,
        gold: drop.item.value || 0,
      };
    }
  } else {
    return null;
  }

  rec.character.lastSeen = nowMs();
  rec.character.twitchLogin = key;
  store.putPlayer(tok, rec.character);

  return {
    drop: publicDrop(drop),
    login: key,
    summary,
  };
}

// Pop the drop with the matching id out of the pool, atomically. Returns
// the drop record or null if not present.
function takeDropById(id) {
  if (!id) return null;
  const idx = pool.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const [drop] = pool.splice(idx, 1);
  return drop;
}

// Claim a specific drop by id — the spatial-collision path. The chatter pet
// walked over THIS drop, not the oldest one. Atomic: the first hit pops the
// drop out so concurrent collisions can't double-credit. Returns `null` when
// the drop is already claimed/expired or the chatter has no Twitch sigma —
// in that "no sigma" case the drop is put back so a Twitch chatter can still
// grab it later.
export function tryClaimById(login, id) {
  const key = String(login || "").toLowerCase();
  if (!key || !id) return null;
  const drop = takeDropById(id);
  if (!drop) return null;
  if (drop.createdAt < nowMs() - DROP_TTL_MS) return null;
  const result = applyDrop(key, drop);
  if (!result) {
    // No sigma on this login — put the drop back at its original position
    // in the queue so a Twitch chatter can still claim it via chat-ping.
    pool.unshift(drop);
    return null;
  }
  return result;
}

export function tryClaim(login) {
  const key = String(login || "").toLowerCase();
  if (!key || !pool.length) return null;

  // Drop expired entries from the front before claiming.
  const cutoff = nowMs() - DROP_TTL_MS;
  while (pool.length && pool[0].createdAt < cutoff) pool.shift();
  if (!pool.length) return null;

  const drop = pool.shift();
  const result = applyDrop(key, drop);
  if (!result) {
    // No sigma on this login — put the drop back at the front so the next
    // claimant gets the same FIFO slot.
    pool.unshift(drop);
    return null;
  }
  return result;
}

// ── Reaper / snapshot ─────────────────────────────────────────────────

export function reap() {
  const cutoff = nowMs() - DROP_TTL_MS;
  const expired = [];
  while (pool.length && pool[0].createdAt < cutoff) {
    const d = pool.shift();
    expired.push({ id: d.id, at: nowMs() });
  }
  return expired;
}

export function snapshot() {
  return {
    ttlMs: DROP_TTL_MS,
    drops: pool.map(publicDrop),
  };
}

export function size() {
  return pool.length;
}
