// SIGMA ABYSS — NPC plan consumption by the world tick (integrate-this PR7).
// Run: node --test test/unit/npc-agents-tick.test.js
// Drives advance() directly with a fabricated world + store stub: ONE bounded
// NPC effect per tick, deterministic, no write-amplification on idle.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance } from "../../server/sigmacraft.js";
import { freshWorld } from "../../server/world-tick.js";
import { NPC_IDS } from "../../shared/npc-defs.js";
import { ZONE_BY_ID, ZONE_IDS } from "../../shared/zones.js";

function feedStore() {
  const feed = [];
  return { pushFeed: (e) => feed.push(e), feed };
}
const otherZone = (zoneId) => ZONE_IDS.find((z) => z !== zoneId && z !== "town") || ZONE_IDS[0];

describe("advance() consumes NPC plans, bounded", () => {
  test("an idle world with no plans and no intents does not mutate", () => {
    const w = freshWorld();
    assert.equal(advance({ world: w }), false);
    assert.equal(w.sigmacraft.tick, 0);
  });

  test("a move plan is applied once, then the world goes idle", () => {
    const w = freshWorld();
    const id = NPC_IDS[0];
    const target = otherZone(w.npcs[id].zoneId);
    w.sigmacraft.npcAgents[id] = {
      plan: { step: { kind: "move", targetId: target }, currentGoal: "go", dialogueLine: "", source: "fallback", plannedAtTick: 0, consumed: false },
      memory: { goals: [], recentIncidents: [], summaryPointer: "" },
    };
    const store = feedStore();
    assert.equal(advance({ world: w, store }), true);
    assert.equal(w.npcs[id].zoneId, target, "npc moved to the planned zone");
    assert.equal(w.sigmacraft.npcAgents[id].plan.consumed, true);
    assert.ok(w.sigmacraft.recentEvents.some((e) => new RegExp(ZONE_BY_ID[target].name).test(e.text)));
    // next tick: nothing left → idle
    assert.equal(advance({ world: w, store }), false);
  });

  test("a talk plan surfaces exactly one npc_dialogue feed entry", () => {
    const w = freshWorld();
    const id = NPC_IDS[0];
    w.sigmacraft.npcAgents[id] = {
      plan: { step: { kind: "talk", targetId: id }, currentGoal: "warn", dialogueLine: "The warrens are restless.", source: "fallback", plannedAtTick: 0, consumed: false },
      memory: { goals: [], recentIncidents: [], summaryPointer: "" },
    };
    const store = feedStore();
    advance({ world: w, store });
    const dlg = store.feed.filter((e) => e.kind === "npc_dialogue");
    assert.equal(dlg.length, 1);
    assert.equal(dlg[0].detail, "The warrens are restless.");
    assert.equal(w.npcs[id].lastDialogueAt, w.sigmacraft.tick);
  });

  test("five plans resolve at exactly one effect per tick", () => {
    const w = freshWorld();
    for (const id of NPC_IDS) {
      w.sigmacraft.npcAgents[id] = {
        plan: { step: { kind: "talk", targetId: id }, currentGoal: "g", dialogueLine: `line ${id}`, source: "fallback", plannedAtTick: 0, consumed: false },
        memory: { goals: [], recentIncidents: [], summaryPointer: "" },
      };
    }
    const store = feedStore();
    let ticks = 0;
    while (advance({ world: w, store }) && ticks < 20) ticks += 1;
    assert.equal(ticks, NPC_IDS.length, "one effect per tick, then idle");
    assert.equal(Object.values(w.sigmacraft.npcAgents).filter((a) => a.plan.consumed).length, NPC_IDS.length);
  });

  test("a move plan with an invalid stored zone does not mutate or throw", () => {
    const w = freshWorld();
    const id = NPC_IDS[0];
    const zoneBefore = w.npcs[id].zoneId;
    w.sigmacraft.npcAgents[id] = {
      plan: { step: { kind: "move", targetId: "narnia" }, currentGoal: "go", dialogueLine: "", source: "fallback", plannedAtTick: 0, consumed: false },
      memory: { goals: [], recentIncidents: [], summaryPointer: "" },
    };
    assert.equal(advance({ world: w, store: feedStore() }), true);
    assert.equal(w.npcs[id].zoneId, zoneBefore, "no mutation for an invalid zone");
    assert.equal(w.sigmacraft.npcAgents[id].plan.consumed, true, "still consumed (no infinite retry)");
  });
});
