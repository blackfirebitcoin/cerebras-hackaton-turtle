// SIGMA ABYSS — Gemma NPC planner (PR7) over the 200-agent overworld.
// Run: node --test test/unit/npc-agents-planner.test.js
// NO live LLM: NPC_PLANNER_LIVE unset ⇒ deterministic fallback only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachNpcPlanner, makeNpcFallbackProposal } from "../../server/sigmacraft-npc-agents.js";
import { freshWorld } from "../../server/world-tick.js";
import { vNpcProposal } from "../../server/validate.js";

function fakeStore(world) {
  let dirty = false;
  return { getWorldState: () => world, putWorldState: () => { dirty = true; }, wasDirty: () => dirty };
}
const anyNpcId = (w) => Object.keys(w.sigmacraft.overworldNpcs).sort()[0];

describe("deterministic fallback proposal", () => {
  test("every overworld NPC's fallback survives the validator unchanged in shape", () => {
    const w = freshWorld();
    let moves = 0;
    for (const id of Object.keys(w.sigmacraft.overworldNpcs)) {
      const p = makeNpcFallbackProposal(id, w);
      const clean = vNpcProposal(p);
      assert.equal(clean.npcId, id);
      assert.ok(["talk", "move"].includes(clean.step.kind));
      assert.ok(clean.dialogueLine.length <= 140);
      assert.ok(clean.currentGoal.length <= 96);
      if (clean.step.kind === "move") {
        // move targets are real adjacent tiles
        assert.ok(w.sigmacraft.map.tiles[clean.step.targetId], "move target is a real tile");
        const here = w.sigmacraft.overworldNpcs[id].tileId;
        assert.ok(w.sigmacraft.map.tiles[here].exits.includes(clean.step.targetId), "tile is adjacent");
        moves += 1;
      }
    }
    assert.ok(moves > 0, "some NPCs choose to move");
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
});
