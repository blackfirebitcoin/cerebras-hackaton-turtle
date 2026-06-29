// SIGMA ABYSS — Project Ascendant build-setter endpoints.
// Run: node --test test/unit/ascendant-build-setters.test.js
//
// Tests:
//   POST /api/sigma/:login/passives  — set passive node ids
//   POST /api/sigma/:login/reserve   — set reserved aura ids
//   POST /api/sigma/:login/position  — set tactical position
//
// Each endpoint follows the swap-set pattern:
//   resolveTwitchSigma → mutate → vCharacter coerce/bound → store.putPlayer
//   → return the standard Project Ascendant build payload.
//
// Tests are module-level (no HTTP server needed): they exercise the validate +
// persist path directly, the same way dual-spec.test.js tests the swap-set
// primitives. This avoids colliding with the live :7777 instance.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import * as store from "../../server/store.js";
import { vCharacter } from "../../server/validate.js";
import { passivePointsFor } from "../../shared/passive-tree.js";
import { freshCharacter, swapBuildSet } from "../../shared/progression.js";
import { RESERVABLE_SKILLS } from "../../shared/skills.js";
import { derive } from "../../shared/stats.js";

// Helper: build a character with a useful passive budget + non-trivial spirit pool.
function testChar(seed = 1, name = "Tester") {
  const c = freshCharacter(seed, name);
  c.highestLevel = 20;
  c.run.stats = { ...c.run.stats, int: 30 };
  c.run.hp = derive(c.run, c).maxHp;
  return c;
}

// ── passives setter — vCharacter coerce semantics ────────────────────────────

describe("passives setter — vCharacter coerce semantics", () => {
  test("valid connected allocation within budget survives intact", () => {
    const c = testChar(1001);
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "warrior_a"];
    const v = vCharacter(c);
    assert.deepEqual(v.passives, ["warrior_start", "warrior_a"]);
  });

  test("over-budget allocation is pruned to the points cap", () => {
    const c = testChar(1002);
    c.highestLevel = 2; // only 2 points
    c.prestige = 0;
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "warrior_a", "warrior_b", "warrior_c"]; // 4 nodes > 2 pts
    const v = vCharacter(c);
    assert.equal(v.passives.length, 2);
    assert.deepEqual(v.passives, ["warrior_start", "warrior_a"]);
  });

  test("disconnected nodes are pruned (orphan dropped)", () => {
    const c = testChar(1003);
    c.highestLevel = 10;
    c.passiveStart = "warrior";
    // warrior_start + warrior_a are connected; mage_c is orphaned.
    c.passives = ["warrior_start", "warrior_a", "mage_c"];
    const v = vCharacter(c);
    assert.ok(v.passives.includes("warrior_start"));
    assert.ok(v.passives.includes("warrior_a"));
    assert.ok(!v.passives.includes("mage_c"), "orphan must be pruned");
  });

  test("unknown ids are dropped", () => {
    const c = testChar(1004);
    c.highestLevel = 10;
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "not_a_real_node"];
    const v = vCharacter(c);
    assert.ok(!v.passives.includes("not_a_real_node"));
  });

  test("non-array passives coerce to []", () => {
    const c = testChar(1005);
    c.passives = "bad_string";
    const v = vCharacter(c);
    assert.deepEqual(v.passives, []);
  });
});

// ── reserve setter — vCharacter coerce semantics ─────────────────────────────

describe("reserve setter — vCharacter coerce semantics", () => {
  test("valid known aura id within spirit pool survives", () => {
    const c = testChar(2001);
    c.run.stats = { ...c.run.stats, int: 50 }; // large pool
    c.reserved = ["fire_aura"];
    const v = vCharacter(c);
    assert.deepEqual(v.reserved, ["fire_aura"]);
  });

  test("unknown aura id is dropped", () => {
    const c = testChar(2002);
    c.reserved = ["fire_aura", "definitely_not_a_real_aura"];
    const v = vCharacter(c);
    assert.ok(!v.reserved.includes("definitely_not_a_real_aura"));
  });

  test("over-reserve is clamped (last entries dropped until pool fits)", () => {
    const c = testChar(2003);
    c.run.stats = { ...c.run.stats, int: 0 }; // very small pool
    // Three auras will exceed any low-int pool.
    c.reserved = ["fire_aura", "ice_aura", "wolf_companion"];
    const v = vCharacter(c);
    const pool = derive(v.run, { ...v, reserved: [] }).spirit;
    let cost = 0;
    for (const id of v.reserved) cost += RESERVABLE_SKILLS[id].spiritCost;
    assert.ok(cost <= pool, "clamped reserved must fit pool");
    assert.ok(v.reserved.length < 3, "excess entries must be dropped");
  });

  test("duplicate ids are deduplicated", () => {
    const c = testChar(2004);
    c.run.stats = { ...c.run.stats, int: 50 };
    c.reserved = ["fire_aura", "fire_aura", "fire_aura"];
    const v = vCharacter(c);
    assert.equal(v.reserved.filter((id) => id === "fire_aura").length, 1);
  });

  test("non-array reserved coerces to []", () => {
    const c = testChar(2005);
    c.reserved = { fire_aura: true };
    const v = vCharacter(c);
    assert.deepEqual(v.reserved, []);
  });
});

// ── position setter — vCharacter coerce semantics ────────────────────────────

describe("position setter — vCharacter coerce semantics", () => {
  test("valid positions survive as-is", () => {
    for (const pos of ["front", "mid", "back"]) {
      const c = testChar(3001);
      c.position = pos;
      const v = vCharacter(c);
      assert.equal(v.position, pos);
    }
  });

  test("invalid position coerces to 'mid'", () => {
    const c = testChar(3002);
    c.position = "sideways";
    const v = vCharacter(c);
    assert.equal(v.position, "mid");
  });

  test("null position coerces to 'mid'", () => {
    const c = testChar(3003);
    c.position = null;
    const v = vCharacter(c);
    assert.equal(v.position, "mid");
  });
});

// ── withBuildSet storage model — inactive-set editing via swap round-trip ────

describe("withBuildSet storage model — inactive set editing via swap round-trip", () => {
  // Validates the storage pattern that withBuildSet uses in the HTTP handlers:
  // swap-to-target → mutate → swap-back.  The same invariants dual-spec.test.js
  // asserts for swapBuildSet apply here.

  test("editing the inactive set (B) via swap round-trip preserves A's fields", () => {
    const c = testChar(4001);
    c.passiveStart = "warrior";
    c.passives = ["warrior_start"]; // Set A
    c.reserved = ["fire_aura"];
    c.position = "front";

    // Simulate withBuildSet targeting "B" when active is "A".
    swapBuildSet(c, "B"); // B materialises as clone of A
    c.passives = [];
    c.reserved = [];
    c.position = "back";
    swapBuildSet(c, "A"); // restore A

    assert.deepEqual(c.passives, ["warrior_start"], "A passives intact after B edit");
    assert.deepEqual(c.reserved, ["fire_aura"], "A reserved intact after B edit");
    assert.equal(c.position, "front", "A position intact after B edit");

    assert.deepEqual(c.setB.passives, [], "B passives were cleared");
    assert.deepEqual(c.setB.reserved, [], "B reserved was cleared");
    assert.equal(c.setB.position, "back", "B position is back");
  });

  test("targeting the active set writes top-level directly (no swap materialises setB)", () => {
    const c = testChar(4002);
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "warrior_a"];
    const v = vCharacter(c);
    assert.deepEqual(v.passives, ["warrior_start", "warrior_a"]);
    // No swap occurred — setB must still be null.
    assert.equal(v.setB, null);
  });

  test("swap round-trip never advances the rng stream", () => {
    const c = testChar(4003);
    const before = c.run.rngState;
    swapBuildSet(c, "B");
    c.position = "back";
    swapBuildSet(c, "A");
    assert.equal(c.run.rngState, before, "swap round-trip must not draw rng");
  });
});

// ── persistence round-trip — vCharacter validates what putPlayer stores ──────

describe("persistence round-trip — vCharacter validates what putPlayer stores", () => {
  let storeDir = "";

  before(() => {
    storeDir = mkdtempSync(join(tmpdir(), "mmo-setters-"));
    process.env.MMO_DATA_DIR = storeDir;
    store.initStore();
  });

  after(() => {
    rmSync(storeDir, { recursive: true, force: true });
    delete process.env.MMO_DATA_DIR;
  });

  function seedPlayer(name, seed) {
    const c = testChar(seed, name);
    const token = `sig_${seed.toString(16).padStart(24, "0")}`;
    store.putPlayer(token, c);
    store.linkTwitch(name, token);
    return { token, character: c };
  }

  test("passives: mutate → validate → persist → reload preserves the allocation", () => {
    const { token } = seedPlayer("ptest", 0xabc001);
    const c = store.getPlayer(token).character;
    c.passiveStart = "warrior";
    c.highestLevel = 10;
    c.passives = ["warrior_start", "warrior_a"];
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.deepEqual(reloaded.passives, ["warrior_start", "warrior_a"]);
  });

  test("passives: over-budget input is coerced before persisting", () => {
    const { token } = seedPlayer("ptest2", 0xabc002);
    const c = store.getPlayer(token).character;
    c.passiveStart = "warrior";
    c.highestLevel = 2; // 2 points only
    c.prestige = 0;
    c.passives = ["warrior_start", "warrior_a", "warrior_b", "warrior_c"];
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.equal(reloaded.passives.length, 2, "over-budget pruned before persist");
  });

  test("reserved: mutate → validate → persist → reload preserves valid auras", () => {
    const { token } = seedPlayer("rtest", 0xabc003);
    const c = store.getPlayer(token).character;
    c.run.stats = { ...c.run.stats, int: 50 };
    c.reserved = ["fire_aura"];
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.deepEqual(reloaded.reserved, ["fire_aura"]);
  });

  test("reserved: over-reserve is clamped before persisting", () => {
    const { token } = seedPlayer("rtest2", 0xabc004);
    const c = store.getPlayer(token).character;
    c.run.stats = { ...c.run.stats, int: 0 }; // minimal pool
    c.reserved = ["fire_aura", "ice_aura", "wolf_companion"];
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    const pool = derive(reloaded.run, { ...reloaded, reserved: [] }).spirit;
    let cost = 0;
    for (const id of reloaded.reserved) cost += RESERVABLE_SKILLS[id].spiritCost;
    assert.ok(cost <= pool, "persisted reserved must fit the pool");
  });

  test("position: mutate → validate → persist → reload preserves valid position", () => {
    const { token } = seedPlayer("postest", 0xabc005);
    const c = store.getPlayer(token).character;
    c.position = "back";
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.equal(reloaded.position, "back");
  });

  test("position: bad value coerces to 'mid' before persisting", () => {
    const { token } = seedPlayer("postest2", 0xabc006);
    const c = store.getPlayer(token).character;
    c.position = "sideways";
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.equal(reloaded.position, "mid");
  });

  test("response shape: buildSetPayload exposes all required build fields", () => {
    // Reconstruct the buildSetPayload helper inline (it is not exported) and
    // assert every field the VCS bridge reads from the response.
    const { token } = seedPlayer("shapetest", 0xabc007);
    const c = store.getPlayer(token).character;
    c.passiveStart = "warrior";
    c.passives = ["warrior_start"];
    c.run.stats = { ...c.run.stats, int: 30 };
    c.reserved = ["fire_aura"];
    c.position = "back";
    const validated = vCharacter(c);
    const sheet = validated.run ? derive(validated.run, validated) : null;
    const payload = {
      ok: true,
      login: "shapetest",
      activeSet: validated.activeSet === "B" ? "B" : "A",
      hasSetB: !!validated.setB,
      spirit: sheet?.spirit ?? null,
      spiritUsed: sheet?.spiritUsed ?? 0,
      reserved: validated.reserved || [],
      passives: validated.passives || [],
      passiveStart: validated.passiveStart || null,
      passivePoints: passivePointsFor(validated),
      position: validated.position || "mid",
      setB: validated.setB
        ? {
            passives: validated.setB.passives || [],
            passiveStart: validated.setB.passiveStart || null,
            reserved: validated.setB.reserved || [],
            position: validated.setB.position || "mid",
          }
        : null,
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.activeSet, "A");
    assert.equal(payload.hasSetB, false);
    assert.ok(typeof payload.spirit === "number", "spirit must be numeric");
    assert.ok(payload.spiritUsed >= 0, "spiritUsed must be non-negative");
    assert.deepEqual(payload.reserved, ["fire_aura"]);
    assert.deepEqual(payload.passives, ["warrior_start"]);
    assert.equal(payload.passiveStart, "warrior");
    assert.ok(payload.passivePoints >= 1);
    assert.equal(payload.position, "back");
    assert.equal(payload.setB, null, "no setB for single-loadout character");
  });

  test("setB fields appear in response payload when setB is materialised", () => {
    const { token } = seedPlayer("setbtest", 0xabc008);
    const c = store.getPlayer(token).character;
    c.passiveStart = "warrior";
    c.passives = ["warrior_start"];
    c.reserved = ["fire_aura"];
    c.position = "front";
    // Materialise Set B then diverge it.
    swapBuildSet(c, "B");
    c.passives = [];
    c.reserved = [];
    c.position = "back";
    swapBuildSet(c, "A");
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    const reloaded = store.getPlayer(token).character;
    assert.ok(reloaded.setB, "setB must be present");
    assert.deepEqual(reloaded.setB.passives, [], "B passives persist");
    assert.deepEqual(reloaded.setB.reserved, [], "B reserved persists");
    assert.equal(reloaded.setB.position, "back", "B position persists");
    // A must be intact.
    assert.deepEqual(reloaded.passives, ["warrior_start"]);
    assert.deepEqual(reloaded.reserved, ["fire_aura"]);
    assert.equal(reloaded.position, "front");
  });
});
