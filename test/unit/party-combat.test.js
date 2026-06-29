// SIGMA ABYSS — demo P3: the party turn-based resolver. Deterministic (seeded),
// bounded, never mutates inputs, attributes kills. combat.js stays untouched.
// Run: node --test test/unit/party-combat.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolvePartyEncounter, MAX_ROUNDS, MAX_LOG } from "../../shared/party-combat.js";

const sheet = (o = {}) => ({
  maxHp: 100, attack: 20, defense: 10, critChance: 0.1, critMult: 1.5, speed: 10, dodge: 0.05, overload: 0.3, ...o,
});
const C = (id, s = {}, isPlayer = false) => ({ id, name: id, isPlayer, sheet: sheet(s), hp: sheet(s).maxHp });

describe("resolvePartyEncounter — deterministic + bounded", () => {
  test("same seed → byte-identical result; different seed may differ", () => {
    const party = [C("hero", { attack: 24 }, true), C("ally", { attack: 18 })];
    const enemies = [C("gob1"), C("gob2")];
    const a = resolvePartyEncounter({ party, enemies, seed: 1234 });
    const b = resolvePartyEncounter({ party, enemies, seed: 1234 });
    assert.deepEqual(a, b, "reproducible from the seed");
    const c = resolvePartyEncounter({ party, enemies, seed: 9999 });
    assert.notDeepEqual(a.log, c.log, "a different seed produces a different fight");
  });

  test("never mutates the input combatants", () => {
    const party = [C("hero", {}, true)];
    const enemies = [C("gob1")];
    const hp0 = party[0].hp;
    resolvePartyEncounter({ party, enemies, seed: 5 });
    assert.equal(party[0].hp, hp0, "input hp untouched");
  });

  test("rounds and log are bounded", () => {
    // two tanky, low-damage sides → likely a timeout; must still cap.
    const party = [C("a", { attack: 2, defense: 80, maxHp: 500 }, true)];
    const enemies = [C("b", { attack: 2, defense: 80, maxHp: 500 })];
    const r = resolvePartyEncounter({ party, enemies, seed: 7 });
    assert.ok(r.rounds <= MAX_ROUNDS, "rounds capped");
    assert.ok(r.log.length <= MAX_LOG, "log capped");
    assert.ok(["victory", "defeat", "timeout"].includes(r.outcome));
  });
});

describe("outcomes + kill attribution", () => {
  test("a strong party wins and every kill is attributed to a party member", () => {
    const party = [C("hero", { attack: 60, maxHp: 200 }, true), C("ally", { attack: 50, maxHp: 180 })];
    const enemies = [C("gob1", { attack: 4, defense: 0, maxHp: 40 }), C("gob2", { attack: 4, defense: 0, maxHp: 40 })];
    const r = resolvePartyEncounter({ party, enemies, seed: 42 });
    assert.equal(r.outcome, "victory");
    assert.equal(r.enemies.filter((e) => !e.alive).length, 2, "both enemies down");
    const partyIds = new Set(party.map((c) => c.id));
    for (const k of r.kills) assert.ok(partyIds.has(k.by), `kill attributed to a party member (${k.by})`);
    assert.ok(r.party.reduce((n, c) => n + c.kills, 0) >= 2, "party kill count tracked");
  });

  test("an overmatched party is defeated", () => {
    const party = [C("hero", { attack: 3, defense: 0, maxHp: 30 }, true)];
    const enemies = [C("ogre1", { attack: 70, maxHp: 300 }), C("ogre2", { attack: 70, maxHp: 300 })];
    const r = resolvePartyEncounter({ party, enemies, seed: 3 });
    assert.equal(r.outcome, "defeat");
    assert.ok(r.party.every((c) => !c.alive), "party wiped");
  });
});
