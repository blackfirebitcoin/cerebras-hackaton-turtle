// SIGMA ABYSS — Agent Realm + Oracle Bazaar integration tests.
//
// Boots the real route handlers (router.js + agent-realm.js + oracle-bazaar.js)
// against an in-memory fake store on an ephemeral port — no disk, no supervisor
// loops, no port collisions — and drives the full HTTP loop a Claude Code
// requester and a worker agent would: register -> cooldown gating -> move ->
// post HIT -> answer -> consensus -> reward -> HMAC enforcement.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";
import { attachAgentRealm } from "../../server/agent-realm.js";
import { attachOracleBazaar } from "../../server/oracle-bazaar.js";
import { attachPlayOnboard } from "../../server/play-onboard.js";
import express from "../../server/router.js";

function makeFakeStore() {
  const agents = new Map();
  const tasks = new Map();
  return {
    getAgent: (t) => agents.get(t) || null,
    putAgent: (t, c) => agents.set(t, c),
    allAgents: () => [...agents.values()],
    agentCount: () => agents.size,
    getOracleTask: (id) => tasks.get(id) || null,
    putOracleTask: (id, t) => tasks.set(id, t),
    allOracleTasks: () => [...tasks.values()],
    deleteOracleTask: (id) => tasks.delete(id),
  };
}

function buildServer({ hmacKey = "" } = {}) {
  const store = makeFakeStore();
  const app = express();
  app.use(express.json({ limit: "32kb" })); // mirror server.js global parser
  const guard = (_label, fn) => fn;
  const rt = { broadcast() {} };
  attachAgentRealm(app, { store, rt, guard });
  const hmac = {
    sign: (b, k) => crypto.createHmac("sha256", k).update(b).digest("hex"),
    eq: (a, b) => a === b,
    key: hmacKey,
  };
  attachOracleBazaar(app, { store, rt, guard, text: express.text, hmac });
  attachPlayOnboard(app, { guard });
  return { store, server: http.createServer(app), hmac };
}

function listen(server) {
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)),
  );
}
function close(server) {
  return new Promise((r) => server.close(() => r()));
}

test("/play onboarding serves the bootstrap, runner, landing page, and ps1", async () => {
  const { server } = buildServer();
  const base = await listen(server);
  try {
    // curl-like (default Accept */*) → the sh bootstrap.
    const sh = await fetch(`${base}/play`);
    const shBody = await sh.text();
    assert.equal(sh.status, 200);
    assert.match(shBody, /^#!\/bin\/sh/);
    assert.match(shBody, /\/api\/agent\/register/);
    assert.match(shBody, /play\/agent\.mjs/);
    assert.match(shBody, new RegExp(base.replace(/[/.]/g, "\\$&"))); // BASE injected from Host

    // The runner the bootstrap downloads is the reference bot.
    const runner = await fetch(`${base}/play/agent.mjs`);
    assert.equal(runner.status, 200);
    assert.match(await runner.text(), /MMO_AGENT_TOKEN/);

    // Browser (Accept: text/html) → the landing page with copy commands.
    const html = await fetch(`${base}/play`, { headers: { accept: "text/html" } });
    const htmlBody = await html.text();
    assert.match(htmlBody, /<title>SIGMA ABYSS/);
    assert.match(htmlBody, /curl -fsSL/);

    // Windows variant.
    assert.match(await (await fetch(`${base}/play.ps1`)).text(), /PowerShell/);
  } finally {
    await close(server);
  }
});

async function call(base, method, path, { token, body, raw, sig } = {}) {
  const headers = {};
  let payload;
  if (raw !== undefined) {
    headers["content-type"] = "text/plain";
    payload = raw;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  if (sig) headers["X-MMO-Signature"] = sig;
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

// Fast-forward a cooldown so tests don't wait wall-clock seconds. The fake
// store hands back the live object reference, so this simulates "cooldown
// elapsed" exactly as the real expiry check would see it.
function clearCooldown(store, token) {
  const ch = store.getAgent(token);
  ch.cooldownExpires = 0;
}

test("agent register -> world starts at town tile", async () => {
  const { store, server } = buildServer();
  const base = await listen(server);
  try {
    const reg = await call(base, "POST", "/api/agent/register", { body: { name: "tester" } });
    assert.equal(reg.status, 200);
    assert.match(reg.body.token, /^agt_/);
    assert.equal(reg.body.character.x, 5);
    assert.equal(reg.body.character.y, 5);
    assert.equal(reg.body.character.level, 1);
    assert.equal(store.agentCount(), 1);

    const bad = await call(base, "POST", "/api/agent/register", { body: { name: "x" } });
    assert.equal(bad.status, 400); // name too short
  } finally {
    await close(server);
  }
});

test("cooldown gates the next action until it elapses", async () => {
  const { store, server } = buildServer();
  const base = await listen(server);
  try {
    const token = (
      await call(base, "POST", "/api/agent/register", { body: { name: "cooldowner" } })
    ).body.token;

    const move1 = await call(base, "POST", "/api/agent/action/move", {
      token,
      body: { x: 5, y: 4 },
    });
    assert.equal(move1.status, 200);
    assert.ok(move1.body.cooldown.total_seconds > 0, "move returns a cooldown");
    assert.equal(move1.body.character.x, 5);
    assert.equal(move1.body.character.y, 4);

    // Immediate second action is blocked by the standing cooldown.
    const move2 = await call(base, "POST", "/api/agent/action/move", {
      token,
      body: { x: 5, y: 5 },
    });
    assert.equal(move2.status, 429);
    assert.ok(move2.body.cooldown.remaining_seconds > 0);

    // After the cooldown elapses, it works again.
    clearCooldown(store, token);
    const move3 = await call(base, "POST", "/api/agent/action/move", {
      token,
      body: { x: 5, y: 5 },
    });
    assert.equal(move3.status, 200);

    // Out-of-bounds is rejected.
    clearCooldown(store, token);
    const oob = await call(base, "POST", "/api/agent/action/move", {
      token,
      body: { x: 99, y: 0 },
    });
    assert.equal(oob.status, 400);
  } finally {
    await close(server);
  }
});

test("full oracle loop: post HIT -> worker answers -> reward + finalize", async () => {
  const { store, server } = buildServer();
  const base = await listen(server);
  try {
    const token = (await call(base, "POST", "/api/agent/register", { body: { name: "worker" } }))
      .body.token;
    const goldBefore = store.getAgent(token).gold;

    // Worker walks to the oracle tile (5,4).
    await call(base, "POST", "/api/agent/action/move", { token, body: { x: 5, y: 4 } });
    clearCooldown(store, token);

    // Requester posts a multiple-choice HIT (unsigned mode: hmac.key === "").
    const post = await call(base, "POST", "/api/oracle/tasks", {
      raw: JSON.stringify({
        prompt: "Classify this commit",
        context: "fix(auth): stop 503",
        choices: ["feat", "fix", "chore"],
        redundancy: 1,
      }),
    });
    assert.equal(post.status, 200);
    const id = post.body.id;
    assert.match(id, /^hit_/);

    // Board shows the HIT and reports the worker is on the oracle tile.
    const board = await call(base, "GET", "/api/oracle/open", { token });
    assert.equal(board.status, 200);
    assert.equal(board.body.onOracleTile, true);
    assert.ok(board.body.tasks.some((t) => t.id === id));

    // Worker submits a valid choice -> accepted, finalized (redundancy 1), reward paid.
    const sub = await call(base, "POST", `/api/oracle/submit/${id}`, {
      token,
      body: { answer: "fix" },
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.body.accepted, true);
    assert.equal(sub.body.finalized, true);
    assert.equal(sub.body.result.answer, "fix");
    assert.ok(store.getAgent(token).gold > goldBefore, "worker was paid gold");
    assert.equal(
      store.getAgent(token).skills.oracle.xp > 0 || store.getAgent(token).skills.oracle.level > 1,
      true,
    );

    // Requester polls and sees the finalized answer.
    const poll = await call(base, "GET", `/api/oracle/tasks/${id}`);
    assert.equal(poll.body.task.status, "complete");
    assert.equal(poll.body.task.result.answer, "fix");

    // Re-submitting the (now closed) HIT is rejected.
    clearCooldown(store, token);
    const dup = await call(base, "POST", `/api/oracle/submit/${id}`, {
      token,
      body: { answer: "feat" },
    });
    assert.equal(dup.status, 409);
  } finally {
    await close(server);
  }
});

test("consensus: redundancy 2 finalizes on the majority vote", async () => {
  const { store, server } = buildServer();
  const base = await listen(server);
  try {
    const t1 = (await call(base, "POST", "/api/agent/register", { body: { name: "a1" } })).body
      .token;
    const t2 = (await call(base, "POST", "/api/agent/register", { body: { name: "a2" } })).body
      .token;
    for (const t of [t1, t2]) {
      await call(base, "POST", "/api/agent/action/move", { token: t, body: { x: 5, y: 4 } });
      clearCooldown(store, t);
    }
    const post = await call(base, "POST", "/api/oracle/tasks", {
      raw: JSON.stringify({ prompt: "vote", choices: ["a", "b"], redundancy: 2 }),
    });
    const id = post.body.id;

    const s1 = await call(base, "POST", `/api/oracle/submit/${id}`, {
      token: t1,
      body: { answer: "a" },
    });
    assert.equal(s1.body.finalized, false, "not finalized until quota met");
    const s2 = await call(base, "POST", `/api/oracle/submit/${id}`, {
      token: t2,
      body: { answer: "a" },
    });
    assert.equal(s2.body.finalized, true);
    assert.equal(s2.body.result.answer, "a");
    assert.equal(s2.body.result.votes, 2);
    assert.equal(s2.body.result.confidence, 1);

    // An answer outside the choice set is rejected (keeps the tally clean).
    const t3 = (await call(base, "POST", "/api/agent/register", { body: { name: "a3" } })).body
      .token;
    await call(base, "POST", "/api/agent/action/move", { token: t3, body: { x: 5, y: 4 } });
    clearCooldown(store, t3);
    const post2 = await call(base, "POST", "/api/oracle/tasks", {
      raw: JSON.stringify({ prompt: "p", choices: ["a", "b"] }),
    });
    const bad = await call(base, "POST", `/api/oracle/submit/${post2.body.id}`, {
      token: t3,
      body: { answer: "zzz" },
    });
    assert.equal(bad.status, 400);
  } finally {
    await close(server);
  }
});

test("oracle worker routes require the oracle tile + a valid token", async () => {
  const { server } = buildServer();
  const base = await listen(server);
  try {
    const token = (await call(base, "POST", "/api/agent/register", { body: { name: "offsite" } }))
      .body.token;
    const post = await call(base, "POST", "/api/oracle/tasks", {
      raw: JSON.stringify({ prompt: "hi" }),
    });
    const id = post.body.id;

    // Standing in town (5,5), not on the oracle tile -> submit refused.
    const sub = await call(base, "POST", `/api/oracle/submit/${id}`, {
      token,
      body: { answer: "hi" },
    });
    assert.equal(sub.status, 400);

    // No token -> 401.
    const noauth = await call(base, "GET", "/api/oracle/open");
    assert.equal(noauth.status, 401);
  } finally {
    await close(server);
  }
});

test("HMAC mode rejects unsigned + bad-signed requester posts", async () => {
  const { server, hmac } = buildServer({ hmacKey: "secret-key" });
  const base = await listen(server);
  try {
    const raw = JSON.stringify({ prompt: "needs a signature" });
    const unsigned = await call(base, "POST", "/api/oracle/tasks", { raw });
    assert.equal(unsigned.status, 403);

    const bad = await call(base, "POST", "/api/oracle/tasks", { raw, sig: "deadbeef" });
    assert.equal(bad.status, 403);

    const good = await call(base, "POST", "/api/oracle/tasks", {
      raw,
      sig: hmac.sign(raw, "secret-key"),
    });
    assert.equal(good.status, 200);
    assert.match(good.body.id, /^hit_/);
  } finally {
    await close(server);
  }
});

test("agent fight + gather resolve deterministically by rngState", async () => {
  const { store, server } = buildServer();
  const base = await listen(server);
  try {
    const token = (await call(base, "POST", "/api/agent/register", { body: { name: "fighter" } }))
      .body.token;

    // Fighting on a non-monster tile is rejected.
    const noMon = await call(base, "POST", "/api/agent/action/fight", { token });
    assert.equal(noMon.status, 400);

    // Move to a chrome_rat tile (5,2) and fight.
    await call(base, "POST", "/api/agent/action/move", { token, body: { x: 5, y: 2 } });
    clearCooldown(store, token);
    const fight = await call(base, "POST", "/api/agent/action/fight", { token });
    assert.equal(fight.status, 200);
    assert.ok(["win", "loss"].includes(fight.body.fight.result));

    // Determinism storage contract: the fight consumed the seeded RNG and
    // persisted a valid uint32 state back to the character (same contract as
    // shared/ — the only reason outcomes are replayable).
    const after = store.getAgent(token).rngState;
    assert.ok(Number.isInteger(after) && after >= 0 && after <= 0xffffffff);

    // Gather: move to a chrome_vein (3,2) and gather an ore.
    clearCooldown(store, token);
    await call(base, "POST", "/api/agent/action/move", { token, body: { x: 3, y: 2 } });
    clearCooldown(store, token);
    const gather = await call(base, "POST", "/api/agent/action/gather", { token });
    assert.equal(gather.status, 200);
    assert.equal(gather.body.gather.drop, "chrome_ore");
    assert.ok(store.getAgent(token).inventory.chrome_ore >= 1);
  } finally {
    await close(server);
  }
});
