// SIGMA ABYSS — PR9: the Sigmacraft Director / game-master lane. The Director
// proposes bounded public beats off-tick (deterministic fallback by default); the
// 3s tick consumes them into the objective + feed. Asserts determinism, the
// validate trust boundary, quest-beat → objective, pacing, and — critically — that
// Director churn is ambient/in-memory only (never a persist signal; idle quiescence).
// Run: node --test test/unit/sigmacraft-director.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance } from "../../server/sigmacraft.js";
import { attachDirector, makeDirectorFallbackProposal } from "../../server/sigmacraft-director.js";
import { vDirectorProposals } from "../../server/validate.js";
import { freshWorld } from "../../server/world-tick.js";
import { DIRECTOR_KINDS, MAX_DIRECTOR_PROPOSALS_PER_CYCLE } from "../../shared/sigmacraft.js";

function trackingStore(world) {
  let puts = 0;
  return {
    getWorldState: () => world,
    putWorldState: () => { puts += 1; },
    pushFeed: () => {},
    puts: () => puts,
  };
}
const feedStore = () => {
  const feed = [];
  return { pushFeed: (e) => feed.push(e), feed };
};

describe("Director fallback proposal (deterministic, bounded)", () => {
  test("is a valid, deterministic director proposal for a given world", () => {
    const w = freshWorld();
    const a = makeDirectorFallbackProposal(w);
    const b = makeDirectorFallbackProposal(w);
    assert.ok(a && DIRECTOR_KINDS.includes(a.kind), "a known director kind");
    assert.deepEqual(a, b, "same world → identical proposal (deterministic)");
    // A default-objective world should open with a quest beat.
    assert.equal(a.kind, "quest_beat");
    assert.ok(a.text.length > 0 && !a.text.includes("{place}"), "place placeholder is filled");
  });

  test("the validate boundary drops malformed proposals and caps the batch", () => {
    const good = { kind: "rumor", text: "a clean rumor" };
    const bad = { kind: "teleport_everyone", text: "no authority here" };
    const out = vDirectorProposals([good, bad]);
    assert.equal(out.length, 1, "the bad-kind proposal was dropped, not the batch");
    assert.equal(out[0].kind, "rumor");
    const huge = Array.from({ length: MAX_DIRECTOR_PROPOSALS_PER_CYCLE + 20 }, () => good);
    assert.equal(vDirectorProposals(huge).length, MAX_DIRECTOR_PROPOSALS_PER_CYCLE, "batch capped");
  });
});

describe("Director loop + tick consume", () => {
  test("propose() queues a validated beat but never raises the persist signal", () => {
    const w = freshWorld();
    const store = trackingStore(w);
    const director = attachDirector({ store, env: {} });

    const proposed = director.propose();
    // propose() is sync here (fallback path) but returns a promise; resolve it.
    return Promise.resolve(proposed).then((ok) => {
      assert.equal(ok, true);
      assert.equal(w.sigmacraft.directorQueue.length, 1, "one beat queued");
      assert.equal(w.sigmacraft.gameMaster.lastBeatKind, w.sigmacraft.directorQueue[0].kind);
      assert.equal(store.puts(), 0, "ambient Director churn is in-memory only (no persist)");
    });
  });

  test("a queued quest_beat updates the public objective on the tick, without dirtying the world", () => {
    const w = freshWorld();
    const before = w.sigmacraft.objective.title;
    w.sigmacraft.directorQueue.push(
      vDirectorProposals([
        {
          kind: "quest_beat",
          questId: "bandit_tithe",
          stageId: "bandit_tithe_stage_1",
          title: "The Bandit Tithe",
          text: "A warband has set a toll on the roads.",
        },
      ])[0],
    );
    const store = feedStore();
    // No player intent → the Director beat must NOT be a persist signal.
    assert.equal(advance({ world: w, store }), false, "director-only tick is not dirty");
    assert.equal(w.sigmacraft.objective.title, "The Bandit Tithe", "objective updated");
    assert.notEqual(w.sigmacraft.objective.title, before);
    assert.equal(w.sigmacraft.directorQueue.length, 0, "beat consumed");
    assert.equal(w.sigmacraft.gameMaster.beats, 1);
    assert.ok(store.feed.some((e) => /Director:/.test(e.detail || "")), "beat surfaced to the feed");
  });

  test("pacing: a second immediate propose() within the cooldown is skipped", async () => {
    const w = freshWorld();
    const store = trackingStore(w);
    const director = attachDirector({ store, env: {} });
    assert.equal(await director.propose(), true, "first beat queued");
    assert.equal(await director.propose(), false, "second beat skipped (cooldown + queued beat)");
    assert.equal(w.sigmacraft.directorQueue.length, 1, "still just one beat");
  });
});
