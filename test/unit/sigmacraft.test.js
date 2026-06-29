// SIGMA ABYSS — Sigmacraft overworld projection + advancer.
// Run: node --test test/unit/sigmacraft.test.js

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  projectSigmacraftSnapshot,
  SIGMACRAFT_INTENT_KINDS,
  MAX_SIGMACRAFT_RECENT_EVENTS,
  NPC_POPULATION_TARGET,
} from "../../shared/sigmacraft.js";
import { advance, enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { freshWorld, startWorldTick } from "../../server/world-tick.js";
import { vSigmacraftIntent } from "../../server/validate.js";

const townOf = (w) => w.sigmacraft.map.townTileId;
const exitOf = (w, tileId) => w.sigmacraft.map.tiles[tileId].exits[0];

describe("Sigmacraft state + overworld projection", () => {
  test("freshWorld seeds the overworld map + 200-agent population", () => {
    const w = freshWorld();
    assert.equal(w.sigmacraft.schema, "sigmacraft.world.v2");
    assert.equal(w.sigmacraft.tick, 0);
    assert.ok(Object.keys(w.sigmacraft.map.tiles).length >= 100, "100+ tiles");
    assert.equal(Object.keys(w.sigmacraft.overworldNpcs).length, NPC_POPULATION_TARGET);
    assert.deepEqual(w.sigmacraft.pendingIntents, []);
  });

  test("intent kinds are the bounded enum", () => {
    assert.deepEqual([...SIGMACRAFT_INTENT_KINDS].sort(), ["disband", "move", "recruit", "rest", "talk"]);
  });

  test("snapshot projects the current tile + tile-exit move actions + windowed map", () => {
    const w = freshWorld();
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.equal(snap.place.id, townOf(w), "anonymous starts at the town tile");
    assert.ok(w.sigmacraft.map.tiles[snap.place.id], "place is a real tile");
    assert.equal(snap.place.terrain, w.sigmacraft.map.tiles[snap.place.id].terrain);
    const moves = snap.validActions.filter((a) => a.kind === "move");
    assert.ok(moves.length > 0);
    for (const m of moves) assert.ok(w.sigmacraft.map.tiles[m.targetId], "move target is a real tile");
    assert.ok(snap.validActions.some((a) => a.kind === "rest"));
    assert.ok(snap.worldMap.cells.length > 0 && snap.worldMap.cells.some((c) => c.current));
  });

  test("snapshot includes a compact all-NPC map roster for animation", () => {
    const w = freshWorld();
    const npc = Object.values(w.sigmacraft.overworldNpcs)[0];
    w.sigmacraft.npcAgents[npc.id] = {
      plan: {
        goal: "map the dangerous road",
        agenda: [{ kind: "move", targetTileId: "basilisk_badlands" }],
        cursor: 0,
        dialogueLine: "The road has teeth.",
        source: "fallback",
        plannedAtTick: 7,
      },
    };
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.equal(snap.worldMap.npcs.length, NPC_POPULATION_TARGET);
    const pub = snap.worldMap.npcs.find((n) => n.id === npc.id);
    assert.equal(pub.tileId, npc.tileId);
    assert.equal(pub.doing, "move");
    assert.equal(pub.targetTileId, "basilisk_badlands");
    assert.equal(pub.plannedAtTick, 7);
    assert.equal(pub.memory, undefined, "rolling memory stays server-side");
  });

  test("an explicit token keys the current tile to actorPlaces", () => {
    const w = freshWorld();
    const target = exitOf(w, townOf(w));
    w.sigmacraft.actorPlaces.sig_z = target;
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.equal(snap.place.id, target, "place follows the token's tracked tile");
  });

  test("occupants surface overworld NPCs standing in the current tile", () => {
    const w = freshWorld();
    const npc = Object.values(w.sigmacraft.overworldNpcs)[0];
    w.sigmacraft.actorPlaces.sig_z = npc.tileId;
    const snap = projectSigmacraftSnapshot(w, null, { token: "sig_z" });
    assert.ok(snap.occupants.some((o) => o.kind === "npc" && o.id === npc.id));
  });
});

describe("Sigmacraft advancer", () => {
  test("resolves a queued move to an adjacent tile + event", () => {
    const w = freshWorld();
    const target = exitOf(w, townOf(w)); // adjacent to the town (the default start)
    enqueueSigmacraftIntent(w, "tok_a", { kind: "move", targetId: target });
    advance({ world: w });
    assert.equal(w.sigmacraft.tick, 1);
    assert.equal(w.sigmacraft.actorPlaces.tok_a, target);
    assert.match(w.sigmacraft.recentEvents.at(-1).text, new RegExp(w.sigmacraft.map.tiles[target].name));
  });

  test("a non-adjacent move is rejected at apply time (no teleport)", () => {
    const w = freshWorld();
    // a far tile that is NOT an exit of the town
    const far = Object.keys(w.sigmacraft.map.tiles).find(
      (id) => id !== townOf(w) && !w.sigmacraft.map.tiles[townOf(w)].exits.includes(id),
    );
    enqueueSigmacraftIntent(w, "tok_a", { kind: "move", targetId: far });
    advance({ world: w });
    assert.notEqual(w.sigmacraft.actorPlaces.tok_a, far, "did not teleport across the map");
    assert.match(w.sigmacraft.recentEvents.at(-1).text, /could not find that road/);
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
    assert.equal(advance({ world: w }), false);
    assert.equal(w.sigmacraft.tick, 0);
    assert.equal(JSON.stringify(w.sigmacraft), before);
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
  test("accepts move/rest/talk; rejects bad kinds + malformed tile ids", () => {
    assert.deepEqual(vSigmacraftIntent({ kind: "move", targetId: "millbridge", nonce: "n1" }), {
      kind: "move",
      nonce: "n1",
      targetId: "millbridge",
    });
    assert.deepEqual(vSigmacraftIntent({ kind: "rest" }), { kind: "rest", nonce: "" });
    assert.deepEqual(vSigmacraftIntent({ kind: "talk", nonce: "x" }), { kind: "talk", nonce: "x" });
    assert.throws(() => vSigmacraftIntent({ kind: "teleport" }), /bad enum/);
    assert.throws(() => vSigmacraftIntent({ kind: "move", targetId: "Bad Tile!" }), /bad tile id/);
    assert.throws(() => vSigmacraftIntent("not-an-object"), /expected object/);
  });
});

describe("startWorldTick legacy gating", () => {
  test("fast lane runs every base tick; legacy lane every Nth", () => {
    let fast = 0;
    let legacy = 0;
    const world = freshWorld();
    const store = {
      getWorldState: () => world,
      putWorldState: () => {},
      allPlayers: () => {
        legacy += 1;
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
    assert.equal(fast, 40);
    assert.equal(legacy, 2);
  });
});
