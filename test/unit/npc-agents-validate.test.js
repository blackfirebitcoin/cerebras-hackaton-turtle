// SIGMA ABYSS — NPC proposal validation (PR7 trust boundary, overworld ids).
// Run: node --test test/unit/npc-agents-validate.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { vNpcProposal, vNpcProposals, vTileId, vNpcAgentId } from "../../server/validate.js";

const base = (over = {}) => ({
  npcId: "npc_adventurer_000",
  currentGoal: "find trouble",
  dialogueLine: "Trouble on the road? Point me at it.",
  step: { kind: "talk", targetId: "npc_adventurer_000" },
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

describe("vNpcProposal rejects what the model must not assert", () => {
  test("malformed npcId throws; vNpcProposals drops it", () => {
    assert.throws(() => vNpcProposal(base({ npcId: "nobody" })), /bad npc id/);
    assert.deepEqual(vNpcProposals([base({ npcId: "nobody" })]), []);
  });

  test("malformed move tile + bad step kind rejected", () => {
    assert.throws(() => vNpcProposal(base({ step: { kind: "move", targetId: "Bad Tile!" } })), /bad tile id/);
    assert.throws(() => vNpcProposal(base({ step: { kind: "fly", targetId: "npc_adventurer_000" } })), /bad enum/);
  });

  test("a valid tile move passes (existence re-checked later, not here)", () => {
    const clean = vNpcProposal(base({ step: { kind: "move", targetId: "wild_05_05" } }));
    assert.equal(clean.step.kind, "move");
    assert.equal(clean.step.targetId, "wild_05_05");
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
