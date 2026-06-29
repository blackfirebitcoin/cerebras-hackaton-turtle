// SIGMA ABYSS — the realtime (WebSocket) layer.
//
// Many viewers play their own sigma at once; this is what makes the
// world feel populated. Per-connection it does identity (anon tokens),
// server-side save persistence, and the shared social feed +
// leaderboard + live player count. Every inbound frame is size-capped
// (ws maxPayload), rate-limited, strictly validated, and handled inside
// a guard() — one player's bad message can never reach another or the
// process.

import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import {
  SAVE_MIN_INTERVAL_MS,
  WS_MAX_CONNECTIONS,
  WS_MSG_MAX_BYTES,
  WS_RATE,
} from "../shared/constants.js";
import * as arena from "./arena.js";
import * as drops from "./drops.js";
import * as store from "./store.js";
import { guard } from "./supervisor.js";
import { parseMessage, ValidationError } from "./validate.js";

function newToken() {
  return `sig_${crypto.randomBytes(12).toString("hex")}`; // sig_ + 24 hex
}

// Top players: prestige, then all-time level, then lifetime kills.
function leaderboard(limit = 12) {
  return store
    .allPlayers()
    .map((p) => p.character)
    .filter(Boolean)
    .map((c) => ({
      name: c.name,
      prestige: c.prestige || 0,
      level: c.highestLevel || c.run?.level || 1,
      kills: c.lifetimeKills || 0,
      bestDepth: c.bestDepth || 0,
      streak: c.bestStreak || 0,
      title: c.titles?.[c.titles.length - 1] || null,
    }))
    .sort((a, b) => b.prestige - a.prestige || b.level - a.level || b.kills - a.kills)
    .slice(0, limit);
}

export function attachRealtime(httpServer, { getRaid } = {}) {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MSG_MAX_BYTES });
  const clients = new Set();

  const onlineCount = () => {
    let n = 0;
    for (const ws of clients) if (ws.token) n += 1;
    return n;
  };

  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket gone */
      }
    }
  };
  const broadcast = (obj) => {
    const msg = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(msg);
        } catch {
          /* drop */
        }
      }
    }
  };

  wss.on("connection", (ws) => {
    if (clients.size >= WS_MAX_CONNECTIONS) {
      send(ws, { t: "error", msg: "server full — try again shortly" });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    ws.isAlive = true;
    ws.token = null;
    ws.rate = []; // sliding-window timestamps
    ws.lastSaveAt = 0;
    clients.add(ws);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on(
      "message",
      guard("ws.message", (raw) => {
        const now = Date.now();

        // Per-connection rate limit.
        ws.rate = ws.rate.filter((t) => now - t < WS_RATE.windowMs);
        if (ws.rate.length >= WS_RATE.max) {
          send(ws, { t: "error", msg: "rate limited — slow down" });
          return;
        }
        ws.rate.push(now);

        let parsed;
        try {
          parsed = parseMessage(raw);
        } catch (e) {
          send(ws, { t: "error", msg: e instanceof ValidationError ? e.message : "bad message" });
          return;
        }

        if (parsed.t === "ping") {
          send(ws, { t: "pong" });
          return;
        }

        if (parsed.t === "hello") {
          let token = parsed.data.token;
          let rec = token ? store.getPlayer(token) : null;
          // Twitch claim: if the client supplied a verified twitch login and
          // we have a server-minted sigma for that login (created by a prior
          // channel-point redemption), use IT — that's the chatter's sigma.
          // We prefer the existing token only if it already matches the link.
          if (parsed.data.twitch) {
            const linked = store.getTokenByTwitch(parsed.data.twitch);
            if (linked) {
              if (token && token !== linked) {
                // The client has its own anon sigma; honor the explicit claim.
                token = linked;
                rec = store.getPlayer(linked);
              } else if (!token) {
                token = linked;
                rec = store.getPlayer(linked);
              }
            } else if (token) {
              // No prior link, but the client identified itself — record it
              // so future redemptions land on the same sigma.
              store.linkTwitch(parsed.data.twitch, token);
            }
          }
          if (!token || !rec) {
            token = newToken(); // first visit, or a stale/forged token
            rec = null;
            if (parsed.data.twitch) store.linkTwitch(parsed.data.twitch, token);
          }
          ws.token = token;
          send(ws, {
            t: "welcome",
            token,
            character: rec ? rec.character : null,
            feed: store.getFeed(),
            leaderboard: leaderboard(),
            players: onlineCount(),
            arena: arena.snapshot(),
            drops: drops.snapshot(),
            raid: getRaid ? getRaid() : null,
          });
          return;
        }

        if (parsed.t === "save") {
          if (!ws.token) {
            send(ws, { t: "error", msg: "say hello first" });
            return;
          }
          if (now - ws.lastSaveAt < SAVE_MIN_INTERVAL_MS) return; // silently throttle
          ws.lastSaveAt = now;
          store.putPlayer(ws.token, parsed.data.character);
          send(ws, { t: "saved", at: now });
          return;
        }

        if (parsed.t === "event") {
          if (!ws.token) {
            send(ws, { t: "error", msg: "say hello first" });
            return;
          }
          const entry = store.pushFeed(parsed.data.event);
          broadcast({ t: "feed", entry });
        }
      }),
    );

    ws.on("close", () => {
      clients.delete(ws);
    });
    ws.on("error", () => {
      clients.delete(ws);
    });
  });

  // Heartbeat — reap dead sockets so the connection table self-heals.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        clients.delete(ws);
      }
    }
  }, 30_000);
  if (heartbeat.unref) heartbeat.unref();

  return {
    broadcast,
    // Is this sigma's token held by a live browser WebSocket right now? The
    // live-delve gate uses it: only advance a run server-side (on chat) when
    // NO browser owns it, or the two sides would fork run.rngState.
    isTokenOnline(token) {
      if (!token) return false;
      for (const ws of clients) {
        if (ws.token === token && ws.readyState === ws.OPEN) return true;
      }
      return false;
    },
    stats() {
      return { players: onlineCount(), connections: clients.size, leaderboard: leaderboard() };
    },
    broadcastStats() {
      broadcast({ t: "stats", players: onlineCount(), leaderboard: leaderboard() });
    },
    shutdown() {
      clearInterval(heartbeat);
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
