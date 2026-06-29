// SIGMA ABYSS — NPC plan consumption by the world tick (PR7, overworld + batch).
// Run: node --test test/unit/npc-agents-tick.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance } from "../../server/sigmacraft.js";
import { freshWorld } from "../../server/world-tick.js";
import { MAX_NPC_EFFECTS_PER_TICK } from "../../shared/sigmacraft.js";

function feedStore() {
  const feed = [];
  return { pushFeed: (e) => feed.push(e), feed };
}
const npcIds = (w) => Object.keys(w.sigmacraft.overworldNpcs).sort();
function planFor(w, id, step, line = "") {
  w.sigmacraft.npcAgents[id] = {
    plan: { step, currentGoal: "g", dialogueLine: line, source: "fallback", plannedAtTick: 0, consumed: false },
    memory: { goals: [], recentIncidents: [], summaryPointer: "" },
  };
}

describe("advance() consumes overworld NPC plans, bounded", () => {
  test("idle world with no plans/intents does not mutate", () => {
    const w = freshWorld();
    assert.equal(advance({ world: w }), false);
    assert.equal(w.sigmacraft.tick, 0);
  });

  test("a tile-move plan moves the overworld NPC once, then idle", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const from = w.sigmacraft.overworldNpcs[id].tileId;
    const dest = w.sigmacraft.map.tiles[from].exits[0];
    planFor(w, id, { kind: "move", targetId: dest });
    const store = feedStore();
    assert.equal(advance({ world: w, store }), true);
    assert.equal(w.sigmacraft.overworldNpcs[id].tileId, dest, "npc moved to the planned tile");
    assert.equal(w.sigmacraft.npcAgents[id].plan.consumed, true);
    assert.equal(advance({ world: w, store }), false, "no work left → idle");
  });

  test("a talk plan surfaces exactly one npc_dialogue feed entry", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    planFor(w, id, { kind: "talk", targetId: id }, "The omens are uneasy.");
    const store = feedStore();
    advance({ world: w, store });
    const dlg = store.feed.filter((e) => e.kind === "npc_dialogue");
    assert.equal(dlg.length, 1);
    assert.equal(dlg[0].detail, "The omens are uneasy.");
  });

  test("applies at most MAX_NPC_EFFECTS_PER_TICK effects per tick", () => {
    const w = freshWorld();
    const ids = npcIds(w).slice(0, MAX_NPC_EFFECTS_PER_TICK + 8); // 20 plans
    for (const id of ids) planFor(w, id, { kind: "talk", targetId: id }, "hi");
    const store = feedStore();
    advance({ world: w, store });
    const consumed = ids.filter((id) => w.sigmacraft.npcAgents[id].plan.consumed).length;
    assert.equal(consumed, MAX_NPC_EFFECTS_PER_TICK, "exactly the cap consumed in one tick");
    // the rest drain over subsequent ticks
    let ticks = 1;
    while (advance({ world: w, store }) && ticks < 10) ticks += 1;
    assert.equal(ids.every((id) => w.sigmacraft.npcAgents[id].plan.consumed), true);
  });

  test("a move plan to a non-adjacent tile does not mutate but is still consumed", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const from = w.sigmacraft.overworldNpcs[id].tileId;
    const far = Object.keys(w.sigmacraft.map.tiles).find(
      (t) => t !== from && !w.sigmacraft.map.tiles[from].exits.includes(t),
    );
    planFor(w, id, { kind: "move", targetId: far });
    assert.equal(advance({ world: w, store: feedStore() }), true);
    assert.equal(w.sigmacraft.overworldNpcs[id].tileId, from, "no teleport for a non-adjacent tile");
    assert.equal(w.sigmacraft.npcAgents[id].plan.consumed, true, "still consumed (no retry loop)");
  });
});
