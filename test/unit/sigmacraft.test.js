// SIGMA ABYSS — Sigmacraft fantasy projection layer.
// Run: node --test test/unit/sigmacraft.test.js
//
// Covers the integrate-this first-slice contracts that don't need a live server:
//   - createSigmacraftState() shape (bounded pointers/queues only)
//   - projectSigmacraftSnapshot() reads existing zones, never a parallel world
//   - the fast sub-advancer resolves bounded intents + caps recent events
//   - enqueue keeps one pending intent per actor
//   - startWorldTick legacy-gating runs the legacy lane every Nth base tick
//     while the fast lane runs every base tick

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createSigmacraftState,
  projectSigmacraftSnapshot,
  SIGMACRAFT_INTENT_KINDS,
  MAX_SIGMACRAFT_RECENT_EVENTS,
} from "../../shared/sigmacraft.js";
import { advance, enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { freshWorld, startWorldTick } from "../../server/world-tick.js";
import { TOWN_ID, ZONE_BY_ID, ZONE_IDS } from "../../shared/zones.js";
import { vSigmacraftIntent } from "../../server/validate.js";

describe("Sigmacraft state + projection", () => {
  test("freshWorld seeds a bounded sigmacraft section", () => {
    const w = freshWorld();
    assert.equal(w.sigmacraft.schema, "sigmacraft.world.v1");
    assert.equal(w.sigmacraft.tick, 0);
    assert.deepEqual(w.sigmacraft.pendingIntents, []);
    assert.deepEqual(w.sigmacraft.recentEvents, []);
    assert.ok(w.sigmacraft.objective?.questId);
  });

  test("intent kinds are the bounded enum", () => {
    assert.deepEqual([...SIGMACRAFT_INTENT_KINDS].sort(), ["move", "rest", "talk"]);
  });

  test("snapshot projects an existing zone as the place, with valid move targets", () => {
    const w = freshWorld();
    const character = { token: "tok_a", zoneId: TOWN_ID, level: 99 };
    const snap = projectSigmacraftSnapshot(w, character);
    assert.equal(snap.place.id, TOWN_ID);
    assert.ok(ZONE_BY_ID[snap.place.id], "place must be a real zone");
    const moves = snap.validActions.filter((a) => a.kind === "move");
    assert.ok(moves.length > 0);
    for (const m of moves) {
      assert.ok(ZONE_BY_ID[m.targetId], "move target must be a real zone");
    }
    assert.ok(snap.validActions.some((a) => a.kind === "rest"));
  });

  test("anonymous snapshot has no valid actions but still reads the world", () => {
    const w = freshWorld();
    const snap = projectSigmacraftSnapshot(w, null);
    assert.deepEqual(snap.validActions, []);
    assert.equal(snap.place.id, TOWN_ID);
  });

  test("snapshot includes the world-map zones with a current flag", () => {
    const w = freshWorld();
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.ok(snap.zones.length >= 6, "all zones projected for the map");
    const current = snap.zones.filter((z) => z.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, TOWN_ID);
  });

  test("an explicit token keys the current place to actorPlaces", () => {
    const w = freshWorld();
    const targetId = Object.keys(ZONE_BY_ID).find((id) => id !== TOWN_ID);
    w.sigmacraft.actorPlaces.sig_z = targetId;
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.equal(snap.place.id, targetId, "place follows the token's tracked zone");
  });

  test("occupants surface existing NPCs standing in the current zone", () => {
    const w = freshWorld();
    // freshWorld seeds NPCs at their home zones; find one and stand there.
    const npc = Object.values(w.npcs)[0];
    w.sigmacraft.actorPlaces.sig_z = npc.zoneId;
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.ok(snap.occupants.some((o) => o.kind === "npc" && o.id === npc.id), "NPC in zone is an occupant");
  });
});

describe("Sigmacraft advancer", () => {
  test("resolves a queued move into actor place + event", () => {
    const w = freshWorld();
    const targetId = Object.keys(ZONE_BY_ID).find((id) => id !== TOWN_ID);
    enqueueSigmacraftIntent(w, "tok_a", { kind: "move", targetId });
    advance({ world: w });
    assert.equal(w.sigmacraft.tick, 1);
    assert.equal(w.sigmacraft.actorPlaces.tok_a, targetId);
    assert.equal(w.sigmacraft.pendingIntents.length, 0);
    assert.match(w.sigmacraft.recentEvents.at(-1).text, new RegExp(ZONE_BY_ID[targetId].name));
  });

  test("enqueue keeps only one pending intent per actor", () => {
    const w = freshWorld();
    enqueueSigmacraftIntent(w, "tok_a", { kind: "rest" });
    const res = enqueueSigmacraftIntent(w, "tok_a", { kind: "talk" });
    assert.equal(res.status, "queued");
    assert.equal(w.sigmacraft.pendingIntents.length, 1);
    assert.equal(w.sigmacraft.pendingIntents[0].kind, "talk");
  });

  test("recent events stay capped under churn", () => {
    const w = freshWorld();
    for (let i = 0; i < MAX_SIGMACRAFT_RECENT_EVENTS + 20; i++) {
      enqueueSigmacraftIntent(w, `tok_${i}`, { kind: "talk" });
      advance({ world: w });
    }
    assert.ok(w.sigmacraft.recentEvents.length <= MAX_SIGMACRAFT_RECENT_EVENTS);
  });

  test("idle advance is a no-op: no tick bump, no mutation, returns false", () => {
    const w = freshWorld();
    const before = JSON.stringify(w.sigmacraft);
    const dirty = advance({ world: w });
    assert.equal(dirty, false, "idle tick must report not-dirty so the loop skips persistence");
    assert.equal(w.sigmacraft.tick, 0, "tick must not advance on an idle world");
    assert.equal(JSON.stringify(w.sigmacraft), before, "no state may change on an idle tick");
  });

  test("advance reports dirty only when it resolves work", () => {
    const w = freshWorld();
    enqueueSigmacraftIntent(w, "tok_a", { kind: "rest" });
    assert.equal(advance({ world: w }), true);
    assert.equal(advance({ world: w }), false, "next idle tick is not dirty");
  });

  test("enqueue de-dups a repeated nonce idempotently", () => {
    const w = freshWorld();
    enqueueSigmacraftIntent(w, "tok_a", { kind: "rest", nonce: "n1" });
    const dup = enqueueSigmacraftIntent(w, "tok_a", { kind: "rest", nonce: "n1" });
    assert.equal(dup.deduped, true);
    assert.equal(w.sigmacraft.pendingIntents.length, 1);
  });
});

describe("vSigmacraftIntent trust boundary", () => {
  test("accepts a bounded move/rest/talk and rejects unknown kinds + zones", () => {
    const moveTarget = ZONE_IDS.find((id) => id !== TOWN_ID);
    assert.deepEqual(vSigmacraftIntent({ kind: "move", targetId: moveTarget, nonce: "n1" }), {
      kind: "move",
      nonce: "n1",
      targetId: moveTarget,
    });
    assert.deepEqual(vSigmacraftIntent({ kind: "rest" }), { kind: "rest", nonce: "" });
    assert.deepEqual(vSigmacraftIntent({ kind: "talk", nonce: "x" }), { kind: "talk", nonce: "x" });
    assert.throws(() => vSigmacraftIntent({ kind: "teleport" }), /bad enum/);
    assert.throws(() => vSigmacraftIntent({ kind: "move", targetId: "narnia" }), /bad enum/);
    assert.throws(() => vSigmacraftIntent("not-an-object"), /expected object/);
  });

  test("nonce is bounded to 64 chars", () => {
    const out = vSigmacraftIntent({ kind: "rest", nonce: "z".repeat(200) });
    assert.equal(out.nonce.length, 64);
  });
});

describe("startWorldTick legacy gating", () => {
  test("fast lane runs every base tick; legacy lane every Nth", () => {
    let fast = 0;
    let legacy = 0;
    // Minimal fakes for the supervised loop.
    const world = freshWorld();
    const store = {
      getWorldState: () => world,
      putWorldState: () => {},
      allPlayers: () => {
        legacy += 1; // allPlayers() is only called inside the legacy lane
        return [];
      },
      drainZoneEvents: () => [],
    };
    let tickFn = null;
    const superviseInterval = (_label, fn) => {
      tickFn = fn;
      return { stop() {} };
    };
    startWorldTick({
      store,
      rt: null,
      superviseInterval,
      intervalMs: 3000,
      legacyEvery: 20,
      fastAdvancers: [() => { fast += 1; }],
      extraAdvancers: [],
    });
    for (let i = 0; i < 40; i++) tickFn();
    assert.equal(fast, 40, "fast lane runs every base tick");
    assert.equal(legacy, 2, "legacy lane runs every 20th base tick");
  });
});
