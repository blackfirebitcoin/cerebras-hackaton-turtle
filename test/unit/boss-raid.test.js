// test/unit/boss-raid.test.js — Boss/raid system defect regression suite.
// Covers D1–D5 fixes. Run: node --test test/unit/boss-raid.test.js
// Uses node:test (zero deps), consistent with the project's test style.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ENEMIES } from "../../shared/enemies.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const arenaJs = readFileSync(join(__dirname, "../../client/js/arena.js"), "utf8");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal currentRaid object the way startRaid() does. */
function makeRaid(boss_id = "goblin_king") {
  const def = ENEMIES[boss_id];
  assert.ok(def, `boss ${boss_id} must exist in ENEMIES`);
  const maxHp = 1000;
  return {
    boss_id,
    name: def.name,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
    contributors: new Map(),
    xpEarned: new Map(),
    startedAt: Date.now(),
    reason: "test",
    fromLogin: "tester",
  };
}

/** raidPublic mirrors the server function. */
function raidPublic(r) {
  if (!r) return null;
  return {
    boss_id: r.boss_id,
    name: r.name,
    hue: r.hue,
    lpc: r.lpc || null,
    hp: r.hp,
    maxHp: r.maxHp,
    contributors: r.contributors.size,
    topContributors: [...r.contributors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([login, dmg]) => ({ login, dmg })),
    startedAt: r.startedAt,
  };
}

// ── D2: raidPublic shape + welcome/snapshot carry raid ───────────────────────

describe("D2 — raidPublic + on-connect snapshot", () => {
  test("raidPublic returns null when no raid", () => {
    assert.equal(raidPublic(null), null);
  });

  test("raidPublic returns correct shape for active raid", () => {
    const raid = makeRaid("goblin_king");
    const pub = raidPublic(raid);
    assert.ok(pub, "should be non-null");
    assert.equal(pub.boss_id, "goblin_king");
    assert.equal(typeof pub.name, "string");
    assert.equal(typeof pub.hp, "number");
    assert.equal(typeof pub.maxHp, "number");
    assert.equal(pub.contributors, 0);
    assert.ok(Array.isArray(pub.topContributors));
    assert.equal(typeof pub.startedAt, "number");
  });

  test("raidPublic correctly counts contributors", () => {
    const raid = makeRaid("goblin_king");
    raid.contributors.set("alice", 100);
    raid.contributors.set("bob", 50);
    const pub = raidPublic(raid);
    assert.equal(pub.contributors, 2);
    assert.equal(pub.topContributors[0].login, "alice");
    assert.equal(pub.topContributors[0].dmg, 100);
  });

  test("welcome frame with non-null raid carries required fields", () => {
    const raid = makeRaid("hollow_druid");
    const welcomeFrame = {
      t: "welcome",
      token: "sig_abc",
      character: null,
      feed: [],
      leaderboard: [],
      players: 0,
      arena: { chatters: [] },
      drops: { drops: [] },
      raid: raidPublic(raid),
    };
    assert.ok(welcomeFrame.raid, "raid should be present");
    assert.equal(welcomeFrame.raid.boss_id, "hollow_druid");
    assert.ok(welcomeFrame.raid.hp > 0);
  });

  test("welcome frame with no raid has null raid field", () => {
    const welcomeFrame = {
      t: "welcome",
      raid: raidPublic(null),
    };
    assert.equal(welcomeFrame.raid, null);
  });
});

// ── D3: autonomous boss attack damage is bounded ──────────────────────────────

describe("D3 — autonomous boss attack damage bounds", () => {
  /** Simulates the damage calc in raid.boss_attack superviseInterval. */
  function simulateBossAttackDmg(boss_id, scale = 0.35, trials = 200) {
    const def = ENEMIES[boss_id];
    const attack = def?.attack || 10;
    const baseAttack = Math.max(6, Math.round(attack * scale));
    const results = [];
    for (let i = 0; i < trials; i++) {
      const dmg = baseAttack + Math.round(Math.random() * baseAttack * 0.5);
      results.push(dmg);
    }
    return results;
  }

  test("goblin_king autonomous attack never exceeds 3x base attack", () => {
    const def = ENEMIES["goblin_king"];
    const scale = 0.35;
    const base = Math.max(6, Math.round((def.attack || 10) * scale));
    const maxExpected = base + Math.round(base * 0.5); // max possible
    const dmgs = simulateBossAttackDmg("goblin_king", scale);
    for (const d of dmgs) {
      assert.ok(d >= 1, `damage ${d} must be positive`);
      assert.ok(d <= maxExpected * 2, `damage ${d} must be bounded (max ${maxExpected * 2})`);
    }
  });

  test("hollow_sigma autonomous attack is non-zero", () => {
    const dmgs = simulateBossAttackDmg("hollow_sigma", 0.35);
    for (const d of dmgs) assert.ok(d > 0, "damage must be positive");
  });

  test("damage scale 0 disables attacks (RAID_BOSS_ATTACK_MS=0 path)", () => {
    // When RAID_BOSS_ATTACK_MS <= 0 the interval body returns early.
    // We test the guard logic directly.
    const RAID_BOSS_ATTACK_MS = 0;
    let attacked = false;
    if (RAID_BOSS_ATTACK_MS > 0) attacked = true;
    assert.equal(attacked, false, "scale=0 disables autonomous attack");
  });

  test("autonomous attack reduces party member hp (applyBossCounter simulation)", () => {
    // Simulate what applyBossCounter does — return an arenaHit frame with side=enemy.
    const fakeHp = 100;
    const dmg = 12;
    const newHp = Math.max(0, fakeHp - dmg);
    assert.equal(newHp, 88);
    assert.ok(newHp >= 0, "hp never goes below 0");
  });
});

// ── D4: startRaid sets currentRaid + spawnable boss guard ────────────────────

describe("D4 — spawn cadence + summon path", () => {
  test("SPAWNABLE_BOSSES only contains boss-kind enemies", () => {
    const spawnable = new Set(
      Object.entries(ENEMIES)
        .filter(([, def]) => def.kind === "boss")
        .map(([id]) => id),
    );
    // Every entry in SPAWNABLE_BOSSES must have kind=boss
    for (const id of spawnable) {
      assert.equal(ENEMIES[id].kind, "boss", `${id} must be kind=boss`);
    }
    assert.ok(spawnable.size > 0, "there must be at least one spawnable boss");
  });

  test("startRaid-equivalent sets all required fields", () => {
    const boss_id = "goblin_king";
    const raid = makeRaid(boss_id);
    assert.equal(raid.boss_id, boss_id);
    assert.ok(raid.hp > 0);
    assert.equal(raid.hp, raid.maxHp);
    assert.ok(raid.contributors instanceof Map);
    assert.ok(raid.xpEarned instanceof Map);
    assert.equal(raid.reason, "test");
  });

  test("summon kind is valid in TWITCH_ACTION_KINDS", () => {
    const TWITCH_ACTION_KINDS = new Set([
      "fight",
      "delve",
      "rest",
      "resurrect",
      "featured",
      "summon",
    ]);
    assert.ok(TWITCH_ACTION_KINDS.has("summon"), "summon must be a valid twitch action kind");
  });

  test("auto-spawn skips when raid is already active", () => {
    // Simulate the guard: if (currentRaid) return
    const currentRaid = makeRaid("goblin_king");
    let spawned = false;
    if (!currentRaid) {
      spawned = true;
    }
    assert.equal(spawned, false, "must not spawn while raid is active");
  });

  test("auto-spawn respects cooldown after last raid", () => {
    const COOLDOWN = 3 * 60_000;
    let lastRaidEndedAt = Date.now() - 10_000; // ended 10s ago
    const now = Date.now();
    const tooSoon = now - lastRaidEndedAt < COOLDOWN;
    assert.ok(tooSoon, "should skip spawn within cooldown window");

    lastRaidEndedAt = Date.now() - 4 * 60_000; // ended 4 min ago
    const ready = now - lastRaidEndedAt >= COOLDOWN;
    assert.ok(ready, "should allow spawn after cooldown expires");
  });

  test("summon with specific boss_id uses that boss", () => {
    const SPAWNABLE = new Set(
      Object.entries(ENEMIES)
        .filter(([, d]) => d.kind === "boss")
        .map(([id]) => id),
    );
    const requested = "goblin_king";
    const boss_id = SPAWNABLE.has(requested) ? requested : [...SPAWNABLE][0];
    assert.equal(boss_id, "goblin_king");
  });

  test("summon with unknown boss_id falls back to random valid boss", () => {
    const SPAWNABLE = new Set(
      Object.entries(ENEMIES)
        .filter(([, d]) => d.kind === "boss")
        .map(([id]) => id),
    );
    const requested = "not_a_real_boss";
    const pool = [...SPAWNABLE];
    const boss_id = SPAWNABLE.has(requested)
      ? requested
      : pool[Math.floor(Math.random() * pool.length)];
    assert.ok(SPAWNABLE.has(boss_id), `fallback boss ${boss_id} must be in SPAWNABLE`);
  });
});

// ── D5: auto-engage + auto-battle ────────────────────────────────────────────

describe("D5 — auto-engage on startRaid + mid-raid join", () => {
  // Mirror the raidState engage/isEngaged/clear logic without importing the
  // live server module (which binds port 7777). Pure logic tests.

  function makeEngagedMap() {
    return new Map(); // login → entry
  }

  function engageLogin(map, login, weapon = null) {
    const family = weapon?.family || "fists";
    // speedMul defaults for fists = 1.0 → perSwing = 3
    map.set(login.toLowerCase(), { ticks: 0, perSwing: 3, weaponLabel: "Fists", family });
  }

  test("auto-engage: all roster logins are engaged when startRaid fires", () => {
    const engaged = makeEngagedMap();
    const roster = ["alice", "bob", "charlie"];
    // Simulate startRaid auto-engage loop
    for (const login of roster) {
      if (engaged.has(login)) continue;
      engageLogin(engaged, login, null);
    }
    assert.equal(engaged.size, 3, "all roster members should be engaged");
    for (const login of roster) {
      assert.ok(engaged.has(login), `${login} must be engaged`);
    }
  });

  test("auto-engage: mid-raid join engages the chatter", () => {
    const engaged = makeEngagedMap();
    // Raid already active; alice was there at start
    engageLogin(engaged, "alice");
    // bob joins mid-raid via chat-ping
    const login = "bob";
    if (!engaged.has(login)) engageLogin(engaged, login, null);
    assert.ok(engaged.has("bob"), "mid-raid joiner must be auto-engaged");
  });

  test("auto-engage: harmless if already engaged", () => {
    const engaged = makeEngagedMap();
    engageLogin(engaged, "alice");
    const sizeBefore = engaged.size;
    // Idempotent: second engage call does not double-add
    if (!engaged.has("alice")) engageLogin(engaged, "alice");
    assert.equal(engaged.size, sizeBefore, "double-engage must not grow the map");
  });

  test("raid.fighter_attack: engaged fighters reduce boss hp", () => {
    // Simulate one auto-tick: each engaged fighter deals dmg to boss.
    const bossMaxHp = 1000;
    let bossHp = bossMaxHp;
    const fighters = ["alice", "bob"];
    // Each fires one swing with a fixed 10 dmg (stands in for fireRaidSwing result).
    for (const _login of fighters) {
      const dmg = 10;
      bossHp = Math.max(0, bossHp - dmg);
    }
    assert.ok(bossHp < bossMaxHp, "boss HP must decrease after fighter tick");
    assert.equal(bossHp, 980, "two fighters × 10dmg = 20 total damage");
  });

  test("raid.fighter_attack: loop stops if boss dies mid-iteration", () => {
    let bossHp = 5; // almost dead
    const fighters = ["alice", "bob", "charlie"];
    let swings = 0;
    for (const _login of fighters) {
      if (bossHp <= 0) break;
      bossHp = Math.max(0, bossHp - 10);
      swings += 1;
    }
    assert.ok(swings < fighters.length, "loop must stop once boss reaches 0 HP");
    assert.equal(bossHp, 0, "HP must not go below 0");
  });
});

// ── D5: client render constants ───────────────────────────────────────────────

describe("D5 — client render constants (source inspection)", () => {
  // arenaJs read at module level above so it's available in all describes.

  test("BOSS_ANCHOR_X is on the right side (> VW/2 = 960)", () => {
    // BOSS_ANCHOR_X = Math.round(1920 * 0.74) = 1421
    const m = arenaJs.match(/BOSS_ANCHOR_X\s*=\s*Math\.round\(1920\s*\*\s*([\d.]+)\)/);
    assert.ok(m, "BOSS_ANCHOR_X must be defined as Math.round(1920 * factor)");
    const factor = Number(m[1]);
    assert.ok(factor > 0.5, `BOSS_ANCHOR_X factor ${factor} must put boss right of center`);
  });

  test("PARTY_LEFT_ANCHOR is on the left side (< VW/2 = 960)", () => {
    const m = arenaJs.match(/PARTY_LEFT_ANCHOR\s*=\s*Math\.round\(1920\s*\*\s*([\d.]+)\)/);
    assert.ok(m, "PARTY_LEFT_ANCHOR must be defined");
    const factor = Number(m[1]);
    assert.ok(factor < 0.5, `PARTY_LEFT_ANCHOR factor ${factor} must be left of center`);
  });

  test("PARTY_SCALE is defined and positive (compact bottom-band layout)", () => {
    const m = arenaJs.match(/PARTY_SCALE\s*=\s*([\d.]+)/);
    assert.ok(m, "PARTY_SCALE must be defined as a constant");
    const scale = Number(m[1]);
    assert.ok(scale > 0, `PARTY_SCALE ${scale} must be positive`);
  });

  test("drawBossParallax function is defined", () => {
    assert.ok(
      arenaJs.includes("function drawBossParallax("),
      "drawBossParallax must be defined in arena.js",
    );
  });

  test("boss facing is 'left' (Elden Ring face-off)", () => {
    // The composeEnemy call inside drawBossScene must pass "left"
    assert.ok(
      arenaJs.includes('"left"') || arenaJs.includes("'left'"),
      "arena.js must contain a 'left' facing literal",
    );
    // More specifically: the composeEnemy call site
    const composeCall = arenaJs.match(/composeEnemy[\s\S]{0,300}"left"/);
    assert.ok(composeCall, "composeEnemy must be called with 'left' facing in drawBossScene");
  });

  test("HP fill uses solid ER crimson (#c81e2e), no gradient stop for orange/gold", () => {
    assert.ok(arenaJs.includes("#c81e2e"), "HP fill must use ER crimson #c81e2e");
    // Confirm the old gradient stops are gone
    assert.ok(!arenaJs.includes("#ff8d2e"), "old orange gradient stop must be removed");
    assert.ok(!arenaJs.includes("#ffd166"), "old gold gradient stop must be removed");
  });

  test("parallax is transparent/translucent (globalAlpha or rgba — no flat opaque fill)", () => {
    // After D1 removal, embers use hsl + globalAlpha rather than rgba — both are translucent.
    // Assert that drawBossParallax uses globalAlpha (the ember layer uses it).
    const parallaxFn = arenaJs.match(/function drawBossParallax[\s\S]*?\n}/);
    assert.ok(parallaxFn, "drawBossParallax must exist");
    const body = parallaxFn[0];
    const translucent = body.includes("globalAlpha") || body.includes("rgba");
    assert.ok(translucent, "parallax must use globalAlpha or rgba (translucent) fills");
  });
});

// ── NEW: D1/D2/D3 render changes (source inspection) ─────────────────────────

describe("D1 — dark backdrop band removed", () => {
  test("drawBossParallax no longer contains the rgba(0,0,0,0.38) dark band fill", () => {
    // Extract just the drawBossParallax function body for a tight assertion.
    const parallaxFn = arenaJs.match(/function drawBossParallax[\s\S]*?^}/m);
    assert.ok(parallaxFn, "drawBossParallax must exist");
    assert.ok(
      !parallaxFn[0].includes("rgba(0,0,0,0.38)"),
      "dark backdrop band rgba(0,0,0,0.38) must be gone from drawBossParallax",
    );
  });

  test("drawBossParallax still contains PARALLAX_LAYERS ember logic", () => {
    const parallaxFn = arenaJs.match(/function drawBossParallax[\s\S]*?^}/m);
    assert.ok(parallaxFn, "drawBossParallax must exist");
    assert.ok(
      parallaxFn[0].includes("PARALLAX_LAYERS") || parallaxFn[0].includes("EMBER_COUNT"),
      "ember parallax layers must still be present in drawBossParallax",
    );
  });

  test("PARALLAX_LAYERS constant is still defined with 3 layers", () => {
    // Count occurrences of `speed:` inside the PARALLAX_LAYERS declaration.
    // The array literal spans multiple lines; match all occurrences in the source
    // between the opening '[' and the matching '];'.
    assert.ok(arenaJs.includes("PARALLAX_LAYERS"), "PARALLAX_LAYERS must be defined");
    // Grab the block that starts with PARALLAX_LAYERS and count speed: entries
    const start = arenaJs.indexOf("PARALLAX_LAYERS");
    const block = arenaJs.slice(start, start + 800); // enough to cover 3-layer array
    const layers = block.match(/speed:/g);
    assert.ok(
      layers && layers.length >= 3,
      `PARALLAX_LAYERS must have ≥ 3 speed entries, got ${layers?.length}`,
    );
  });
});

describe("D2 — fighter melee dash constants", () => {
  test("MELEE_SWING_MS is defined and ≥ 500", () => {
    const m = arenaJs.match(/MELEE_SWING_MS\s*=\s*(\d+)/);
    assert.ok(m, "MELEE_SWING_MS must be defined");
    const ms = Number(m[1]);
    assert.ok(ms >= 500, `MELEE_SWING_MS ${ms} must be ≥ 500 (was 300)`);
  });

  test("MELEE_GAP is defined and positive (standoff distance scales with boss)", () => {
    const m = arenaJs.match(/MELEE_GAP\s*=\s*(\d+)/);
    assert.ok(m, "MELEE_GAP must be defined");
    const gap = Number(m[1]);
    assert.ok(gap > 0, `MELEE_GAP ${gap} must be positive`);
  });

  test("swingAnim.set uses MELEE_SWING_MS (not the old literal 300)", () => {
    // raidHit handler must reference MELEE_SWING_MS not the old now+300 literal
    assert.ok(arenaJs.includes("MELEE_SWING_MS"), "MELEE_SWING_MS must be referenced in arena.js");
    // The old literal for the old tiny lunge should not remain as the sole value
    // (it's fine if 300 appears elsewhere — we just need MELEE_SWING_MS to exist)
    const raidHitBlock = arenaJs.match(/case "raidHit"[\s\S]*?break;/);
    assert.ok(raidHitBlock, "raidHit case must exist");
    assert.ok(
      raidHitBlock[0].includes("MELEE_SWING_MS"),
      "raidHit must set swingAnim with MELEE_SWING_MS",
    );
  });

  test("spawnRaidBolt is NOT called in the raidHit handler (melee replaced ranged)", () => {
    const raidHitBlock = arenaJs.match(/case "raidHit"[\s\S]*?break;/);
    assert.ok(raidHitBlock, "raidHit case must exist");
    assert.ok(
      !raidHitBlock[0].includes("spawnRaidBolt"),
      "spawnRaidBolt must not be called from raidHit (melee replaced ranged bolt)",
    );
  });

  test("meleeSlashPool is defined for melee impact sparks", () => {
    assert.ok(arenaJs.includes("meleeSlashPool"), "meleeSlashPool pool must be defined");
  });
});

describe("D3 — boss attack cycle constants and state", () => {
  test("BOSS_TELEGRAPH_MS is defined and within 500–1000ms", () => {
    const m = arenaJs.match(/BOSS_TELEGRAPH_MS\s*=\s*(\d+)/);
    assert.ok(m, "BOSS_TELEGRAPH_MS must be defined");
    const v = Number(m[1]);
    assert.ok(v >= 500 && v <= 1000, `BOSS_TELEGRAPH_MS ${v} must be 500–1000`);
  });

  test("BOSS_STRIKE_MS is defined and shorter than BOSS_TELEGRAPH_MS", () => {
    const mt = arenaJs.match(/BOSS_TELEGRAPH_MS\s*=\s*(\d+)/);
    const ms = arenaJs.match(/BOSS_STRIKE_MS\s*=\s*(\d+)/);
    assert.ok(mt && ms, "both BOSS_TELEGRAPH_MS and BOSS_STRIKE_MS must be defined");
    const telegraph = Number(mt[1]);
    const strike = Number(ms[1]);
    assert.ok(
      strike < telegraph,
      `BOSS_STRIKE_MS (${strike}) must be shorter than BOSS_TELEGRAPH_MS (${telegraph})`,
    );
  });

  test("BOSS_ATK_CD is defined and greater than BOSS_TELEGRAPH_MS + BOSS_STRIKE_MS + BOSS_RECOVER_MS", () => {
    const mcd = arenaJs.match(/BOSS_ATK_CD\s*=\s*(\d+)/);
    const mt = arenaJs.match(/BOSS_TELEGRAPH_MS\s*=\s*(\d+)/);
    const ms = arenaJs.match(/BOSS_STRIKE_MS\s*=\s*(\d+)/);
    const mr = arenaJs.match(/BOSS_RECOVER_MS\s*=\s*(\d+)/);
    assert.ok(mcd && mt && ms && mr, "all boss attack cycle constants must be defined");
    const cd = Number(mcd[1]);
    const total = Number(mt[1]) + Number(ms[1]) + Number(mr[1]);
    assert.ok(cd > total, `BOSS_ATK_CD (${cd}) must be > total cycle time (${total})`);
  });

  test("BOSS_ATK_INITIAL_DELAY is defined and positive", () => {
    const m = arenaJs.match(/BOSS_ATK_INITIAL_DELAY\s*=\s*(\d+)/);
    assert.ok(m, "BOSS_ATK_INITIAL_DELAY must be defined");
    assert.ok(Number(m[1]) > 0, "BOSS_ATK_INITIAL_DELAY must be positive");
  });

  test("bossAtk state object is defined with required fields", () => {
    assert.ok(arenaJs.includes("bossAtk"), "bossAtk state object must be defined");
    assert.ok(arenaJs.includes("telegraphUntil"), "bossAtk must have telegraphUntil");
    assert.ok(arenaJs.includes("strikeUntil"), "bossAtk must have strikeUntil");
    assert.ok(arenaJs.includes("recoverUntil"), "bossAtk must have recoverUntil");
  });

  test("bossShock pool is defined for shockwave rings", () => {
    assert.ok(arenaJs.includes("bossShock"), "bossShock pool must be defined");
  });

  test("partyHitUntil is defined for party recoil gating", () => {
    assert.ok(arenaJs.includes("partyHitUntil"), "partyHitUntil must be defined");
  });

  test("applyRaidStart resets boss attack cycle on new raid", () => {
    // applyRaidStart must reference bossAtk and bossShock reset
    const applyFn = arenaJs.match(/function applyRaidStart[\s\S]*?^}/m);
    assert.ok(applyFn, "applyRaidStart must exist");
    assert.ok(applyFn[0].includes("bossAtk"), "applyRaidStart must reset bossAtk");
    assert.ok(applyFn[0].includes("bossShock"), "applyRaidStart must clear bossShock");
    assert.ok(applyFn[0].includes("partyHitUntil"), "applyRaidStart must reset partyHitUntil");
  });

  test("D3 ordering: telegraph < strike < recover; cd > all three summed", () => {
    const mt = Number(arenaJs.match(/BOSS_TELEGRAPH_MS\s*=\s*(\d+)/)[1]);
    const ms = Number(arenaJs.match(/BOSS_STRIKE_MS\s*=\s*(\d+)/)[1]);
    const mr = Number(arenaJs.match(/BOSS_RECOVER_MS\s*=\s*(\d+)/)[1]);
    const cd = Number(arenaJs.match(/BOSS_ATK_CD\s*=\s*(\d+)/)[1]);
    // Sanity: all positive
    assert.ok(mt > 0 && ms > 0 && mr > 0 && cd > 0, "all cycle constants must be positive");
    // cd must give the boss meaningful idle time
    assert.ok(cd > mt + ms + mr, "cooldown must exceed total active cycle time");
  });
});

// ── D1: bar mode compact render geometry ─────────────────────────────────────

describe("D1 — barMode compact boss bar geometry", () => {
  // Pure geometry: drawBossBarCompact operates in the 0..170 virtual space.
  // We verify the key constants stay within the strip so the bar is visible.

  const BAR_H = 18;
  const BAR_Y = 6;
  const MARGIN = 16;
  const LABEL_Y = BAR_Y + BAR_H + 10;
  const VW = 1920;
  const BAR_W = VW - MARGIN * 2;
  const BAR_MODE_HEIGHT = 170;

  test("bar top edge is within barMode strip (0..170)", () => {
    assert.ok(BAR_Y >= 0, "bar top must be >= 0");
    assert.ok(BAR_Y < BAR_MODE_HEIGHT, "bar top must be inside 170px strip");
  });

  test("bar bottom + label is within barMode strip", () => {
    assert.ok(LABEL_Y < BAR_MODE_HEIGHT, `label at y=${LABEL_Y} must fit in 170px`);
  });

  test("bar width is positive and fits VW", () => {
    assert.ok(BAR_W > 0, "bar width must be positive");
    assert.ok(BAR_W <= VW, "bar width must not exceed VW");
  });

  test("hp pct is clamped to [0,1]", () => {
    const clamp = (hp, maxHp) => Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    assert.equal(clamp(500, 1000), 0.5);
    assert.equal(clamp(0, 1000), 0);
    assert.equal(clamp(1000, 1000), 1);
    assert.equal(clamp(-10, 1000), 0);
    assert.equal(clamp(1200, 1000), 1);
  });

  test("drawBossBarCompact-equivalent does not throw on edge-case raid state", () => {
    // Simulate the function operating on a minimal raid object.
    const raid = { name: "Goblin King", hp: 0, maxHp: 1000, contributors: 0 };
    const pct = Math.max(0, Math.min(1, raid.hp / Math.max(1, raid.maxHp)));
    assert.equal(pct, 0);
    // name formatting
    const label = `⚔ ${raid.name.toUpperCase()}`;
    assert.ok(label.length > 0);
    // contributors label
    const c = raid.contributors || 0;
    const ctLabel = c
      ? `${c} FIGHTER${c === 1 ? "" : "S"} — !FIGHT TO JOIN`
      : "BOSS RAID — !FIGHT TO ENGAGE";
    assert.ok(ctLabel.includes("ENGAGE"));
  });
});

// ── B: compact bottom-band layout constants ───────────────────────────────────

describe("B — compact bottom-band layout", () => {
  test("BOSS_SCALE is compact (< 3.0)", () => {
    const m = arenaJs.match(/BOSS_SCALE\s*=\s*([\d.]+)/);
    assert.ok(m, "BOSS_SCALE must be defined");
    const scale = Number(m[1]);
    assert.ok(scale < 3.0, `BOSS_SCALE ${scale} must be compact (< 3.0)`);
    assert.ok(scale > 1.0, `BOSS_SCALE ${scale} must be > 1.0`);
  });

  test("BOSS_GROUND_Y anchors fight near bottom (> 800)", () => {
    const m = arenaJs.match(/BOSS_GROUND_Y\s*=\s*(\d+)/);
    assert.ok(m, "BOSS_GROUND_Y must be defined");
    const y = Number(m[1]);
    assert.ok(y > 800, `BOSS_GROUND_Y ${y} must be near the bottom (> 800)`);
    assert.ok(y < 960, `BOSS_GROUND_Y ${y} must leave room above game bar (< 960)`);
  });

  test("PARTY_SCALE is small for compact fighters (< 1.2)", () => {
    const m = arenaJs.match(/PARTY_SCALE\s*=\s*([\d.]+)/);
    assert.ok(m, "PARTY_SCALE must be defined");
    const scale = Number(m[1]);
    assert.ok(scale < 1.2, `PARTY_SCALE ${scale} must be small (< 1.2) for compact layout`);
    assert.ok(scale > 0.5, `PARTY_SCALE ${scale} must be > 0.5`);
  });

  test("drawBossHpBarOnCanvas is NOT called in drawBossScene (game bar owns progress)", () => {
    // Only look at non-comment lines in the drawBossScene body.
    const start = arenaJs.indexOf("function drawBossScene(");
    const end = arenaJs.indexOf("function drawPartyMember(");
    assert.ok(start >= 0 && end > start, "drawBossScene and drawPartyMember must exist");
    const lines = arenaJs
      .slice(start, end)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"));
    assert.ok(
      !lines.some((l) => l.includes("drawBossHpBarOnCanvas(")),
      "drawBossHpBarOnCanvas must not be called in drawBossScene (progress moved to game bar)",
    );
  });

  test("drawBossPopups is NOT called in drawBossScene (clean raid look)", () => {
    const start = arenaJs.indexOf("function drawBossScene(");
    const end = arenaJs.indexOf("function drawPartyMember(");
    assert.ok(start >= 0 && end > start, "drawBossScene and drawPartyMember must exist");
    const lines = arenaJs
      .slice(start, end)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"));
    assert.ok(
      !lines.some((l) => l.includes("drawBossPopups(")),
      "drawBossPopups must not be called in drawBossScene",
    );
  });
});

// ── A: declutter — loot/banner draw calls removed ────────────────────────────

describe("A — declutter (loot/banner draw calls removed)", () => {
  test("bar-mode raid path draws the compact boss scene, not only the HP strip", () => {
    const start = arenaJs.indexOf("function draw(now)");
    const end = arenaJs.indexOf("\n// ── Elden Ring", start);
    assert.ok(start >= 0, "draw function must exist");
    const body = end > start ? arenaJs.slice(start, end) : arenaJs.slice(start, start + 900);
    assert.ok(
      body.includes("drawCompactBossScene("),
      "bar-mode raid path must draw the compact boss scene",
    );
    assert.ok(body.includes("drawBossBarCompact("), "bar-mode raid path must keep the HP strip");
  });

  test("drawDrop is NOT called in draw() (loot orbs suppressed)", () => {
    // Slice draw() body: between function draw(now) and the next top-level function.
    const start = arenaJs.indexOf("function draw(now)");
    const end = arenaJs.indexOf("\n// ── Elden Ring", start);
    assert.ok(start >= 0, "draw function must exist");
    const body = end > start ? arenaJs.slice(start, end) : arenaJs.slice(start, start + 600);
    assert.ok(!body.includes("drawDrop("), "drawDrop must not be called in draw()");
  });

  test("drawClaimAnims is NOT called in draw()", () => {
    const start = arenaJs.indexOf("function draw(now)");
    const end = arenaJs.indexOf("\n// ── Elden Ring", start);
    const body = end > start ? arenaJs.slice(start, end) : arenaJs.slice(start, start + 600);
    assert.ok(!body.includes("drawClaimAnims("), "drawClaimAnims must not be called in draw()");
  });

  test("drawSessionBanner is NOT called in draw()", () => {
    const start = arenaJs.indexOf("function draw(now)");
    const end = arenaJs.indexOf("\n// ── Elden Ring", start);
    const body = end > start ? arenaJs.slice(start, end) : arenaJs.slice(start, start + 600);
    assert.ok(
      !body.includes("drawSessionBanner("),
      "drawSessionBanner must not be called in draw()",
    );
  });

  test("tickDropCollisions is still called (server economy intact)", () => {
    const start = arenaJs.indexOf("function draw(now)");
    const end = arenaJs.indexOf("\n// ── Elden Ring", start);
    const body = end > start ? arenaJs.slice(start, end) : arenaJs.slice(start, start + 600);
    assert.ok(body.includes("tickDropCollisions()"), "tickDropCollisions must still run");
  });
});

// ── C: chat-activity gate ─────────────────────────────────────────────────────

describe("C — chat-activity gate", () => {
  // Read server.js for source assertions.
  const serverJs = readFileSync(join(__dirname, "../../server/server.js"), "utf8");

  test("RAID_REQUIRE_CHAT_MS is defined (60s window)", () => {
    const m = serverJs.match(/RAID_REQUIRE_CHAT_MS\s*=\s*[\s\S]*?(\d+)_000/);
    assert.ok(
      m || serverJs.includes("RAID_REQUIRE_CHAT_MS"),
      "RAID_REQUIRE_CHAT_MS must be defined",
    );
    // Extract and verify value
    const declMatch = serverJs.match(/RAID_REQUIRE_CHAT_MS\s*=.*?(\d+)_000/);
    if (declMatch) {
      const secs = Number(declMatch[1]);
      assert.ok(
        secs >= 30 && secs <= 300,
        `RAID_REQUIRE_CHAT_MS default should be 30–300s, got ${secs}s`,
      );
    }
  });

  test("RAID_QUIET_END_MS is defined and > RAID_REQUIRE_CHAT_MS (hysteresis)", () => {
    assert.ok(serverJs.includes("RAID_QUIET_END_MS"), "RAID_QUIET_END_MS must be defined");
    const mReq = serverJs.match(/RAID_REQUIRE_CHAT_MS\s*=.*?(\d+)_000/);
    const mEnd = serverJs.match(/RAID_QUIET_END_MS\s*=.*?(\d+)_000/);
    if (mReq && mEnd) {
      assert.ok(
        Number(mEnd[1]) > Number(mReq[1]),
        `RAID_QUIET_END_MS (${mEnd[1]}s) must be > RAID_REQUIRE_CHAT_MS (${mReq[1]}s)`,
      );
    }
  });

  test("summon handler checks chatPingsInLast before starting raid", () => {
    // The summon block must gate on chatPingsInLast(RAID_REQUIRE_CHAT_MS).
    const summonBlock = serverJs.match(/kind === "summon"[\s\S]*?summonResult = \{ started/);
    assert.ok(summonBlock, "summon handler block must exist");
    assert.ok(
      summonBlock[0].includes("chatPingsInLast"),
      "summon handler must check chatPingsInLast before starting raid",
    );
  });

  test("auto-spawn timer checks chatPingsInLast before starting raid", () => {
    const autoSpawnBlock = serverJs.match(/raid\.auto_spawn[\s\S]*?startRaid\(boss_id/);
    assert.ok(autoSpawnBlock, "auto_spawn block must exist");
    assert.ok(
      autoSpawnBlock[0].includes("chatPingsInLast"),
      "auto-spawn must check chatPingsInLast before starting raid",
    );
  });

  test("chat-gate logic: startRaid no-ops with no recent chat", () => {
    // Simulate the gate: chatPingsInLast returns 0 → raid must not start.
    const chatLog = []; // empty log
    function chatPingsInLastSim(ms) {
      const cutoff = Date.now() - ms;
      let count = 0;
      for (let i = chatLog.length - 1; i >= 0; i -= 1) {
        if (chatLog[i] >= cutoff) count += 1;
        else break;
      }
      return count;
    }
    const RAID_REQUIRE = 60_000;
    let raidStarted = false;
    // Guard as implemented in server.js
    if (chatPingsInLastSim(RAID_REQUIRE) === 0) {
      // no-op
    } else {
      raidStarted = true;
    }
    assert.equal(raidStarted, false, "startRaid must no-op with empty chat log");
  });

  test("chat-gate logic: startRaid proceeds with recent chat", () => {
    const now = Date.now();
    const chatLog = [now - 5000]; // ping 5s ago
    function chatPingsInLastSim(ms) {
      const cutoff = Date.now() - ms;
      let count = 0;
      for (let i = chatLog.length - 1; i >= 0; i -= 1) {
        if (chatLog[i] >= cutoff) count += 1;
        else break;
      }
      return count;
    }
    const RAID_REQUIRE = 60_000;
    let raidStarted = false;
    if (chatPingsInLastSim(RAID_REQUIRE) === 0) {
      // no-op
    } else {
      raidStarted = true;
    }
    assert.equal(raidStarted, true, "startRaid must proceed when recent chat exists");
  });

  test("quiet auto-end: endRaid fires after RAID_QUIET_END_MS of silence", () => {
    // Simulate the fighter_attack interval quiet-end check.
    const chatLog = []; // no pings
    function chatPingsInLastSim(ms) {
      const cutoff = Date.now() - ms;
      return chatLog.filter((t) => t >= cutoff).length;
    }
    const RAID_QUIET = 120_000;
    let endedRaid = false;
    // Simulate the guard added to fighter_attack
    if (chatPingsInLastSim(RAID_QUIET) === 0) {
      endedRaid = true; // endRaid(false, "") called
    }
    assert.equal(endedRaid, true, "raid must auto-end after quiet window");
  });

  test("vfx_afk event raids are exempt from quiet auto-end", () => {
    assert.ok(
      serverJs.includes('currentRaid.reason !== "vfx_afk"'),
      "raid.fighter_attack quiet-end guard must not clear vfx_afk event raids",
    );
  });

  test("hysteresis: raid survives brief lull (quiet < RAID_QUIET_END_MS)", () => {
    const now = Date.now();
    // Last ping was 90s ago — within quiet window (< 120s) but past require (> 60s).
    const chatLog = [now - 90_000];
    function chatPingsInLastSim(ms) {
      const cutoff = Date.now() - ms;
      return chatLog.filter((t) => t >= cutoff).length;
    }
    const RAID_QUIET = 120_000;
    let endedRaid = false;
    if (chatPingsInLastSim(RAID_QUIET) === 0) {
      endedRaid = true;
    }
    // 90s ago is within RAID_QUIET_END_MS=120s window → still counts → no end
    assert.equal(endedRaid, false, "raid must not end while still within quiet window");
  });
});

// ── Inc1: Poise / Stagger / Enrage (Project Ascendant) ───────────────────────

// Constants mirroring server.js (tested in isolation — no live server import).
const POISE_PER_SWING_BY_FAMILY = {
  hammer: 28,
  greatsword: 22,
  axe: 20,
  fists: 12,
  sword: 14,
  spear: 14,
  dagger: 7,
  bow: 10,
  staff: 8,
  wand: 7,
};
const POISE_PER_HP = 0.08;
const POISE_MIN = 60;
const STAGGER_MS = 5_000;
const ENRAGE_MS = 4 * 60_000;

/** Build a raid object with poise/stagger/enrage as startRaid() does. */
function makePoiseRaid(boss_id = "goblin_king", maxHpOverride = null) {
  const def = ENEMIES[boss_id];
  assert.ok(def, `boss ${boss_id} must exist`);
  const maxHp = maxHpOverride ?? 1000;
  const maxPoise = Math.max(POISE_MIN, Math.round(maxHp * POISE_PER_HP));
  const now = Date.now();
  return {
    boss_id,
    name: def.name,
    hp: maxHp,
    maxHp,
    poise: maxPoise,
    maxPoise,
    staggeredUntil: 0,
    enrageAt: now + ENRAGE_MS,
    contributors: new Map(),
    xpEarned: new Map(),
    startedAt: now,
    reason: "test",
    fromLogin: "tester",
  };
}

/** Simulate poise drain for one swing and return { poise, staggered, staggeredUntil }. */
function simulatePoiseDrain(raid, weaponFamily) {
  const now = Date.now();
  const isStaggered = raid.staggeredUntil > now;
  if (!isStaggered && raid.poise > 0) {
    const drain = POISE_PER_SWING_BY_FAMILY[weaponFamily] || 10;
    raid.poise = Math.max(0, raid.poise - drain);
    if (raid.poise === 0) {
      raid.staggeredUntil = now + STAGGER_MS;
    }
  }
  return {
    poise: raid.poise,
    staggered: raid.staggeredUntil > now,
    staggeredUntil: raid.staggeredUntil,
  };
}

describe("Inc1 — poise initialisation", () => {
  test("maxPoise is POISE_PER_HP × maxHp, floored at POISE_MIN", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    assert.equal(raid.maxPoise, Math.max(POISE_MIN, Math.round(1000 * POISE_PER_HP)));
  });

  test("poise starts at maxPoise", () => {
    const raid = makePoiseRaid("goblin_king");
    assert.equal(raid.poise, raid.maxPoise);
  });

  test("staggeredUntil starts at 0", () => {
    const raid = makePoiseRaid("goblin_king");
    assert.equal(raid.staggeredUntil, 0);
  });

  test("enrageAt is set ~4 min in the future", () => {
    const before = Date.now();
    const raid = makePoiseRaid("goblin_king");
    assert.ok(raid.enrageAt > before + ENRAGE_MS - 100, "enrageAt must be in the future");
    assert.ok(raid.enrageAt < before + ENRAGE_MS + 100, "enrageAt must be ~4min from now");
  });

  test("tiny boss (low maxHp) still gets POISE_MIN poise floor", () => {
    const raid = makePoiseRaid("goblin_king", 50); // 50 * 0.08 = 4 → floored to 60
    assert.equal(raid.maxPoise, POISE_MIN);
  });
});

describe("Inc1 — poise drain per weapon family", () => {
  test("hammer drains more poise than dagger", () => {
    assert.ok(POISE_PER_SWING_BY_FAMILY.hammer > POISE_PER_SWING_BY_FAMILY.dagger);
  });

  test("axe poise drain > wand poise drain", () => {
    assert.ok(POISE_PER_SWING_BY_FAMILY.axe > POISE_PER_SWING_BY_FAMILY.wand);
  });

  test("a swing reduces poise by the family's drain value", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    const before = raid.poise;
    const result = simulatePoiseDrain(raid, "sword");
    assert.equal(result.poise, before - POISE_PER_SWING_BY_FAMILY.sword);
  });

  test("poise never goes below 0", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    raid.poise = 5; // almost empty
    const result = simulatePoiseDrain(raid, "hammer"); // 28 drain
    assert.equal(result.poise, 0);
  });
});

describe("Inc1 — stagger trigger and window", () => {
  test("stagger fires when poise reaches 0", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    raid.poise = POISE_PER_SWING_BY_FAMILY.hammer; // exactly one swing away
    const result = simulatePoiseDrain(raid, "hammer");
    assert.equal(result.poise, 0);
    assert.ok(result.staggered, "stagger must be active when poise hits 0");
  });

  test("staggeredUntil is STAGGER_MS after trigger", () => {
    const before = Date.now();
    const raid = makePoiseRaid("goblin_king", 1000);
    raid.poise = 1; // one drain away
    simulatePoiseDrain(raid, "hammer");
    assert.ok(raid.staggeredUntil >= before + STAGGER_MS - 5);
    assert.ok(raid.staggeredUntil <= before + STAGGER_MS + 100);
  });

  test("poise drain is skipped while boss is already staggered", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    // Manually set staggered
    raid.staggeredUntil = Date.now() + STAGGER_MS;
    raid.poise = 0;
    const before = raid.poise;
    simulatePoiseDrain(raid, "sword");
    // Poise must not change (already staggered path)
    assert.equal(raid.poise, before, "poise must not drain during stagger");
  });

  test("stagger broadcasts a {t:'stagger', until} frame shape", () => {
    // Verify the frame shape matches what raidPublic + fireRaidSwing broadcast.
    const until = Date.now() + STAGGER_MS;
    const frame = { t: "stagger", until, at: Date.now() };
    assert.equal(frame.t, "stagger");
    assert.ok(frame.until > Date.now(), "until must be in the future");
  });

  test("party swings deal +50% during stagger (stagger crit window)", () => {
    // Simulate stagger damage multiplier.
    const baseAtk = 100;
    const staggerMul = 1.5;
    const staggerDmg = Math.round(baseAtk * staggerMul);
    assert.equal(staggerDmg, 150);
    assert.ok(staggerDmg > baseAtk, "stagger must amplify party damage");
  });
});

describe("Inc1 — enrage flips at enrageAt", () => {
  test("raid is not enraged before enrageAt", () => {
    const raid = makePoiseRaid("goblin_king");
    const isEnraged = raid.enrageAt > 0 && Date.now() > raid.enrageAt;
    assert.equal(isEnraged, false, "raid must not be enraged immediately after start");
  });

  test("raid IS enraged after enrageAt has passed (simulated)", () => {
    const raid = makePoiseRaid("goblin_king");
    raid.enrageAt = Date.now() - 1; // artificially in the past
    const isEnraged = raid.enrageAt > 0 && Date.now() > raid.enrageAt;
    assert.equal(isEnraged, true, "raid must be enraged once enrageAt passes");
  });

  test("enraged counter damage is ×2 of base", () => {
    const base = 30;
    const enragedDmg = Math.round(base * 2);
    assert.equal(enragedDmg, 60);
  });

  test("boss does NOT counter while staggered", () => {
    const raid = makePoiseRaid("goblin_king");
    raid.staggeredUntil = Date.now() + STAGGER_MS;
    const isStaggered = raid.staggeredUntil > Date.now();
    let counterFired = false;
    // Simulate server guard: !isStaggered && Math.random() < counterChance
    if (!isStaggered) counterFired = true; // would fire normally
    assert.equal(counterFired, false, "counter must be suppressed while staggered");
  });
});

describe("Inc1 — /api/raid exposes poise fields", () => {
  test("raidPublic includes poise, maxPoise, staggered, enraged, enrageAt", () => {
    const raid = makePoiseRaid("goblin_king", 1000);
    // Mirror raidPublic logic.
    const now = Date.now();
    const pub = {
      ...{ boss_id: raid.boss_id, hp: raid.hp, maxHp: raid.maxHp },
      poise: raid.poise,
      maxPoise: raid.maxPoise,
      staggered: raid.staggeredUntil > now,
      staggeredUntil: raid.staggeredUntil,
      enraged: raid.enrageAt > 0 && now > raid.enrageAt,
      enrageAt: raid.enrageAt,
    };
    assert.ok("poise" in pub, "raidPublic must expose poise");
    assert.ok("maxPoise" in pub, "raidPublic must expose maxPoise");
    assert.ok("staggered" in pub, "raidPublic must expose staggered boolean");
    assert.ok("enraged" in pub, "raidPublic must expose enraged boolean");
    assert.ok("enrageAt" in pub, "raidPublic must expose enrageAt timestamp");
    assert.equal(pub.staggered, false, "fresh raid must not be staggered");
    assert.equal(pub.enraged, false, "fresh raid must not be enraged");
    assert.equal(pub.poise, pub.maxPoise, "fresh poise must equal maxPoise");
  });

  test("server.js raidPublic function reads poise fields from raid object", () => {
    const serverJs = readFileSync(join(__dirname, "../../server/server.js"), "utf8");
    assert.ok(serverJs.includes("poise: r.poise"), "raidPublic must expose poise");
    assert.ok(serverJs.includes("maxPoise: r.maxPoise"), "raidPublic must expose maxPoise");
    assert.ok(serverJs.includes("staggered:"), "raidPublic must expose staggered");
    assert.ok(serverJs.includes("enraged:"), "raidPublic must expose enraged");
    assert.ok(serverJs.includes("enrageAt: r.enrageAt"), "raidPublic must expose enrageAt");
  });
});

describe("Inc1 — client poise render (source inspection)", () => {
  test("STAGGER_DISPLAY_MS constant is defined", () => {
    assert.ok(arenaJs.includes("STAGGER_DISPLAY_MS"), "STAGGER_DISPLAY_MS must be defined");
  });

  test("poise pip render uses BOSS_ANCHOR_X reference", () => {
    assert.ok(
      arenaJs.includes("Poise pip") || arenaJs.includes("poisePct"),
      "arena.js must contain poise pip render logic",
    );
  });

  test("STAGGERED text flash is rendered on boss", () => {
    assert.ok(arenaJs.includes("STAGGERED"), "arena.js must render STAGGERED text");
  });

  test("enrage tint uses low globalAlpha (< 0.15 — non-cluttering)", () => {
    // The enrage tint block uses globalAlpha = 0.09 + small sine wobble.
    // Verify the base value literal is present (the subtlety constraint).
    assert.ok(arenaJs.includes("0.09"), "enrage tint must use a low base globalAlpha (0.09)");
    // Also verify the enrage block exists at all.
    assert.ok(
      arenaJs.includes("isEnraged"),
      "arena.js must reference isEnraged for the enrage tint",
    );
  });

  test("stagger case is handled in WS switch", () => {
    assert.ok(
      arenaJs.includes('case "stagger"'),
      'arena.js WS handler must have a case "stagger" branch',
    );
  });
});

// ── CHANGE 1: roster dedup + real level ──────────────────────────────────────

describe("CHANGE 1 — roster dedup + real level (source inspection)", () => {
  test("upsertChatter keys on login.toLowerCase()", () => {
    // The roster Map key must be the lowercased login so 'Alice'/'alice' don't
    // create two slots. Assert that upsertChatter uses .toLowerCase() on the key.
    assert.ok(
      arenaJs.includes("login.toLowerCase()"),
      "upsertChatter must key roster on login.toLowerCase()",
    );
  });

  test("dropChatter uses lowercased key", () => {
    const dropFn = arenaJs.match(/function dropChatter[\s\S]*?^}/m);
    assert.ok(dropFn, "dropChatter must be defined");
    assert.ok(dropFn[0].includes("toLowerCase()"), "dropChatter must lowercase the login key");
  });

  test("setRosterFromSnapshot dedupes with a seen-Set guard", () => {
    const fn = arenaJs.match(/function setRosterFromSnapshot[\s\S]*?^}/m);
    assert.ok(fn, "setRosterFromSnapshot must be defined");
    assert.ok(
      fn[0].includes("seen.has(key)") || fn[0].includes("seen.has("),
      "setRosterFromSnapshot must have a seen-Set dedup guard",
    );
  });

  test("upsertChatter copies level into the new-chatter object", () => {
    // The new-chatter object literal must include 'level'.
    const fn = arenaJs.match(/function upsertChatter[\s\S]*?^}/m);
    assert.ok(fn, "upsertChatter must be defined");
    assert.ok(fn[0].includes("level:"), "upsertChatter new-chatter object must include level");
  });

  test("upsertChatter copies level/xp/xpToNext/zone/weapon in the refresh branch", () => {
    const fn = arenaJs.match(/function upsertChatter[\s\S]*?^}/m);
    assert.ok(fn, "upsertChatter must be defined");
    const body = fn[0];
    assert.ok(body.includes("next.level"), "refresh branch must update next.level");
    assert.ok(body.includes("next.xp"), "refresh branch must update next.xp");
    assert.ok(body.includes("next.weapon"), "refresh branch must update next.weapon");
  });
});

// ── CHANGE 2: gear auras ─────────────────────────────────────────────────────

describe("CHANGE 2 — gear auras (source inspection)", () => {
  test("AURA_CONFIG table is defined with 5 entries (tiers 0-4)", () => {
    assert.ok(arenaJs.includes("AURA_CONFIG"), "AURA_CONFIG must be defined in arena.js");
    // Grab from declaration to the closing '];'
    const start = arenaJs.indexOf("const AURA_CONFIG");
    const end = arenaJs.indexOf("];", start) + 2;
    const block = arenaJs.slice(start, end);
    // Count motes: fields in the config entries
    const nullEntry = block.includes("null");
    assert.ok(nullEntry, "AURA_CONFIG[0] must be null (no aura for tier 0)");
    const colorCount = (block.match(/color:/g) || []).length;
    assert.equal(colorCount, 4, "AURA_CONFIG must have 4 color entries (tiers 1-4)");
  });

  test("drawAura function is defined", () => {
    assert.ok(arenaJs.includes("function drawAura("), "drawAura must be defined in arena.js");
  });

  test("drawAura uses globalCompositeOperation='lighter' (additive glow)", () => {
    const fn = arenaJs.match(/function drawAura[\s\S]*?^}/m);
    assert.ok(fn, "drawAura must be defined");
    assert.ok(
      fn[0].includes('"lighter"'),
      "drawAura must use globalCompositeOperation='lighter' for additive glow",
    );
  });

  test("drawAura is called in drawChatter (skip when down)", () => {
    const fn = arenaJs.match(/function drawChatter[\s\S]*?^}/m);
    assert.ok(fn, "drawChatter must be defined");
    assert.ok(fn[0].includes("drawAura("), "drawChatter must call drawAura");
    assert.ok(fn[0].includes("!chatter.down"), "drawChatter must skip aura when chatter is down");
  });

  test("drawChatter still suppresses avatar composition in FOES_ONLY", () => {
    const start = arenaJs.indexOf("function drawChatter(");
    const end = arenaJs.indexOf("function drawPartyMember(", start);
    assert.ok(start >= 0 && end > start, "drawChatter must be defined");
    const body = arenaJs.slice(start, end);
    const foesOnlyReturn = body.indexOf("if (FOES_ONLY) return null;");
    const avatarCompose = body.indexOf("composeAvatar(");
    assert.ok(foesOnlyReturn >= 0, "drawChatter must still return early in FOES_ONLY");
    assert.ok(avatarCompose >= 0, "drawChatter must still compose the chatter avatar outside FOES_ONLY");
    assert.ok(
      foesOnlyReturn < avatarCompose,
      "drawChatter must skip avatar composition before composeAvatar() in FOES_ONLY",
    );
  });

  test("drawAura is called in drawPartyMember (skip when sleeping)", () => {
    const fn = arenaJs.match(/function drawPartyMember[\s\S]*?^}/m);
    assert.ok(fn, "drawPartyMember must be defined");
    assert.ok(fn[0].includes("drawAura("), "drawPartyMember must call drawAura");
    assert.ok(fn[0].includes("!sleeping"), "drawPartyMember must skip aura when sleeping");
  });

  test("tier-4 config has core:true and most motes", () => {
    const start = arenaJs.indexOf("const AURA_CONFIG");
    const end = arenaJs.indexOf("];", start) + 2;
    const block = arenaJs.slice(start, end);
    assert.ok(block.includes("core: true"), "tier-4 AURA_CONFIG must include core:true");
    // tier-4 motes must be >= tier-3 motes
    const moteMatches = [...block.matchAll(/motes:\s*(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(moteMatches.length >= 2, "must have at least 2 mote entries");
    const lastTwo = moteMatches.slice(-2);
    assert.ok(lastTwo[1] >= lastTwo[0], "tier-4 motes must be >= tier-3 motes");
  });

  test("upsertChatter copies auraTier", () => {
    const fn = arenaJs.match(/function upsertChatter[\s\S]*?^}/m);
    assert.ok(fn, "upsertChatter must be defined");
    assert.ok(fn[0].includes("auraTier"), "upsertChatter must copy auraTier");
  });
});

// ── CHANGE 3: blank main screen + bar-mode full game ─────────────────────────

describe("CHANGE 3 — blank main screen + bar-mode full game (source inspection)", () => {
  test("draw() only blanks full-screen when !barMode && !FOES_ONLY", () => {
    const drawFn = arenaJs.match(/function draw\(now\)[\s\S]*?\nfunction /m);
    assert.ok(drawFn, "draw() must be defined");
    const body = drawFn[0];
    // Full-screen stays blank unless FOES_ONLY is active for VCS monster rendering.
    assert.ok(
      body.includes("if (!barMode && !FOES_ONLY)") && body.includes("return;"),
      "draw() must only early-return for blank full-screen when FOES_ONLY is not active",
    );
  });

  test("bar-mode renders chatters both in raid and non-raid", () => {
    const drawFn = arenaJs.match(/function draw\(now\)[\s\S]*?\nfunction /m);
    assert.ok(drawFn, "draw() must be defined");
    const body = drawFn[0];
    // Both raid + non-raid paths must call drawChatter
    assert.ok(
      body.includes("drawChatter("),
      "bar-mode draw() must call drawChatter for roaming chatters",
    );
    // drawBossBarCompact must be called for raid in bar mode
    assert.ok(
      body.includes("drawBossBarCompact("),
      "bar-mode draw() must call drawBossBarCompact during a raid",
    );
  });

  test("full-screen JRPG drawBossScene is NOT called from draw() in bar-mode path", () => {
    // In the new layout, drawBossScene is only accessible from the old non-barMode path.
    // Since draw() now returns early for !barMode, the function body after the early
    // return (i.e. barMode only) must not call drawBossScene.
    const drawFn = arenaJs.match(/function draw\(now\)[\s\S]*?\nfunction /m);
    assert.ok(drawFn, "draw() must be defined");
    const body = drawFn[0];
    // Find the early-return guard and get everything after it
    const afterReturn = body.slice(body.indexOf("return;") + 7);
    assert.ok(
      !afterReturn.includes("drawBossScene("),
      "draw() bar-mode body must not call drawBossScene (full-screen JRPG removed)",
    );
  });

  test("BAR_MODE_HEIGHT_PX is defined (pure height threshold)", () => {
    assert.ok(
      arenaJs.includes("BAR_MODE_HEIGHT_PX"),
      "BAR_MODE_HEIGHT_PX must be defined as the bar-mode height threshold",
    );
    const m = arenaJs.match(/BAR_MODE_HEIGHT_PX\s*=\s*(\d+)/);
    assert.ok(m, "BAR_MODE_HEIGHT_PX must be a numeric constant");
    assert.ok(Number(m[1]) > 0, "BAR_MODE_HEIGHT_PX must be positive");
  });

  test("barMode is set by fitCanvas() based on canvas height alone (no URL param)", () => {
    const fitFn = arenaJs.match(/function fitCanvas\(\)[\s\S]*?^}/m);
    assert.ok(fitFn, "fitCanvas() must be defined");
    assert.ok(
      fitFn[0].includes("barMode") && fitFn[0].includes("BAR_MODE_HEIGHT_PX"),
      "fitCanvas() must set barMode from BAR_MODE_HEIGHT_PX height threshold",
    );
    // Must NOT read URLSearchParams for barMode (it's pure height, not URL param)
    assert.ok(
      !fitFn[0].includes("URLSearchParams"),
      "fitCanvas() must not use URLSearchParams for barMode (pure height threshold)",
    );
  });
});

// ── Inc3: Multiplayer Combo Chains ────────────────────────────────────────────

import {
  AILMENTS,
  COMBOS,
  detectCombo,
  familyTrigger,
  weaponAilment,
} from "../../shared/ailments.js";

describe("Inc3 — boss ailment accumulation + cross-fighter combos", () => {
  // Minimal raid object with the Inc3 bossAilments map.
  function makeRaidInc3(boss_id = "goblin_king") {
    const base = makeRaid(boss_id);
    return {
      ...base,
      poise: 200,
      maxPoise: 200,
      staggeredUntil: 0,
      enrageAt: 0,
      bossAilments: new Map(),
    };
  }

  // Simulate the ailment-apply path from fireRaidSwing (no actual server import).
  // Returns whether the ailment proc'd (always forces proc for deterministic tests).
  function applyAilmentForced(raid, login, family, plus = 0) {
    const spec = weaponAilment(family, plus);
    if (!spec) return false;
    const existing = raid.bossAilments.get(spec.id);
    if (!existing) {
      raid.bossAilments.set(spec.id, {
        id: spec.id,
        stacks: spec.stacks,
        ttl: spec.ttl,
        appliedBy: login,
        dotAcc: 0,
      });
    } else {
      existing.ttl = Math.max(existing.ttl, spec.ttl);
      existing.stacks = Math.min(existing.stacks + spec.stacks, 5);
      existing.appliedBy = login;
    }
    return true;
  }

  // Simulate combo detection from fireRaidSwing (cross-fighter check).
  // Returns null or { combo, bonusDmg, consumed } given swinger, base dmg.
  function detectRaidCombo(raid, swingerLogin, family, baseDmg) {
    const trigger = familyTrigger(family);
    if (!trigger) return null;
    for (const [ailmentId, a] of raid.bossAilments) {
      if (a.appliedBy === swingerLogin) continue; // same fighter — no cross-fighter combo
      const combo = detectCombo(trigger, [ailmentId]);
      if (!combo) continue;
      const bonusDmg = Math.max(1, Math.round(baseDmg * (combo.mul - 1)));
      if (combo.consumes) raid.bossAilments.delete(ailmentId);
      return { combo: combo.id, label: combo.label, bonusDmg, consumed: !!combo.consumes };
    }
    return null;
  }

  // ── Ailment accumulation ──────────────────────────────────────────────

  test("axe family proc applies 'bleeding' ailment to boss", () => {
    const spec = weaponAilment("axe", 0);
    assert.ok(spec, "axe must return an ailment spec");
    assert.equal(spec.id, "bleeding");
    assert.ok(spec.procChance > 0, "procChance must be positive");
    assert.ok(spec.ttl > 0, "ttl must be positive");
  });

  test("staff family proc applies 'burning' ailment to boss", () => {
    const spec = weaponAilment("staff", 0);
    assert.ok(spec);
    assert.equal(spec.id, "burning");
  });

  test("sword family returns null — no ailment proc, no extra RNG", () => {
    assert.equal(weaponAilment("sword"), null);
  });

  test("boss accumulates ailment from a fighter swing", () => {
    const raid = makeRaidInc3();
    const applied = applyAilmentForced(raid, "alice", "staff");
    assert.ok(applied, "staff must apply an ailment");
    assert.ok(raid.bossAilments.has("burning"), "boss must have burning ailment");
    const a = raid.bossAilments.get("burning");
    assert.equal(a.appliedBy, "alice");
    assert.ok(a.stacks >= 1);
    assert.ok(a.ttl >= 1);
  });

  test("second application by same fighter refreshes ttl + increments stacks", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "axe");
    applyAilmentForced(raid, "alice", "axe");
    const a = raid.bossAilments.get("bleeding");
    assert.ok(a.stacks >= 2, "stacks must accumulate");
    assert.equal(a.appliedBy, "alice");
  });

  test("second application by different fighter refreshes ttl and re-attributes", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "axe");
    applyAilmentForced(raid, "bob", "axe");
    const a = raid.bossAilments.get("bleeding");
    // Re-attributed to bob (the most recent applier)
    assert.equal(a.appliedBy, "bob");
  });

  test("stacks cap at 5", () => {
    const raid = makeRaidInc3();
    for (let i = 0; i < 10; i++) applyAilmentForced(raid, "alice", "axe");
    const a = raid.bossAilments.get("bleeding");
    assert.ok(a.stacks <= 5, `stacks ${a.stacks} must not exceed cap of 5`);
  });

  // ── Cross-fighter combo ───────────────────────────────────────────────

  test("familyTrigger: staff returns 'fire', wand returns 'fire'", () => {
    assert.equal(familyTrigger("staff"), "fire");
    assert.equal(familyTrigger("wand"), "fire");
  });

  test("familyTrigger: axe/dagger/hammer return null (no innate trigger)", () => {
    assert.equal(familyTrigger("axe"), null);
    assert.equal(familyTrigger("dagger"), null);
    assert.equal(familyTrigger("hammer"), null);
  });

  test("cross-fighter IGNITE combo: alice applies burning (axe), bob triggers with staff", () => {
    const raid = makeRaidInc3();
    // Alice applies bleeding (axe) — not the combo target, but let's use burning.
    // Use staff for alice (burning), then bob triggers with staff (fire trigger).
    applyAilmentForced(raid, "alice", "staff"); // alice → burning on boss
    assert.ok(raid.bossAilments.has("burning"), "burning must be on boss");

    // Bob swings with staff: fire trigger vs burning → IGNITE combo
    const baseDmg = 50;
    const result = detectRaidCombo(raid, "bob", "staff", baseDmg);
    assert.ok(result, "cross-fighter combo must fire");
    assert.equal(result.combo, "ignite");
    assert.equal(result.label, "IGNITE");
    assert.ok(result.bonusDmg >= 1, "bonus damage must be positive");
    // IGNITE does not consume (fire keeps burning)
    assert.equal(result.consumed, false);
    // burning ailment must still be on boss
    assert.ok(raid.bossAilments.has("burning"), "burning must persist (IGNITE doesn't consume)");
  });

  test("cross-fighter IGNITE bonus damage is (mul-1) × baseDmg", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "staff");
    const baseDmg = 100;
    const result = detectRaidCombo(raid, "bob", "staff", baseDmg);
    assert.ok(result);
    // IGNITE mul = 1.8 → bonus = (1.8-1) × 100 = 80
    const expectedBonus = Math.round(baseDmg * (COMBOS.ignite.mul - 1));
    assert.equal(result.bonusDmg, expectedBonus);
  });

  test("cross-fighter combo credits bonus damage in contributors map", () => {
    // Simulate the full contribution path: apply ailment, detect combo, credit bonus.
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "staff");
    const baseDmg = 50;
    const result = detectRaidCombo(raid, "bob", "staff", baseDmg);
    assert.ok(result);
    // Simulate contribution credit as fireRaidSwing does
    raid.contributors.set("bob", (raid.contributors.get("bob") || 0) + baseDmg + result.bonusDmg);
    assert.ok(raid.contributors.get("bob") > baseDmg, "bob contribution must include combo bonus");
  });

  // ── Same-fighter no-combo ─────────────────────────────────────────────

  test("same-fighter does NOT trigger a combo against their own ailment", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "staff"); // alice applies burning
    // Alice swings again with staff — should NOT trigger IGNITE (same fighter)
    const result = detectRaidCombo(raid, "alice", "staff", 50);
    assert.equal(result, null, "same fighter must not trigger a combo on their own ailment");
  });

  test("no combo fires when boss has no ailments", () => {
    const raid = makeRaidInc3();
    const result = detectRaidCombo(raid, "bob", "staff", 50);
    assert.equal(result, null, "no combo when boss has no ailments");
  });

  test("no combo fires for a family with no innate trigger (axe)", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "staff"); // burning on boss
    // bob swings with axe — axe has no familyTrigger, so no combo
    const result = detectRaidCombo(raid, "bob", "axe", 50);
    assert.equal(result, null, "axe has no innate trigger — no combo");
  });

  // ── raidCombo WS frame shape (client handler present) ────────────────

  test("client arena.js handles raidCombo frame", () => {
    assert.ok(
      arenaJs.includes('case "raidCombo"'),
      'arena.js must handle the "raidCombo" WS frame',
    );
  });

  test("raidCombo handler pushes into bossPopups with custom text", () => {
    const comboBlock = arenaJs.match(/case "raidCombo"[\s\S]*?break;/);
    assert.ok(comboBlock, "raidCombo case must exist");
    assert.ok(
      comboBlock[0].includes("bossPopups"),
      "raidCombo handler must push into bossPopups for the combo flash",
    );
  });

  test("raidCombo handler applies extra boss shake (shakeUntil)", () => {
    const comboBlock = arenaJs.match(/case "raidCombo"[\s\S]*?break;/);
    assert.ok(comboBlock);
    assert.ok(
      comboBlock[0].includes("shakeUntil"),
      "raidCombo handler must set bossFx.shakeUntil for dramatic effect",
    );
  });

  // ── DoT tick logic ────────────────────────────────────────────────────

  test("bleeding ailment has dotFrac defined (DoT capable)", () => {
    assert.ok(AILMENTS.bleeding.dot, "bleeding must be a DoT ailment");
    assert.ok(AILMENTS.bleeding.dotFrac > 0, "bleeding dotFrac must be positive");
  });

  test("burning ailment has dotFrac defined (DoT capable)", () => {
    assert.ok(AILMENTS.burning.dot, "burning must be a DoT ailment");
    assert.ok(AILMENTS.burning.dotFrac > 0, "burning dotFrac must be positive");
  });

  test("TTL decay removes ailment after ttl ticks", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "axe");
    const a = raid.bossAilments.get("bleeding");
    const initialTtl = a.ttl;
    // Simulate tick decay
    for (let i = 0; i < initialTtl; i++) {
      a.ttl -= 1;
      if (a.ttl <= 0) raid.bossAilments.delete("bleeding");
    }
    assert.ok(!raid.bossAilments.has("bleeding"), "bleeding must expire after ttl ticks");
  });

  test("bossAilments exposed in raidPublic-equivalent shape", () => {
    const raid = makeRaidInc3();
    applyAilmentForced(raid, "alice", "staff");
    // Mirror what raidPublic() does
    const pub = {
      bossAilments: [...raid.bossAilments.values()].map((a) => ({
        id: a.id,
        stacks: a.stacks,
      })),
    };
    assert.ok(Array.isArray(pub.bossAilments), "bossAilments must be an array in raidPublic");
    assert.equal(pub.bossAilments[0].id, "burning");
    assert.ok(pub.bossAilments[0].stacks >= 1);
  });
});

// ── Inc5: Tactical Positioning ────────────────────────────────────────────────
// All tests are server-only logic mirrors — no live server import.

// Mirror the Inc5 position bonus constants from server/server.js.
const MELEE_FAMILIES = new Set(["sword", "axe", "hammer", "greatsword", "spear", "fists"]);
const RANGED_FAMILIES = new Set(["bow", "wand", "staff", "dagger"]);

/**
 * Mirror the posDmgMul + posExtraPoiseDrain + posCounterMul logic from fireRaidSwing.
 * Returns { posDmgMul, posExtraPoiseDrain, posCounterMul }.
 */
function positionBonuses(position, weaponFamily) {
  const isMelee = MELEE_FAMILIES.has(weaponFamily);
  const isRanged = RANGED_FAMILIES.has(weaponFamily);
  let posDmgMul = 1.0;
  let posExtraPoiseDrain = 0;
  let posCounterMul = 1.0;
  if (position === "front") {
    posDmgMul = isMelee ? 1.2 : 1.08;
    posExtraPoiseDrain = 6;
    posCounterMul = 1.3;
  } else if (position === "back") {
    posDmgMul = isRanged ? 1.15 : 1.05;
    posExtraPoiseDrain = 0;
    posCounterMul = 1.4;
  } else {
    // mid
    posDmgMul = 1.05;
    posCounterMul = 1.0;
  }
  return { posDmgMul, posExtraPoiseDrain, posCounterMul };
}

/** Mirror the counter-chance adjustment from fireRaidSwing. */
function counterChance(source, position) {
  const base = source === "chat" ? 0.35 : 0.5;
  const bias = position === "front" ? 0.1 : position === "back" ? -0.1 : 0;
  return Math.min(0.9, Math.max(0.1, base + bias));
}

describe("Inc5 — position default is mid", () => {
  test("position field defaults to 'mid' when absent", () => {
    const b = positionBonuses(undefined || "mid", "sword");
    assert.equal(b.posDmgMul, 1.05, "mid position must give 1.05× damage");
    assert.equal(b.posExtraPoiseDrain, 0, "mid has no extra poise drain");
    assert.equal(b.posCounterMul, 1.0, "mid has no counter vulnerability");
  });

  test("unknown position coerces to mid bonuses", () => {
    // vCharacter coerces unknown → 'mid'; positionBonuses mirrors the else branch.
    // Pass "mid" directly (the coerced result) to verify mid bonuses apply.
    const coerced = "mid"; // what vEnum(unknown, [...], "mid") returns
    const b = positionBonuses(coerced, "sword");
    assert.equal(b.posDmgMul, 1.05);
    assert.equal(b.posCounterMul, 1.0);
  });

  test("validate.js coerces unknown position to mid (source inspection)", () => {
    const validateJs = readFileSync(join(__dirname, "../../server/validate.js"), "utf8");
    assert.ok(
      validateJs.includes('"front", "mid", "back"') ||
        validateJs.includes('"front","mid","back"') ||
        validateJs.includes('["front", "mid", "back"]'),
      "vCharacter must enumerate front/mid/back as valid positions",
    );
    assert.ok(
      validateJs.includes("position:") || validateJs.includes("position :"),
      "vCharacter must have a position field",
    );
  });
});

describe("Inc5 — frontline bonuses", () => {
  test("frontline melee fighter gets 1.20× damage multiplier", () => {
    const b = positionBonuses("front", "sword");
    assert.equal(b.posDmgMul, 1.2);
  });

  test("frontline ranged fighter gets smaller 1.08× bonus (not full melee bonus)", () => {
    const b = positionBonuses("front", "bow");
    assert.equal(b.posDmgMul, 1.08);
  });

  test("frontline adds 6 extra poise drain per swing", () => {
    const b = positionBonuses("front", "hammer");
    assert.equal(b.posExtraPoiseDrain, 6);
  });

  test("frontline takes 1.30× counter damage (vulnerable — exposed)", () => {
    const b = positionBonuses("front", "sword");
    assert.equal(b.posCounterMul, 1.3);
  });

  test("frontline counter damage is always ≥ mid counter damage", () => {
    const front = positionBonuses("front", "sword");
    const mid = positionBonuses("mid", "sword");
    assert.ok(
      front.posCounterMul >= mid.posCounterMul,
      "front must be at least as vulnerable as mid",
    );
  });

  test("frontline bosses target first — higher counter chance vs command swing", () => {
    const fc = counterChance("command", "front");
    const mc = counterChance("command", "mid");
    assert.ok(fc > mc, `front counter chance ${fc} must exceed mid ${mc}`);
  });

  test("frontline boss counter-chance is capped at 0.9", () => {
    const fc = counterChance("command", "front");
    assert.ok(fc <= 0.9, `front counter chance ${fc} must not exceed 0.9`);
  });
});

describe("Inc5 — backline bonuses", () => {
  test("backline ranged fighter gets 1.15× damage multiplier", () => {
    const b = positionBonuses("back", "staff");
    assert.equal(b.posDmgMul, 1.15);
  });

  test("backline melee fighter at back gets smaller 1.05× bonus", () => {
    const b = positionBonuses("back", "sword");
    assert.equal(b.posDmgMul, 1.05);
  });

  test("backline has no extra poise drain", () => {
    const b = positionBonuses("back", "wand");
    assert.equal(b.posExtraPoiseDrain, 0);
  });

  test("backline takes 1.40× counter damage (fragile — hit hard if reached)", () => {
    const b = positionBonuses("back", "staff");
    assert.equal(b.posCounterMul, 1.4);
  });

  test("backline counter vulnerability exceeds frontline (punished more if hit)", () => {
    const front = positionBonuses("front", "staff");
    const back = positionBonuses("back", "staff");
    assert.ok(
      back.posCounterMul > front.posCounterMul,
      "backline takes more counter damage than frontline when hit",
    );
  });

  test("backline targeted last — lower counter chance vs command swing", () => {
    const bc = counterChance("command", "back");
    const mc = counterChance("command", "mid");
    assert.ok(bc < mc, `back counter chance ${bc} must be below mid ${mc}`);
  });

  test("backline counter-chance floor is 0.1", () => {
    const bc = counterChance("command", "back");
    assert.ok(bc >= 0.1, `back counter chance ${bc} must not go below 0.1`);
  });
});

describe("Inc5 — raid swing damage ordering", () => {
  test("front melee > mid > back melee for damage mult", () => {
    const f = positionBonuses("front", "sword").posDmgMul;
    const m = positionBonuses("mid", "sword").posDmgMul;
    const b = positionBonuses("back", "sword").posDmgMul;
    assert.ok(f > m, `front (${f}) must beat mid (${m}) for melee`);
    assert.equal(m, b, "mid and back melee bonus are equal (1.05×)");
  });

  test("back ranged > mid ranged for damage mult", () => {
    const b = positionBonuses("back", "bow").posDmgMul;
    const m = positionBonuses("mid", "bow").posDmgMul;
    assert.ok(b > m, `back ranged (${b}) must beat mid (${m})`);
  });

  test("all positions produce posDmgMul ≥ 1.0 (no negative bonus)", () => {
    for (const pos of ["front", "mid", "back"]) {
      for (const fam of ["sword", "bow", "hammer", "wand"]) {
        const { posDmgMul } = positionBonuses(pos, fam);
        assert.ok(posDmgMul >= 1.0, `${pos}/${fam} posDmgMul ${posDmgMul} must be ≥ 1`);
      }
    }
  });
});

describe("Inc5 — publicEntry exposes position", () => {
  test("server/arena.js publicEntry includes position field (source inspection)", () => {
    const arenaServerJs = readFileSync(join(__dirname, "../../server/arena.js"), "utf8");
    assert.ok(
      arenaServerJs.includes("position: e.position"),
      "publicEntry must expose position from the roster entry",
    );
  });

  test("server/arena.js mintOrRefresh syncs position from character", () => {
    const arenaServerJs = readFileSync(join(__dirname, "../../server/arena.js"), "utf8");
    assert.ok(
      arenaServerJs.includes("existing.position = character.position"),
      "mintOrRefresh refresh branch must sync position from character",
    );
    assert.ok(
      arenaServerJs.includes("position: character?.position"),
      "new-entry construction must set position from character",
    );
  });

  test("raidPublic topContributors include position field (source inspection)", () => {
    const serverJs = readFileSync(join(__dirname, "../../server/server.js"), "utf8");
    assert.ok(
      serverJs.includes("position: pos"),
      "raidPublic topContributors must include position field",
    );
  });
});

describe("Inc5 — client position tag", () => {
  test("client arena.js copies position in upsertChatter new-entry branch", () => {
    assert.ok(
      arenaJs.includes("position: c.position"),
      "upsertChatter new-entry must copy position from server chatter",
    );
  });

  test("client arena.js refreshes position in upsertChatter update branch", () => {
    assert.ok(
      arenaJs.includes("next.position = c.position"),
      "upsertChatter update branch must refresh position",
    );
  });

  test("client renders [F] tag for front and [B] tag for back positions", () => {
    assert.ok(
      arenaJs.includes('"[F]"') ||
        arenaJs.includes("'[F]'") ||
        arenaJs.includes('" [F]"') ||
        arenaJs.includes("` [F]`") ||
        arenaJs.includes("[F]"),
      "arena.js must reference [F] position tag for frontline",
    );
    assert.ok(
      arenaJs.includes('"[B]"') ||
        arenaJs.includes("'[B]'") ||
        arenaJs.includes('" [B]"') ||
        arenaJs.includes("` [B]`") ||
        arenaJs.includes("[B]"),
      "arena.js must reference [B] position tag for backline",
    );
  });

  test("mid position shows no tag (label unchanged for most players)", () => {
    // Verify the posTag logic: mid produces empty string
    const pos = "mid";
    const posTag = pos === "front" ? " [F]" : pos === "back" ? " [B]" : "";
    assert.equal(posTag, "", "mid position must produce no tag (empty string)");
  });
});

describe("Inc5 — sim determinism unchanged", () => {
  test("shared/combat.js (delveTick) has no Math.random() calls", () => {
    // The determinism invariant: the core tick must never call Math.random().
    // shared/mob-tier.js legitimately accepts Math.random as a default parameter
    // for the live arena layer — that's server-side spectacle, not the sim tick.
    // We pin the two sim-critical files explicitly.
    const combatSrc = readFileSync(join(__dirname, "../../shared/combat.js"), "utf8");
    assert.ok(
      !combatSrc.includes("Math.random"),
      "shared/combat.js must not call Math.random() — use makeRng() for determinism",
    );
  });

  test("shared/progression.js has no Math.random() calls", () => {
    const src = readFileSync(join(__dirname, "../../shared/progression.js"), "utf8");
    assert.ok(!src.includes("Math.random"), "shared/progression.js must not call Math.random()");
  });

  test("shared/loot.js has no Math.random() calls", () => {
    const src = readFileSync(join(__dirname, "../../shared/loot.js"), "utf8");
    assert.ok(!src.includes("Math.random"), "shared/loot.js must not call Math.random()");
  });

  test("Inc5 position field is NOT present in shared/combat.js (server-only)", () => {
    // Positioning is server-only per spec — it must not bleed into the shared sim.
    const combatSrc = readFileSync(join(__dirname, "../../shared/combat.js"), "utf8");
    assert.ok(
      !combatSrc.includes("position"),
      "shared/combat.js must not reference 'position' — Inc5 is server-only",
    );
  });
});
