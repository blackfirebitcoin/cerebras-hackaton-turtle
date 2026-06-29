// SIGMA ABYSS — passive tree test suite (Project Ascendant Inc4).
// Run: node --test test/unit/passive-tree.test.js
// node:test (built-in, zero deps) — consistent with the project's no-frameworks rule.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { resolveEncounter } from "../../shared/combat.js";
import { makeEnemy } from "../../shared/enemies.js";
import {
  CLASS_START_IDS,
  CLASS_START_ZONES,
  entryNodeFor,
  isAllocationConnected,
  KEYSTONE_IDS,
  neighborsOf,
  nodeById,
  PASSIVE_IDENTITY,
  PASSIVE_NODE_COUNT,
  PASSIVE_NODE_IDS,
  passiveFlags,
  passiveMods,
  passivePointsFor,
  passiveTreePayload,
  pruneToConnected,
  starterClassForSeed,
} from "../../shared/passive-tree.js";
import { freshCharacter, freshRun, simulateOffline } from "../../shared/progression.js";
import { makeRng } from "../../shared/rng.js";
import { derive } from "../../shared/stats.js";

// ── Graph shape ───────────────────────────────────────────────────────────────

describe("passive-tree — graph shape", () => {
  test("has ~100 nodes (prototype of the PoE web)", () => {
    assert.ok(PASSIVE_NODE_COUNT >= 80, `expected >=80 nodes, got ${PASSIVE_NODE_COUNT}`);
    assert.equal(PASSIVE_NODE_IDS.length, PASSIVE_NODE_COUNT);
  });

  test("has 8 class start zones mapping to the spec's classes", () => {
    assert.equal(CLASS_START_ZONES.length, 8);
    for (const want of ["warrior", "ranger", "mage", "monk", "templar", "rogue"]) {
      assert.ok(CLASS_START_IDS.includes(want), `missing class ${want}`);
    }
  });

  test("each class start zone's entry node exists and is tagged with its zone", () => {
    for (const z of CLASS_START_ZONES) {
      const entry = nodeById(z.entry);
      assert.ok(entry, `entry ${z.entry} must exist`);
      assert.equal(entry.zone, z.id, `entry ${z.entry} must be tagged zone ${z.id}`);
    }
  });

  test("has 4-6 build-defining keystones", () => {
    assert.ok(
      KEYSTONE_IDS.length >= 4 && KEYSTONE_IDS.length <= 6,
      `keystones=${KEYSTONE_IDS.length}`,
    );
    for (const id of KEYSTONE_IDS) assert.equal(nodeById(id).kind, "keystone");
  });

  test("adjacency is symmetric (undirected graph)", () => {
    for (const id of PASSIVE_NODE_IDS) {
      for (const nb of neighborsOf(id)) {
        assert.ok(neighborsOf(nb).includes(id), `edge ${id}->${nb} is not symmetric`);
      }
    }
  });

  test("every adjacency points to a real node (no dangling edges)", () => {
    for (const id of PASSIVE_NODE_IDS) {
      for (const nb of neighborsOf(id)) {
        assert.ok(nodeById(nb), `node ${id} adj to missing node ${nb}`);
      }
    }
  });

  test("the graph is fully connected (every node reachable from any start)", () => {
    const start = entryNodeFor("warrior");
    const reached = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of neighborsOf(cur)) {
        if (!reached.has(nb)) {
          reached.add(nb);
          queue.push(nb);
        }
      }
    }
    assert.equal(reached.size, PASSIVE_NODE_COUNT, "graph must be one connected component");
  });

  test("builds can cross: a warrior can reach a mage keystone through shared interior", () => {
    // BFS from warrior_start must reach ks_avatar_of_fire (mage-side hub).
    const start = entryNodeFor("warrior");
    const reached = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift();
      for (const nb of neighborsOf(cur)) {
        if (!reached.has(nb)) {
          reached.add(nb);
          queue.push(nb);
        }
      }
    }
    for (const ks of KEYSTONE_IDS) {
      assert.ok(reached.has(ks), `warrior must be able to reach keystone ${ks}`);
    }
  });

  test("nodeById returns null for unknown id; neighborsOf returns [] for unknown id", () => {
    assert.equal(nodeById("nope"), null);
    assert.deepEqual(neighborsOf("nope"), []);
  });

  test("starterClassForSeed is deterministic and in range", () => {
    assert.equal(starterClassForSeed(12345), starterClassForSeed(12345));
    assert.ok(CLASS_START_IDS.includes(starterClassForSeed(999)));
  });
});

// ── passiveMods aggregation ─────────────────────────────────────────────────────

describe("passive-tree — passiveMods aggregation", () => {
  test("passiveMods([]) returns exact identity (×1 on *Mul, +0 on *Add)", () => {
    const m = passiveMods([]);
    assert.equal(m.hpMul, 1);
    assert.equal(m.atkMul, 1);
    assert.equal(m.defMul, 1);
    assert.equal(m.speedMul, 1);
    assert.equal(m.dangerMul, 1);
    assert.equal(m.critAdd, 0);
    assert.equal(m.critMultAdd, 0);
    assert.equal(m.dodgeAdd, 0);
    assert.equal(m.lootQtyAdd, 0);
    assert.equal(m.lootRarityAdd, 0);
    assert.equal(m.spiritAdd, 0);
  });

  test("passiveMods(null) returns the frozen identity object", () => {
    assert.equal(passiveMods(null), PASSIVE_IDENTITY);
  });

  test("passiveMods aggregates a single node's mods", () => {
    // warrior_start: { hpMul:1.05, atkMul:1.02 }
    const m = passiveMods(["warrior_start"]);
    assert.ok(Math.abs(m.atkMul - 1.02) < 1e-9, `atkMul=${m.atkMul}`);
    assert.ok(Math.abs(m.hpMul - 1.05) < 1e-9, `hpMul=${m.hpMul}`);
    assert.equal(m.defMul, 1, "defMul untouched");
  });

  test("passiveMods composes *Mul multiplicatively, *Add additively across nodes", () => {
    // warrior_start (atkMul 1.02) + warrior_a (atkMul 1.06) + warrior_b (atkMul 1.08, critAdd 0.02)
    const m = passiveMods(["warrior_start", "warrior_a", "warrior_b"]);
    assert.ok(Math.abs(m.atkMul - 1.02 * 1.06 * 1.08) < 1e-9, `atkMul=${m.atkMul}`);
    assert.ok(Math.abs(m.critAdd - 0.02) < 1e-12, `critAdd=${m.critAdd}`);
  });

  test("passiveMods ignores unknown ids", () => {
    const m = passiveMods(["warrior_start", "not_a_node"]);
    assert.ok(Math.abs(m.atkMul - 1.02) < 1e-9);
  });

  test("passiveMods dedupes (a doubled id is not counted twice)", () => {
    const once = passiveMods(["warrior_a"]);
    const twice = passiveMods(["warrior_a", "warrior_a"]);
    assert.equal(once.atkMul, twice.atkMul, "duplicate node must not double-apply");
  });

  test("passiveFlags marks keystone flags", () => {
    const flags = passiveFlags(["ks_glass_cannon"]);
    assert.equal(flags.glass, true);
    assert.deepEqual(passiveFlags([]), {});
  });
});

// ── derive() exact-identity firewall ────────────────────────────────────────────

describe("CRITICAL passive-tree — derive() exact-identity when no passives", () => {
  const KEYS = [
    "maxHp",
    "attack",
    "defense",
    "critChance",
    "critMult",
    "speed",
    "dodge",
    "overload",
    "lootQty",
    "lootRarity",
    "dangerMult",
    "deathSave",
    "hiddenChance",
    "spirit",
    "spiritUsed",
  ];

  test("derive(run, null) byte-identical to derive(run, {passives:[]})", () => {
    const run = freshRun(1, 0);
    const baseline = derive(run, null);
    const emptyAlloc = derive(run, { passives: [] });
    for (const k of KEYS) {
      assert.equal(
        emptyAlloc[k],
        baseline[k],
        `key ${k} must be byte-identical when passives empty`,
      );
    }
  });

  test("derive() with no passives field equals derive() with empty passives", () => {
    const run = freshRun(424242, 0);
    run.stats = { ...run.stats, str: 17, int: 23, agi: 11, luck: 13 };
    const noField = derive(run, { name: "x" });
    const emptyField = derive(run, { name: "x", passives: [] });
    for (const k of KEYS) {
      assert.equal(noField[k], emptyField[k], `key ${k} must match`);
    }
  });

  test("a fresh character (passiveStart set, passives:[]) derives byte-identical to null-char", () => {
    const c = freshCharacter(31337, "Fresh");
    const withChar = derive(c.run, c);
    const nullChar = derive(c.run, null);
    // Faction/skills/traits etc are also identity-when-default on a fresh char,
    // so derive(c.run,c) === derive(c.run,null) for these combat keys. The point
    // is the passive layer adds NO drift on top of that baseline.
    for (const k of ["maxHp", "attack", "defense", "spirit"]) {
      assert.equal(withChar[k], nullChar[k], `${k} must be unchanged by the empty passive layer`);
    }
  });

  test("derive() does not draw rng for passives (rngState unchanged)", () => {
    const run = freshRun(42, 0);
    const before = run.rngState;
    derive(run, { passives: ["warrior_start", "warrior_a", "ks_glass_cannon"] });
    derive(run, { passives: ["warrior_start", "warrior_a"] });
    assert.equal(run.rngState, before, "derive() with passives must not mutate rngState");
  });
});

// ── derive() applies passives ───────────────────────────────────────────────────

describe("passive-tree — derive() applies allocated passives", () => {
  test("an offense node raises attack vs un-allocated", () => {
    const run = freshRun(1, 0);
    const none = derive(run, { passives: [] });
    const alloc = derive(run, { passives: ["warrior_start", "warrior_a"] });
    assert.ok(alloc.attack > none.attack, "offense passive must raise attack");
    assert.equal(alloc.maxHp > none.maxHp, true, "warrior_start hpMul must also raise maxHp");
  });

  test("a defense node raises defense", () => {
    const run = freshRun(1, 0);
    const none = derive(run, { passives: [] });
    const alloc = derive(run, { passives: ["warden_start", "warden_a"] });
    assert.ok(alloc.defense > none.defense, "defense passive must raise defense");
  });

  test("a flat-spirit node raises the spirit pool", () => {
    const run = freshRun(1, 0);
    const none = derive(run, { passives: [] });
    const alloc = derive(run, { passives: ["mage_start", "mage_a"] });
    assert.ok(alloc.spirit > none.spirit, "spiritAdd passive must raise spirit");
  });
});

// ── Keystone effects (Glass Cannon + others) ────────────────────────────────────

describe("passive-tree — keystone effects", () => {
  test("Glass Cannon: ~+100% attack, ~-50% max HP (reuses glass semantics)", () => {
    const run = freshRun(1, 0);
    run.stats = { ...run.stats, str: 30, vit: 20 };
    const none = derive(run, { passives: [] });
    // Allocate the connected chain into the keystone is not required for derive
    // (derive just reads the allocated set); validate enforces connectivity.
    const ks = derive(run, { passives: ["ks_glass_cannon"] });
    assert.ok(ks.attack > none.attack * 1.9, `attack should ~double: ${none.attack}->${ks.attack}`);
    assert.ok(ks.maxHp < none.maxHp * 0.6, `maxHp should ~halve: ${none.maxHp}->${ks.maxHp}`);
  });

  test("Iron Reflexes: big defense, dodge removed (clamped to 0)", () => {
    const run = freshRun(1, 0);
    run.stats = { ...run.stats, agi: 200 }; // would normally give meaningful dodge
    const none = derive(run, { passives: [] });
    const ks = derive(run, { passives: ["ks_iron_reflexes"] });
    assert.ok(ks.defense > none.defense, "iron reflexes must raise defense");
    assert.equal(ks.dodge, 0, "iron reflexes must remove dodge (negative add → clamp 0)");
  });

  test("Blood Magic: spirit pool collapses to 0, HP rises", () => {
    const run = freshRun(1, 0);
    run.stats = { ...run.stats, int: 50, vit: 20 };
    const none = derive(run, { passives: [] });
    const ks = derive(run, { passives: ["ks_blood_magic"] });
    assert.equal(ks.spirit, 0, "blood magic must zero the spirit pool (floored)");
    assert.ok(ks.maxHp > none.maxHp, "blood magic must raise maxHp");
  });

  test("Necromantic Bond: direct attack down, spirit up", () => {
    const run = freshRun(1, 0);
    run.stats = { ...run.stats, str: 20, int: 10 };
    const none = derive(run, { passives: [] });
    const ks = derive(run, { passives: ["ks_necromantic_bond"] });
    assert.ok(ks.attack < none.attack, "necromantic bond must lower direct attack");
    assert.ok(ks.spirit > none.spirit, "necromantic bond must raise spirit (for minions)");
  });
});

// ── Connectivity (BFS) ──────────────────────────────────────────────────────────

describe("passive-tree — isAllocationConnected", () => {
  test("empty allocation is trivially connected", () => {
    assert.equal(isAllocationConnected([], "warrior"), true);
    assert.equal(isAllocationConnected(null, "warrior"), true);
  });

  test("a connected chain from the start is accepted", () => {
    // warrior_start -> warrior_a -> warrior_b (a real path)
    assert.equal(
      isAllocationConnected(["warrior_start", "warrior_a", "warrior_b"], "warrior"),
      true,
    );
  });

  test("an allocation missing the start entry is rejected", () => {
    // warrior_a without warrior_start has no anchor.
    assert.equal(isAllocationConnected(["warrior_a", "warrior_b"], "warrior"), false);
  });

  test("an orphan node not chained to the start makes the allocation disconnected", () => {
    // warrior_start + a far-away mage node with no allocated path between them.
    assert.equal(isAllocationConnected(["warrior_start", "mage_c"], "warrior"), false);
  });

  test("a hole in the chain disconnects everything past it", () => {
    // warrior_start, warrior_a, then SKIP warrior_b, jump to warrior_c → c orphaned.
    assert.equal(
      isAllocationConnected(["warrior_start", "warrior_a", "warrior_c"], "warrior"),
      false,
    );
  });
});

describe("passive-tree — pruneToConnected (coerce, not reject)", () => {
  test("drops the disconnected orphan, keeps the connected component", () => {
    const kept = pruneToConnected(["warrior_start", "warrior_a", "mage_c"], "warrior");
    assert.ok(kept.includes("warrior_start"));
    assert.ok(kept.includes("warrior_a"));
    assert.ok(!kept.includes("mage_c"), "orphan must be dropped");
  });

  test("drops everything when the start entry is not allocated", () => {
    assert.deepEqual(pruneToConnected(["warrior_a", "warrior_b"], "warrior"), []);
  });

  test("drops unknown ids", () => {
    const kept = pruneToConnected(["warrior_start", "fake_node"], "warrior");
    assert.deepEqual(kept, ["warrior_start"]);
  });

  test("preserves input order for kept ids", () => {
    const kept = pruneToConnected(["warrior_start", "warrior_a", "warrior_b"], "warrior");
    assert.deepEqual(kept, ["warrior_start", "warrior_a", "warrior_b"]);
  });
});

// ── Points budget ───────────────────────────────────────────────────────────────

describe("passive-tree — passivePointsFor budget", () => {
  test("a fresh level-1 char gets exactly 1 point", () => {
    assert.equal(passivePointsFor({ highestLevel: 1, prestige: 0 }), 1);
  });

  test("points scale with highestLevel (1 per level)", () => {
    assert.equal(passivePointsFor({ highestLevel: 10, prestige: 0 }), 10);
    assert.equal(passivePointsFor({ highestLevel: 50, prestige: 0 }), 50);
  });

  test("prestige adds 1 point per 10 prestige", () => {
    assert.equal(passivePointsFor({ highestLevel: 10, prestige: 50 }), 15);
  });

  test("null/garbage char floors to 1 point", () => {
    assert.equal(passivePointsFor(null), 1);
    assert.equal(passivePointsFor({}), 1);
  });
});

// ── validate.js: vCharacter passive validation ──────────────────────────────────

describe("passive-tree — validate vCharacter passives (coerce+bound)", () => {
  let vCharacter;
  before(async () => {
    const mod = await import("../../server/validate.js");
    vCharacter = mod.vCharacter;
  });

  test("freshCharacter validates cleanly with passives:[]", () => {
    const c = freshCharacter(7, "Fresh");
    const v = vCharacter(c);
    assert.deepEqual(v.passives, [], "fresh char passives must validate to []");
    assert.ok(CLASS_START_IDS.includes(v.passiveStart), "passiveStart must be a valid class");
  });

  test("missing passives coerces to []", () => {
    const c = freshCharacter(7, "NoPassives");
    delete c.passives;
    const v = vCharacter(c);
    assert.deepEqual(v.passives, []);
  });

  test("unknown node ids are dropped", () => {
    const c = freshCharacter(7, "BadIds");
    c.highestLevel = 20;
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "totally_fake_node", "warrior_a"];
    const v = vCharacter(c);
    assert.ok(!v.passives.includes("totally_fake_node"), "unknown id dropped");
    assert.ok(v.passives.includes("warrior_start"), "valid connected id kept");
  });

  test("disconnected/orphan allocation is pruned to the connected component", () => {
    const c = freshCharacter(7, "Orphan");
    c.highestLevel = 50;
    c.passiveStart = "warrior";
    // warrior_start + warrior_a are connected; mage_c is an orphan.
    c.passives = ["warrior_start", "warrior_a", "mage_c"];
    const v = vCharacter(c);
    assert.ok(v.passives.includes("warrior_start"));
    assert.ok(v.passives.includes("warrior_a"));
    assert.ok(!v.passives.includes("mage_c"), "orphan dropped by connectivity check");
  });

  test("allocation missing the start entry is fully dropped", () => {
    const c = freshCharacter(7, "NoAnchor");
    c.highestLevel = 50;
    c.passiveStart = "warrior";
    c.passives = ["warrior_a", "warrior_b"]; // no warrior_start anchor
    const v = vCharacter(c);
    assert.deepEqual(v.passives, [], "no-anchor allocation must be dropped");
  });

  test("count is capped at the points budget (drops past-budget tail)", () => {
    const c = freshCharacter(7, "Overspent");
    c.highestLevel = 3; // budget = 3 points
    c.prestige = 0;
    c.passiveStart = "warrior";
    // A connected chain of 5 nodes — only the first 3 fit the budget.
    c.passives = ["warrior_start", "warrior_a", "warrior_b", "warrior_c", "gw_north"];
    const v = vCharacter(c);
    assert.equal(v.passives.length, 3, "must cap to the 3-point budget");
    assert.deepEqual(
      v.passives,
      ["warrior_start", "warrior_a", "warrior_b"],
      "keeps the earliest (priority) ids",
    );
  });

  test("a valid within-budget connected allocation survives intact", () => {
    const c = freshCharacter(7, "Good");
    c.highestLevel = 10; // plenty of budget
    c.passiveStart = "warrior";
    c.passives = ["warrior_start", "warrior_a", "warrior_b"];
    const v = vCharacter(c);
    assert.deepEqual(v.passives, ["warrior_start", "warrior_a", "warrior_b"]);
  });

  test("unknown passiveStart coerces to the first class", () => {
    const c = freshCharacter(7, "BadStart");
    c.passiveStart = "not_a_class";
    const v = vCharacter(c);
    assert.equal(v.passiveStart, CLASS_START_IDS[0]);
  });
});

// ── payload ─────────────────────────────────────────────────────────────────────

describe("passive-tree — passiveTreePayload (GET /api/passive-tree)", () => {
  test("payload carries nodeCount, zones, keystones and full node list", () => {
    const p = passiveTreePayload();
    assert.equal(p.nodeCount, PASSIVE_NODE_COUNT);
    assert.equal(p.zones.length, 8);
    assert.equal(p.keystones.length, KEYSTONE_IDS.length);
    assert.equal(p.nodes.length, PASSIVE_NODE_COUNT);
    // Each node carries id + adjacency + mods for the graph renderer.
    for (const nd of p.nodes) {
      assert.ok(typeof nd.id === "string");
      assert.ok(Array.isArray(nd.adj));
      assert.ok(nd.mods && typeof nd.mods === "object");
    }
  });
});

// ── CRITICAL: sim determinism WITH and WITHOUT passives ─────────────────────────

describe("CRITICAL passive-tree — sim determinism (offline↔live parity)", () => {
  test("simulateOffline: same seed → identical report WITHOUT passives", () => {
    const c1 = freshCharacter(12345, "A");
    const c2 = freshCharacter(12345, "B");
    const r1 = simulateOffline(c1, 4 * 3600 * 1000);
    const r2 = simulateOffline(c2, 4 * 3600 * 1000);
    assert.equal(r1.kills, r2.kills);
    assert.equal(r1.xpGained, r2.xpGained);
    assert.equal(r1.endLevel, r2.endLevel);
    assert.equal(r1.ticks, r2.ticks);
    assert.equal(c1.run.rngState, c2.run.rngState);
  });

  test("simulateOffline: same seed → identical report WITH the same passive allocation", () => {
    const c1 = freshCharacter(77777, "PassiveA");
    const c2 = freshCharacter(77777, "PassiveB");
    for (const c of [c1, c2]) {
      c.passiveStart = "warrior";
      c.passives = ["warrior_start", "warrior_a", "warrior_b"];
    }
    const r1 = simulateOffline(c1, 4 * 3600 * 1000);
    const r2 = simulateOffline(c2, 4 * 3600 * 1000);
    assert.equal(r1.kills, r2.kills, "kills must be deterministic with passives");
    assert.equal(r1.xpGained, r2.xpGained, "xpGained must be deterministic");
    assert.equal(r1.endLevel, r2.endLevel, "endLevel must be deterministic");
    assert.equal(c1.run.rngState, c2.run.rngState, "rngState must match after offline sim");
  });

  test("EXACT-IDENTITY: empty-passives offline report equals no-passives-field report", () => {
    const c1 = freshCharacter(55555, "EmptyA");
    const c2 = freshCharacter(55555, "EmptyB");
    c1.passives = [];
    // c2 keeps freshCharacter's default [] — both must match a byte-identical run.
    const r1 = simulateOffline(c1, 3 * 3600 * 1000);
    const r2 = simulateOffline(c2, 3 * 3600 * 1000);
    assert.equal(r1.kills, r2.kills);
    assert.equal(r1.xpGained, r2.xpGained);
    assert.equal(c1.run.rngState, c2.run.rngState);
  });

  test("resolveEncounter: a passive-allocated fighter is deterministic same-seed", () => {
    const run = freshRun(1, 0);
    run.stats = { ...run.stats, str: 20 };
    const sheet = derive(run, { passives: ["warrior_start", "warrior_a", "ks_glass_cannon"] });
    const fighter = { ...sheet, hp: sheet.maxHp, potions: 0, weaponFamily: "sword", weaponPlus: 4 };
    const ai = { fleeHpFrac: 0, potionHpFrac: 0, targetPriority: "lowest_hp" };
    const r1 = resolveEncounter({
      fighter,
      enemies: [makeEnemy("goblin", 5, 1)],
      ai,
      rng: makeRng(4242),
    });
    const r2 = resolveEncounter({
      fighter,
      enemies: [makeEnemy("goblin", 5, 1)],
      ai,
      rng: makeRng(4242),
    });
    assert.equal(r1.outcome, r2.outcome);
    assert.equal(r1.hpAfter, r2.hpAfter);
    assert.equal(r1.xpGained, r2.xpGained);
  });
});
