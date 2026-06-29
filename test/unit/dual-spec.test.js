// SIGMA ABYSS — Project Ascendant Inc6: dual specialization.
// Run: node --test test/unit/dual-spec.test.js
//
// The make-or-break constraints this file guards:
//  1. EXACT-IDENTITY — a single-loadout character (no setB, activeSet "A")
//     produces byte-identical derive()/delveTick output (offline↔live parity).
//  2. Migration — an old (v2, no dual-spec fields) save loads as activeSet "A",
//     setB null, gearB null → it IS Set A, byte-identical.
//  3. The active set drives derive() — swapping flips the build the sheet reads.
//  4. The swap is a between-tick data shuffle; it never draws rng.
//  5. Both sets are validated by the trust boundary with the same sub-validators.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vCharacter } from "../../server/validate.js";
import { BUILD_SETS, SCHEMA_VERSION } from "../../shared/constants.js";
import { entryNodeFor } from "../../shared/passive-tree.js";
import { delveTick, deployToZone, freshCharacter, swapBuildSet } from "../../shared/progression.js";
import { RESERVABLE_SKILLS } from "../../shared/skills.js";
import { activeBuild, derive } from "../../shared/stats.js";

// Deterministic deep clone so two characters can run the same sim independently.
const clone = (v) => JSON.parse(JSON.stringify(v));

// Build a high-int character carrying a fire_aura reservation on the active set,
// so derive() shows a non-trivial aura delta + spiritUsed > 0.
function auraChar(seed, name) {
  const c = freshCharacter(seed, name);
  c.run.stats = { ...c.run.stats, int: 30 };
  c.run.hp = derive(c.run, c).maxHp;
  c.reserved = ["fire_aura"];
  return c;
}

describe("Inc6 — schema + defaults", () => {
  test("SCHEMA_VERSION bumped to 3 for dual specialization", () => {
    assert.equal(SCHEMA_VERSION, 3);
  });

  test("BUILD_SETS enum is exactly ['A','B']", () => {
    assert.deepEqual(BUILD_SETS, ["A", "B"]);
  });

  test("freshCharacter defaults to activeSet 'A', setB null, run.gearB null", () => {
    const c = freshCharacter(12345, "New");
    assert.equal(c.activeSet, "A");
    assert.equal(c.setB, null);
    assert.equal(c.run.gearB, null);
    assert.equal(c.v, 3);
  });
});

describe("Inc6 — EXACT-IDENTITY for single-loadout characters", () => {
  test("derive() output is byte-identical with vs. without the new fields", () => {
    // A character with the legacy shape only (no activeSet/setB/gearB at all).
    const legacy = freshCharacter(54321, "Legacy");
    legacy.reserved = ["fire_aura"];
    legacy.run.stats = { ...legacy.run.stats, int: 24 };

    // Strip the new fields entirely to simulate a pre-Inc6 object in memory.
    const stripped = clone(legacy);
    delete stripped.activeSet;
    delete stripped.setB;
    delete stripped.run.gearB;

    const sheetNew = derive(legacy.run, legacy);
    const sheetOld = derive(stripped.run, stripped);
    assert.deepEqual(
      sheetNew,
      sheetOld,
      "derive() must be byte-identical with or without the dual-spec fields",
    );
  });

  test("activeBuild() of a single-loadout char mirrors the legacy top-level fields", () => {
    // Validate first so the character has the full canonical shape (e.g. the
    // Inc5 `position` field, which freshCharacter does not set but validate
    // defaults to "mid").
    const c = vCharacter(freshCharacter(222, "Solo"));
    c.passives = [entryNodeFor(c.passiveStart)];
    c.reserved = [];
    const b = activeBuild(c);
    assert.equal(b.set, "A");
    assert.equal(b.gear, c.run.gear);
    assert.deepEqual(b.passives, c.passives);
    assert.equal(b.passiveStart, c.passiveStart);
    assert.deepEqual(b.reserved, c.reserved);
    assert.equal(b.position, c.position);
    assert.equal(b.position, "mid");
    assert.equal(b.skillTalents, c.skillTalents);
  });

  test("delveTick determinism: single-loadout chars, same seed → identical outcome", () => {
    const c1 = auraChar(99999, "A");
    const c2 = auraChar(99999, "B");
    deployToZone(c1, "goblin_warrens");
    deployToZone(c2, "goblin_warrens");
    const out1 = delveTick(c1);
    const out2 = delveTick(c2);
    assert.equal(out1.type, out2.type);
    assert.equal(c1.run.rngState, c2.run.rngState, "rngState must match after one tick");
    if (out1.result && out2.result) {
      assert.equal(out1.result.outcome, out2.result.outcome);
      assert.equal(out1.result.kills, out2.result.kills);
      assert.equal(out1.result.hpAfter, out2.result.hpAfter);
    }
  });

  test("swap never draws rng (derive after a swap leaves rngState untouched)", () => {
    const c = auraChar(42, "NoRng");
    const before = c.run.rngState;
    swapBuildSet(c, "B");
    derive(c.run, c);
    swapBuildSet(c, "A");
    derive(c.run, c);
    assert.equal(c.run.rngState, before, "swap + derive must not advance the rng stream");
  });
});

describe("Inc6 — migration of an old save", () => {
  test("a v2 save with no dual-spec fields loads as Set A, setB null, gearB null", () => {
    const old = freshCharacter(7, "OldSave");
    // Simulate a pre-Inc6 persisted object: v=2, no activeSet/setB/gearB.
    const onDisk = clone(old);
    onDisk.v = 2;
    delete onDisk.activeSet;
    delete onDisk.setB;
    delete onDisk.run.gearB;

    const migrated = vCharacter(onDisk);
    assert.equal(migrated.activeSet, "A", "old save must default to Set A");
    assert.equal(migrated.setB, null, "old save must have no Set B");
    assert.equal(migrated.run.gearB, null, "old save must have null inactive gear");
    // The trust boundary preserves the stored version (the established
    // convention — vInt returns the on-disk value, only minting a fresh char
    // stamps the current SCHEMA_VERSION). The MIGRATION is additive: the new
    // dual-spec fields appear with their exact-identity defaults regardless of
    // the stored version number. (SCHEMA_VERSION === 3 is asserted above.)
    assert.equal(migrated.v, 2, "stored version is preserved, not force-rewritten");
  });

  test("migrated old save derives byte-identically to the pre-migration object", () => {
    const old = freshCharacter(8, "OldSave2");
    old.reserved = ["ice_aura"];
    old.run.stats = { ...old.run.stats, int: 20 };
    old.run.hp = derive(old.run, old).maxHp;

    const preMigration = derive(old.run, old);

    const onDisk = clone(old);
    onDisk.v = 2;
    delete onDisk.activeSet;
    delete onDisk.setB;
    delete onDisk.run.gearB;
    const migrated = vCharacter(onDisk);

    assert.deepEqual(
      derive(migrated.run, migrated),
      preMigration,
      "migration must be exact-identity for derive()",
    );
  });
});

describe("Inc6 — activeSet swap changes the build derive() reads", () => {
  test("Set A has the aura, Set B (cleared) does not → derive differs", () => {
    const c = auraChar(31337, "Dual");
    const fireCost = RESERVABLE_SKILLS.fire_aura.spiritCost;

    // Set A: fire_aura reserved.
    const sheetA = derive(c.run, c);
    assert.equal(sheetA.spiritUsed, fireCost, "Set A reserves fire_aura");
    assert.ok(sheetA.spiritUsed > 0);

    // Swap to B (lazily materialized as a clone of A), then clear B's reservation.
    swapBuildSet(c, "B");
    assert.equal(c.activeSet, "B");
    c.reserved = []; // edit the now-active Set B
    const sheetB = derive(c.run, c);
    assert.equal(sheetB.spiritUsed, 0, "Set B has no reservation");
    assert.ok(
      sheetB.attack < sheetA.attack,
      "fire_aura's atkMul makes Set A's attack strictly higher than cleared Set B",
    );

    // Swap back to A — the aura returns (build identity survived the swap).
    swapBuildSet(c, "A");
    assert.equal(c.activeSet, "A");
    assert.deepEqual(
      c.reserved,
      ["fire_aura"],
      "Set A's reservation is intact after the round-trip",
    );
    assert.equal(derive(c.run, c).spiritUsed, fireCost);
    // Set B's edited (empty) reservation is preserved in the parked set.
    assert.deepEqual(c.setB.reserved, []);
  });

  test("gear is swapped run-side (run.gear ↔ run.gearB) and never crosses permadeath", () => {
    const c = freshCharacter(4242, "Gearer");
    // Tag Set A's weapon so we can track which loadout is active.
    c.run.gear.weapon.name = "Set A Blade";
    swapBuildSet(c, "B");
    assert.equal(c.run.gear.weapon.name, "Set A Blade", "B starts as a clone of A's gear");
    // Diverge Set B's weapon.
    c.run.gear.weapon.name = "Set B Blade";
    swapBuildSet(c, "A");
    assert.equal(c.run.gear.weapon.name, "Set A Blade", "A's gear returns after swapping back");
    assert.equal(c.run.gearB.weapon.name, "Set B Blade", "B's gear is parked on the run");
  });

  test("swap to the current set is an idempotent no-op", () => {
    const c = freshCharacter(5, "Idem");
    assert.equal(swapBuildSet(c, "A"), "A");
    assert.equal(c.setB, null, "no-op must not materialize Set B");
    assert.equal(c.activeSet, "A");
  });

  test("toggling via swapBuildSet round-trips the active marker", () => {
    const c = freshCharacter(6, "Toggle");
    assert.equal(swapBuildSet(c, "B"), "B");
    assert.equal(swapBuildSet(c, "A"), "A");
    assert.equal(swapBuildSet(c, "B"), "B");
    assert.equal(c.activeSet, "B");
  });
});

describe("Inc6 — both sets pass the trust boundary", () => {
  test("vCharacter validates setB with the same sub-validators (coerce, never reject)", () => {
    const c = freshCharacter(909, "Validated");
    const entry = entryNodeFor(c.passiveStart);
    c.run.stats = { ...c.run.stats, int: 40 }; // enough spirit for a reservation
    c.setB = {
      passiveStart: c.passiveStart,
      passives: [entry, "definitely-not-a-real-node"], // bad id must be dropped
      reserved: ["fire_aura", "not-a-real-skill"], // bad id must be dropped
      position: "back",
      skillTalents: {},
    };
    const out = vCharacter(c);
    assert.ok(out.setB, "setB survives validation");
    assert.deepEqual(out.setB.passives, [entry], "unknown passive id is coerced away");
    assert.deepEqual(out.setB.reserved, ["fire_aura"], "unknown reserved id is coerced away");
    assert.equal(out.setB.position, "back", "valid position is kept");
  });

  test("an over-reserved setB is clamped to the shared spirit pool, not rejected", () => {
    const c = freshCharacter(910, "OverReserve");
    c.run.stats = { ...c.run.stats, int: 0 }; // tiny pool
    c.setB = {
      passiveStart: c.passiveStart,
      passives: [],
      // Three auras far exceed a low-int spirit pool — must clamp from the end.
      reserved: ["fire_aura", "ice_aura", "wolf_companion"],
      position: "mid",
      skillTalents: {},
    };
    const out = vCharacter(c);
    const pool = derive(out.run, { ...out, reserved: [] }).spirit;
    let cost = 0;
    for (const id of out.setB.reserved) cost += RESERVABLE_SKILLS[id].spiritCost;
    assert.ok(cost <= pool, "setB reservation cost must fit the shared spirit pool");
    assert.ok(out.setB.reserved.length < 3, "over-reservation is trimmed, not rejected");
  });

  test("invalid activeSet coerces to 'A'; setB null stays null (exact-identity)", () => {
    const c = freshCharacter(911, "Coerce");
    c.activeSet = "Z"; // bogus
    c.setB = "not an object";
    const out = vCharacter(c);
    assert.equal(out.activeSet, "A");
    assert.equal(out.setB, null);
  });

  test("run.gearB is validated as gear when present, null otherwise", () => {
    const c = freshCharacter(912, "GearB");
    swapBuildSet(c, "B"); // materializes run.gearB as a real gear object
    const out = vCharacter(c);
    assert.ok(
      out.run.gearB && typeof out.run.gearB === "object",
      "gearB survives as a gear object",
    );
    assert.ok("weapon" in out.run.gearB, "gearB has gear slots");
  });
});
