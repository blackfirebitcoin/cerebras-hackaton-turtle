// Scalability test — MMO resolveEncounter enemy count scaling.
// N=1, 10, 50 enemies; assert time(50-enemy) < 200 * time(1-enemy).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEncounter } from "../../shared/combat.js";
import { makeRng } from "../../shared/rng.js";

function makeFighter() {
  return {
    hp: 500,
    maxHp: 500,
    attack: 30,
    defense: 10,
    crit: 0.15,
    dodge: 0.05,
    potions: 5,
    effects: [],
    priority: "nearest",
  };
}

function makeEnemies(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    name: `Mob${i}`,
    hp: 20,
    maxHp: 20,
    attack: 5,
    defense: 1,
    threat: 1,
    kind: "normal",
    xp: 10,
    gold: 2,
    lootTable: [],
  }));
}

function runBatch(enemyCount, iterations) {
  const enemies = makeEnemies(enemyCount);
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    resolveEncounter({
      fighter: makeFighter(),
      enemies: [...enemies.map((e) => ({ ...e }))], // fresh copies so HP resets
      ai: { priority: "nearest" },
      rng: makeRng(i * 4999 + enemyCount),
    });
  }
  return (performance.now() - t0) / iterations;
}

describe("mmo — scalability (enemy count scaling)", () => {
  test("sub-quadratic: time(50-enemy) < 200 * time(1-enemy)", () => {
    // Warm up
    runBatch(1, 5);

    const t1 = runBatch(1, 50);
    runBatch(10, 20); // mid-point
    const t50 = runBatch(50, 10);

    assert.ok(
      t50 < 200 * Math.max(t1, 0.001),
      `t50=${t50.toFixed(3)}ms, t1=${t1.toFixed(3)}ms — exceeded 200× ratio`,
    );
  });
});
