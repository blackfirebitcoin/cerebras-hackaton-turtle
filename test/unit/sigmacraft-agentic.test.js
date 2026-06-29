// SIGMA ABYSS — PR-C: two-layer agentic NPC planning. Covers the PURE cascade
// primitives (tileSupportsAction / nextHopToward / deriveNextStep) and the full
// strategic→tactical integration (planner agenda → tick walks it to completion).
// Run: node --test test/unit/sigmacraft-agentic.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  deriveNextStep,
  generateOverworld,
  nextHopToward,
  tileSupportsAction,
} from "../../shared/sigmacraft.js";
import { advance } from "../../server/sigmacraft.js";
import { attachNpcPlanner } from "../../server/sigmacraft-npc-agents.js";
import { freshWorld } from "../../server/world-tick.js";

const MAP = generateOverworld("agentic-seed");
const TILES = MAP.tiles;
const typeTile = (t) => Object.values(TILES).find((x) => x.type === t);

describe("tileSupportsAction — the grounding preconditions", () => {
  test("each action is gated to the right tile types", () => {
    const wilds = typeTile("wilds");
    const town = typeTile("town");
    const dungeon = typeTile("dungeon");
    assert.equal(tileSupportsAction(wilds, "gather"), true);
    assert.equal(tileSupportsAction(town, "gather"), false);
    assert.equal(tileSupportsAction(town, "rest"), true);
    assert.equal(tileSupportsAction(town, "craft"), true);
    assert.equal(tileSupportsAction(dungeon, "fight"), true);
    assert.equal(tileSupportsAction(town, "fight"), false); // safe town, no fight
    assert.equal(tileSupportsAction(town, "talk"), true); // talk always ok
    assert.equal(tileSupportsAction(null, "rest"), false);
  });
});

describe("nextHopToward — deterministic BFS pathing", () => {
  test("returns an ADJACENT hop that strictly progresses toward the target", () => {
    const start = MAP.townTileId;
    const far = Object.keys(TILES).find((t) => t !== start && !TILES[start].exits.includes(t));
    const hop = nextHopToward(start, far, TILES);
    assert.notEqual(hop, start, "moved off the start");
    assert.ok(TILES[start].exits.includes(hop), "the hop is a real neighbour");
    assert.equal(nextHopToward(start, start, TILES), start, "already-there is a no-op");
  });

  test("repeated hops actually reach the target (and it's deterministic)", () => {
    const start = MAP.townTileId;
    const target = Object.keys(TILES).find((t) => t !== start);
    let cur = start;
    let steps = 0;
    while (cur !== target && steps < 200) {
      const next = nextHopToward(cur, target, TILES);
      assert.equal(next, nextHopToward(cur, target, TILES), "deterministic");
      if (next === cur) break;
      cur = next;
      steps += 1;
    }
    assert.equal(cur, target, "reached the target by following hops");
  });
});

describe("deriveNextStep — the cascade", () => {
  test("walks to the objective tile, then performs the action, then completes", () => {
    const gatherTile = Object.values(TILES).find((t) => tileSupportsAction(t, "gather"));
    const start = MAP.townTileId;
    const agenda = [{ kind: "gather", targetTileId: gatherTile.id }];
    // Phase 1: still away → a move hop, NOT complete.
    const s1 = deriveNextStep({ tileId: start }, agenda, 0, TILES);
    assert.equal(s1.kind, "move");
    assert.equal(s1.objectiveComplete, false);
    // Phase 2: standing on the target → perform gather, objective complete.
    const s2 = deriveNextStep({ tileId: gatherTile.id }, agenda, 0, TILES);
    assert.equal(s2.kind, "gather");
    assert.equal(s2.objectiveComplete, true);
  });

  test("an unsupported terminal action at the tile degrades to talk (never fails)", () => {
    const town = typeTile("town");
    const s = deriveNextStep({ tileId: town.id }, [{ kind: "gather", targetTileId: town.id }], 0, TILES);
    assert.equal(s.kind, "talk"); // town can't gather → talk
    assert.equal(s.objectiveComplete, true);
  });

  test("a finished agenda yields a completing no-op", () => {
    const s = deriveNextStep({ tileId: MAP.townTileId }, [{ kind: "rest" }], 5, TILES);
    assert.equal(s.kind, "noop");
    assert.equal(s.objectiveComplete, true);
  });
});

describe("integration — strategic agenda cascades to completion on the tick", () => {
  test("an NPC walks its whole planner-issued agenda and mutates real state", async () => {
    const w = freshWorld();
    const store = { getWorldState: () => w, putWorldState() {}, pushFeed() {} };
    await attachNpcPlanner({ store, env: { SIGMACRAFT_NPC_MAX_PER_CYCLE: "5" } }).plan();

    const [id, agent] = Object.entries(w.sigmacraft.npcAgents).find(([, a]) => a?.plan?.agenda?.length);
    const len = agent.plan.agenda.length;
    const rec = w.sigmacraft.overworldNpcs[id];
    const startTile = rec.tileId;

    // Walk many ticks; the agenda should complete (cursor reaches the end). None of
    // these NPC-only ticks may raise the persist signal (ambient/quiescent).
    let everDirty = false;
    for (let t = 0; t < 60 && (agent.plan.cursor || 0) < len; t++) {
      everDirty = advance({ world: w, store }) || everDirty;
    }
    assert.equal(agent.plan.cursor, len, "the NPC completed its full agenda");
    assert.equal(everDirty, false, "ambient agenda execution never persists (quiescence)");
    // It actually went somewhere or did something (real state touched).
    const moved = rec.tileId !== startTile;
    const acted = (rec.supplies || 0) > 0 || rec.moodValue !== 50;
    assert.ok(moved || acted, "the NPC relocated and/or changed supplies/mood");
  });
});
