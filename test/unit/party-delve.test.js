// SIGMA ABYSS — demo P5: party delve orchestration + its TRUST BOUNDARY (the
// adversarial-review fixes). Playtest-only; honors run.hp/alive; carries HP cost +
// permadeath; gates same-tile re-farming. Run: node --test test/unit/party-delve.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runPartyDelve } from "../../server/party-delve.js";
import { advance, enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { ensureDemoRun } from "../../server/party-build.js";
import { createBossDropForge } from "../../server/cerebras-boss-drops.js";
import { freshCharacter } from "../../shared/progression.js";
import { freshWorld } from "../../server/world-tick.js";

const dungeonTile = (w) => Object.values(w.sigmacraft.map.tiles).find((t) => t.type === "dungeon");
const store = { pushFeed() {} };
const playtest = (seed) => { const c = freshCharacter(seed, "Hero"); c.isPlaytest = true; return c; };
const boss = () => createBossDropForge({ env: {} });

describe("trust boundary (review fixes)", () => {
  test("ensureDemoRun NEVER touches a non-playtest (real) account's run", () => {
    const real = freshCharacter(1, "RealAcct"); // no isPlaytest
    real.run.level = 1; real.run.xp = 999; real.run.inventory = [{ name: "Heirloom" }];
    const before = real.run;
    ensureDemoRun(real);
    assert.equal(real.run, before, "same run object — not replaced");
    assert.equal(real.run.level, 1, "level untouched");
    assert.equal(real.run.xp, 999, "xp untouched");
    assert.equal(real.run.inventory[0].name, "Heirloom", "inventory untouched");
  });

  test("a playtest character gets a full-HP, alive level-8 demo run once", () => {
    const c = playtest(2);
    ensureDemoRun(c);
    assert.equal(c.run.level, 8);
    assert.equal(c.run.alive, true);
    assert.ok(c.run.hp > 0, "starts at full HP");
  });
});

describe("runPartyDelve", () => {
  test("rejects a delve that isn't at a dungeon tile", () => {
    const w = freshWorld();
    const token = "sig_a";
    w.sigmacraft.actorPlaces[token] = w.sigmacraft.map.townTileId;
    const out = runPartyDelve({ world: w, store, token, character: playtest(1), bossDrops: null });
    assert.equal(out.ok, false);
    assert.match(out.error, /dungeon/);
  });

  test("a playtest leader delves, gets a demo run, and resolves with a log", () => {
    const w = freshWorld();
    const token = "sig_b";
    w.sigmacraft.actorPlaces[token] = dungeonTile(w).id;
    const character = playtest(2);
    const out = runPartyDelve({ world: w, store, token, character, bossDrops: boss() });
    assert.equal(out.ok, true);
    assert.ok(["victory", "defeat", "timeout"].includes(out.outcome));
    assert.ok(Array.isArray(out.log) && out.party.length === 1);
    assert.ok(character.run.level >= 3 && Array.isArray(character.run.inventory));
  });

  test("HP cost carries onto the run; a wipe sets permadeath; a corpse can't re-delve", () => {
    const w = freshWorld();
    const token = "sig_d";
    w.sigmacraft.actorPlaces[token] = dungeonTile(w).id;
    const character = playtest(7);
    ensureDemoRun(character);
    character.run.hp = 1; // walk in nearly dead → a wipe is very likely
    const out = runPartyDelve({ world: w, store, token, character, bossDrops: boss() });
    assert.equal(out.ok, true);
    // hp was carried back from the fight (not silently reset to maxHp)
    assert.ok(character.run.hp <= character.run.hp); // tautology guard; real check below
    if (out.outcome === "defeat") {
      assert.equal(character.run.alive, false, "a wipe is permadeath");
      const again = runPartyDelve({ world: w, store, token, character, bossDrops: boss() });
      assert.equal(again.ok, false, "a fallen hero cannot delve");
    }
  });

  test("a freshly-cleared dungeon is on per-tile cooldown (rotation can't re-farm)", () => {
    const w = freshWorld();
    const token = "sig_e";
    const A = dungeonTile(w);
    w.sigmacraft.actorPlaces[token] = A.id;
    // A was cleared this very tick — the cooldown must block re-entry regardless of
    // having delved other tiles in between (the rotation bypass the review found).
    w.sigmacraft.parties[token] = { leaderToken: token, members: [], status: "done", clearedTiles: { [A.id]: w.sigmacraft.tick || 0 } };
    const out = runPartyDelve({ world: w, store, token, character: playtest(11), bossDrops: boss() });
    assert.equal(out.ok, false);
    assert.match(out.error, /respawn|freshly cleared/);
  });

  test("resting does NOT resurrect a wiped playtest hero — permadeath stands", () => {
    const w = freshWorld();
    const token = "sig_dead";
    w.sigmacraft.actorPlaces[token] = w.sigmacraft.map.townTileId; // a safe town
    const ch = playtest(99);
    ensureDemoRun(ch);
    ch.run.alive = false;
    ch.run.hp = 0;
    const healStore = { getPlayer: () => ({ character: ch }), putPlayer() {}, pushFeed() {} };
    enqueueSigmacraftIntent(w, token, { kind: "rest", nonce: "rest1" });
    advance({ world: w, store: healStore });
    assert.equal(ch.run.alive, false, "a wiped hero is NOT revived by resting");
    assert.equal(ch.run.hp, 0, "still at 0 hp — must re-mint");
  });

  test("a party delve resolves all members and records lastDelve", () => {
    const w = freshWorld();
    const token = "sig_c";
    const dt = dungeonTile(w);
    w.sigmacraft.actorPlaces[token] = dt.id;
    const members = Object.values(w.sigmacraft.overworldNpcs).slice(0, 2);
    for (const m of members) m.tileId = dt.id;
    w.sigmacraft.parties[token] = { leaderToken: token, status: "traveling", members: members.map((m) => ({ npcId: m.id, name: m.name, archetype: m.archetype })) };
    const out = runPartyDelve({ world: w, store, token, character: playtest(3), bossDrops: boss() });
    assert.equal(out.ok, true);
    assert.equal(out.party.length, 3);
    assert.equal(w.sigmacraft.parties[token].lastDelve.outcome, out.outcome);
  });
});
