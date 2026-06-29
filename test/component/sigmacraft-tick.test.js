// test/component/sigmacraft-tick.test.js — Sigmacraft tick integration.
//
// Drives the REAL startWorldTick wiring (real store, real sigmacraft.advance,
// real feed bridge, real snapshot projection) — not fakes — to prove the
// integrate-this loop: enqueue intent -> supervised tick resolves it -> snapshot
// advances -> event bridged to feed. Also asserts the fast/legacy cadence split
// and the idle no-op (write-amplification guard) end-to-end. Closes the
// "component/integration boot test for the new cadence behaviour" gate.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

describe("Sigmacraft tick — real supervised-loop integration", () => {
  let store;
  let startWorldTick;
  let freshWorld;
  let enqueueSigmacraftIntent;
  let projectSigmacraftSnapshot;
  let storeDir;
  let driveTick; // captured real tick callback
  const TOKEN = "sig_bbbbbbbbbbbbbbbbbbbbbbbb";

  before(async () => {
    storeDir = mkdtempSync(join(tmpdir(), "mmo-sc-tick-"));
    process.env.MMO_DATA_DIR = storeDir;
    store = await import("../../server/store.js");
    ({ startWorldTick, freshWorld } = await import("../../server/world-tick.js"));
    ({ enqueueSigmacraftIntent } = await import("../../server/sigmacraft.js"));
    ({ projectSigmacraftSnapshot } = await import("../../shared/sigmacraft.js"));

    const sigmacraft = await import("../../server/sigmacraft.js");
    store.initStore?.();
    store.initWorldState(() => freshWorld());

    // Capture the REAL tick callback so we can drive it deterministically while
    // still exercising the real startWorldTick body, store, and advancer.
    const superviseInterval = (_label, fn) => {
      driveTick = fn;
      return { stop() {} };
    };
    startWorldTick({
      store,
      rt: null,
      superviseInterval,
      intervalMs: 3000,
      legacyEvery: 20,
      fastAdvancers: [(ctx) => sigmacraft.advance(ctx)],
      extraAdvancers: [],
    });
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
    delete process.env.MMO_DATA_DIR;
  });

  test("an idle base tick does not advance the world tick (no write amplification)", () => {
    const before = projectSigmacraftSnapshot(store.getWorldState()).worldTick;
    driveTick();
    const after = projectSigmacraftSnapshot(store.getWorldState()).worldTick;
    assert.equal(after, before, "idle tick must not advance sigmacraft.tick");
  });

  test("a queued intent is resolved by the supervised tick and bridged to feed", () => {
    const world = store.getWorldState();
    enqueueSigmacraftIntent(world, TOKEN, { kind: "talk", nonce: "c1" });
    store.putWorldState(world);

    const before = projectSigmacraftSnapshot(store.getWorldState()).worldTick;
    driveTick();
    const snap = projectSigmacraftSnapshot(store.getWorldState());

    assert.equal(snap.worldTick, before + 1, "tick advances when work is resolved");
    assert.ok(
      snap.recentEvents.some((e) => /traded word/.test(e.text)),
      "resolved event appears in the world recent-events ring",
    );
    const feed = store.getFeed();
    assert.ok(
      feed.some((e) => e.kind === "narrative" && /traded word/.test(e.detail || "")),
      "resolved event is bridged into the capped feed.json",
    );
  });

  test("the legacy lane runs every 20th base tick while the fast lane runs every tick", () => {
    // Drive enough ticks to cross a legacy boundary; the world epoch (only the
    // legacy core worldTick advances it) must move exactly once per 20 ticks.
    const epochBefore = store.getWorldState().epoch;
    for (let i = 0; i < 20; i++) driveTick();
    const epochAfter = store.getWorldState().epoch;
    assert.equal(epochAfter - epochBefore, 1, "legacy core tick advances epoch once per 20 base ticks");
  });
});
