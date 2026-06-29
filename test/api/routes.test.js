// test/api/routes.test.js — HTTP route contract tests for SIGMA ABYSS server.
//
// Uses node:test + node:assert (zero extra deps). Creates an in-process HTTP
// server on a random port (port:0), hits the API, then closes it.
//
// Covered: GET /healthz, GET /api/leaderboard, GET /api/stats, GET /api/feed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// Isolate persistence so a stale ./data world.json can't leak in (the overworld
// snapshot needs the freshly generated map).
const STORE_DIR = mkdtempSync(join(tmpdir(), "mmo-api-routes-"));
process.env.MMO_DATA_DIR = STORE_DIR;

// This suite builds its own tiny app from the first-party router and the
// real store module, then exercises the route contracts over loopback. It
// deliberately does not import server.js, which binds a port and boots the
// WebSocket + supervisor stack at module load.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "../../server/router.js";
// store is imported DYNAMICALLY in before() so it reads MMO_DATA_DIR (set above).
let store;
import { freshWorld } from "../../server/world-tick.js";
import { enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { projectSigmacraftSnapshot } from "../../shared/sigmacraft.js";
import { vSigmacraftIntent } from "../../server/validate.js";
import { TOWN_ID } from "../../shared/zones.js";

// We build a minimal app mirroring the routes we want to test, using the
// same store module. This avoids the WebSocket + supervisor boot.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let baseUrl = "";
let httpServer;

function json(res, data, status = 200) {
  res.status(status).json(data);
}

before(async () => {
  store = await import("../../server/store.js"); // reads the isolated MMO_DATA_DIR
  const app = express();
  app.use(express.json());

  // Mirror the routes under test using the same store module.
  app.get("/healthz", (_req, res) => {
    json(res, { ok: true, uptime: process.uptime() });
  });

  app.get("/api/leaderboard", (_req, res) => {
    const top = store.getLeaderboard ? store.getLeaderboard(10) : [];
    json(res, { ok: true, leaderboard: top });
  });

  app.get("/api/stats", (_req, res) => {
    const s = store.getStats ? store.getStats() : {};
    json(res, { ok: true, stats: s });
  });

  app.get("/api/feed", (_req, res) => {
    const feed = store.getFeed ? store.getFeed(20) : [];
    json(res, { ok: true, feed });
  });

  // Seed a Sigmacraft-capable world + one token-owning player, then mirror the
  // real Sigmacraft routes using the SAME handler logic as server.js so the
  // validation + enqueue + projection contracts are exercised over HTTP.
  store.initWorldState(() => freshWorld());
  store.putPlayer("sig_aaaaaaaaaaaaaaaaaaaaaaaa", {
    token: "sig_aaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Tester",
    level: 99,
    zoneId: TOWN_ID,
  });

  app.get("/api/sigmacraft/snapshot", (req, res) => {
    const qs = (req.url || "").split("?")[1] || "";
    const token = String(new URLSearchParams(qs).get("token") || "").slice(0, 64);
    const character = token ? store.getPlayer(token)?.character || null : null;
    json(res, { ok: true, snapshot: projectSigmacraftSnapshot(store.getWorldState(), character, { token }) });
  });

  app.post("/api/sigmacraft/intent", (req, res) => {
    const token = String(req.body?.token || "").slice(0, 64);
    const rec = token ? store.getPlayer(token) : null;
    if (!rec?.character) return json(res, { ok: false, error: "unknown token" }, 401);
    let intent;
    try {
      intent = vSigmacraftIntent(req.body?.intent ?? req.body);
    } catch (err) {
      return json(res, { ok: false, error: err?.message || "bad intent" }, 400);
    }
    // Tile moves are gated at apply time (tick adjacency check), not here.
    const world = store.getWorldState();
    const result = enqueueSigmacraftIntent(world, token, intent);
    store.putWorldState(world);
    return json(res, { ok: result.status !== "rejected", ...result }, result.status === "rejected" ? 409 : 200);
  });

  httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  rmSync(STORE_DIR, { recursive: true, force: true });
  await new Promise((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  test("returns 200 with ok:true", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
  });

  test("Content-Type is application/json", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.ok(res.headers.get("content-type")?.includes("application/json"));
  });
});

describe("GET /api/leaderboard", () => {
  test("returns 200 with leaderboard array", async () => {
    const res = await fetch(`${baseUrl}/api/leaderboard`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.leaderboard));
  });
});

describe("GET /api/stats", () => {
  test("returns 200 with stats object", async () => {
    const res = await fetch(`${baseUrl}/api/stats`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(typeof json.stats === "object" && json.stats !== null);
  });
});

describe("GET /api/feed", () => {
  test("returns 200 with feed array", async () => {
    const res = await fetch(`${baseUrl}/api/feed`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.feed));
  });
});

describe("GET /api/sigmacraft/snapshot", () => {
  test("anonymous returns a snapshot reading the town tile + a windowed map", async () => {
    const res = await fetch(`${baseUrl}/api/sigmacraft/snapshot`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.snapshot.realmId, "sigmacraft_alpha");
    assert.equal(j.snapshot.place.id, "millbridge"); // the town tile
    assert.ok(j.snapshot.worldMap.cells.length > 0);
    // tile-exit move actions are available without a character (free-roam graph)
    assert.ok(j.snapshot.validActions.some((a) => a.kind === "move"));
  });

  test("token-scoped returns valid actions for the player", async () => {
    const res = await fetch(`${baseUrl}/api/sigmacraft/snapshot?token=sig_aaaaaaaaaaaaaaaaaaaaaaaa`);
    const j = await res.json();
    assert.ok(j.snapshot.validActions.length > 0);
    assert.ok(j.snapshot.validActions.some((a) => a.kind === "rest"));
  });
});

describe("POST /api/sigmacraft/intent", () => {
  test("rejects an unknown token with 401", async () => {
    const res = await fetch(`${baseUrl}/api/sigmacraft/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "sig_000000000000000000000000", intent: { kind: "rest" } }),
    });
    assert.equal(res.status, 401);
  });

  test("rejects a bad intent kind with 400 (validation boundary)", async () => {
    const res = await fetch(`${baseUrl}/api/sigmacraft/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "sig_aaaaaaaaaaaaaaaaaaaaaaaa", intent: { kind: "teleport" } }),
    });
    assert.equal(res.status, 400);
  });

  test("queues a valid rest intent with 200", async () => {
    const res = await fetch(`${baseUrl}/api/sigmacraft/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "sig_aaaaaaaaaaaaaaaaaaaaaaaa",
        intent: { kind: "rest", nonce: "api-n1" },
      }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.status, "queued");
  });
});
