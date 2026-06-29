// SIGMA ABYSS — PR6: Agent Realm × Sigmacraft. Mounts the REAL attachAgentRealm
// and drives the new `sigmacraft` action + the world projection over loopback.
// Run: node --test test/api/agent-sigmacraft.test.js

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const STORE_DIR = mkdtempSync(join(tmpdir(), "mmo-agent-sc-"));
process.env.MMO_DATA_DIR = STORE_DIR;

import express from "../../server/router.js";
import { guard } from "../../server/supervisor.js";
import { attachAgentRealm } from "../../server/agent-realm.js";
import { freshWorld } from "../../server/world-tick.js";
import { advance } from "../../server/sigmacraft.js";

let store;
let baseUrl = "";
let httpServer;
let agentToken = "";

const headers = (extra = {}) => ({ "content-type": "application/json", ...extra });

before(async () => {
  store = await import("../../server/store.js");
  store.initStore?.();
  store.initWorldState(() => freshWorld());

  const app = express();
  app.use(express.json());
  attachAgentRealm(app, { store, rt: { broadcast() {} }, guard });
  httpServer = createServer(app);
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const reg = await (
    await fetch(`${baseUrl}/api/agent/register`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "scout_bot" }) })
  ).json();
  agentToken = reg.token;
  assert.ok(agentToken?.startsWith("agt_"));
});

after(async () => {
  rmSync(STORE_DIR, { recursive: true, force: true });
  await new Promise((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
});

describe("GET /api/agent/world carries the Sigmacraft overworld", () => {
  test("includes a sigmacraft projection + the static tile map", async () => {
    const j = await (await fetch(`${baseUrl}/api/agent/world`)).json();
    assert.ok(j.sigmacraft, "sigmacraft projection present");
    assert.equal(j.sigmacraft.realmId, "sigmacraft_alpha");
    assert.ok(j.sigmacraftMap?.tiles && Object.keys(j.sigmacraftMap.tiles).length >= 100);
  });
});

describe("POST /api/agent/action/sigmacraft", () => {
  test("requires a bearer token (401 without)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/action/sigmacraft`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ intent: { kind: "rest" } }),
    });
    assert.equal(res.status, 401);
  });

  test("a bearer-authed move enqueues and tracks the agent's tile after the tick", async () => {
    const world = store.getWorldState();
    const town = world.sigmacraft.map.townTileId;
    const target = world.sigmacraft.map.tiles[town].exits[0];

    const res = await fetch(`${baseUrl}/api/agent/action/sigmacraft`, {
      method: "POST",
      headers: headers({ authorization: `Bearer ${agentToken}` }),
      body: JSON.stringify({ intent: { kind: "move", targetId: target, nonce: "a1" } }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.sigmacraft.status, "queued");
    assert.ok(j.cooldown, "a cooldown was returned (anti-abuse pacing preserved)");

    // resolve the queued intent on the tick; the agt_ token now tracks in actorPlaces
    advance({ world, store: { pushFeed() {} } });
    assert.equal(world.sigmacraft.actorPlaces[agentToken], target);
  });

  test("a second immediate action is cooldown-gated (429)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/action/sigmacraft`, {
      method: "POST",
      headers: headers({ authorization: `Bearer ${agentToken}` }),
      body: JSON.stringify({ intent: { kind: "rest" } }),
    });
    assert.equal(res.status, 429);
  });

  test("a malformed intent is rejected by the validate boundary (400)", async () => {
    // fresh agent to dodge the cooldown from the previous test
    const reg = await (
      await fetch(`${baseUrl}/api/agent/register`, { method: "POST", headers: headers(), body: JSON.stringify({ name: "scout_bot2" }) })
    ).json();
    const res = await fetch(`${baseUrl}/api/agent/action/sigmacraft`, {
      method: "POST",
      headers: headers({ authorization: `Bearer ${reg.token}` }),
      body: JSON.stringify({ intent: { kind: "teleport" } }),
    });
    assert.equal(res.status, 400);
  });
});
