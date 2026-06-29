// SIGMA ABYSS — Phase D: Gemma boss-drop enrichment. The PURE enricher
// (shared/boss-drops.js) clamps model output onto a deterministic forged drop; the
// server forge (server/cerebras-boss-drops.js) is cache-primary + fallback-first
// and NEVER awaits the model on the kill path (an injected mock llm proves it).
// Run: node --test test/unit/boss-drops.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { enrichBossDrop } from "../../shared/boss-drops.js";
import { forgeRaidDrop } from "../../shared/loot.js";
import { RARITY_RANK } from "../../shared/constants.js";
import { createBossDropForge } from "../../server/cerebras-boss-drops.js";

const BOSS = "goblin_king"; // mythic relic with luck/greed/lootQty/rarity/crit affixes

describe("enrichBossDrop — pure, clamped, no power-creep", () => {
  test("applies name/flavor/effect but keeps slot/base/ilvl and never upgrades rarity", () => {
    const base = forgeRaidDrop(BOSS, 30);
    const out = enrichBossDrop(base, {
      name: "Hunger of the Hollow Crown",
      flavor: "It remembers every king it outlived.",
      effect: "vampire",
      rarity: "oneofone", // ABOVE mythic — must be rejected
    });
    assert.equal(out.name, "Hunger of the Hollow Crown");
    assert.equal(out.flavor, "It remembers every king it outlived.");
    assert.equal(out.effect, "vampire");
    assert.equal(out.slot, base.slot);
    assert.equal(out.base, base.base);
    assert.equal(out.ilvl, base.ilvl);
    assert.ok(RARITY_RANK[out.rarity] <= RARITY_RANK[base.rarity], "rarity never upgraded");
    assert.equal(out.source, "gemma");
  });

  test("affix values are clamped to the deterministic band; new stats are ignored", () => {
    const base = forgeRaidDrop(BOSS, 30);
    const luckBase = base.affixes.find((a) => a.stat === "luck").value;
    const out = enrichBossDrop(base, {
      affixes: [
        { stat: "luck", value: luckBase * 100 }, // absurd → clamped to <=1.25x
        { stat: "str", value: 9999 }, // not on the item → ignored
      ],
    });
    const luckOut = out.affixes.find((a) => a.stat === "luck").value;
    assert.ok(luckOut <= Math.ceil(luckBase * 1.25), `luck clamped (${luckOut} <= ${luckBase * 1.25})`);
    assert.ok(luckOut >= Math.floor(luckBase * 0.5), "luck not below the floor");
    assert.ok(!out.affixes.some((a) => a.stat === "str"), "no invented affix stat");
  });

  test("garbage / empty input returns the base unchanged in shape", () => {
    const base = forgeRaidDrop(BOSS, 20);
    const out = enrichBossDrop(base, { name: 123, effect: "not_a_real_effect", rarity: "ultra" });
    assert.equal(out.name, base.name, "non-string name ignored");
    assert.equal(out.effect, base.effect, "unknown effect ignored");
    assert.equal(out.rarity, base.rarity, "unknown rarity ignored");
  });
});

describe("createBossDropForge — cache-primary, never awaits on the kill path", () => {
  test("with live OFF, forgeOrCached == deterministic and warm is a no-op", async () => {
    const forge = createBossDropForge({ env: {}, llm: { available: () => true, chat: async () => ({}) } });
    const a = forge.forgeOrCached(BOSS, 25);
    assert.equal(a.source, undefined, "deterministic drop has no gemma source");
    assert.equal(await forge.warm(BOSS, 25, {}), false, "warm no-ops when live off");
    assert.equal(forge._cacheSize(), 0);
  });

  test("first kill is deterministic; after warm, later kills get cached enrichment instantly", async () => {
    let calls = 0;
    const llm = {
      available: () => true,
      chat: async () => {
        calls += 1;
        return { name: "The Goblin Reliquary", flavor: "Coined from a stolen throne.", effect: "midas" };
      },
    };
    const forge = createBossDropForge({ env: { BOSS_DROPS_LIVE: "1" }, llm });

    const first = forge.forgeOrCached(BOSS, 30); // sync — no cache yet → deterministic
    assert.notEqual(first.name, "The Goblin Reliquary");

    assert.equal(await forge.warm(BOSS, 30, { killerLevel: 30 }), true);
    assert.equal(forge._cacheSize(), 1);

    const later = forge.forgeOrCached(BOSS, 45); // cached enrichment, re-scaled to ilvl(45)
    assert.equal(later.name, "The Goblin Reliquary");
    assert.equal(later.source, "gemma");
    assert.ok(later.ilvl > first.ilvl, "ilvl still scales with the killer level");

    await forge.warm(BOSS, 45, {}); // already cached → must NOT call the model again
    assert.equal(calls, 1, "exactly one generation per boss (cache-primary)");
  });

  test("a model failure leaves the cache empty → deterministic drop keeps shipping", async () => {
    const llm = { available: () => true, chat: async () => { throw new Error("provider down"); } };
    const forge = createBossDropForge({ env: { BOSS_DROPS_LIVE: "1" }, llm });
    assert.equal(await forge.warm(BOSS, 30, {}), false);
    assert.equal(forge._cacheSize(), 0);
    assert.equal(forge.forgeOrCached(BOSS, 30).source, undefined, "still the deterministic drop");
  });
});
