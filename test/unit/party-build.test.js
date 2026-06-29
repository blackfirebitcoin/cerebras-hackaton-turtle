// SIGMA ABYSS — demo P2: NPC→combatant stat bridge. Sheets are deterministic
// (baked from FNV(npc.id) only, never live mood/supplies) and vary by archetype.
// Run: node --test test/unit/party-build.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildNpcCombatant, buildPartyCombatants, buildPlayerCombatant } from "../../server/party-build.js";
import { freshWorld } from "../../server/world-tick.js";

describe("buildPlayerCombatant — honors the live run", () => {
  test("starts at run.hp (not maxHp) and reflects run.alive", () => {
    const run = { level: 6, stats: { str: 10, agi: 8, vit: 10, luck: 5, int: 5, greed: 5, resolve: 8 }, gear: {}, hp: 7, alive: true };
    const c = buildPlayerCombatant({ name: "Hero", run });
    assert.ok(c.sheet.maxHp > 7, "maxHp is higher than the wounded live hp");
    assert.equal(c.hp, 7, "combatant starts at the run's live hp");
    assert.equal(c.alive, true);
    const dead = buildPlayerCombatant({ name: "Ghost", run: { ...run, hp: 0, alive: false } });
    assert.equal(dead.alive, false, "a dead run is not alive");
  });
});

const npc = (id, archetype, name = "Test") => ({ id, name, archetype });

describe("buildNpcCombatant — deterministic + archetype-shaped", () => {
  test("two builds of the same NPC yield a byte-identical sheet", () => {
    const a = buildNpcCombatant(npc("npc_guard_001", "guard", "Caelar"));
    const b = buildNpcCombatant(npc("npc_guard_001", "guard", "Caelar"));
    assert.deepEqual(a.sheet, b.sheet, "sheet is reproducible from the id seed");
    assert.equal(a.level, b.level);
    assert.equal(a.hp, a.sheet.maxHp, "hp starts at maxHp");
  });

  test("live mood/supplies do NOT affect the sheet (id-seeded only)", () => {
    const base = npc("npc_scout_007", "scout", "Wren");
    const a = buildNpcCombatant({ ...base, moodValue: 10, supplies: 0 });
    const b = buildNpcCombatant({ ...base, moodValue: 99, supplies: 5 });
    assert.deepEqual(a.sheet, b.sheet, "drifting state is ignored");
  });

  test("archetypes produce distinct combat profiles (guard tanky, scout fast)", () => {
    const guard = buildNpcCombatant(npc("npc_guard_001", "guard"));
    const scout = buildNpcCombatant(npc("npc_scout_001", "scout"));
    assert.ok(guard.sheet.maxHp > scout.sheet.maxHp, "guard has more HP than scout");
    assert.ok(scout.sheet.speed >= guard.sheet.speed, "scout is at least as fast as guard");
    for (const c of [guard, scout]) {
      assert.ok(c.sheet.attack >= 1 && c.sheet.maxHp > 0, "valid sheet");
    }
  });
});

describe("buildPartyCombatants", () => {
  test("builds the leader + each recruited member", () => {
    const w = freshWorld();
    const members = Object.values(w.sigmacraft.overworldNpcs).slice(0, 2);
    const party = { members: members.map((m) => ({ npcId: m.id, name: m.name, archetype: m.archetype })) };
    const leader = { token: "agt_x", name: "Hero", run: { level: 3, stats: { str: 8, agi: 6, vit: 7, luck: 5, int: 5, greed: 5, resolve: 6 }, gear: {} } };
    const roster = buildPartyCombatants(party, leader, (id) => w.sigmacraft.overworldNpcs[id]);
    assert.equal(roster.length, 3, "leader + 2 members");
    assert.equal(roster[0].isPlayer, true);
    assert.ok(roster.slice(1).every((c) => !c.isPlayer && c.sheet.maxHp > 0));
  });
});
