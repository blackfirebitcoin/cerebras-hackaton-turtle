// SIGMA ABYSS — PR8: the read-only Sigmacraft overworld snapshot CLI tool.
// Seeds a temp world.json from freshWorld() and drives tools/sigmacraft-snapshot.js
// as a real subprocess, asserting the ported overworld views. Pure read — the tool
// must never write the file back.
// Run: node --test test/tools/sigmacraft-snapshot.test.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";

import { freshWorld } from "../../server/world-tick.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "tools", "sigmacraft-snapshot.js");

let dataDir = "";
let worldFile = "";
let firstNpcId = "";

function run(args) {
  return execFileSync("node", [TOOL, ...args, "--data-dir", dataDir], { encoding: "utf8" });
}

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sc-snap-"));
  worldFile = join(dataDir, "world.json");
  const w = freshWorld();
  writeFileSync(worldFile, JSON.stringify(w));
  firstNpcId = Object.keys(w.sigmacraft.overworldNpcs).sort()[0];
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

describe("tools/sigmacraft-snapshot.js — overworld read tool", () => {
  test("`world --json` reports the 140-tile map + 200 NPCs + 7 tile types", () => {
    const j = JSON.parse(run(["world", "--json"]));
    assert.equal(j.map.tileCount, 140);
    assert.equal(j.map.townTileId, "millbridge");
    assert.equal(j.population.totalNpcs, 200);
    assert.equal(Object.keys(j.map.typeCounts).length, 7);
    assert.ok(Array.isArray(j.recentEvents));
    assert.ok(j.planner && typeof j.planner.tracked === "number");
  });

  test("`map --json` carries the full tile graph with exits", () => {
    const j = JSON.parse(run(["map", "--json"]));
    assert.equal(j.tileCount, 140);
    assert.equal(j.tiles.length, 140);
    const town = j.tiles.find((t) => t.id === "millbridge");
    assert.ok(town && Array.isArray(town.exits) && town.exits.length > 0);
  });

  test("`map --tile millbridge` shows one tile in full with named exits", () => {
    const j = JSON.parse(run(["map", "--tile", "millbridge"]));
    assert.equal(j.id, "millbridge");
    assert.equal(j.type, "town");
    assert.ok(j.exits.every((e) => typeof e.id === "string" && typeof e.name === "string"));
  });

  test("`npc <id>` returns identity + (absent) plan for a seeded NPC", () => {
    const j = JSON.parse(run(["npc", firstNpcId]));
    assert.equal(j.id, firstNpcId);
    assert.ok(typeof j.name === "string" && j.name.length > 0);
    assert.ok(typeof j.archetype === "string");
    assert.ok("plan" in j); // null until the planner runs — the field must exist
  });

  test("`snapshot` (no token) projects the town tile via the shared projection", () => {
    const j = JSON.parse(run(["snapshot"]));
    assert.equal(j.schema, "sigmacraft.snapshot.v2");
    assert.equal(j.place.id, "millbridge");
    assert.ok(j.worldMap && Array.isArray(j.validActions));
  });

  test("the tool is pure-read — world.json is byte-identical after running", () => {
    const before = readFileSync(worldFile, "utf8");
    const mtimeBefore = statSync(worldFile).mtimeMs;
    run(["world"]);
    run(["map"]);
    run(["snapshot"]);
    assert.equal(readFileSync(worldFile, "utf8"), before, "file contents unchanged");
    assert.equal(statSync(worldFile).mtimeMs, mtimeBefore, "file not rewritten");
  });
});
