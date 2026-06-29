// SIGMA ABYSS — Gemma NPC planner (integrate-this PR7), deterministic fallback.
// Run: node --test test/unit/npc-agents-planner.test.js
// NO live LLM: NPC_PLANNER_LIVE is unset, so the deterministic fallback is the
// entire path — fully socket-free.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachNpcPlanner, makeNpcFallbackProposal } from "../../server/sigmacraft-npc-agents.js";
import { freshWorld } from "../../server/world-tick.js";
import { vNpcProposal } from "../../server/validate.js";
import { NPC_IDS } from "../../shared/npc-defs.js";
import { ZONE_BY_ID, ZONE_IDS } from "../../shared/zones.js";

function fakeStore(world) {
  let dirty = false;
  return { getWorldState: () => world, putWorldState: () => { dirty = true; }, wasDirty: () => dirty };
}

describe("deterministic fallback proposal", () => {
  test("every NPC's fallback survives the validator unchanged in shape", () => {
    const w = freshWorld();
    for (const id of NPC_IDS) {
      const p = makeNpcFallbackProposal(id, w);
      const clean = vNpcProposal(p);
      assert.equal(clean.npcId, id);
      assert.ok(["talk", "move"].includes(clean.step.kind));
      assert.ok(clean.dialogueLine.length <= 140);
      assert.ok(clean.currentGoal.length <= 96);
      assert.ok(!/\{name\}/.test(clean.dialogueLine), "no unresolved placeholder leaks");
    }
  });

  test("is deterministic for the same (npc, tick, zone, phase)", () => {
    const w = freshWorld();
    const a = makeNpcFallbackProposal(NPC_IDS[0], w);
    const b = makeNpcFallbackProposal(NPC_IDS[0], w);
    assert.deepEqual(a, b);
  });

  test("move targets are real zones one tier away", () => {
    const w = freshWorld();
    for (const id of NPC_IDS) {
      const p = makeNpcFallbackProposal(id, w);
      if (p.step.kind !== "move") continue;
      assert.ok(ZONE_IDS.includes(p.step.targetId), "move target is a real zone");
      const from = ZONE_BY_ID[w.npcs[id].zoneId].tier ?? 0;
      const to = ZONE_BY_ID[p.step.targetId].tier ?? 0;
      assert.equal(Math.abs(to - from), 1, "move is tier ±1");
    }
  });
});

describe("off-tick scheduler", () => {
  test("plan() writes a proposal but never touches schedule/zone (planner is proposal-only)", async () => {
    const w = freshWorld();
    const store = fakeStore(w);
    const id0 = NPC_IDS.slice().sort()[0];
    const phaseBefore = w.npcs[id0].schedulePhase;
    const zoneBefore = w.npcs[id0].zoneId;

    await attachNpcPlanner({ store, env: {} }).plan();

    assert.ok(w.sigmacraft.npcAgents[id0]?.plan, "a plan was written for the first NPC");
    assert.equal(w.sigmacraft.npcAgents[id0].plan.plannedAtTick, w.sigmacraft.tick);
    assert.equal(w.sigmacraft.npcAgents[id0].plan.source, "fallback");
    assert.ok(store.wasDirty(), "putWorldState flagged dirty");
    // The planner must NOT advance the world (that's the tick's job).
    assert.equal(w.npcs[id0].schedulePhase, phaseBefore);
    assert.equal(w.npcs[id0].zoneId, zoneBefore);
  });

  test("default batch size is one plan per cycle", async () => {
    const w = freshWorld();
    await attachNpcPlanner({ store: fakeStore(w), env: {} }).plan();
    const planned = Object.values(w.sigmacraft.npcAgents).filter((a) => a.plan).length;
    assert.equal(planned, 1);
  });

  test("a fresh plan is skipped on the next immediate cycle (reuse window)", async () => {
    const w = freshWorld();
    const store = fakeStore(w);
    const planner = attachNpcPlanner({ store, env: {} });
    await planner.plan();
    const firstId = Object.keys(w.sigmacraft.npcAgents)[0];
    await planner.plan(); // same tick → first NPC within reuse window, planner moves on
    const planned = Object.keys(w.sigmacraft.npcAgents);
    assert.ok(planned.length >= 2 || planned[0] !== firstId, "cursor advanced to a different NPC");
  });
});
