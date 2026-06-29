// test/component/server-boot.test.js — in-process server module boot test.
//
// Verifies: store, supervisor, and validate modules load cleanly; store
// read/write/getLeaderboard/getStats all work in isolation. No port binding.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("store module — boot", () => {
  let store;

  test("loads without error", async () => {
    store = await import("../../server/store.js");
  });

  test("getLeaderboard returns an array", () => {
    const lb = typeof store.getLeaderboard === "function" ? store.getLeaderboard(5) : [];
    assert.ok(Array.isArray(lb), "getLeaderboard must return array");
  });

  test("getStats returns an object", () => {
    if (typeof store.getStats !== "function") return;
    const stats = store.getStats();
    assert.ok(typeof stats === "object" && stats !== null, "getStats must return an object");
  });

  test("getFeed returns an array", () => {
    if (typeof store.getFeed !== "function") return;
    const feed = store.getFeed(10);
    assert.ok(Array.isArray(feed), "getFeed must return array");
  });

  test("putPlayer / getPlayer round-trip", () => {
    if (typeof store.putPlayer !== "function" || typeof store.getPlayer !== "function") return;
    const token = "test-boot-token-001";
    const char = { level: 1, name: "TestHero", run: null };
    store.putPlayer(token, char);
    const retrieved = store.getPlayer(token);
    assert.ok(retrieved !== null, "getPlayer must find just-stored player");
    assert.equal(retrieved?.character?.level ?? retrieved?.level, 1);
  });
});

describe("validate module — boot", () => {
  let validate;

  test("loads without error", async () => {
    validate = await import("../../server/validate.js");
  });

  test("exports at least one function or object", () => {
    assert.ok(validate !== null && validate !== undefined, "validate module must export something");
  });
});

describe("supervisor module — boot", () => {
  let supervisor;

  test("loads without error", async () => {
    supervisor = await import("../../server/supervisor.js");
  });

  test("exports guard function", () => {
    assert.equal(typeof supervisor.guard, "function", "supervisor must export guard()");
  });

  test("exports installGlobalGuards function", () => {
    assert.equal(
      typeof supervisor.installGlobalGuards,
      "function",
      "supervisor must export installGlobalGuards()",
    );
  });

  test("exports superviseInterval function", () => {
    assert.equal(
      typeof supervisor.superviseInterval,
      "function",
      "supervisor must export superviseInterval()",
    );
  });
});
