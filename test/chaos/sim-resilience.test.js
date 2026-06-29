// SIGMA ABYSS — Chaos tests: sim resilience under degenerate inputs.
//
// Each test injects a "real failure" condition and asserts that:
//   - delveTick() does not throw
//   - resolveDeath() produces a valid fresh run
//   - simulateOffline() terminates and returns without throwing
//
// Run: node --test test/chaos/sim-resilience.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  delveTick,
  deployToZone,
  freshCharacter,
  resolveDeath,
  simulateOffline,
} from "../../shared/progression.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** freshCharacter takes (seed:number, name?:string) */
function aliveChar(seed = 42) {
  return freshCharacter(seed);
}

function deployedChar(zoneId = "verdant_path") {
  const c = aliveChar();
  deployToZone(c, zoneId);
  return c;
}

// ── delveTick() — does not throw on degenerate character state ─────────────────

describe("chaos: delveTick() — null/corrupt run fields", () => {
  test("delveTick does not throw when rngState is null", () => {
    const c = deployedChar();
    c.run.rngState = null;
    assert.doesNotThrow(() => delveTick(c));
  });

  test("delveTick does not throw when rngSeed is 0", () => {
    const c = deployedChar();
    c.run.rngSeed = 0;
    assert.doesNotThrow(() => delveTick(c));
  });

  test("delveTick returns an object on a safe zone (not a throw)", () => {
    const c = deployedChar("town"); // town zone is safe
    const result = delveTick(c);
    // Either idle (safe zone) or a combat result — never a throw
    assert.ok(typeof result === "object" && result !== null, "delveTick must return an object");
  });

  test("delveTick does not throw when character hp is 0", () => {
    const c = deployedChar();
    c.run.hp = 0;
    assert.doesNotThrow(() => delveTick(c));
  });

  test("delveTick does not throw when inventory is empty array", () => {
    const c = deployedChar();
    c.run.inventory = [];
    assert.doesNotThrow(() => delveTick(c));
  });

  test("delveTick does not throw when gear slots are null", () => {
    const c = deployedChar();
    // Wipe gear to nulls — should fall back to bare fists defaults
    if (c.run.gear) {
      for (const slot of Object.keys(c.run.gear)) {
        c.run.gear[slot] = null;
      }
    }
    assert.doesNotThrow(() => delveTick(c));
  });
});

// ── Simulated mid-tick disconnect ────────────────────────────────────────────
//
// The server calls delveTick() per tick. A "disconnected client" means the
// character object may have stale/missing fields from a partial desync.
// Verify the tick terminates cleanly (does not hang or throw).

describe("chaos: delveTick() — mid-tick client disconnect simulation", () => {
  test("delveTick terminates even when run.effects is undefined", () => {
    const c = deployedChar();
    // Strip the effects array (would happen if a client WS close races with tick)
    delete c.run.effects;
    assert.doesNotThrow(() => {
      const result = delveTick(c);
      assert.ok(result !== undefined, "tick must return a result");
    });
  });

  test("delveTick does not hang when run.depth is very high", () => {
    const c = deployedChar();
    c.run.depth = 999; // beyond normal ceiling
    const start = Date.now();
    assert.doesNotThrow(() => delveTick(c));
    assert.ok(Date.now() - start < 500, "delveTick must not hang");
  });
});

// ── resolveDeath() — invariants after hard crash ──────────────────────────────

describe("chaos: resolveDeath() — run/account split invariant", () => {
  test("resolveDeath does not throw on a freshly created character", () => {
    const c = aliveChar();
    assert.doesNotThrow(() => resolveDeath(c, { xpGain: 0, goldGain: 0, highestDepth: 0 }));
  });

  test("resolveDeath produces a new run with level=1 after death", () => {
    const c = deployedChar();
    c.run.level = 10;
    resolveDeath(c, { xpGain: 50, goldGain: 100, highestDepth: 5 });
    assert.equal(c.run.level, 1, "run level must reset to 1 after permadeath");
  });

  test("resolveDeath does not decrease account gold", () => {
    const c = deployedChar();
    const before = c.gold || 0;
    resolveDeath(c, { xpGain: 0, goldGain: 50, highestDepth: 0 });
    assert.ok((c.gold || 0) >= before, "account gold must not decrease after death");
  });
});

// ── simulateOffline() — terminates even for large elapsed time ────────────────

describe("chaos: simulateOffline() — large offline duration", () => {
  test("simulateOffline terminates within 1000ms for 24h offline", () => {
    const c = deployedChar();
    const start = Date.now();
    assert.doesNotThrow(() => simulateOffline(c, 24 * 60 * 60 * 1000));
    assert.ok(Date.now() - start < 1000, "simulateOffline must terminate within 1s");
  });

  test("simulateOffline terminates (throws or returns) for a character with null run", () => {
    const c = aliveChar();
    c.run = null;
    // simulateOffline on a dead character (null run) may throw a TypeError —
    // the key invariant is that it terminates within a bounded time, not that
    // it silently no-ops. We verify it does NOT hang.
    const start = Date.now();
    try {
      simulateOffline(c, 5000);
    } catch (_e) {
      // TypeError from accessing c.run.level is acceptable — the process terminates
    }
    assert.ok(Date.now() - start < 500, "simulateOffline must terminate even with null run");
  });
});
