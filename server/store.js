// SIGMA ABYSS — persistence.
//
// JSON-file store behind a tiny interface: in-memory is authoritative
// while the process runs, disk is a debounced atomic snapshot. Zero
// native deps — nothing to compile — so the server is genuinely
// "playable the moment it starts". Swapping to SQLite later is a
// one-file change behind these same exports.
//
// Self-healing: a corrupt store file is renamed aside and the server
// starts fresh rather than crash-looping on boot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEED_MAX } from "../shared/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default to the repo's ./data; `MMO_DATA_DIR` overrides it so a test or a
// second instance can run fully isolated from a live server's store (the
// live game must never have its players.json raced by a test boot).
const DATA_DIR = process.env.MMO_DATA_DIR || path.join(__dirname, "..", "data");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const FEED_FILE = path.join(DATA_DIR, "feed.json");
const TWITCH_LINKS_FILE = path.join(DATA_DIR, "twitch-links.json");
const AGENTS_FILE = path.join(DATA_DIR, "agents.json");
const ORACLE_TASKS_FILE = path.join(DATA_DIR, "oracle-tasks.json");
const WORLD_FILE = path.join(DATA_DIR, "world.json");
const MARKET_FILE = path.join(DATA_DIR, "market.json");

let players = new Map(); // token -> { character, updatedAt }
let feed = []; // newest-first, capped at FEED_MAX
let twitchLinks = new Map(); // twitch login (lowercased) -> token
let agents = new Map(); // agent bearer token -> agent character (Agent Realm)
let oracleTasks = new Map(); // HIT id -> oracle task (Oracle Bazaar)
let world = null; // the single shared-world document (master §0.5), or null until init
let market = null; // the market document (listings + buy orders), or null until init
let zoneEvents = []; // bounded buffer of {zoneId, kind, n} drained by the world tick
let dirty = false;
let linksDirty = false;
let agentsDirty = false;
let tasksDirty = false;
let worldDirty = false;
let marketDirty = false;

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    console.warn(`[store] corrupt ${path.basename(file)} — starting fresh: ${e.message}`);
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

export function initStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = readJsonSafe(PLAYERS_FILE, {});
  players = new Map(Object.entries(p && typeof p === "object" && !Array.isArray(p) ? p : {}));
  const f = readJsonSafe(FEED_FILE, []);
  feed = Array.isArray(f) ? f.slice(0, FEED_MAX) : [];
  const links = readJsonSafe(TWITCH_LINKS_FILE, {});
  twitchLinks = new Map(
    Object.entries(links && typeof links === "object" && !Array.isArray(links) ? links : {}),
  );
  const ag = readJsonSafe(AGENTS_FILE, {});
  agents = new Map(Object.entries(ag && typeof ag === "object" && !Array.isArray(ag) ? ag : {}));
  const ot = readJsonSafe(ORACLE_TASKS_FILE, {});
  oracleTasks = new Map(
    Object.entries(ot && typeof ot === "object" && !Array.isArray(ot) ? ot : {}),
  );
  console.log(
    `[store] loaded ${players.size} players, ${feed.length} feed entries, ${twitchLinks.size} twitch links, ${agents.size} agents, ${oracleTasks.size} oracle tasks`,
  );
}

// ── Agent Realm: agent characters keyed by bearer token ───────────────────
export function getAgent(token) {
  return agents.get(token) || null;
}
export function putAgent(token, character) {
  agents.set(token, character);
  agentsDirty = true;
}
export function allAgents() {
  return [...agents.values()];
}
export function agentCount() {
  return agents.size;
}

// ── Oracle Bazaar: inference HITs keyed by id ─────────────────────────────
export function getOracleTask(id) {
  return oracleTasks.get(id) || null;
}
export function putOracleTask(id, task) {
  oracleTasks.set(id, task);
  tasksDirty = true;
}
export function allOracleTasks() {
  return [...oracleTasks.values()];
}
export function deleteOracleTask(id) {
  if (oracleTasks.delete(id)) tasksDirty = true;
}

// ── Persistent shared world (master §0.5) ─────────────────────────────
// ONE namespaced document (data/world.json). Loaded once, seeded from the
// passed factory if absent or corrupt; the world tick mutates it in memory
// and persistence rides the same debounced atomic flush as everything else.
export function initWorldState(makeInitial) {
  const raw = readJsonSafe(WORLD_FILE, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    world = raw;
  } else {
    world = typeof makeInitial === "function" ? makeInitial() : {};
    worldDirty = true; // persist the seeded world on the next flush
  }
  console.log(
    `[store] world loaded — epoch ${world?.epoch ?? 0}, ${Object.keys(world?.factions || {}).length} factions, ${Object.keys(world?.zones || {}).length} zones`,
  );
  return world;
}

export function getWorldState() {
  return world;
}

export function putWorldState(w) {
  world = w;
  worldDirty = true;
}

// VCS account POINTERS (integrate-this PR3) live in the world.sigmacraft
// namespace, keyed by anon token — pointers only, never durable account state.
export function getVcsAccount(token) {
  return world?.sigmacraft?.vcsAccounts?.[token] || null;
}

// Upsert a resolved pointer. The store stays "dumb" (no validate/vcs-bridge
// import) — the caller passes the derived pointer. Churn guard: an unchanged
// pointer does NOT raise worldDirty, so a linked viewer reconnecting every few
// seconds never rewrites world.json.
export function upsertVcsAccount(token, pointer) {
  if (!world || !token || !pointer) return null;
  if (!world.sigmacraft || typeof world.sigmacraft !== "object") world.sigmacraft = {};
  if (!world.sigmacraft.vcsAccounts || typeof world.sigmacraft.vcsAccounts !== "object") {
    world.sigmacraft.vcsAccounts = {};
  }
  const prev = world.sigmacraft.vcsAccounts[token] || null;
  const next = {
    vcsAccountId: pointer.vcsAccountId,
    snapshotVersion: Number.isInteger(pointer.snapshotVersion)
      ? pointer.snapshotVersion
      : prev?.snapshotVersion || 0,
    twitchLogin: pointer.twitchLogin || null,
    identitySource: pointer.identitySource || "anonymous",
    verified: pointer.verified === true,
  };
  if (
    prev &&
    prev.vcsAccountId === next.vcsAccountId &&
    prev.snapshotVersion === next.snapshotVersion &&
    prev.twitchLogin === next.twitchLogin &&
    prev.identitySource === next.identitySource &&
    prev.verified === next.verified
  ) {
    return prev; // unchanged — no world.json rewrite
  }
  world.sigmacraft.vcsAccounts[token] = next;
  worldDirty = true;
  return next;
}

// Cheap fire-and-forget zone signal (a kill, a death) that the world tick
// drains and folds into zone pressure. Bounded so a flood can't grow it.
const ZONE_EVENTS_MAX = 2000;
export function notifyZoneEvent(zoneId, kind, n = 1) {
  if (!zoneId) return;
  zoneEvents.push({ zoneId, kind: kind || "ping", n });
  if (zoneEvents.length > ZONE_EVENTS_MAX)
    zoneEvents.splice(0, zoneEvents.length - ZONE_EVENTS_MAX);
}

export function drainZoneEvents() {
  if (zoneEvents.length === 0) return [];
  const out = zoneEvents;
  zoneEvents = [];
  return out;
}

// ── Market document (master §0.5 — the SECOND store doc) ──────────────
// Split out of world.json because at hundreds of ~5KB listings the atomic
// world write would get slow ([A2 §9.6]). Same load/seed/flush pattern.
export function initMarketState(makeInitial) {
  const raw = readJsonSafe(MARKET_FILE, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    market = raw;
  } else {
    market = typeof makeInitial === "function" ? makeInitial() : { listings: {}, buyOrders: {} };
    marketDirty = true;
  }
  if (!market.listings || typeof market.listings !== "object") market.listings = {};
  if (!market.buyOrders || typeof market.buyOrders !== "object") market.buyOrders = {};
  console.log(
    `[store] market loaded — ${Object.keys(market.listings).length} listings, ${Object.keys(market.buyOrders).length} buy orders`,
  );
  return market;
}

export function getMarket() {
  return market;
}

export function putMarket(m) {
  market = m;
  marketDirty = true;
}

export function getPlayer(token) {
  return players.get(token) || null;
}

export function putPlayer(token, character) {
  players.set(token, { character, updatedAt: Date.now() });
  dirty = true;
}

export function allPlayers() {
  return [...players.values()];
}

export function playerCount() {
  return players.size;
}

// Append a feed entry. `persist:false` adds it to the live in-memory ring (so /api/feed
// and WS viewers still see it) WITHOUT raising the disk-persist signal — used for
// ambient, regenerable Sigmacraft narration (NPC/director flavor). That keeps a
// player-less server at a true zero-write steady state (the players.json+feed.json
// analogue of the world.json idle-quiescence guard / PSU power safety). Ephemeral
// entries still ride to disk opportunistically the next time a real event dirties
// the store; they are simply never the CAUSE of a write.
export function pushFeed(entry, { persist = true } = {}) {
  const e = { ...entry, at: Date.now() };
  feed.unshift(e);
  if (feed.length > FEED_MAX) feed.length = FEED_MAX;
  if (persist) dirty = true;
  return e;
}

export function getFeed() {
  return feed;
}

// Called on a supervised interval by server.js. No-op unless something
// changed; on write failure it keeps `dirty` set so the next tick retries.
export function flush() {
  if (!dirty && !linksDirty && !agentsDirty && !tasksDirty && !worldDirty && !marketDirty) return;
  try {
    if (dirty) {
      writeJsonAtomic(PLAYERS_FILE, Object.fromEntries(players));
      writeJsonAtomic(FEED_FILE, feed);
      dirty = false;
    }
    if (linksDirty) {
      writeJsonAtomic(TWITCH_LINKS_FILE, Object.fromEntries(twitchLinks));
      linksDirty = false;
    }
    if (agentsDirty) {
      writeJsonAtomic(AGENTS_FILE, Object.fromEntries(agents));
      agentsDirty = false;
    }
    if (tasksDirty) {
      writeJsonAtomic(ORACLE_TASKS_FILE, Object.fromEntries(oracleTasks));
      tasksDirty = false;
    }
    if (worldDirty && world) {
      writeJsonAtomic(WORLD_FILE, world);
      worldDirty = false;
    }
    if (marketDirty && market) {
      writeJsonAtomic(MARKET_FILE, market);
      marketDirty = false;
    }
  } catch (e) {
    console.error(`[store] flush failed (will retry): ${e.message}`);
    // leave every dirty flag set for retry
    dirty = dirty || true;
    linksDirty = linksDirty || true;
    agentsDirty = agentsDirty || true;
    tasksDirty = tasksDirty || true;
    worldDirty = worldDirty || true;
    marketDirty = marketDirty || true;
  }
}

// ── Twitch identity bridge ────────────────────────────────────────────
// Channel-point redemptions key by twitch login; this maps to an internal
// anon token so the chatter doesn't need to claim a sigma manually before
// redeeming.

export function getTokenByTwitch(login) {
  return twitchLinks.get(String(login).toLowerCase()) || null;
}

export function linkTwitch(login, token) {
  const key = String(login).toLowerCase();
  twitchLinks.set(key, token);
  linksDirty = true;
}

export function allTwitchLinks() {
  return Object.fromEntries(twitchLinks);
}

// Dedup ring for boss-spawn events. CF Worker retries + double-fire
// from two independent sources (twitch-events + IRC USERNOTICE) both
// land here; an event_id seen once short-circuits the broadcast.
const seenBossEvents = new Set();
const BOSS_DEDUP_MAX = 512;

export function markBossEvent(id) {
  if (!id) return false;
  if (seenBossEvents.has(id)) return true;
  seenBossEvents.add(id);
  if (seenBossEvents.size > BOSS_DEDUP_MAX) {
    const first = seenBossEvents.values().next().value;
    seenBossEvents.delete(first);
  }
  return false;
}
