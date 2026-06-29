// Stress test — MMO resolveEncounter: N=5000 encounters.
// Assert no exceptions thrown.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveEncounter } from "../../shared/combat.js";
import { makeRng } from "../../shared/rng.js";

function makeFighter(hp = 80) {
  return {
    hp,
    maxHp: hp,
    attack: 12,
    defense: 4,
    crit: 0.1,
    dodge: 0.05,
    potions: 1,
    effects: [],
    priority: "nearest",
  };
}

function makeEnemy(i) {
  return {
    id: `e${i}`,
    name: `Enemy${i}`,
    hp: 20 + (i % 40),
    maxHp: 60,
    attack: 7 + (i % 5),
    defense: 1,
    threat: 1,
    kind: "normal",
    xp: 40,
    gold: 5,
    lootTable: [],
  };
}

describe("mmo — stress (N=5000 resolveEncounter)", () => {
  test("no exceptions; all encounters return a result", () => {
    const N = 5000;
    let errors = 0;
    let results = 0;

    for (let i = 0; i < N; i++) {
      try {
        const rng = makeRng(i * 6271 + 3);
        const outcome = resolveEncounter({
          fighter: makeFighter(50 + (i % 100)),
          enemies: [makeEnemy(i % 20)],
          ai: { priority: ["nearest", "lowest_hp", "highest_threat"][i % 3] },
          rng,
        });
        if (outcome) results++;
      } catch {
        errors++;
      }
    }

    assert.equal(errors, 0);
    assert.equal(results, N);
  });
});
