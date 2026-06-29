// SIGMA ABYSS — NPC proposal validation (integrate-this PR7 trust boundary).
// Run: node --test test/unit/npc-agents-validate.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { vNpcProposal, vNpcProposals } from "../../server/validate.js";
import { NPC_IDS } from "../../shared/npc-defs.js";
import { ZONE_IDS } from "../../shared/zones.js";

const realNpc = NPC_IDS[0];
const realZone = ZONE_IDS.find((z) => z !== "town") || ZONE_IDS[0];
const base = (over = {}) => ({
  npcId: realNpc,
  currentGoal: "tend the warrens",
  dialogueLine: "State your business, delver.",
  step: { kind: "talk", targetId: realNpc },
  memoryPatch: { goals: [{ text: "g" }], recentIncidents: [], summaryPointer: "x" },
  source: "fallback",
  ...over,
});

describe("vNpcProposal rejects what the model must not assert", () => {
  test("unknown npcId throws; vNpcProposals drops it from the batch", () => {
    assert.throws(() => vNpcProposal(base({ npcId: "nobody" })), /bad enum/);
    assert.deepEqual(vNpcProposals([base({ npcId: "nobody" })]), []);
  });

  test("unknown move zone and bad step kind are rejected", () => {
    assert.throws(() => vNpcProposal(base({ step: { kind: "move", targetId: "narnia" } })), /bad enum/);
    assert.throws(() => vNpcProposal(base({ step: { kind: "fly", targetId: realNpc } })), /bad enum/);
  });

  test("a valid move proposal passes", () => {
    const clean = vNpcProposal(base({ step: { kind: "move", targetId: realZone } }));
    assert.equal(clean.step.kind, "move");
    assert.equal(clean.step.targetId, realZone);
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
    assert.equal(clean.dialogueLine, "hithere", "zero-width + control chars removed");
  });
});
