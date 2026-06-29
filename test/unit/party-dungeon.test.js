// SIGMA ABYSS — demo P4: dungeon enemies (party-scaled) + loot distribution.
// Reuses makeEnemy/rollDrop/boss-drop forge. Run: node --test test/unit/party-dungeon.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildDungeonEnemies, rollPartyLoot } from "../../server/party-dungeon.js";
import { createBossDropForge } from "../../server/cerebras-boss-drops.js";
import { buildNpcCombatant, buildPlayerCombatant } from "../../server/party-build.js";
import { resolvePartyEncounter } from "../../shared/party-combat.js";

const tile = (danger) => ({ id: "wild_dungeon", type: "dungeon", danger, name: "Goblin Warrens" });

describe("buildDungeonEnemies — deterministic + party-scaled", () => {
  test("same (tile,size,seed) → identical pack; bigger party → more enemies", () => {
    const a = buildDungeonEnemies(tile(3), 2, 77);
    const b = buildDungeonEnemies(tile(3), 2, 77);
    assert.deepEqual(a.enemies.map((e) => e.sheet), b.enemies.map((e) => e.sheet), "reproducible");
    const big = buildDungeonEnemies(tile(3), 5, 77);
    assert.ok(big.enemies.length > a.enemies.length, "party size scales the pack");
  });

  test("a dangerous dungeon is capped by a real boss (RAID_BOSS_DROPS id)", () => {
    const { enemies } = buildDungeonEnemies(tile(4), 3, 5);
    const boss = enemies.find((e) => e.isBoss);
    assert.ok(boss, "a boss caps the pack");
    assert.ok(["goblin_king", "hollow_druid", "chrome_centurion", "catacomb_tyrant"].includes(boss.bossId));
    assert.ok(boss.sheet.maxHp > 0 && boss.sheet.attack > 0);
  });

  test("low-danger dungeons have no boss", () => {
    assert.ok(!buildDungeonEnemies(tile(1), 2, 9).enemies.some((e) => e.isBoss));
  });
});

describe("rollPartyLoot", () => {
  const bossDrops = createBossDropForge({ env: {} }); // live OFF → deterministic forgeRaidDrop

  test("victory drops one item per kill, attributed to the killer; defeat drops nothing", () => {
    const party = [buildPlayerCombatant({ name: "Hero", run: { level: 8, stats: { str: 14, agi: 9, vit: 12, luck: 6, int: 5, greed: 5, resolve: 9 }, gear: {} } })];
    const result = {
      outcome: "victory",
      enemies: [{ id: "goblin_0" }, { id: "skeleton_1" }],
      kills: [{ enemyId: "goblin_0", by: party[0].id }, { enemyId: "skeleton_1", by: party[0].id }],
    };
    const built = { enemies: [{ id: "goblin_0", bossId: null }, { id: "skeleton_1", bossId: null }] };
    const loot = rollPartyLoot({ result, builtEnemies: built.enemies, party, level: 8, depth: 2, seed: 11, bossDrops });
    assert.equal(loot.drops.length, 2, "one drop per kill");
    assert.ok(loot.drops.every((d) => d.memberId === party[0].id && d.item));

    const lost = rollPartyLoot({ result: { outcome: "defeat", kills: [] }, builtEnemies: [], party, level: 8, depth: 2, seed: 11, bossDrops });
    assert.equal(lost.drops.length, 0, "no loot on defeat");
  });

  test("a boss kill yields a boss drop flagged fromBoss", () => {
    const party = [buildPlayerCombatant({ name: "Hero", run: { level: 10, stats: { str: 14, agi: 9, vit: 12, luck: 6, int: 5, greed: 5, resolve: 9 }, gear: {} } })];
    const result = { outcome: "victory", kills: [{ enemyId: "goblin_king_3", by: party[0].id }] };
    const built = [{ id: "goblin_king_3", bossId: "goblin_king" }];
    const loot = rollPartyLoot({ result, builtEnemies: built, party, level: 12, depth: 4, seed: 3, bossDrops });
    assert.equal(loot.drops.length, 1);
    assert.equal(loot.drops[0].fromBoss, true);
    assert.ok(loot.drops[0].item.name, "boss item has a name (the raid drop)");
  });
});

describe("end-to-end: build → resolve → loot", () => {
  test("a party clears a dungeon and walks out with loot", () => {
    // strong party so the smoke reliably reaches victory
    const party = [
      buildPlayerCombatant({ name: "Hero", run: { level: 12, stats: { str: 20, agi: 12, vit: 16, luck: 8, int: 6, greed: 6, resolve: 12 }, gear: {} } }),
      buildNpcCombatant({ id: "npc_guard_001", name: "Caelar", archetype: "guard" }),
    ];
    const { enemies, level, depth } = buildDungeonEnemies(tile(2), party.length, 4242);
    const result = resolvePartyEncounter({ party, enemies, seed: 4242 });
    assert.ok(["victory", "defeat", "timeout"].includes(result.outcome));
    const loot = rollPartyLoot({ result, builtEnemies: enemies, party, level, depth, seed: 4242, bossDrops: createBossDropForge({ env: {} }) });
    if (result.outcome === "victory") assert.equal(loot.drops.length, result.kills.length, "loot per kill on victory");
  });
});
