// SIGMA ABYSS — feed/players write-quiescence (PR-C audit follow-up). Drives the
// REAL server/store.js against a temp MMO_DATA_DIR (not a stubbed pushFeed), so it
// actually exercises the disk path the unit quiescence test is blind to: ambient
// NPC narration must NOT rewrite players.json/feed.json on a player-less server,
// while a genuine (persist) feed event still does.
// Run: node --test test/integration/sigmacraft-feed-quiescence.test.js

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const DIR = mkdtempSync(join(tmpdir(), "sc-feedq-"));
process.env.MMO_DATA_DIR = DIR; // store caches DATA_DIR at module load → set before import

import { advance } from "../../server/sigmacraft.js";
import { attachNpcPlanner } from "../../server/sigmacraft-npc-agents.js";
import { freshWorld } from "../../server/world-tick.js";

let store;
const mtime = (f) => (existsSync(join(DIR, f)) ? statSync(join(DIR, f)).mtimeMs : null);

before(async () => {
  store = await import("../../server/store.js");
  store.initStore?.();
  store.initWorldState(() => freshWorld());
});
after(() => rmSync(DIR, { recursive: true, force: true }));

describe("ambient NPC churn does not write players.json / feed.json", () => {
  test("many NPC-only planner+tick cycles leave both files untouched, then a real feed event persists", async () => {
    const planner = attachNpcPlanner({ store, env: {} });

    // Settle any initial writes.
    await planner.plan();
    for (let t = 0; t < 6; t++) advance({ world: store.getWorldState(), store });
    store.flush();
    const players0 = mtime("players.json");
    const feed0 = mtime("feed.json");

    // Drive several more ambient cycles — none may dirty the store.
    for (let c = 0; c < 4; c++) {
      await planner.plan();
      for (let t = 0; t < 6; t++) {
        assert.equal(advance({ world: store.getWorldState(), store }), false, "an NPC-only tick must not be dirty");
      }
      store.flush();
    }
    assert.equal(mtime("players.json"), players0, "players.json NOT rewritten by ambient NPC churn");
    assert.equal(mtime("feed.json"), feed0, "feed.json NOT rewritten by ambient NPC churn");

    // A genuine (persist) feed event MUST still reach disk — the ephemeral path
    // must not have broken normal persistence.
    store.pushFeed({ kind: "narrative", name: "Test", detail: "a real, persisted event" });
    store.flush();
    assert.notEqual(mtime("feed.json"), feed0, "a persist:true feed event still writes feed.json");
  });
});
