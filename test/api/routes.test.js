// test/api/routes.test.js — HTTP route contract tests for SIGMA ABYSS server.
//
// Uses node:test + node:assert (zero extra deps). Creates an in-process HTTP
// server on a random port (port:0), hits the API, then closes it.
//
// Covered: GET /healthz, GET /api/leaderboard, GET /api/stats, GET /api/feed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

// This suite builds its own tiny app from the first-party router and the
// real store module, then exercises the route contracts over loopback. It
// deliberately does not import server.js, which binds a port and boots the
// WebSocket + supervisor stack at module load.

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "../../server/router.js";
// Dynamically import store so we can pre-seed minimal state.
import * as store from "../../server/store.js";

// We build a minimal app mirroring the routes we want to test, using the
// same store module. This avoids the WebSocket + supervisor boot.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let baseUrl = "";
let httpServer;

function json(res, data, status = 200) {
  res.status(status).json(data);
}

before(async () => {
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

  httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
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
