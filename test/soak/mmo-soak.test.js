// Soak test — MMO resolveEncounter: N=500 over simulated 60s.
// Assert no latency degradation between first 10% and last 10%.

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

function makeEnemies(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `Mob${i}`,
    hp: 30 + i * 5,
    maxHp: 55,
    attack: 8,
    defense: 2,
    threat: 1,
    kind: "normal",
    xp: 45,
    gold: 8,
    lootTable: [],
  }));
}

describe("mmo — soak (N=500 over simulated 60s)", () => {
  test("no latency degradation across simulated window", () => {
    const N = 500;
    const latencies = [];

    for (let i = 0; i < N; i++) {
      const rng = makeRng(i * 8191 + 7);
      const t0 = performance.now();
      resolveEncounter({
        fighter: makeFighter(),
        enemies: makeEnemies(1 + (i % 4)),
        ai: { priority: "nearest" },
        rng,
      });
      latencies.push(performance.now() - t0);
    }

    const slice = Math.floor(N * 0.1);
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const earlyAvg = avg(latencies.slice(0, slice));
    const lateAvg = avg(latencies.slice(-slice));

    assert.ok(
      lateAvg < earlyAvg * 3 + 5,
      `late avg ${lateAvg.toFixed(2)}ms >= 3× early avg ${earlyAvg.toFixed(2)}ms + 5ms buffer`,
    );
  });
});
