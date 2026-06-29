// Spike test — MMO: 100 concurrent resolveEncounter simulations via Promise.all.
// All must complete without error; total wall time < 500ms.

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

function makeEnemy(i) {
  return {
    id: `e${i}`,
    name: `Mob${i}`,
    hp: 40,
    maxHp: 40,
    attack: 8,
    defense: 2,
    threat: 1,
    kind: "normal",
    xp: 50,
    gold: 10,
    lootTable: [],
  };
}

describe("mmo — spike (N=100 parallel resolveEncounter)", () => {
  test("all 100 concurrent encounters complete without error", async () => {
    const N = 100;
    const t0 = performance.now();

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve(
          resolveEncounter({
            fighter: makeFighter(),
            enemies: [makeEnemy(i % 10)],
            ai: { priority: "nearest" },
            rng: makeRng(i * 3571 + 2),
          }),
        ),
      ),
    );

    const elapsed = performance.now() - t0;
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(failed.length, 0);
    assert.ok(elapsed < 500, `spike took ${elapsed.toFixed(1)}ms >= 500ms threshold`);
  });
});
