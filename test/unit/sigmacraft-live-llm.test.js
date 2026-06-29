// SIGMA ABYSS — Phase D: live-Gemma wiring for the NPC planner + Director, driven
// by an INJECTED mock llm client (no real network). Proves the live path maps
// model output into the SAME validated proposal shape (source "gemma"), and that
// any failure / unavailability hard-falls-back to the deterministic planner.
// Run: node --test test/unit/sigmacraft-live-llm.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachNpcPlanner } from "../../server/sigmacraft-npc-agents.js";
import { attachDirector } from "../../server/sigmacraft-director.js";
import { freshWorld } from "../../server/world-tick.js";

const fakeStore = (world) => ({ getWorldState: () => world, putWorldState: () => {}, pushFeed: () => {} });
const okLlm = (reply) => ({ available: () => true, chat: async () => reply });
const throwingLlm = () => ({ available: () => true, chat: async () => { throw new Error("boom"); } });
const unavailableLlm = () => {
  let called = false;
  return { available: () => false, chat: async () => { called = true; return {}; }, wasCalled: () => called };
};
const firstPlan = (w) => Object.values(w.sigmacraft.npcAgents).find((a) => a?.plan)?.plan;

describe("NPC planner — live Gemma via the seam", () => {
  test("maps a model reply into a validated 'gemma' proposal", async () => {
    const w = freshWorld();
    const planner = attachNpcPlanner({
      store: fakeStore(w),
      env: { NPC_PLANNER_LIVE: "1", SIGMACRAFT_NPC_MAX_PER_CYCLE: "3" },
      llm: okLlm({ goal: "scout the marches", line: "Stay sharp.", action: "talk" }),
    });
    await planner.plan();
    const plan = firstPlan(w);
    assert.ok(plan, "a plan was written");
    assert.equal(plan.source, "gemma");
    assert.equal(plan.currentGoal, "scout the marches");
    assert.equal(plan.step.kind, "talk");
  });

  test("a model failure hard-falls-back to the deterministic planner", async () => {
    const w = freshWorld();
    const planner = attachNpcPlanner({
      store: fakeStore(w),
      env: { NPC_PLANNER_LIVE: "1", SIGMACRAFT_NPC_MAX_PER_CYCLE: "3" },
      llm: throwingLlm(),
    });
    await planner.plan();
    assert.equal(firstPlan(w).source, "fallback");
  });

  test("live flag set but seam unavailable ⇒ fallback, and chat is never called", async () => {
    const w = freshWorld();
    const llm = unavailableLlm();
    const planner = attachNpcPlanner({
      store: fakeStore(w),
      env: { NPC_PLANNER_LIVE: "1", SIGMACRAFT_NPC_MAX_PER_CYCLE: "3" },
      llm,
    });
    await planner.plan();
    assert.equal(firstPlan(w).source, "fallback");
    assert.equal(llm.wasCalled(), false, "an unavailable seam is never called");
  });
});

describe("Director — live Gemma via the seam", () => {
  test("maps a model reply into a validated 'gemma' director beat", async () => {
    const w = freshWorld();
    const director = attachDirector({
      store: fakeStore(w),
      env: { DIRECTOR_LIVE: "1" },
      llm: okLlm({ kind: "rumor", title: "", text: "A bell rings with no hand to ring it." }),
    });
    assert.equal(await director.propose(), true);
    const beat = w.sigmacraft.directorQueue[0];
    assert.equal(beat.source, "gemma");
    assert.equal(beat.kind, "rumor");
    assert.match(beat.text, /bell rings/);
  });

  test("a model failure hard-falls-back to a deterministic beat", async () => {
    const w = freshWorld();
    const director = attachDirector({ store: fakeStore(w), env: { DIRECTOR_LIVE: "1" }, llm: throwingLlm() });
    assert.equal(await director.propose(), true);
    assert.equal(w.sigmacraft.directorQueue[0].source, "fallback");
  });
});
