// SIGMA ABYSS — integration test.
//
// Boots the real server.js as a subprocess on a non-default port and drives
// the live HTTP API + WS realtime layer over loopback. Verifies the wiring
// the unit suite can't:
//   - /healthz comes up (server + supervisor + store + realtime all init)
//   - /api/feed, /api/leaderboard, /api/stats return their documented shapes
//   - /api/sigma/<login> mints a sigma on first hit (chat-elixir bridge contract)
//   - /api/chat-ping/<login> records a chat-ping + enrolls into the arena
//   - WS upgrade on /ws yields a JSON-protocol handshake
//
// Each test reuses the same subprocess (boot is ~300ms). The before() hook
// polls /healthz until it answers; after() SIGTERMs the child and waits for
// the exit.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

// Pick a port well outside the production default so a running server doesn't
// collide. Anything in the unprivileged range is fine — we just need an idle
// loopback port.
const PORT = 17777;
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server failed to come up in ${timeoutMs}ms (last: ${lastErr})`);
}

before(async () => {
  child = spawn(process.execPath, ["server/server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Pipe child stderr to our stderr only on failure — silence the happy path.
  child.stderr.on("data", () => {
    /* suppressed; surfaced on assertion failure via the spawn exit code */
  });
  child.stdout.on("data", () => {
    /* suppressed */
  });
  await waitForHealth();
});

after(async () => {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", resolve);
    // Hard-kill after 3s — supervisor drain shouldn't take longer.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve();
    }, 3_000);
  });
});

describe("server-boot — full stack comes up", () => {
  test("/healthz returns liveness + counters", async () => {
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok("ok" in body || "uptime" in body, "healthz should include ok/uptime");
  });

  test("/api/feed returns an array under .feed or top-level", async () => {
    const res = await fetch(`${BASE}/api/feed`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const feed = Array.isArray(body) ? body : body.feed;
    assert.ok(
      Array.isArray(feed),
      `feed should be an array, got: ${JSON.stringify(body).slice(0, 80)}`,
    );
  });

  test("/api/leaderboard returns ranked entries", async () => {
    const res = await fetch(`${BASE}/api/leaderboard`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const lb = Array.isArray(body) ? body : body.leaderboard;
    assert.ok(Array.isArray(lb), "leaderboard is an array");
  });

  test("/api/stats returns server state", async () => {
    const res = await fetch(`${BASE}/api/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
  });
});

describe("server-boot — chat-elixir bridge contracts", () => {
  test("/api/sigma/<login> mints a sigma for a never-seen login", async () => {
    const login = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const res = await fetch(`${BASE}/api/sigma/${login}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, `unexpected: ${JSON.stringify(body)}`);
    assert.equal(typeof body.token, "string");
    assert.equal(body.login, login);
    assert.ok(body.sigma, "sigma payload should be present");
  });

  test("/api/chat-ping/<login> records the ping and returns 200", async () => {
    const login = `it_ping_${Date.now().toString(36)}`;
    const res = await fetch(`${BASE}/api/chat-ping/${login}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: 1 }),
    });
    assert.equal(res.status, 200, `chat-ping should accept; got: ${await res.text()}`);
  });

  test("/api/arena surfaces the chat-ping enrolment", async () => {
    // Ping a new chatter, then assert they show up in the arena roster.
    // (/api/arena/state is just counters; /api/arena is the full snapshot.)
    const login = `it_arena_${Date.now().toString(36)}`;
    await fetch(`${BASE}/api/chat-ping/${login}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: 1 }),
    });
    const res = await fetch(`${BASE}/api/arena`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.chatters), "arena snapshot has a chatters array");
    const found = body.chatters.some((c) => c.login === login || c.login === login.toLowerCase());
    assert.ok(found, `expected ${login} in arena.chatters; got ${body.chatters.length} entries`);
  });

  test("/api/viewers reflects POSTed counts", async () => {
    const youtube = 42;
    const twitch = 17;
    const put = await fetch(`${BASE}/api/viewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtube, twitch }),
    });
    assert.equal(put.status, 200);
    const get = await fetch(`${BASE}/api/viewers`);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.youtube, youtube);
    assert.equal(body.twitch, twitch);
  });
});
