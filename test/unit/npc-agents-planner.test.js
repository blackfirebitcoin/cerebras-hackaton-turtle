// SIGMA ABYSS — Gemma NPC planner (PR7) over the 200-agent overworld.
// Run: node --test test/unit/npc-agents-planner.test.js
// NO live LLM: NPC_PLANNER_LIVE unset ⇒ deterministic fallback only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachNpcPlanner, makeNpcFallbackProposal } from "../../server/sigmacraft-npc-agents.js";
import { setDemoThroughputProfile } from "../../server/sigmacraft-demo-throughput.js";
import { freshWorld } from "../../server/world-tick.js";
import { vNpcProposal } from "../../server/validate.js";

function fakeStore(world) {
  let dirty = false;
  return { getWorldState: () => world, putWorldState: () => { dirty = true; }, wasDirty: () => dirty };
}
const anyNpcId = (w) => Object.keys(w.sigmacraft.overworldNpcs).sort()[0];

import { NPC_ACTION_KINDS } from "../../shared/sigmacraft.js";

describe("deterministic fallback agenda", () => {
  test("every overworld NPC's fallback agenda survives the validator + is grounded", () => {
    const w = freshWorld();
    for (const id of Object.keys(w.sigmacraft.overworldNpcs)) {
      const p = makeNpcFallbackProposal(id, w);
      const clean = vNpcProposal(p);
      assert.equal(clean.npcId, id);
      assert.ok(Array.isArray(clean.agenda) && clean.agenda.length > 0, "has a non-empty agenda");
      assert.ok(clean.agenda.length <= 5, "agenda bounded");
      for (const obj of clean.agenda) {
        assert.ok(NPC_ACTION_KINDS.includes(obj.kind), `known action kind: ${obj.kind}`);
        if (obj.targetTileId) {
          assert.ok(w.sigmacraft.map.tiles[obj.targetTileId], "objective targets a REAL tile");
        }
      }
      assert.ok(clean.dialogueLine.length <= 140);
      assert.ok(clean.currentGoal.length <= 96);
    }
  });

  test("is deterministic for the same (npc, tick, tile)", () => {
    const w = freshWorld();
    const id = anyNpcId(w);
    assert.deepEqual(makeNpcFallbackProposal(id, w), makeNpcFallbackProposal(id, w));
  });
});

describe("off-tick scheduler", () => {
  test("plan() writes proposals but never moves the NPC itself (proposal-only)", async () => {
    const w = freshWorld();
    const store = fakeStore(w);
    const id0 = anyNpcId(w);
    const tileBefore = w.sigmacraft.overworldNpcs[id0].tileId;

    await attachNpcPlanner({ store, env: {} }).plan();

    assert.ok(w.sigmacraft.npcAgents[id0]?.plan, "a plan was written for the first NPC");
    assert.equal(w.sigmacraft.npcAgents[id0].plan.plannedAtTick, w.sigmacraft.tick);
    // Ambient NPC plans are in-memory only — the planner must NOT raise the persist
    // signal, or an idle/player-less server would rewrite world.json every cycle
    // (idle quiescence / write-amplification guard; see server/sigmacraft.js).
    assert.ok(!store.wasDirty(), "planner does not persist ambient NPC churn");
    assert.equal(w.sigmacraft.overworldNpcs[id0].tileId, tileBefore, "planner does not move the NPC");
  });

  test("batch auto-sizes to refresh the whole population within the reuse window", async () => {
    const w = freshWorld();
    await attachNpcPlanner({ store: fakeStore(w), env: {} }).plan();
    const planned = Object.values(w.sigmacraft.npcAgents).filter((a) => a.plan).length;
    // ceil(200 / NPC_PLAN_REUSE_TICKS=5) = 40
    assert.equal(planned, Math.ceil(Object.keys(w.sigmacraft.overworldNpcs).length / 5));
  });

  test("env override caps the batch", async () => {
    const w = freshWorld();
    await attachNpcPlanner({ store: fakeStore(w), env: { SIGMACRAFT_NPC_MAX_PER_CYCLE: "3" } }).plan();
    assert.equal(Object.values(w.sigmacraft.npcAgents).filter((a) => a.plan).length, 3);
  });

  test("demo throughput queue throttles how many NPC plans can be written", async () => {
    const w = freshWorld();
    setDemoThroughputProfile(w.sigmacraft, "slow50", Date.now());

    await attachNpcPlanner({ store: fakeStore(w), env: {} }).plan();

    const planned = Object.values(w.sigmacraft.npcAgents).filter((a) => a.plan).length;
    assert.ok(planned > 0, "some completed jobs can plan");
    assert.ok(planned < Math.ceil(Object.keys(w.sigmacraft.overworldNpcs).length / 5), "slow throughput cannot write the full batch");
    assert.ok(w.sigmacraft.demoThroughput.queue.length > 100, "uncompleted jobs remain queued");
  });
});
