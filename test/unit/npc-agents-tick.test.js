// SIGMA ABYSS — NPC agenda cascade on the world tick (PR-C, two-layer planning).
// advance() walks each NPC's strategic agenda one tactical primitive per tick:
// move toward the objective tile, then perform the action on arrival, advancing the
// cursor. Effects mutate REAL npc state (tileId/supplies/moodValue) IN-MEMORY but
// never raise the persist signal (idle quiescence). Only player intents return true.
// Run: node --test test/unit/npc-agents-tick.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { advance } from "../../server/sigmacraft.js";
import { freshWorld } from "../../server/world-tick.js";
import { MAX_NPC_EFFECTS_PER_TICK, NPC_SUPPLY_CAP } from "../../shared/sigmacraft.js";

function feedStore() {
  const feed = [];
  return { pushFeed: (e) => feed.push(e), feed };
}
const npcIds = (w) => Object.keys(w.sigmacraft.overworldNpcs).sort();
// Install a single-objective agenda whose target is the NPC's CURRENT tile, so the
// terminal action fires on the first tick (no travel needed) — keeps tests crisp.
function agendaHere(w, id, kind) {
  const rec = w.sigmacraft.overworldNpcs[id];
  w.sigmacraft.npcAgents[id] = {
    plan: { goal: "g", agenda: [{ kind, targetTileId: rec.tileId }], cursor: 0, dialogueLine: "hi", source: "fallback", plannedAtTick: 0 },
    memory: { goals: [], recentIncidents: [], summaryPointer: "" },
  };
  return rec;
}
// Pick a tile of a given type (so action preconditions are satisfiable).
const tileOfType = (w, type) => Object.values(w.sigmacraft.map.tiles).find((t) => t.type === type);

describe("advance() cascades NPC agendas, bounded + ambient", () => {
  test("idle world with no agenda/intents does not mutate", () => {
    const w = freshWorld();
    assert.equal(advance({ world: w }), false);
    assert.equal(w.sigmacraft.tick, 0);
  });

  test("a gather objective at a supporting tile bumps supplies (in-memory) but is NOT dirty", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const wilds = tileOfType(w, "wilds");
    const rec = w.sigmacraft.overworldNpcs[id];
    rec.tileId = wilds.id; // stand on a gather-supporting tile
    agendaHere(w, id, "gather");
    const store = feedStore();
    assert.equal(advance({ world: w, store }), false, "npc-only tick is not dirty");
    assert.equal(rec.supplies, 1, "gathered one supply");
    assert.equal(w.sigmacraft.npcAgents[id].plan.cursor, 1, "objective complete → cursor advanced");
  });

  test("a rest objective at a safe tile raises mood and completes the agenda", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const rec = w.sigmacraft.overworldNpcs[id];
    rec.tileId = w.sigmacraft.map.townTileId; // town = safe, rest-supporting
    rec.moodValue = 50;
    agendaHere(w, id, "rest");
    advance({ world: w, store: feedStore() });
    assert.ok(rec.moodValue > 50, "mood recovered");
    assert.equal(advance({ world: w, store: feedStore() }), false, "agenda done → idle");
  });

  test("a craft objective consumes a supply when available", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const rec = w.sigmacraft.overworldNpcs[id];
    rec.tileId = w.sigmacraft.map.townTileId; // craft-supporting
    rec.supplies = 2;
    agendaHere(w, id, "craft");
    advance({ world: w, store: feedStore() });
    assert.equal(rec.supplies, 1, "one supply consumed by crafting");
  });

  test("a talk objective surfaces exactly one npc_dialogue feed entry", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    agendaHere(w, id, "talk");
    const store = feedStore();
    advance({ world: w, store });
    const dlg = store.feed.filter((e) => e.kind === "npc_dialogue");
    assert.equal(dlg.length, 1);
  });

  test("the NPC walks toward a distant objective one adjacent hop per tick (no teleport)", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const rec = w.sigmacraft.overworldNpcs[id];
    const start = rec.tileId;
    // target a far tile; first tick must be an ADJACENT hop, not the target itself
    const far = Object.keys(w.sigmacraft.map.tiles).find(
      (t) => t !== start && !w.sigmacraft.map.tiles[start].exits.includes(t),
    );
    w.sigmacraft.npcAgents[id] = {
      plan: { goal: "g", agenda: [{ kind: "move", targetTileId: far }], cursor: 0, dialogueLine: "", source: "fallback", plannedAtTick: 0 },
      memory: { goals: [], recentIncidents: [], summaryPointer: "" },
    };
    advance({ world: w, store: feedStore() });
    assert.notEqual(rec.tileId, far, "did not teleport to the far tile");
    assert.ok(w.sigmacraft.map.tiles[start].exits.includes(rec.tileId), "moved to an adjacent tile toward the target");
  });

  test("applies at most MAX_NPC_EFFECTS_PER_TICK effects per tick", () => {
    const w = freshWorld();
    const ids = npcIds(w).slice(0, MAX_NPC_EFFECTS_PER_TICK + 8); // 20 agendas
    for (const id of ids) agendaHere(w, id, "talk");
    const store = feedStore();
    advance({ world: w, store });
    const advanced = ids.filter((id) => (w.sigmacraft.npcAgents[id].plan.cursor || 0) > 0).length;
    assert.equal(advanced, MAX_NPC_EFFECTS_PER_TICK, "exactly the cap advanced in one tick");
  });

  test("supplies never exceed the cap across repeated gathers", () => {
    const w = freshWorld();
    const id = npcIds(w)[0];
    const wilds = tileOfType(w, "wilds");
    const rec = w.sigmacraft.overworldNpcs[id];
    rec.tileId = wilds.id;
    for (let i = 0; i < NPC_SUPPLY_CAP + 3; i++) {
      agendaHere(w, id, "gather"); // fresh single-gather agenda each round
      advance({ world: w, store: feedStore() });
    }
    assert.equal(rec.supplies, NPC_SUPPLY_CAP, "supplies clamped at the cap");
  });
});
