// SIGMA ABYSS — demo P5: party delve orchestration. Inline, bounded, gated to a
// dungeon tile; the leader keeps the loot. Run: node --test test/unit/party-delve.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runPartyDelve } from "../../server/party-delve.js";
import { createBossDropForge } from "../../server/cerebras-boss-drops.js";
import { freshCharacter } from "../../shared/progression.js";
import { freshWorld } from "../../server/world-tick.js";

const dungeonTile = (w) => Object.values(w.sigmacraft.map.tiles).find((t) => t.type === "dungeon");
const store = { pushFeed() {} };

describe("runPartyDelve", () => {
  test("rejects a delve that isn't at a dungeon tile", () => {
    const w = freshWorld();
    const token = "sig_a";
    w.sigmacraft.actorPlaces[token] = w.sigmacraft.map.townTileId; // a safe town
    const out = runPartyDelve({ world: w, store, token, character: freshCharacter(1, "Hero"), bossDrops: null });
    assert.equal(out.ok, false);
    assert.match(out.error, /dungeon/);
  });

  test("a solo leader delves a dungeon, gets a demo run, and resolves with a log", () => {
    const w = freshWorld();
    const token = "sig_b";
    const dt = dungeonTile(w);
    w.sigmacraft.actorPlaces[token] = dt.id;
    const character = freshCharacter(2, "Hero");
    assert.equal(character.run?.level || 1, 1, "fresh character starts at run level 1");
    const out = runPartyDelve({ world: w, store, token, character, bossDrops: createBossDropForge({ env: {} }) });
    assert.equal(out.ok, true);
    assert.ok(["victory", "defeat", "timeout"].includes(out.outcome));
    assert.ok(Array.isArray(out.log) && out.party.length === 1);
    assert.ok(character.run && character.run.level >= 3, "a combat-ready demo run was created");
    assert.ok(Array.isArray(character.run.inventory));
  });

  test("a party delve resolves all members and records lastDelve on the party", () => {
    const w = freshWorld();
    const token = "sig_c";
    const dt = dungeonTile(w);
    w.sigmacraft.actorPlaces[token] = dt.id;
    // form a party with two recruited members co-located at the dungeon
    const members = Object.values(w.sigmacraft.overworldNpcs).slice(0, 2);
    for (const m of members) m.tileId = dt.id;
    w.sigmacraft.parties[token] = {
      leaderToken: token, status: "traveling",
      members: members.map((m) => ({ npcId: m.id, name: m.name, archetype: m.archetype })),
    };
    const out = runPartyDelve({ world: w, store, token, character: freshCharacter(3, "Hero"), bossDrops: createBossDropForge({ env: {} }) });
    assert.equal(out.ok, true);
    assert.equal(out.party.length, 3, "leader + 2 members fought");
    assert.ok(w.sigmacraft.parties[token].lastDelve, "delve outcome recorded on the party");
    assert.equal(w.sigmacraft.parties[token].lastDelve.outcome, out.outcome);
    if (out.outcome === "victory") assert.ok(out.loot.length >= 0);
  });
});
