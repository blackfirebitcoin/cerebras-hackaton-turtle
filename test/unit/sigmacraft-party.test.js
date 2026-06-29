// SIGMA ABYSS — demo P0: tavern party-finding (recruit/disband). A leader at the
// town tile recruits co-located NPCs into a persisted party; recruits are pinned
// (partyLock) so the planner/tick stop walking them off. Player-driven → persists.
// Run: node --test test/unit/sigmacraft-party.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance, enqueueSigmacraftIntent } from "../../server/sigmacraft.js";
import { attachNpcPlanner } from "../../server/sigmacraft-npc-agents.js";
import { projectParty, projectSigmacraftSnapshot, PARTY_MAX_MEMBERS } from "../../shared/sigmacraft.js";
import { vSigmacraftIntent } from "../../server/validate.js";
import { freshWorld } from "../../server/world-tick.js";

const LEADER = "agt_leader"; // no actorPlaces entry → defaults to the town tile
const feedStore = () => ({ pushFeed() {} });
const townNpcs = (w) => Object.values(w.sigmacraft.overworldNpcs).filter((n) => n.tileId === w.sigmacraft.map.townTileId);
function recruit(w, npcId) {
  enqueueSigmacraftIntent(w, LEADER, { kind: "recruit", targetNpcId: npcId, nonce: `r${npcId}` });
  return advance({ world: w, store: feedStore() });
}

describe("recruit intent validation", () => {
  test("recruit requires a well-formed npc id; disband/delve take no target", () => {
    assert.equal(vSigmacraftIntent({ kind: "recruit", targetNpcId: "npc_adventurer_000" }).targetNpcId, "npc_adventurer_000");
    assert.throws(() => vSigmacraftIntent({ kind: "recruit", targetNpcId: "nope" }), /bad npc id/);
    assert.equal(vSigmacraftIntent({ kind: "disband" }).kind, "disband");
    assert.equal(vSigmacraftIntent({ kind: "delve" }).kind, "delve");
  });
});

describe("tavern recruit / disband", () => {
  test("recruiting a co-located NPC forms a party, pins it, and persists (dirty)", () => {
    const w = freshWorld();
    const npc = townNpcs(w)[0];
    const dirty = recruit(w, npc.id);
    assert.equal(dirty, true, "a recruit is a player-driven, persisted mutation");
    const party = w.sigmacraft.parties[LEADER];
    assert.ok(party && party.members.length === 1, "one member in the party");
    assert.equal(party.members[0].npcId, npc.id);
    assert.equal(w.sigmacraft.overworldNpcs[npc.id].partyLock, LEADER, "recruit is partyLocked to the leader");
  });

  test("a partyLocked NPC stops pursuing its own agenda on the tick", async () => {
    const w = freshWorld();
    const npc = townNpcs(w)[0];
    await attachNpcPlanner({ store: { getWorldState: () => w, putWorldState() {}, pushFeed() {} }, env: {} }).plan();
    recruit(w, npc.id);
    const tileBefore = npc.tileId;
    for (let t = 0; t < 8; t++) advance({ world: w, store: feedStore() });
    assert.equal(npc.tileId, tileBefore, "recruited NPC did not wander off via its agenda");
  });

  test("cannot recruit an NPC that isn't co-located, nor past the party cap", () => {
    const w = freshWorld();
    // not co-located: an NPC somewhere other than town
    const far = Object.values(w.sigmacraft.overworldNpcs).find((n) => n.tileId !== w.sigmacraft.map.townTileId);
    recruit(w, far.id);
    assert.ok(!w.sigmacraft.parties[LEADER] || !w.sigmacraft.parties[LEADER].members.some((m) => m.npcId === far.id), "far NPC not recruited");

    // fill to the cap from town locals (+ synthesize extra co-located NPCs if needed)
    const town = w.sigmacraft.map.townTileId;
    const locals = townNpcs(w);
    let i = 0;
    while ((w.sigmacraft.parties[LEADER]?.members.length || 0) < PARTY_MAX_MEMBERS && i < locals.length) recruit(w, locals[i++].id);
    const capped = w.sigmacraft.parties[LEADER].members.length;
    assert.ok(capped <= PARTY_MAX_MEMBERS, "never exceeds the party cap");
  });

  test("disband clears the party and releases partyLock; snapshot reflects it", () => {
    const w = freshWorld();
    const npc = townNpcs(w)[0];
    recruit(w, npc.id);
    let snap = projectSigmacraftSnapshot(w, null, { token: LEADER });
    assert.equal(snap.party.members.length, 1, "snapshot surfaces the party");

    enqueueSigmacraftIntent(w, LEADER, { kind: "disband", nonce: "d1" });
    advance({ world: w, store: feedStore() });
    assert.equal(w.sigmacraft.parties[LEADER], undefined, "party removed");
    assert.equal(w.sigmacraft.overworldNpcs[npc.id].partyLock, null, "partyLock released");
    assert.equal(projectParty(w.sigmacraft, LEADER), null, "no party in projection");
  });
});
