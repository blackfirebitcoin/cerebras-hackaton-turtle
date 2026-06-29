// Load test — MMO resolveEncounter hot path.
// N=1000 sequential combat resolutions; assert mean < 5ms, p99 < 20ms.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEncounter } from "../../shared/combat.js";
import { makeRng } from "../../shared/rng.js";

function makeFighter() {
  return {
    hp: 100,
    maxHp: 100,
    attack: 15,
    defense: 5,
    crit: 0.1,
    dodge: 0.05,
    potions: 2,
    effects: [],
    priority: "nearest",
  };
}

function makeEnemies(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `Goblin ${i}`,
    hp: 30 + i * 10,
    maxHp: 30 + i * 10,
    attack: 8 + i,
    defense: 2,
    threat: 1,
    kind: "normal",
    xp: 50,
    gold: 10,
    lootTable: [],
  }));
}

describe("mmo — load (N=1000 resolveEncounter)", () => {
  test("mean < 5ms, p99 < 20ms", () => {
    const N = 1000;
    const latencies = [];
    const ai = { priority: "nearest" };

    for (let i = 0; i < N; i++) {
      const rng = makeRng(i * 7919 + 1);
      const fighter = makeFighter();
      const enemies = makeEnemies(2 + (i % 3));

      const t0 = performance.now();
      resolveEncounter({ fighter, enemies, ai, rng });
      latencies.push(performance.now() - t0);
    }

    latencies.sort((a, b) => a - b);
    const mean = latencies.reduce((s, v) => s + v, 0) / N;
    const p99 = latencies[Math.floor(N * 0.99)];

    assert.ok(mean < 5, `mean ${mean.toFixed(3)}ms >= 5ms threshold`);
    assert.ok(p99 < 20, `p99 ${p99.toFixed(3)}ms >= 20ms threshold`);
  });
});
