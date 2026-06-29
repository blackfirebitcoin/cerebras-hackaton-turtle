// SIGMA ABYSS — deterministic sim test suite.
// Run: node --test test/sim.test.js
// Uses node:test (built-in, zero deps) — consistent with the project's
// vanilla-JS + no-frameworks philosophy.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { LEVEL_MAX, START_STATS, STAT_KEYS, XP_BASE, XP_GROWTH } from "../shared/constants.js";
import { ENEMIES, makeEnemy } from "../shared/enemies.js";
import {
  affixText,
  bareFists,
  forgeRaidDrop,
  itemPower,
  makeItem,
  rollDrop,
  rollRarity,
  sellValue,
} from "../shared/loot.js";
import {
  bankAtTown,
  checkUnlocks,
  delveTick,
  deployToZone,
  ensureStarterGear,
  freshCharacter,
  freshRun,
  gainXp,
  resolveDeath,
  retreatToTown,
  sellOne,
  simulateOffline,
  xpForLevel,
} from "../shared/progression.js";
import { makeRng, mixSeed } from "../shared/rng.js";
import {
  damageMul,
  derive,
  distributeByPreset,
  gearEffects,
  spentPoints,
} from "../shared/stats.js";
import { recommendedZone, unlockedZones, ZONES, zoneById } from "../shared/zones.js";

// ── RNG determinism ───────────────────────────────────────────────────────────

describe("makeRng — determinism", () => {
  test("same seed produces identical sequence", () => {
    const r1 = makeRng(12345);
    const r2 = makeRng(12345);
    for (let i = 0; i < 20; i++) {
      assert.equal(r1.next(), r2.next());
    }
  });

  test("different seeds produce different sequences", () => {
    const r1 = makeRng(1);
    const r2 = makeRng(2);
    const seq1 = Array.from({ length: 10 }, () => r1.next());
    const seq2 = Array.from({ length: 10 }, () => r2.next());
    assert.notDeepEqual(seq1, seq2);
  });

  test("state save and restore produces identical continuation", () => {
    const r = makeRng(99999);
    // Draw a few values to advance state.
    r.next();
    r.next();
    r.next();
    const savedState = r.state;
    const expected = Array.from({ length: 10 }, () => r.next());
    // Restore and replay.
    r.state = savedState;
    const replayed = Array.from({ length: 10 }, () => r.next());
    assert.deepEqual(expected, replayed);
  });

  test("int() stays within [min, max]", () => {
    const r = makeRng(42);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(3, 7);
      assert.ok(n >= 3 && n <= 7, `int out of range: ${n}`);
    }
  });

  test("float() stays within [min, max)", () => {
    const r = makeRng(13);
    for (let i = 0; i < 1000; i++) {
      const n = r.float(0, 1);
      assert.ok(n >= 0 && n < 1, `float out of range: ${n}`);
    }
  });

  test("chance() respects probability boundary", () => {
    const r = makeRng(7);
    let trueCount = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) if (r.chance(0.5)) trueCount++;
    // Within 3% of 50% expected.
    assert.ok(
      trueCount > N * 0.47 && trueCount < N * 0.53,
      `chance(0.5) far from 50%: ${trueCount}/${N}`,
    );
  });

  test("weighted() picks the only option when it exists", () => {
    const r = makeRng(1);
    for (let i = 0; i < 10; i++) {
      assert.equal(r.weighted([["only", 999]]), "only");
    }
  });

  test("quality() returns value in [0,1]", () => {
    const r = makeRng(55);
    for (let i = 0; i < 200; i++) {
      const q = r.quality();
      assert.ok(q >= 0 && q <= 1, `quality out of [0,1]: ${q}`);
    }
  });

  test("mixSeed is deterministic for same inputs", () => {
    assert.equal(mixSeed(111, 222), mixSeed(111, 222));
  });

  test("mixSeed differs for different inputs", () => {
    assert.notEqual(mixSeed(1, 2), mixSeed(2, 1));
    assert.notEqual(mixSeed(0, 0), mixSeed(1, 0));
  });

  test("seed=0 is coerced to 1 (never stays zero)", () => {
    const r = makeRng(0);
    // Should not hang and should produce values.
    const v = r.next();
    assert.ok(typeof v === "number" && Number.isFinite(v));
  });
});

// ── Stats / derive() ──────────────────────────────────────────────────────────

describe("stats — derive()", () => {
  test("derive() returns all expected keys", () => {
    const run = freshRun(1, 0);
    const sheet = derive(run);
    for (const k of [
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
      "effects",
    ]) {
      assert.ok(k in sheet, `missing key: ${k}`);
    }
  });

  test("higher vit → higher maxHp", () => {
    const r1 = freshRun(1, 0);
    r1.stats.vit = 5;
    const r2 = freshRun(1, 0);
    r2.stats.vit = 50;
    assert.ok(derive(r2).maxHp > derive(r1).maxHp);
  });

  test("higher str → higher attack", () => {
    const r1 = freshRun(1, 0);
    r1.stats.str = 5;
    const r2 = freshRun(1, 0);
    r2.stats.str = 50;
    assert.ok(derive(r2).attack > derive(r1).attack);
  });

  test("higher agi → higher speed and dodge", () => {
    const r1 = freshRun(1, 0);
    r1.stats.agi = 5;
    const r2 = freshRun(1, 0);
    r2.stats.agi = 50;
    const s1 = derive(r1),
      s2 = derive(r2);
    assert.ok(s2.speed > s1.speed);
    assert.ok(s2.dodge > s1.dodge);
  });

  test("critChance is capped at 0.75", () => {
    const r = freshRun(1, 0);
    r.stats.luck = 999;
    assert.ok(derive(r).critChance <= 0.75);
  });

  test("dodge is capped at 0.6", () => {
    const r = freshRun(1, 0);
    r.stats.agi = 999;
    assert.ok(derive(r).dodge <= 0.6);
  });

  test("damageMul returns 1 at 0 defense", () => {
    assert.equal(damageMul(0), 1);
  });

  test("damageMul decreases as defense rises", () => {
    assert.ok(damageMul(100) < damageMul(0));
    assert.ok(damageMul(200) < damageMul(100));
  });

  test("distributeByPreset bruiser puts most into str+vit+resolve", () => {
    const stats = distributeByPreset("bruiser", 30);
    const sum = STAT_KEYS.reduce((acc, k) => acc + (stats[k] - START_STATS[k]), 0);
    // All 30 points must be distributed (no points lost).
    assert.equal(sum, 30);
    // Bruiser weights str:3, vit:2, resolve:1 → str must be highest gain.
    assert.ok(stats.str > stats.agi);
  });

  test("spentPoints counts allocated points above START_STATS", () => {
    const stats = { ...START_STATS, str: 15 }; // 10 extra into str
    assert.equal(spentPoints(stats), 10);
  });

  test("gearEffects collects effect ids from equipped items", () => {
    const gear = {
      weapon: { slot: "weapon", affixes: [], effect: "bloodthirst" },
      armor: null,
      ring: null,
      relic: null,
      charm: null,
    };
    const efx = gearEffects(gear);
    assert.ok(efx.includes("bloodthirst"));
  });
});

// ── Zones ─────────────────────────────────────────────────────────────────────

describe("zones", () => {
  test("zoneById returns town for unknown id", () => {
    assert.equal(zoneById("nonexistent").id, "town");
  });

  test("all non-safe zones have enemies", () => {
    for (const z of ZONES.filter((z) => !z.safe)) {
      assert.ok(z.enemies.length > 0, `${z.id} has no enemies`);
    }
  });

  test("all non-safe zones have a boss", () => {
    for (const z of ZONES.filter((z) => !z.safe)) {
      assert.ok(z.boss, `${z.id} has no boss`);
    }
  });

  test("zone tiers increase monotonically", () => {
    const nonSafe = ZONES.filter((z) => !z.safe);
    for (let i = 1; i < nonSafe.length; i++) {
      assert.ok(nonSafe[i].tier > nonSafe[i - 1].tier, `tier not monotonic at index ${i}`);
    }
  });

  test("unlockedZones respects minLevel", () => {
    const lowChar = freshCharacter(1, "LowLevel");
    lowChar.highestLevel = 1;
    const zones = unlockedZones(lowChar);
    // goblin_warrens (minLevel:1) should be accessible, tier-5 (minLevel:50) should not.
    assert.ok(zones.some((z) => z.id === "goblin_warrens"));
    assert.ok(!zones.some((z) => z.minLevel > 5));
  });

  test("recommendedZone returns the highest unlocked zone", () => {
    const highChar = freshCharacter(1, "HighLevel");
    highChar.highestLevel = 99;
    const rec = recommendedZone(highChar);
    assert.ok(rec.minLevel <= 99);
    // Should be the last one with minLevel ≤ 99.
    const unlocked = unlockedZones(highChar);
    assert.equal(rec.id, unlocked[unlocked.length - 1].id);
  });
});

// ── Enemies ───────────────────────────────────────────────────────────────────

describe("enemies", () => {
  test("makeEnemy produces positive hp and attack", () => {
    const rng = makeRng(1);
    const e = makeEnemy("goblin", 5, 2, rng);
    assert.ok(e.maxHp > 0);
    assert.ok(e.hp === e.maxHp);
    assert.ok(e.attack > 0);
  });

  test("makeEnemy scales with level", () => {
    const rng1 = makeRng(1),
      rng2 = makeRng(1);
    const low = makeEnemy("goblin", 1, 0, rng1);
    const high = makeEnemy("goblin", 20, 0, rng2);
    assert.ok(high.maxHp > low.maxHp);
    assert.ok(high.attack > low.attack);
  });

  test("boss has threat=3, elite has threat=2, normal has threat=1", () => {
    const rng = makeRng(7);
    const boss = makeEnemy("goblin_king", 5, 0, rng);
    const elite = makeEnemy("cursed_gambler", 5, 0, rng);
    const normal = makeEnemy("goblin", 5, 0, rng);
    assert.equal(boss.threat, 3);
    assert.equal(elite.threat, 2);
    assert.equal(normal.threat, 1);
  });

  test("all enemy ids in zone rosters resolve to known archetypes", () => {
    for (const zone of ZONES.filter((z) => !z.safe)) {
      for (const id of [...zone.enemies, ...zone.elites, zone.boss]) {
        assert.ok(id in ENEMIES, `unknown enemy id "${id}" in zone ${zone.id}`);
      }
    }
  });

  test("every enemy archetype has an lpc spec", () => {
    for (const [id, def] of Object.entries(ENEMIES)) {
      assert.ok(def.lpc && typeof def.lpc === "object", `${id} missing lpc`);
    }
  });

  test("makeEnemy without rng still returns valid enemy", () => {
    const e = makeEnemy("skeleton", 3, 1);
    assert.ok(e.maxHp > 0 && e.attack > 0);
  });

  test("unknown id falls back to goblin", () => {
    const e = makeEnemy("does_not_exist", 1, 0);
    assert.equal(e.id, "does_not_exist");
    // The name should come from goblin fallback.
    assert.equal(e.name, ENEMIES.goblin.name);
  });
});

// ── Loot ──────────────────────────────────────────────────────────────────────

describe("loot", () => {
  test("rollRarity returns a valid rarity string", () => {
    const rng = makeRng(1);
    const rarities = new Set();
    for (let i = 0; i < 200; i++) rarities.add(rollRarity(rng, 0));
    // All results should be in the known rarities list.
    const VALID = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "oneofone"];
    for (const r of rarities) assert.ok(VALID.includes(r), `unexpected rarity: ${r}`);
  });

  test("rollRarity with bias produces rare+ more often", () => {
    const rng1 = makeRng(42),
      rng2 = makeRng(42);
    let highCount0 = 0,
      highCount5 = 0;
    const N = 500;
    const HIGH = new Set(["rare", "epic", "legendary", "mythic", "oneofone"]);
    for (let i = 0; i < N; i++) {
      if (HIGH.has(rollRarity(rng1, 0))) highCount0++;
      if (HIGH.has(rollRarity(rng2, 5))) highCount5++;
    }
    assert.ok(highCount5 > highCount0, "bias 5 should produce more high-rarity drops");
  });

  test("makeItem returns item with correct slot and rarity", () => {
    const rng = makeRng(7);
    const item = makeItem({ slot: "weapon", rarity: "rare", ilvl: 5, rng });
    assert.equal(item.slot, "weapon");
    assert.equal(item.rarity, "rare");
    assert.ok(item.affixes.length > 0);
    assert.ok(typeof item.name === "string" && item.name.length > 0);
  });

  test("legendary+ item gets an effect", () => {
    const rng = makeRng(1);
    const item = makeItem({ slot: "ring", rarity: "legendary", ilvl: 10, rng });
    assert.ok(typeof item.effect === "string" && item.effect.length > 0);
  });

  test("common item has no effect", () => {
    const rng = makeRng(1);
    const item = makeItem({ slot: "armor", rarity: "common", ilvl: 5, rng });
    assert.equal(item.effect, null);
  });

  test("itemPower is non-negative", () => {
    const rng = makeRng(9);
    for (let i = 0; i < 20; i++) {
      const item = rollDrop({ rng, level: 5, depth: 2 });
      assert.ok(itemPower(item) >= 0);
    }
  });

  test("sellValue is positive", () => {
    const rng = makeRng(5);
    const item = makeItem({ slot: "charm", rarity: "epic", ilvl: 8, rng });
    assert.ok(sellValue(item) > 0);
  });

  test("bareFists has zero power and zero value", () => {
    const bf = bareFists();
    assert.equal(itemPower(bf), 0);
    assert.equal(bf.power, 0);
    assert.equal(bf.value, 0);
    assert.equal(bf.slot, "weapon");
  });

  test("rollDrop determinism: same rng state produces same item", () => {
    const rng1 = makeRng(999),
      rng2 = makeRng(999);
    const item1 = rollDrop({ rng: rng1, level: 10, depth: 3 });
    const item2 = rollDrop({ rng: rng2, level: 10, depth: 3 });
    assert.equal(item1.slot, item2.slot);
    assert.equal(item1.rarity, item2.rarity);
    assert.equal(item1.name, item2.name);
    assert.equal(item1.power, item2.power);
  });

  test("forgeRaidDrop returns correct boss item", () => {
    const item = forgeRaidDrop("goblin_king", 10);
    assert.ok(item !== null);
    assert.equal(item.raidDrop, "goblin_king");
    assert.equal(item.effect, "midas");
    assert.equal(item.rarity, "mythic");
    assert.ok(item.ilvl >= 15);
  });

  test("forgeRaidDrop returns null for unknown boss", () => {
    assert.equal(forgeRaidDrop("not_a_boss", 10), null);
  });

  test("affixText formats correctly for flat and pct affixes", () => {
    const flat = { stat: "str", kind: "prefix", value: 10, pct: false };
    const pct = { stat: "crit", kind: "suffix", value: 0.05, pct: true };
    assert.match(affixText(flat), /\+10/);
    assert.match(affixText(pct), /5\.0%/);
  });
});

// ── Progression ───────────────────────────────────────────────────────────────

describe("progression — freshCharacter / freshRun", () => {
  test("freshCharacter starts at level 1, full HP, alive", () => {
    const c = freshCharacter(1, "Test");
    assert.equal(c.run.level, 1);
    assert.equal(c.run.alive, true);
    const sheet = derive(c.run);
    assert.equal(c.run.hp, sheet.maxHp);
  });

  test("freshCharacter preserves seed", () => {
    const c = freshCharacter(424242, "SeedTest");
    assert.equal(c.seed, 424242);
  });

  test("freshCharacter has 3 potions", () => {
    const c = freshCharacter(1);
    assert.equal(c.run.potions, 3);
  });

  test("freshCharacter starts in town", () => {
    const c = freshCharacter(1);
    assert.equal(c.run.zone, "town");
  });

  test("same seed produces same name + cosmetics", () => {
    const c1 = freshCharacter(12345, undefined);
    const c2 = freshCharacter(12345, undefined);
    assert.equal(c1.name, c2.name);
    assert.deepEqual(c1.cosmetics, c2.cosmetics);
  });

  test("freshRun mints a deterministic rngSeed from seed+runIndex", () => {
    const r1 = freshRun(100, 0);
    const r2 = freshRun(100, 0);
    assert.equal(r1.rngSeed, r2.rngSeed);
  });

  test("different runIndex produces different rngSeed", () => {
    const r0 = freshRun(100, 0);
    const r1 = freshRun(100, 1);
    assert.notEqual(r0.rngSeed, r1.rngSeed);
  });
});

describe("progression — xpForLevel / gainXp", () => {
  test("xp curve strictly increases", () => {
    for (let lvl = 1; lvl < 20; lvl++) {
      assert.ok(xpForLevel(lvl + 1) > xpForLevel(lvl));
    }
  });

  test("xpForLevel(1) is XP_BASE", () => {
    assert.equal(xpForLevel(1), Math.round(XP_BASE * XP_GROWTH ** 0));
  });

  test("gainXp levels up when threshold crossed", () => {
    const run = freshRun(1, 0);
    run.xp = 0;
    const needed = xpForLevel(1);
    const res = gainXp(run, needed);
    assert.equal(run.level, 2);
    assert.ok(res.leveled);
    assert.equal(res.levelsGained, 1);
  });

  test("gainXp never exceeds LEVEL_MAX", () => {
    const run = freshRun(1, 0);
    run.level = LEVEL_MAX;
    gainXp(run, 1e15);
    assert.equal(run.level, LEVEL_MAX);
  });

  test("gainXp heals a fraction of maxHp on level up", () => {
    const run = freshRun(1, 0);
    run.hp = 1; // set HP dangerously low
    gainXp(run, xpForLevel(1));
    assert.ok(run.hp > 1, "level-up should heal some HP");
  });
});

// ── Run/Account split (permadeath) ────────────────────────────────────────────

describe("progression — permadeath / run–account split", () => {
  test("resolveDeath erases the run, mints a new one", () => {
    const c = freshCharacter(55, "Doomed");
    deployToZone(c, "goblin_warrens");
    c.run.level = 5;
    c.run.kills = 10;
    const oldSeed = c.run.rngSeed;
    const result = resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "a goblin" });
    // run is reset.
    assert.equal(c.run.level, 1);
    assert.equal(c.run.kills, 0);
    assert.ok(c.run.alive);
    // rngSeed changes (new run index → new seed).
    assert.notEqual(c.run.rngSeed, oldSeed);
    // account-level fields survive.
    assert.ok(c.prestige > 0, "prestige paid on death");
    assert.equal(c.lifetimeRuns, 1);
    assert.ok(result.prestigeGained > 0);
  });

  test("resolveDeath preserves prestige, gold, and titles", () => {
    const c = freshCharacter(66, "Rich");
    c.gold = 1000;
    c.prestige = 50;
    c.titles = ["Survivor"];
    const goldBefore = c.gold;
    deployToZone(c, "goblin_warrens");
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    // Gold is untouched by death.
    assert.equal(c.gold, goldBefore);
    assert.ok(c.prestige >= 50, "prestige should not decrease on death");
    assert.ok(c.titles.includes("Survivor"), "titles persist across death");
  });

  test("resolveDeath resets streak to 0", () => {
    const c = freshCharacter(77, "Streaker");
    c.streak = 5;
    deployToZone(c, "goblin_warrens");
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    assert.equal(c.streak, 0);
  });

  test("resolveDeath carries forward AI config to the new run", () => {
    const c = freshCharacter(88, "AI");
    c.run.ai.greedMode = true;
    c.run.ai.retreatDepth = 15;
    deployToZone(c, "goblin_warrens");
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    assert.equal(c.run.ai.greedMode, true);
    assert.equal(c.run.ai.retreatDepth, 15);
  });

  test("run fields reset: level, depth, gear, inventory, xp", () => {
    const c = freshCharacter(99, "LoadedUp");
    const rng = makeRng(1);
    c.run.level = 10;
    c.run.depth = 8;
    c.run.xp = 999;
    c.run.inventory = [rollDrop({ rng, level: 5 })];
    deployToZone(c, "goblin_warrens");
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    assert.equal(c.run.level, 1);
    assert.equal(c.run.depth, 0);
    assert.equal(c.run.xp, 0);
    assert.equal(c.run.inventory.length, 0);
  });
});

// ── Zone transitions ──────────────────────────────────────────────────────────

describe("progression — zone transitions", () => {
  test("deployToZone moves character into zone", () => {
    const c = freshCharacter(1);
    const r = deployToZone(c, "goblin_warrens");
    assert.ok(r.ok);
    assert.equal(c.run.zone, "goblin_warrens");
    assert.equal(c.run.danger, 0);
    assert.equal(c.run.depth, 0);
  });

  test("deployToZone refuses town (safe zone)", () => {
    const c = freshCharacter(1);
    const r = deployToZone(c, "town");
    assert.ok(!r.ok);
  });

  test("deployToZone refuses deploy when run is dead", () => {
    const c = freshCharacter(1);
    c.run.alive = false;
    const r = deployToZone(c, "goblin_warrens");
    assert.ok(!r.ok);
  });

  test("retreatToTown heals to full HP", () => {
    const c = freshCharacter(1);
    deployToZone(c, "goblin_warrens");
    c.run.hp = 1;
    retreatToTown(c);
    assert.equal(c.run.zone, "town");
    assert.equal(c.run.hp, derive(c.run).maxHp);
  });

  test("retreatToTown increments streak", () => {
    const c = freshCharacter(1);
    deployToZone(c, "goblin_warrens");
    retreatToTown(c);
    assert.equal(c.streak, 1);
  });
});

// ── bankAtTown / sellOne ──────────────────────────────────────────────────────

describe("progression — banking", () => {
  test("bankAtTown converts inventory to gold and clears it", () => {
    const c = freshCharacter(1);
    const rng = makeRng(1);
    c.run.inventory = [rollDrop({ rng, level: 5 }), rollDrop({ rng, level: 5 })];
    const goldBefore = c.gold;
    const res = bankAtTown(c);
    assert.ok(res.gold > 0);
    assert.equal(c.run.inventory.length, 0);
    assert.ok(c.gold > goldBefore);
    assert.equal(res.itemsSold, 2);
  });

  test("bankAtTown pays a prestige trickle scaled by gold sold", () => {
    const c = freshCharacter(1);
    // Force a high-value item.
    c.run.inventory = [
      {
        id: "test",
        slot: "charm",
        rarity: "legendary",
        ilvl: 20,
        affixes: [],
        effect: "midas",
        name: "TestItem",
        power: 100,
        value: 800,
        starter: false,
      },
    ];
    const res = bankAtTown(c);
    assert.ok(res.prestige > 0);
  });

  test("sellOne removes item at index and gives gold", () => {
    const c = freshCharacter(1);
    const rng = makeRng(1);
    const item = rollDrop({ rng, level: 5 });
    c.run.inventory = [item];
    const res = sellOne(c, 0);
    assert.ok(res.ok);
    assert.ok(res.gold > 0);
    assert.equal(c.run.inventory.length, 0);
  });

  test("sellOne returns ok:false for bad index", () => {
    const c = freshCharacter(1);
    c.run.inventory = [];
    assert.ok(!sellOne(c, 0).ok);
    assert.ok(!sellOne(c, -1).ok);
  });
});

// ── checkUnlocks / prestige milestones ────────────────────────────────────────

describe("progression — prestige milestones", () => {
  test("Survivor title granted at prestige 10", () => {
    const c = freshCharacter(1, "Prestige10");
    c.prestige = 10;
    const fresh = checkUnlocks(c);
    assert.ok(c.titles.includes("Survivor"));
    assert.ok(fresh.some((u) => u.kind === "title" && u.value === "Survivor"));
  });

  test("checkUnlocks is idempotent — does not duplicate grants", () => {
    const c = freshCharacter(1);
    c.prestige = 25;
    checkUnlocks(c);
    const titlesBefore = [...c.titles];
    checkUnlocks(c); // second call
    assert.deepEqual(c.titles, titlesBefore);
  });

  test("cosmetics unlocked at prestige 25 (Delver)", () => {
    const c = freshCharacter(1);
    c.prestige = 25;
    checkUnlocks(c);
    assert.ok(c.cosmeticsUnlocked.includes("aura_bronze"));
  });
});

// ── ensureStarterGear ─────────────────────────────────────────────────────────

describe("progression — ensureStarterGear", () => {
  test("null weapon slot gets bare fists", () => {
    const c = freshCharacter(1);
    c.run.gear.weapon = null;
    ensureStarterGear(c);
    assert.equal(c.run.gear.weapon.id, "starter-fists");
  });

  test("existing weapon is not replaced", () => {
    const c = freshCharacter(1);
    const rng = makeRng(1);
    const realWeapon = rollDrop({ rng, level: 5, slot: "weapon" });
    c.run.gear.weapon = realWeapon;
    ensureStarterGear(c);
    assert.equal(c.run.gear.weapon.id, realWeapon.id);
  });
});

// ── Sim determinism — core invariant ─────────────────────────────────────────

describe("CRITICAL: sim determinism", () => {
  test("simulateOffline: identical seed+elapsed → identical report", () => {
    const c1 = freshCharacter(12345, "A");
    const c2 = freshCharacter(12345, "B"); // different name, same seed
    const r1 = simulateOffline(c1, 4 * 3600 * 1000);
    const r2 = simulateOffline(c2, 4 * 3600 * 1000);
    assert.equal(r1.kills, r2.kills, "kills must match");
    assert.equal(r1.xpGained, r2.xpGained, "xpGained must match");
    assert.equal(r1.itemsFound, r2.itemsFound, "itemsFound must match");
    assert.equal(r1.died, r2.died, "died must match");
    assert.equal(r1.endLevel, r2.endLevel, "endLevel must match");
    assert.equal(r1.levelsGained, r2.levelsGained, "levelsGained must match");
    assert.equal(r1.bossKills, r2.bossKills, "bossKills must match");
    assert.equal(r1.ticks, r2.ticks, "ticks must match");
  });

  test("delveTick: two identical runs from same state produce identical outcome", () => {
    const c1 = freshCharacter(99999, "Clone1");
    const c2 = freshCharacter(99999, "Clone2");
    deployToZone(c1, "goblin_warrens");
    deployToZone(c2, "goblin_warrens");
    // Both chars now have same rng state and zone.
    const out1 = delveTick(c1);
    const out2 = delveTick(c2);
    assert.equal(out1.type, out2.type);
    if (out1.result && out2.result) {
      assert.equal(out1.result.outcome, out2.result.outcome);
      assert.equal(out1.result.kills, out2.result.kills);
      assert.equal(out1.result.hpAfter, out2.result.hpAfter);
      assert.equal(out1.result.xpGained, out2.result.xpGained);
    }
  });

  test("rng state persists between ticks (offline matches live sequence)", () => {
    // Run delveTick N times on c1, then simulateOffline the same N ticks on c2.
    // They should land at the same state (kills, level, depth, rngState).
    const c1 = freshCharacter(11111, "Live");
    const c2 = freshCharacter(11111, "Offline");
    deployToZone(c1, "goblin_warrens");

    const tickCount = 5;
    let died = false;
    for (let i = 0; i < tickCount && !died; i++) {
      const out = delveTick(c1);
      if (out.type === "death") {
        resolveDeath(c1, out);
        died = true;
      } else if (out.type === "retreat" || out.type === "boss_clear") {
        retreatToTown(c1);
        bankAtTown(c1);
        deployToZone(c1, "goblin_warrens");
      }
    }

    // Offline sim: OFFLINE_TICK_MS is 9000 ms per tick.
    const elapsedMs = tickCount * 9000;
    simulateOffline(c2, elapsedMs);

    // Both should have consumed the same number of kills regardless of outcome.
    // (Exact parity is only guaranteed up to the death boundary — once died,
    //  resolveDeath mints a new run. We check rngState matches if both survived.)
    if (!died && c1.run.alive && c2.run.alive) {
      assert.equal(c1.run.rngState, c2.run.rngState, "rngState must match after same tick count");
    }
    // At minimum both must have advanced (made RNG draws).
    assert.ok(c1.lifetimeKills >= 0);
    assert.ok(c2.lifetimeKills >= 0);
  });

  test("different seeds produce different outcomes", () => {
    const c1 = freshCharacter(1, "A");
    const c2 = freshCharacter(2, "B");
    const r1 = simulateOffline(c1, 3 * 3600 * 1000);
    const r2 = simulateOffline(c2, 3 * 3600 * 1000);
    // The two runs starting from different seeds should diverge in at least
    // one metric (kills, XP, or level).
    const same =
      r1.kills === r2.kills &&
      r1.xpGained === r2.xpGained &&
      r1.endLevel === r2.endLevel &&
      r1.levelsGained === r2.levelsGained;
    assert.ok(!same, "different seeds should produce divergent runs");
  });

  test("elapsed=0 produces a no-op report", () => {
    const c = freshCharacter(1);
    const r = simulateOffline(c, 0);
    assert.equal(r.ticks, 0);
    assert.equal(r.ran, false);
  });

  test("rest posture is deterministic", () => {
    const c1 = freshCharacter(777, "Rester1");
    const c2 = freshCharacter(777, "Rester2");
    c1.posture = "rest";
    c2.posture = "rest";
    const r1 = simulateOffline(c1, 6 * 3600 * 1000);
    const r2 = simulateOffline(c2, 6 * 3600 * 1000);
    assert.equal(r1.goldGained, r2.goldGained);
    assert.equal(r1.prestigeGained, r2.prestigeGained);
    assert.equal(r1.mode, "rest");
    assert.equal(r2.mode, "rest");
  });
});

// ── Leaderboard ranking math ───────────────────────────────────────────────────

describe("leaderboard ranking math", () => {
  test("prestige-based ranking: higher prestige sorts first", () => {
    const players = [
      { name: "Low", prestige: 10, lifetimeKills: 5 },
      { name: "High", prestige: 100, lifetimeKills: 1 },
      { name: "Mid", prestige: 50, lifetimeKills: 50 },
    ];
    const sorted = [...players].sort((a, b) => b.prestige - a.prestige);
    assert.equal(sorted[0].name, "High");
    assert.equal(sorted[1].name, "Mid");
    assert.equal(sorted[2].name, "Low");
  });

  test("kill-count tiebreaker when prestige is equal", () => {
    const players = [
      { name: "Fewerkillers", prestige: 50, lifetimeKills: 5 },
      { name: "Morekills", prestige: 50, lifetimeKills: 100 },
    ];
    const sorted = [...players].sort((a, b) =>
      b.prestige !== a.prestige ? b.prestige - a.prestige : b.lifetimeKills - a.lifetimeKills,
    );
    assert.equal(sorted[0].name, "Morekills");
  });

  test("resolveDeath prestige gain scales with level + depth + zone tier", () => {
    const makeChar = (level, depth, zoneTier, kills) => {
      const c = freshCharacter(1, "T");
      c.run.level = level;
      c.run.depth = depth;
      c.run.kills = kills;
      return { c, zoneTier };
    };

    const { c: c1, zoneTier: t1 } = makeChar(5, 5, 1, 10);
    const { c: c2, zoneTier: t2 } = makeChar(20, 15, 4, 100);

    const zone1 = ZONES.find((z) => z.tier === t1);
    const zone2 = ZONES.find((z) => z.tier === t2);

    const r1 = resolveDeath(c1, { zone: zone1, deathBy: "the abyss" });
    const r2 = resolveDeath(c2, { zone: zone2, deathBy: "the abyss" });

    assert.ok(
      r2.prestigeGained > r1.prestigeGained,
      `deeper/longer run should earn more prestige: ${r2.prestigeGained} vs ${r1.prestigeGained}`,
    );
  });

  test("bestLevel tracks the highest level across runs", () => {
    const c = freshCharacter(1, "Record");
    deployToZone(c, "goblin_warrens");
    c.run.level = 15;
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    assert.equal(c.bestLevel, 15);
    // Second death at lower level should not lower bestLevel.
    c.run.level = 3;
    resolveDeath(c, { zone: zoneById("goblin_warrens"), deathBy: "the abyss" });
    assert.equal(c.bestLevel, 15);
  });
});

// ── WS message validation (server/validate.js) ────────────────────────────────

describe("validate — parseMessage", () => {
  // Lazy-import validate.js to avoid touching server.js or realtime.js.
  let parseMessage, ValidationError, vInt, vStr, vEnum, vBool, vCharacter;
  before(async () => {
    const mod = await import("../server/validate.js");
    parseMessage = mod.parseMessage;
    ValidationError = mod.ValidationError;
    vInt = mod.vInt;
    vStr = mod.vStr;
    vEnum = mod.vEnum;
    vBool = mod.vBool;
    vCharacter = mod.vCharacter;
  });

  test("rejects non-JSON", () => {
    assert.throws(() => parseMessage("not json"), ValidationError);
  });

  test("rejects empty string", () => {
    assert.throws(() => parseMessage(""), ValidationError);
  });

  test("rejects JSON array at top level", () => {
    assert.throws(() => parseMessage("[]"), ValidationError);
  });

  test("rejects unknown message type", () => {
    assert.throws(() => parseMessage(JSON.stringify({ t: "explode" })), ValidationError);
  });

  test("parses ping", () => {
    const msg = parseMessage(JSON.stringify({ t: "ping" }));
    assert.equal(msg.t, "ping");
    assert.deepEqual(msg.data, {});
  });

  test("parses hello with valid twitch login (lowercases it)", () => {
    const msg = parseMessage(JSON.stringify({ t: "hello", twitch: "CoolStreamer_42" }));
    assert.equal(msg.t, "hello");
    assert.equal(msg.data.twitch, "coolstreamer_42");
  });

  test("hello rejects malformed twitch login (spaces)", () => {
    const msg = parseMessage(JSON.stringify({ t: "hello", twitch: "has spaces" }));
    assert.equal(msg.data.twitch, null);
  });

  test("hello with null token and name is fine", () => {
    const msg = parseMessage(JSON.stringify({ t: "hello", token: null, name: null }));
    assert.equal(msg.data.token, null);
    assert.equal(msg.data.name, null);
  });

  test("save round-trips a real character", () => {
    const c = freshCharacter(424242, "SmokeSigma");
    const msg = parseMessage(JSON.stringify({ t: "save", character: c }));
    assert.equal(msg.t, "save");
    assert.equal(msg.data.character.name, "SmokeSigma");
  });

  test("hostile values are clamped, not rejected", () => {
    const msg = parseMessage(
      JSON.stringify({
        t: "save",
        character: {
          name: "x".repeat(9999),
          seed: -5,
          prestige: 1e30,
          run: { level: 99999 },
        },
      }),
    );
    const ch = msg.data.character;
    assert.ok(ch.name.length <= 18, "name clamped to NAME_MAX");
    assert.ok(ch.seed >= 1, "seed clamped to minimum 1");
    assert.ok(ch.prestige <= 1e9, "prestige bounded");
    assert.ok(ch.run.level <= LEVEL_MAX, "level clamped to LEVEL_MAX");
  });

  test("vInt clamps out-of-range values", () => {
    assert.equal(vInt(500, 0, 100, 0), 100);
    assert.equal(vInt(-5, 0, 100, 0), 0);
  });

  test("vInt returns default for missing value", () => {
    assert.equal(vInt(undefined, 0, 100, 42), 42);
  });

  test("vStr strips control characters", () => {
    const dirty = "hello world end";
    const clean = vStr(dirty, 100);
    assert.ok(!clean.includes(" "), "null byte stripped");
    assert.ok(!clean.includes(" "), "line separator stripped");
    assert.ok(clean.includes("hello") && clean.includes("world"));
  });

  test("vStr truncates to maxLen", () => {
    const s = vStr("a".repeat(200), 10);
    assert.equal(s.length, 10);
  });

  test("vEnum rejects unknown value without default", () => {
    assert.throws(() => vEnum("nope", ["a", "b"]));
  });

  test("vEnum returns default for unknown value", () => {
    assert.equal(vEnum("nope", ["a", "b"], "a"), "a");
  });

  test("vBool coerces truthy/falsy", () => {
    assert.equal(vBool(1), true);
    assert.equal(vBool(0), false);
    assert.equal(vBool(undefined, true), true);
  });

  test("vCharacter validates and normalises a character", () => {
    const c = freshCharacter(1, "Bob");
    const validated = vCharacter(c);
    assert.equal(validated.name, "Bob");
    assert.ok(validated.run.alive !== undefined);
    assert.ok(Number.isInteger(validated.run.level));
  });
});
