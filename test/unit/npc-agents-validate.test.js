// SIGMA ABYSS — NPC proposal validation (PR-C trust boundary, agenda model).
// Run: node --test test/unit/npc-agents-validate.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { vNpcAgenda, vNpcProposal, vNpcProposals, vTileId, vNpcAgentId } from "../../server/validate.js";

const base = (over = {}) => ({
  npcId: "npc_adventurer_000",
  currentGoal: "find trouble",
  dialogueLine: "Trouble on the road? Point me at it.",
  agenda: [
    { kind: "gather", targetTileId: "wild_05_05" },
    { kind: "rest", targetTileId: "millbridge" },
  ],
  memoryPatch: { goals: [{ text: "g" }], recentIncidents: [], summaryPointer: "x" },
  source: "fallback",
  ...over,
});

describe("vTileId / vNpcAgentId shape validators", () => {
  test("accept generated ids, reject junk + control chars", () => {
    assert.equal(vTileId("millbridge"), "millbridge");
    assert.equal(vTileId("wild_03_07"), "wild_03_07");
    assert.throws(() => vTileId("Bad Tile!"), /bad tile id/);
    assert.throws(() => vTileId("Town"), /bad tile id/); // uppercase rejected
    assert.equal(vNpcAgentId("npc_adventurer_044"), "npc_adventurer_044");
    assert.throws(() => vNpcAgentId("npc_bogus"), /bad npc id/);
    assert.throws(() => vNpcAgentId("zzz_000"), /bad npc id/);
  });
});

describe("vNpcAgenda — the strategic plan boundary", () => {
  test("accepts known action kinds with optional target tiles", () => {
    const a = vNpcAgenda([
      { kind: "fight", targetTileId: "wild_10_00" },
      { kind: "rest" },
      { kind: "craft", targetTileId: "millbridge" },
    ]);
    assert.equal(a.length, 3);
    assert.equal(a[0].kind, "fight");
    assert.equal(a[0].targetTileId, "wild_10_00");
    assert.equal(a[1].targetTileId, undefined); // optional
  });

  test("DROPS objectives with a bad kind or a malformed target (vArr, not reject-batch)", () => {
    const a = vNpcAgenda([
      { kind: "gather", targetTileId: "wild_05_05" }, // good
      { kind: "teleport", targetTileId: "wild_05_05" }, // bad kind → dropped
      { kind: "move", targetTileId: "Bad Tile!" }, // bad tile → dropped
      { kind: "rest" }, // good
    ]);
    assert.equal(a.length, 2, "only the two valid objectives survive");
    assert.deepEqual(a.map((o) => o.kind), ["gather", "rest"]);
  });

  test("caps the agenda length", () => {
    const a = vNpcAgenda(Array.from({ length: 20 }, () => ({ kind: "rest" })));
    assert.ok(a.length <= 5, `agenda capped (got ${a.length})`);
  });
});

describe("vNpcProposal rejects what the model must not assert", () => {
  test("malformed npcId throws; vNpcProposals drops it", () => {
    assert.throws(() => vNpcProposal(base({ npcId: "nobody" })), /bad npc id/);
    assert.deepEqual(vNpcProposals([base({ npcId: "nobody" })]), []);
  });

  test("a valid agenda passes (tile existence re-checked on the tick, not here)", () => {
    const clean = vNpcProposal(base({ agenda: [{ kind: "move", targetTileId: "wild_05_05" }] }));
    assert.equal(clean.agenda[0].kind, "move");
    assert.equal(clean.agenda[0].targetTileId, "wild_05_05");
  });

  test("a 200-proposal batch is not truncated", () => {
    const batch = Array.from({ length: 200 }, (_, i) => base({ npcId: `npc_adventurer_${String(i % 1000).padStart(3, "0")}` }));
    assert.equal(vNpcProposals(batch).length, 200);
  });
});

describe("vNpcProposal bounds + scrubs", () => {
  test("dialogueLine capped to 140, currentGoal to 96", () => {
    const clean = vNpcProposal(base({ dialogueLine: "z".repeat(300), currentGoal: "g".repeat(300) }));
    assert.equal(clean.dialogueLine.length, 140);
    assert.equal(clean.currentGoal.length, 96);
  });

  test("memory goals/incidents are capped", () => {
    const clean = vNpcProposal(
      base({
        memoryPatch: {
          goals: Array.from({ length: 9 }, (_, i) => ({ text: `g${i}` })),
          recentIncidents: Array.from({ length: 30 }, (_, i) => ({ summary: `i${i}`, tick: i })),
          summaryPointer: "p",
        },
      }),
    );
    assert.ok(clean.memoryPatch.goals.length <= 2);
    assert.ok(clean.memoryPatch.recentIncidents.length <= 8);
  });

  test("zero-width + control chars are scrubbed from the line", () => {
    const zwsp = String.fromCharCode(0x200b);
    const ctrl = String.fromCharCode(0x07);
    const clean = vNpcProposal(base({ dialogueLine: `hi${zwsp}${ctrl}there` }));
    assert.equal(clean.dialogueLine, "hithere");
  });
});
