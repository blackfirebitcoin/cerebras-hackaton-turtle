// SIGMA ABYSS — game-state unit tests.
//
// Covers pure-function modules that the existing test pyramid only exercises
// indirectly (load/chaos suites hit the server end-to-end, but never assert on
// the underlying primitives):
//   - validate.js     (input coercion + scrub set)
//   - raid-state.js   (engagement state machine + chats-per-swing math)
//   - drops.js        (drop pool spawners + reaper)
//   - supervisor.js   (fault containment + supervised intervals)
//   - arena.js        (roster + chatter ping)
//   - agent-realm.js  (cooldowns + reward grants + oracle tile guard)
//
// Run: node --test test/unit/game-state.test.js

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  AGENT_BASE_HP,
  AGENT_COOLDOWN,
  AGENT_HP_PER_LEVEL,
  AGENT_START,
  GEAR_SLOTS,
  RARITIES,
} from "../../shared/constants.js";

// ── validate.js ─────────────────────────────────────────────────────────

import {
  ValidationError,
  vArr,
  vBool,
  vEnum,
  vInt,
  vNum,
  vStr,
  vToken,
} from "../../server/validate.js";

describe("validate.vInt", () => {
  test("clamps to range", () => {
    assert.equal(vInt(5, 0, 10), 5);
    assert.equal(vInt(-5, 0, 10), 0);
    assert.equal(vInt(99, 0, 10), 10);
  });
  test("truncates floats", () => {
    assert.equal(vInt(3.9, 0, 10), 3);
    assert.equal(vInt(-3.9, -10, 10), -3);
  });
  test("coerces numeric strings", () => {
    assert.equal(vInt("7", 0, 10), 7);
  });
  test("returns dflt for null/undefined/empty", () => {
    assert.equal(vInt(null, 0, 10, 4), 4);
    assert.equal(vInt(undefined, 0, 10, 4), 4);
    assert.equal(vInt("", 0, 10, 4), 4);
  });
  test("returns dflt on NaN", () => {
    assert.equal(vInt("not-a-number", 0, 10, 4), 4);
  });
  test("throws ValidationError without dflt on NaN", () => {
    assert.throws(() => vInt("not-a-number", 0, 10), ValidationError);
  });
});

describe("validate.vNum", () => {
  test("preserves floats within range", () => {
    assert.equal(vNum(3.14, 0, 10), 3.14);
  });
  test("clamps", () => {
    assert.equal(vNum(99.5, 0, 10), 10);
    assert.equal(vNum(-1.5, 0, 10), 0);
  });
});

describe("validate.vStr", () => {
  test("truncates to maxLen", () => {
    assert.equal(vStr("hello world", 5), "hello");
  });
  test("strips C0 control codes", () => {
    assert.equal(vStr("hi\x00\x07there\x1f!", 30), "hithere!");
  });
  test("strips DEL (U+007F)", () => {
    assert.equal(vStr("ab", 30), "ab");
  });
  test("strips zero-width chars (U+200B–U+200F)", () => {
    assert.equal(vStr("a​b‎c", 30), "abc");
  });
  test("strips U+2028 / U+2029 line separators", () => {
    assert.equal(vStr("a b c", 30), "abc");
  });
  test("returns dflt for non-string with dflt", () => {
    assert.equal(vStr(123, 30, "fallback"), "fallback");
  });
  test("throws without dflt for non-string", () => {
    assert.throws(() => vStr(123, 30), ValidationError);
  });
});

describe("validate.vBool", () => {
  test("coerces truthy/falsy", () => {
    assert.equal(vBool(1), true);
    assert.equal(vBool(""), false);
    assert.equal(vBool("yes"), true);
  });
  test("uses dflt for null/undefined", () => {
    assert.equal(vBool(null, true), true);
    assert.equal(vBool(undefined, false), false);
  });
});

describe("validate.vEnum", () => {
  test("accepts known values", () => {
    assert.equal(vEnum("rare", RARITIES, "common"), "rare");
  });
  test("returns dflt for unknown values when provided", () => {
    assert.equal(vEnum("ultra-mega", RARITIES, "common"), "common");
  });
  test("throws without dflt on unknown", () => {
    assert.throws(() => vEnum("ultra-mega", RARITIES), ValidationError);
  });
});

describe("validate.vArr", () => {
  test("returns empty array for null/undefined", () => {
    assert.deepEqual(
      vArr(null, (x) => x, 10),
      [],
    );
    assert.deepEqual(
      vArr(undefined, (x) => x, 10),
      [],
    );
  });
  test("throws on non-array", () => {
    assert.throws(() => vArr("nope", (x) => x, 10), ValidationError);
  });
  test("caps at maxLen", () => {
    const out = vArr([1, 2, 3, 4, 5], (x) => x, 3);
    assert.deepEqual(out, [1, 2, 3]);
  });
  test("silently drops bad items", () => {
    const out = vArr(
      [1, "x", 2, "y", 3],
      (x) => {
        if (typeof x !== "number") throw new Error("nope");
        return x;
      },
      10,
    );
    assert.deepEqual(out, [1, 2, 3]);
  });
});

describe("validate.vToken", () => {
  test("accepts valid sig_ token", () => {
    const t = `sig_${"a".repeat(24)}`;
    assert.equal(vToken(t), t);
  });
  test("rejects wrong prefix", () => {
    assert.throws(() => vToken(`foo_${"a".repeat(24)}`), ValidationError);
  });
  test("rejects wrong length", () => {
    assert.throws(() => vToken("sig_aaa"), ValidationError);
  });
  test("rejects non-string", () => {
    assert.throws(() => vToken(null), ValidationError);
  });
});

// ── raid-state.js ───────────────────────────────────────────────────────

import * as raidState from "../../server/raid-state.js";

describe("raid-state.chatsPerSwing", () => {
  test("base speedMul (1.0) → 3 chats per swing", () => {
    assert.equal(raidState.chatsPerSwing(1.0), 3);
  });
  test("dagger speedMul (1.35) → 2 chats per swing", () => {
    assert.equal(raidState.chatsPerSwing(1.35), 2);
  });
  test("hammer/greatsword speedMul (0.85/0.8) → 4 chats per swing", () => {
    assert.equal(raidState.chatsPerSwing(0.85), 4);
    assert.equal(raidState.chatsPerSwing(0.8), 4);
  });
  test("missing/zero speedMul defaults to 3", () => {
    assert.equal(raidState.chatsPerSwing(0), 3);
    assert.equal(raidState.chatsPerSwing(undefined), 3);
  });
  test("very fast weapon clamps to 1 chat per swing", () => {
    assert.equal(raidState.chatsPerSwing(10), 1);
  });
});

describe("raid-state engagement state machine", () => {
  beforeEach(() => raidState.clear());
  afterEach(() => raidState.clear());

  test("engage/isEngaged/disengage roundtrip", () => {
    assert.equal(raidState.isEngaged("alice"), false);
    raidState.engage("alice", { family: "sword" });
    assert.equal(raidState.isEngaged("alice"), true);
    assert.equal(raidState.disengage("alice"), true);
    assert.equal(raidState.isEngaged("alice"), false);
  });

  test("login is case-insensitive", () => {
    raidState.engage("Alice", { family: "sword" });
    assert.equal(raidState.isEngaged("ALICE"), true);
    assert.equal(raidState.isEngaged("alice"), true);
  });

  test("consumeChatTicks fires a swing every 3 ticks for base weapon", () => {
    raidState.engage("bob", { family: "fists" });
    assert.equal(raidState.consumeChatTicks("bob", 1), 0);
    assert.equal(raidState.consumeChatTicks("bob", 1), 0);
    assert.equal(raidState.consumeChatTicks("bob", 1), 1);
    assert.equal(raidState.consumeChatTicks("bob", 1), 0); // counter reset
  });

  test("consumeChatTicks coalesces multi-line increments", () => {
    raidState.engage("carol", { family: "fists" }); // 3 chats per swing
    assert.equal(raidState.consumeChatTicks("carol", 7), 2); // 7/3 = 2 swings, 1 left over
    assert.equal(raidState.consumeChatTicks("carol", 2), 1); // 3 cumulative → 1 swing
  });

  test("consumeChatTicks for un-engaged login returns 0", () => {
    assert.equal(raidState.consumeChatTicks("nobody", 5), 0);
  });

  test("clear() removes all engagements", () => {
    raidState.engage("a", { family: "sword" });
    raidState.engage("b", { family: "dagger" });
    assert.equal(raidState.size(), 2);
    raidState.clear();
    assert.equal(raidState.size(), 0);
  });
});

// ── drops.js ────────────────────────────────────────────────────────────

import * as drops from "../../server/drops.js";

function drainDrops() {
  // No public reset — drain by reading the snapshot and reaping by waiting.
  // Tests rely on diffing snapshot sizes before/after each spawn.
}

describe("drops spawners", () => {
  test("spawnKillReward yields 1 xp + sometimes a gold drop", () => {
    const before = drops.size();
    const out = drops.spawnKillReward({ foeMaxHp: 60 });
    const after = drops.size();
    assert.ok(out.length === 1 || out.length === 2, `expected 1-2 drops, got ${out.length}`);
    assert.equal(out[0].kind, "xp");
    if (out.length === 2) assert.equal(out[1].kind, "gold");
    assert.equal(after - before, out.length);
  });

  test("spawnXpBurst returns intensity-scaled xp drops", () => {
    const out = drops.spawnXpBurst({ intensity: 1 });
    // base count: round(2 + 1 * 1.5) = 4
    assert.equal(out.length, 4);
    for (const d of out) assert.equal(d.kind, "xp");
  });

  test("spawnSessionDrops mixes xp / gold / item kinds", () => {
    const out = drops.spawnSessionDrops({ intensity: 2, itemLevel: 5 });
    const kinds = new Set(out.map((d) => d.kind));
    assert.ok(kinds.has("xp"), "expected at least one xp drop");
    assert.ok(kinds.has("gold"), "expected at least one gold drop");
    // Items may roll null occasionally but session intensity 2 with 1+ tries
    // should almost always land at least one. Don't hard-assert to avoid flake.
  });

  test("intensity clamps to [0.4, 4]", () => {
    const huge = drops.spawnXpBurst({ intensity: 999 });
    // intensity clamps to 4 → round(2 + 4 * 1.5) = 8
    assert.equal(huge.length, 8);
    // intensity: 0.5 → k = 0.5 → round(2 + 0.5 * 1.5) = round(2.75) = 3.
    // (intensity: 0 short-circuits to 1 via `Number(0) || 1` — not the lower
    // clamp; that's intentional, 0/null/undefined fall back to the default.)
    const small = drops.spawnXpBurst({ intensity: 0.5 });
    assert.equal(small.length, 3);
  });

  test("snapshot returns public-safe drop records", () => {
    drops.spawnXpBurst({ intensity: 0.5 });
    const snap = drops.snapshot();
    assert.equal(typeof snap.ttlMs, "number");
    assert.ok(Array.isArray(snap.drops));
    assert.ok(snap.drops.length > 0);
    for (const d of snap.drops) {
      assert.ok(d.id);
      assert.ok(["xp", "gold", "item"].includes(d.kind));
      assert.equal(typeof d.x, "number");
      assert.equal(typeof d.y, "number");
      assert.equal(typeof d.createdAt, "number");
      assert.equal(typeof d.expiresAt, "number");
      assert.ok(d.expiresAt > d.createdAt);
    }
  });

  test("tryClaim returns null when no Twitch sigma is linked", () => {
    drops.spawnXp ? null : null; // no direct spawn helper; pool may already have entries
    drops.spawnXpBurst({ intensity: 1 });
    const result = drops.tryClaim(`nonexistent-login-zzz-${Date.now()}`);
    assert.equal(result, null);
  });
});

// ── supervisor.js ───────────────────────────────────────────────────────

import { guard, health, superviseInterval } from "../../server/supervisor.js";

describe("supervisor.guard", () => {
  test("wraps a clean function transparently", () => {
    const wrapped = guard("test/clean", (a, b) => a + b);
    assert.equal(wrapped(2, 3), 5);
  });

  test("contains exceptions, returns undefined", (t) => {
    // Suppress the contained fault log so the test output stays clean.
    const origErr = console.error;
    t.after(() => (console.error = origErr));
    console.error = () => {};

    const wrapped = guard("test/throws", () => {
      throw new Error("kaboom");
    });
    const result = wrapped();
    assert.equal(result, undefined);
  });

  test("health() reports recent fault count + degraded flag", () => {
    const h = health();
    assert.equal(typeof h, "object");
    assert.equal(typeof h.recentFaults, "number");
    assert.equal(typeof h.degraded, "boolean");
  });
});

describe("supervisor.superviseInterval", () => {
  test("keeps firing after a thrown tick", async (t) => {
    const origErr = console.error;
    t.after(() => (console.error = origErr));
    console.error = () => {};

    let ticks = 0;
    const stop = superviseInterval(
      "test/flaky",
      () => {
        ticks += 1;
        if (ticks === 1) throw new Error("first tick boom");
      },
      10,
    );
    await new Promise((r) => setTimeout(r, 60));
    stop();
    assert.ok(ticks >= 3, `expected at least 3 ticks despite throw, got ${ticks}`);
  });
});

// ── arena.js ────────────────────────────────────────────────────────────

import * as arena from "../../server/arena.js";
import { gearAuraTier } from "../../server/arena.js";
import { RARITY_RANK } from "../../shared/constants.js";

describe("gearAuraTier", () => {
  test("returns 0 for a character with no run", () => {
    assert.equal(gearAuraTier(null), 0);
    assert.equal(gearAuraTier({}), 0);
    assert.equal(gearAuraTier({ run: null }), 0);
  });

  test("returns 0 for a character with no gear", () => {
    assert.equal(gearAuraTier({ run: {} }), 0);
    assert.equal(gearAuraTier({ run: { gear: {} } }), 0);
  });

  test("returns correct tier for a legendary weapon (tier 4)", () => {
    const character = { run: { gear: { weapon: { rarity: "legendary" } } } };
    assert.equal(gearAuraTier(character), 4);
  });

  test("returns correct tier for a mythic item (tier 4 — clamped)", () => {
    const character = { run: { gear: { armor: { rarity: "mythic" } } } };
    assert.equal(gearAuraTier(character), 4);
  });

  test("returns correct tier for a oneofone item (tier 4 — clamped)", () => {
    const character = { run: { gear: { ring: { rarity: "oneofone" } } } };
    assert.equal(gearAuraTier(character), 4);
  });

  test("returns correct tier for an epic item (tier 3)", () => {
    const character = { run: { gear: { weapon: { rarity: "epic" } } } };
    assert.equal(gearAuraTier(character), 3);
  });

  test("returns correct tier for a rare item (tier 2)", () => {
    const character = { run: { gear: { weapon: { rarity: "rare" } } } };
    assert.equal(gearAuraTier(character), 2);
  });

  test("returns correct tier for an uncommon item (tier 1)", () => {
    const character = { run: { gear: { weapon: { rarity: "uncommon" } } } };
    assert.equal(gearAuraTier(character), 1);
  });

  test("returns 0 for a common item (tier 0 — no aura)", () => {
    const character = { run: { gear: { weapon: { rarity: "common" } } } };
    assert.equal(gearAuraTier(character), 0);
  });

  test("takes the max rank across all gear slots", () => {
    // weapon=common(0), armor=epic(3) → should return 3
    const character = {
      run: {
        gear: {
          weapon: { rarity: "common" },
          armor: { rarity: "epic" },
          ring: { rarity: "rare" },
        },
      },
    };
    assert.equal(gearAuraTier(character), 3);
  });

  test("skips null/undefined slots", () => {
    const character = {
      run: {
        gear: {
          weapon: null,
          armor: { rarity: "rare" },
        },
      },
    };
    assert.equal(gearAuraTier(character), 2);
  });
});

describe("arena publicEntry auraTier", () => {
  test("snapshot exposes auraTier:0 for a new entry (no character gear)", () => {
    const login = `aura-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    arena.pingChatter(login, "test");
    const entry = arena.snapshot().chatters.find((e) => e.login === login);
    assert.ok(entry, "entry must be in snapshot");
    assert.equal(typeof entry.auraTier, "number", "auraTier must be a number");
    assert.equal(entry.auraTier, 0, "new entry with no character must have auraTier 0");
  });

  test("refreshLastSeen updates lastSeenAt for an existing entry", () => {
    const login = `refresh-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    arena.pingChatter(login, "test");
    arena.refreshLastSeen(login);
    // arenaHp returns non-null → entry is still in roster (not evicted)
    const hp = arena.arenaHp(login);
    assert.ok(hp, "entry must still be in roster after refreshLastSeen");
  });

  test("refreshLastSeen is a no-op for an unknown login", () => {
    // Must not throw
    assert.doesNotThrow(() => arena.refreshLastSeen(`not-in-roster-${Date.now()}`));
  });
});

void RARITY_RANK; // silence unused-import lint

describe("arena roster", () => {
  test("tickIntervalMs returns a positive number", () => {
    const ms = arena.tickIntervalMs();
    assert.equal(typeof ms, "number");
    assert.ok(ms > 0);
  });

  test("pingChatter mints an entry for a new login", () => {
    const login = `unit-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const before = arena.size();
    arena.pingChatter(login, "test");
    const after = arena.size();
    assert.equal(after - before, 1);
    const entry = arena.snapshot().chatters.find((e) => e.login === login);
    assert.ok(entry, "entry should be in snapshot");
    assert.equal(entry.hp, entry.maxHp, "new entry should be full HP");
    assert.ok(entry.foe, "new entry should have a foe");
  });

  test("pingChatter is idempotent for the same login", () => {
    const login = `unit-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    arena.pingChatter(login, "test");
    const after1 = arena.size();
    arena.pingChatter(login, "test");
    const after2 = arena.size();
    assert.equal(after2, after1, "second ping should not add a new entry");
  });

  test("arenaHp returns null for an unknown login", () => {
    assert.equal(arena.arenaHp(`not-in-roster-zzz-${Date.now()}`), null);
  });

  test("arenaHp returns hp/maxHp for a known login", () => {
    const login = `unit-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    arena.pingChatter(login, "test");
    const hp = arena.arenaHp(login);
    assert.ok(hp);
    assert.equal(typeof hp.hp, "number");
    assert.equal(typeof hp.maxHp, "number");
    assert.ok(hp.hp <= hp.maxHp);
  });
});

// ── agent-realm.js ──────────────────────────────────────────────────────

import {
  applyOracleCooldown,
  cooldownRemaining,
  freshAgentCharacter,
  grantReward,
  isOnOracleTile,
  publicAgent,
} from "../../server/agent-realm.js";

describe("agent-realm.freshAgentCharacter", () => {
  test("starts at spawn tile, level 1, full HP, empty inventory", () => {
    const ch = freshAgentCharacter("Tester", 12345);
    assert.equal(ch.name, "Tester");
    assert.equal(ch.x, AGENT_START.x);
    assert.equal(ch.y, AGENT_START.y);
    assert.equal(ch.level, 1);
    assert.equal(ch.xp, 0);
    assert.equal(ch.hp, AGENT_BASE_HP);
    assert.equal(ch.maxHp, AGENT_BASE_HP);
    assert.deepEqual(ch.inventory, {});
    assert.equal(ch.cooldownExpires, 0);
    assert.equal(ch.gold, 0);
    assert.equal(ch.taskCoins, 0);
  });

  test("seeds the rng with the given seed", () => {
    const a = freshAgentCharacter("A", 42);
    const b = freshAgentCharacter("B", 42);
    assert.equal(a.rngState, b.rngState);
  });

  test("zero seed becomes 1 (non-zero rng requirement)", () => {
    const ch = freshAgentCharacter("Z", 0);
    assert.equal(ch.rngState, 1);
  });
});

describe("agent-realm.cooldownRemaining", () => {
  test("0 when no cooldown is active", () => {
    const ch = freshAgentCharacter("idle", 1);
    assert.equal(cooldownRemaining(ch), 0);
  });

  test("positive when expiry is in the future", () => {
    const ch = freshAgentCharacter("cooling", 1);
    ch.cooldownExpires = Date.now() + 5000;
    const r = cooldownRemaining(ch);
    assert.ok(r > 4 && r <= 5, `expected ~5s, got ${r}`);
  });

  test("0 when expiry is in the past", () => {
    const ch = freshAgentCharacter("expired", 1);
    ch.cooldownExpires = Date.now() - 10000;
    assert.equal(cooldownRemaining(ch), 0);
  });
});

describe("agent-realm.publicAgent", () => {
  test("does not leak rngState or raw cooldownExpires", () => {
    const ch = freshAgentCharacter("hidden", 999);
    ch.cooldownExpires = Date.now() + 5000;
    const pub = publicAgent(ch);
    assert.equal(pub.rngState, undefined);
    assert.equal(pub.cooldownExpires, undefined);
    assert.ok(pub.cooldown);
    assert.equal(typeof pub.cooldown.remaining_seconds, "number");
  });

  test("returns the agent-realm tile contents", () => {
    const ch = freshAgentCharacter("spawn", 1);
    const pub = publicAgent(ch);
    // (5,5) is the town/spawn tile
    assert.ok(pub.tile);
    assert.equal(pub.tile.type, "town");
  });
});

describe("agent-realm.isOnOracleTile", () => {
  test("true on the oracle tile (5,4)", () => {
    const ch = freshAgentCharacter("seer", 1);
    ch.x = 5;
    ch.y = 4;
    assert.equal(isOnOracleTile(ch), true);
  });

  test("false on the spawn tile (5,5)", () => {
    const ch = freshAgentCharacter("noob", 1);
    assert.equal(isOnOracleTile(ch), false);
  });

  test("false on an empty tile", () => {
    const ch = freshAgentCharacter("wanderer", 1);
    ch.x = 0;
    ch.y = 7;
    assert.equal(isOnOracleTile(ch), false);
  });
});

describe("agent-realm.grantReward", () => {
  test("adds gold + coins", () => {
    const ch = freshAgentCharacter("rich", 1);
    grantReward(ch, { gold: 100, coins: 5 });
    assert.equal(ch.gold, 100);
    assert.equal(ch.taskCoins, 5);
  });

  test("adds character XP and levels up at threshold", () => {
    const ch = freshAgentCharacter("grinder", 1);
    // xpForLevel(1) = round(40 * 1.14^0) = 40
    const out = grantReward(ch, { xp: 100, skill: "oracle" });
    assert.ok(out.charLevels >= 1, `expected at least 1 char level, got ${out.charLevels}`);
    assert.equal(ch.hp, ch.maxHp, "ding heals to full");
    assert.ok(ch.maxHp >= AGENT_BASE_HP + AGENT_HP_PER_LEVEL, "maxHp grows per level");
  });

  test("adds skill XP to the named skill", () => {
    const ch = freshAgentCharacter("apprentice", 1);
    grantReward(ch, { xp: 20, skill: "mining" });
    assert.ok(ch.skills.mining.xp > 0 || ch.skills.mining.level > 1);
  });

  test("ignores negative gold/coins (clamps to 0 added)", () => {
    const ch = freshAgentCharacter("clamp", 1);
    grantReward(ch, { gold: -50, coins: -5 });
    assert.equal(ch.gold, 0);
    assert.equal(ch.taskCoins, 0);
  });
});

describe("agent-realm.applyOracleCooldown", () => {
  test("uses AGENT_COOLDOWN.oracle as the total", () => {
    const ch = freshAgentCharacter("orc", 1);
    const cd = applyOracleCooldown(ch);
    assert.equal(cd.total_seconds, AGENT_COOLDOWN.oracle);
    assert.equal(cd.remaining_seconds, AGENT_COOLDOWN.oracle);
    assert.ok(typeof cd.expiration === "string");
    const remaining = cooldownRemaining(ch);
    assert.ok(remaining > AGENT_COOLDOWN.oracle - 1 && remaining <= AGENT_COOLDOWN.oracle);
  });
});

// Reference unused imports to silence lint without changing the surface.
void GEAR_SLOTS;
void drainDrops;
