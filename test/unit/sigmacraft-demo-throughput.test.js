// Hackathon throughput demo telemetry.
// Run: node --test test/unit/sigmacraft-demo-throughput.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEMO_PLANS_DEMANDED_PER_10S,
  demoThroughputStatus,
  setDemoThroughputProfile,
  takeReadyDemoPlannerJobs,
} from "../../server/sigmacraft-demo-throughput.js";

const sigmacraftWithNpcs = (count = 200) => ({
  overworldNpcs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`npc_${String(i).padStart(3, "0")}`, { id: `npc_${String(i).padStart(3, "0")}` }])),
});

describe("sigmacraft demo throughput", () => {
  test("Cerebras profile can satisfy the demo planning demand", () => {
    const world = {};
    const p = setDemoThroughputProfile(world, "cerebras", 1_000);

    assert.equal(p.profile, "cerebras");
    assert.equal(p.partyFinderStalls, false);
    assert.ok(p.capacityPer10s >= p.demandPer10s);
    assert.ok(p.partyJoinMs.every((ms) => ms <= p.partyDeadlineMs));
  });

  test("50 token simulated profile visibly falls behind", () => {
    const world = {};
    setDemoThroughputProfile(world, "slow50", 1_000);
    const p = demoThroughputStatus(world, 31_000);

    assert.equal(p.profile, "slow50");
    assert.equal(p.partyFinderStalls, true);
    assert.ok(p.capacityPer10s < p.demandPer10s);
    assert.ok(p.queueDepth > 20);
    assert.ok(p.staleNpcs > 20);
    assert.ok(p.partyJoinMs.some((ms) => ms > p.partyDeadlineMs));
  });

  test("fast profile clears the real planner stress queue", () => {
    const s = sigmacraftWithNpcs();
    const p = setDemoThroughputProfile(s, "cerebras", 50_000);

    assert.equal(p.profile, "cerebras");
    assert.equal(p.requestedJobs, DEMO_PLANS_DEMANDED_PER_10S * 3);
    assert.equal(p.queueDepth, 0);
    assert.equal(p.staleNpcs, 0);
    assert.equal(p.completedJobs, DEMO_PLANS_DEMANDED_PER_10S * 3);
    assert.equal(p.readyNpcs, DEMO_PLANS_DEMANDED_PER_10S * 3);
    const ready = takeReadyDemoPlannerJobs(s, Object.keys(s.overworldNpcs), 5, 50_000);
    assert.equal(ready.length, 5);
  });

  test("Model A leaves real overdue NPC planner jobs in the queue", () => {
    const s = sigmacraftWithNpcs();
    const p = setDemoThroughputProfile(s, "slow50", 50_000);

    assert.equal(p.profile, "slow50");
    assert.equal(p.requestedJobs, DEMO_PLANS_DEMANDED_PER_10S * 3);
    assert.ok(p.completedJobs < 10);
    assert.ok(p.queueDepth > 100);
    assert.ok(p.staleNpcs > 100);
    assert.ok(p.missedDeadlines > 100);
    assert.ok(Array.isArray(s.demoThroughput.staleNpcIds));
    assert.equal(s.demoThroughput.staleNpcIds.length, p.staleNpcs);
  });
});
