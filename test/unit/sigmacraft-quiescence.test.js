// SIGMA ABYSS — RF-1/RF-2: the idle-quiescence invariant (write-amplification
// regression guard, PSU power safety). The 15s NPC planner keeps manufacturing
// ambient plans, but on a player-less world the system MUST reach a no-write
// steady state: the planner must not raise the persist signal, and the fast lane
// (advance) must return false for NPC-only ticks. A player intent, by contrast,
// MUST raise it (player state has to survive restart).
//
// Unlike a hand-seeded "0 plans" check, this drives the REAL attachNpcPlanner loop
// so it reflects a running server.
// Run: node --test test/unit/sigmacraft-quiescence.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance, enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { attachNpcPlanner } from "../../server/sigmacraft-npc-agents.js";
import { freshWorld } from "../../server/world-tick.js";

// A store that counts persist signals (putWorldState). getWorldState hands out
// the live world ref, exactly like the real store.
function trackingStore(world) {
  let puts = 0;
  return {
    getWorldState: () => world,
    putWorldState: () => { puts += 1; },
    pushFeed: () => {},
    puts: () => puts,
  };
}

const anyUnconsumedPlan = (w) =>
  Object.values(w.sigmacraft.npcAgents).some((a) => a?.plan && !a.plan.consumed);

describe("idle-quiescence: a player-less world reaches a no-write steady state", () => {
  test("the real planner + fast lane never raise the persist signal with no players", async () => {
    const w = freshWorld();
    const store = trackingStore(w);
    const planner = attachNpcPlanner({ store, env: {} });

    // Drive several full planner→consume cycles, exactly as the live loops do.
    for (let cycle = 0; cycle < 3; cycle++) {
      await planner.plan(); // manufactures ~40 ambient plans (deterministic fallback)
      assert.ok(anyUnconsumedPlan(w), "planner produced unconsumed ambient plans (loop is live)");
      // The fast lane drains them over multiple base ticks; none may be a persist
      // signal. 6 ticks comfortably drains a 40-plan batch at 12/tick.
      for (let t = 0; t < 6; t++) {
        assert.equal(advance({ world: w, store }), false, "an NPC-only tick must not be dirty");
      }
    }
    assert.equal(store.puts(), 0, "no world.json persist was triggered by ambient NPC churn");
  });

  test("a queued PLAYER intent DOES raise the persist signal (player state must survive restart)", async () => {
    const w = freshWorld();
    const store = trackingStore(w);
    const token = "agt_quiescence";
    const town = w.sigmacraft.map.townTileId;
    const dest = w.sigmacraft.map.tiles[town].exits[0];

    enqueueSigmacraftIntent(w, token, { kind: "move", targetId: dest, nonce: "q1" });
    assert.equal(advance({ world: w, store }), true, "a player move is a durable mutation → dirty");
    assert.equal(w.sigmacraft.actorPlaces[token], dest, "the player move resolved");
  });
});
