// SIGMA ABYSS — Sigmacraft overworld generator (deterministic, 140 tiles, 200 npcs).
// Run: node --test test/unit/sigmacraft-gen.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  generateOverworld,
  generatePopulation,
  seedSigmacraftOverworld,
  createSigmacraftState,
  NPC_POPULATION_TARGET,
} from "../../shared/sigmacraft.js";

describe("generateOverworld", () => {
  const a = generateOverworld("sigmacraft_alpha");
  const b = generateOverworld("sigmacraft_alpha");

  test("is byte-identical across runs (golden determinism)", () => {
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("produces 100+ tiles with a town anchor", () => {
    assert.ok(Object.keys(a.tiles).length >= 100);
    assert.equal(a.tiles[a.townTileId].type, "town");
  });

  test("every one of the 7 display types is present", () => {
    const types = new Set(Object.values(a.tiles).map((t) => t.type));
    for (const t of ["town", "city", "dungeon", "wilds", "road", "shrine", "ruins"]) {
      assert.ok(types.has(t), `type ${t} present`);
    }
  });

  test("every tile exit is reciprocal and in-bounds", () => {
    for (const tile of Object.values(a.tiles)) {
      for (const exitId of tile.exits) {
        const neighbor = a.tiles[exitId];
        assert.ok(neighbor, `exit ${exitId} exists`);
        assert.ok(neighbor.exits.includes(tile.id), "exit is reciprocal");
      }
    }
  });
});

describe("generatePopulation", () => {
  const tiles = generateOverworld("sigmacraft_alpha").tiles;
  const pop = generatePopulation("sigmacraft_alpha", tiles);

  test("is byte-identical across runs", () => {
    assert.equal(JSON.stringify(pop), JSON.stringify(generatePopulation("sigmacraft_alpha", tiles)));
  });

  test("has exactly 200 agents with well-formed ids on real tiles", () => {
    const ids = Object.keys(pop);
    assert.equal(ids.length, NPC_POPULATION_TARGET);
    for (const id of ids) {
      assert.match(id, /^npc_[a-z]+_\d{3}$/);
      assert.ok(tiles[pop[id].tileId], "agent stands on a real tile");
    }
  });
});

describe("seedSigmacraftOverworld", () => {
  test("idempotently seeds map + population, and re-seed is a no-op", () => {
    const s = createSigmacraftState();
    assert.equal(s.map, null);
    seedSigmacraftOverworld(s, "sigmacraft_alpha");
    assert.ok(s.map?.tiles && Object.keys(s.overworldNpcs).length === NPC_POPULATION_TARGET);
    const mapRef = s.map;
    seedSigmacraftOverworld(s, "sigmacraft_alpha");
    assert.equal(s.map, mapRef, "existing map is not regenerated");
  });
});
