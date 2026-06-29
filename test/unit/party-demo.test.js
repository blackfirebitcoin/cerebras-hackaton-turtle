// SIGMA ABYSS — automated party finding vertical slice.
// Run: node --test test/unit/party-demo.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createBossDropForge } from "../../server/cerebras-boss-drops.js";
import { commitPartyDemo, runPartyDemo } from "../../server/party-demo.js";
import { DEMO_PARTY_DEADLINE_MS } from "../../server/sigmacraft-demo-throughput.js";
import { PARTY_MAX_MEMBERS } from "../../shared/sigmacraft.js";
import { freshCharacter } from "../../shared/progression.js";
import { freshWorld } from "../../server/world-tick.js";

const store = () => ({ feed: [], pushFeed(e) { this.feed.push(e); } });
const playtest = (seed) => {
  const c = freshCharacter(seed, "Playtester");
  c.isPlaytest = true;
  return c;
};

describe("runPartyDemo", () => {
  test("stages tavern party finding, then commits travel and wave combat through the boss", () => {
    const w = freshWorld();
    const token = "sig_demo_party";
    const s = store();
    const character = playtest(101);

    const out = runPartyDemo({
      world: w,
      store: s,
      token,
      character,
      bossDrops: createBossDropForge({ env: {} }),
    });

    assert.equal(out.ok, true);
    assert.equal(out.startTile.id, w.sigmacraft.map.townTileId);
    assert.equal(out.targetTile.type, "dungeon");
    assert.equal(out.outcome, "victory");
    assert.equal(out.bossDead, true);
    assert.ok(out.waves.length >= 2, "combat is split into waves");
    assert.equal(out.waves.at(-1).boss, true, "final wave contains the boss");
    assert.ok(out.waves.every((w) => w.startParty?.length && w.startEnemies?.length), "waves include start-state HP for playback");
    assert.ok(out.waves.every((w) => w.party.every((p) => Number.isFinite(p.maxHp) && p.maxHp > 0)), "party HP max is projected");
    assert.ok(out.waves.every((w) => w.enemies.every((e) => Number.isFinite(e.maxHp) && e.maxHp > 0)), "enemy HP max is projected");
    assert.equal(out.joinDecisions.filter((d) => d.accepted).length >= PARTY_MAX_MEMBERS, true);
    assert.equal(out.joinDecisions.filter((d) => d.accepted).every((d) => d.dialogue && Number.isFinite(d.joinAtMs)), true);
    assert.equal(out.plannerDemo.profile, "cerebras");
    assert.equal(out.plannerDemo.partyFinderStalls, false);
    assert.equal(
      out.joinDecisions.filter((d) => d.accepted).slice(0, PARTY_MAX_MEMBERS).every((d) => d.joinAtMs <= DEMO_PARTY_DEADLINE_MS),
      true,
    );
    assert.equal(w.sigmacraft.parties[token].members.length, PARTY_MAX_MEMBERS);
    assert.equal(w.sigmacraft.actorPlaces[token], w.sigmacraft.map.townTileId, "start stays in town");
    for (const member of w.sigmacraft.parties[token].members) {
      const npc = w.sigmacraft.overworldNpcs[member.npcId];
      assert.equal(npc.partyLock, token);
      assert.equal(npc.tileId, w.sigmacraft.map.townTileId, "member waits in town before travel commit");
    }
    assert.equal(w.sigmacraft.parties[token].lastDelve, null, "no final result before commit");
    assert.equal(s.feed.length, 0, "start does not publish final feed item");

    const committed = commitPartyDemo({ world: w, store: s, token, character, runId: out.runId });
    assert.equal(committed.ok, true);
    assert.equal(committed.status, "committed");
    assert.equal(w.sigmacraft.actorPlaces[token], out.targetTile.id);
    for (const member of w.sigmacraft.parties[token].members) {
      const npc = w.sigmacraft.overworldNpcs[member.npcId];
      assert.equal(npc.tileId, out.targetTile.id);
    }
    assert.equal(w.sigmacraft.parties[token].lastDelve.bossDead, true);
    assert.ok(Array.isArray(character.run.inventory), "leader keeps a bounded inventory");
    assert.equal(s.feed.length, 1, "commit emits one public feed item");
  });

  test("refuses to fabricate progression for non-playtest accounts", () => {
    const w = freshWorld();
    const real = freshCharacter(202, "Real");
    const out = runPartyDemo({ world: w, store: store(), token: "real_token", character: real, bossDrops: null });
    assert.equal(out.ok, false);
    assert.match(out.error, /playtest-only/);
    assert.equal(w.sigmacraft.parties.real_token, undefined);
  });

  test("slow planner profile makes the party finder miss the 30s demo deadline", () => {
    const w = freshWorld();
    w.sigmacraft.demoThroughput = { profile: "slow50", setAt: Date.now() };
    const out = runPartyDemo({
      world: w,
      store: store(),
      token: "sig_demo_slow",
      character: playtest(303),
      bossDrops: null,
    });

    assert.equal(out.ok, true);
    assert.equal(out.plannerDemo.profile, "slow50");
    assert.equal(out.plannerDemo.partyFinderStalls, true);
    const accepted = out.joinDecisions.filter((d) => d.accepted).slice(0, PARTY_MAX_MEMBERS);
    assert.equal(accepted.length, PARTY_MAX_MEMBERS);
    assert.ok(accepted.some((d) => d.joinAtMs > DEMO_PARTY_DEADLINE_MS), "at least one needed NPC answers too late");
    assert.ok(accepted.filter((d) => d.joinAtMs <= DEMO_PARTY_DEADLINE_MS).length < PARTY_MAX_MEMBERS);
  });
});
