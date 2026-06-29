// SIGMA ABYSS — Vampire-Survivors combat layer test suite.
// Run: node --test test/unit/vampire-survivors.test.js
// node:test (built-in, zero deps) — consistent with the no-frameworks rule.
//
// Covers: gem spawn+magnetize+pickup, weapon auto-fire resolution, the synergy
// /evolution matrix, faint -> lose-active-weapon, the validate boundary, and the
// determinism firewall (a non-VS sigma is byte-identical; a VS sigma replays).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vCharacter } from "../../server/validate.js";
import { resolveEncounter } from "../../shared/combat.js";
import { makeEnemy } from "../../shared/enemies.js";
import { delveTick, deployToZone, freshCharacter } from "../../shared/progression.js";
import { makeRng } from "../../shared/rng.js";
import { derive } from "../../shared/stats.js";
import {
  activeEvolutions,
  advanceGems,
  applyFaint,
  EVOLUTIONS,
  fireWeaponVolley,
  gemSnapshot,
  gemValue,
  harvestVsTick,
  normalizeLoadout,
  resolveLoadout,
  spawnGemsForKills,
  VS_TUNABLES,
  WEAPON_BY_ID,
  WEAPON_CATALOG,
  WEAPON_IDS,
  weaponCatalogPayload,
} from "../../shared/vampire-survivors.js";

// Live-enemy helper: the shape resolveEncounter / fireWeaponVolley expect.
function liveEnemies(n, hp = 1000) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ _idx: i, hp, maxHp: hp, kind: "normal", threat: 1 });
  return out;
}

describe("catalog + loadout", () => {
  test("catalog ships 8+ auto-fire weapon types with complete fields", () => {
    assert.ok(WEAPON_CATALOG.length >= 8, "at least 8 weapons");
    for (const w of WEAPON_CATALOG) {
      assert.equal(typeof w.id, "string");
      assert.equal(typeof w.fireRate, "number");
      assert.equal(typeof w.damage, "number");
      assert.ok("count" in w && "pierce" in w && "area" in w);
    }
    assert.equal(new Set(WEAPON_IDS).size, WEAPON_IDS.length, "ids unique");
  });

  test("weaponCatalogPayload exposes weapons + evolutions + tunables", () => {
    const p = weaponCatalogPayload();
    assert.ok(Array.isArray(p.weapons) && p.weapons.length >= 8);
    assert.ok(Array.isArray(p.evolutions) && p.evolutions.length >= 8);
    assert.equal(p.maxSlots, VS_TUNABLES.maxWeaponSlots);
  });

  test("normalizeLoadout drops unknown ids, de-dupes, slot-caps", () => {
    const big = [...WEAPON_IDS, ...WEAPON_IDS, "not_a_weapon"];
    const norm = normalizeLoadout(big);
    assert.ok(norm.length <= VS_TUNABLES.maxWeaponSlots);
    assert.equal(new Set(norm).size, norm.length);
    for (const id of norm) assert.ok(WEAPON_BY_ID[id]);
    assert.equal(normalizeLoadout("garbage").length, 0);
  });
});

describe("weapon auto-fire resolution", () => {
  test("a volley deals positive damage and tags the firing weapon", () => {
    const specs = resolveLoadout(["wand"]).specs;
    const live = liveEnemies(3);
    const { hits, totalDmg } = fireWeaponVolley(specs, { attack: 100 }, live, 0);
    assert.ok(hits.length >= 1);
    assert.ok(totalDmg > 0);
    assert.equal(hits[0].wid, "wand");
    assert.ok(hits[0].dmg >= 1);
  });

  test("area:'all' weapons strike every live enemy", () => {
    const specs = resolveLoadout(["nova"]).specs; // nova has area "all"
    const live = liveEnemies(5);
    const { hits } = fireWeaponVolley(specs, { attack: 80 }, live, 0);
    const touched = new Set(hits.map((h) => h.idx));
    assert.equal(touched.size, 5);
  });

  test("count + pierce bounds the number of enemies a single-target weapon hits", () => {
    const specs = resolveLoadout(["knife"]).specs; // count 2 + pierce 2 = 4 touched
    const live = liveEnemies(10);
    const { hits } = fireWeaponVolley(specs, { attack: 50 }, live, 0);
    const knife = WEAPON_BY_ID.knife;
    assert.equal(hits.length, knife.count + knife.pierce);
  });

  test("empty loadout = empty volley (no draws, byte-identical posture)", () => {
    const { hits, totalDmg } = fireWeaponVolley([], { attack: 100 }, liveEnemies(3), 0);
    assert.equal(hits.length, 0);
    assert.equal(totalDmg, 0);
  });

  test("weapons make a hard fight winnable (the VS power fantasy)", () => {
    // Same RNG seed, same brutal pack: with weapons the fighter clears it.
    const enemies = () => [
      makeEnemy("imp", 12, 8, makeRng(7)),
      makeEnemy("imp", 12, 8, makeRng(7)),
    ];
    const fighter = () => ({
      hp: 600,
      maxHp: 600,
      attack: 90,
      defense: 30,
      critChance: 0.1,
      critMult: 1.5,
      speed: 2,
      dodge: 0.05,
      overload: 0,
      deathSave: 0,
      effects: [],
      potions: 0,
    });
    const ai = { targetPriority: "highest_threat", fleeHpFrac: 0, potionHpFrac: 0 };
    const withW = { ...fighter(), weapons: resolveLoadout(["beam", "nova", "knife"]).specs };
    const r1 = resolveEncounter({ fighter: withW, enemies: enemies(), ai, rng: makeRng(99) });
    assert.equal(r1.outcome, "win");
  });
});

describe("synergy / evolution matrix", () => {
  test("every evolution names a real base + (weapon|passive) requirement", () => {
    for (const ev of EVOLUTIONS) {
      assert.ok(WEAPON_BY_ID[ev.base], `${ev.id} base is a real weapon`);
      const req = ev.requires || {};
      assert.ok(req.weapon || req.passive, `${ev.id} has a requirement`);
      if (req.weapon) assert.ok(WEAPON_BY_ID[req.weapon], `${ev.id} partner is a real weapon`);
    }
  });

  test("a weapon-pair triggers its evolution and rewrites the resolved spec", () => {
    const evos = activeEvolutions(["whip", "garlic"]);
    assert.ok(evos.some((e) => e.id === "bloody_tear"));
    const { specs, evolutions } = resolveLoadout(["whip", "garlic"]);
    assert.ok(evolutions.includes("bloody_tear"));
    const whipSpec = specs.find((s) => s.baseId === "whip");
    assert.equal(whipSpec.evolved, true);
    assert.equal(whipSpec.area, "all"); // Bloody Tear evolves the whip to hit all
    assert.ok(whipSpec.damage >= WEAPON_BY_ID.whip.damage);
  });

  test("a weapon+passive keystone triggers its evolution", () => {
    assert.equal(activeEvolutions(["wand"]).length, 0); // wand alone -> nothing
    const evos = activeEvolutions(["wand"], ["ks_glass_cannon"]);
    assert.ok(evos.some((e) => e.id === "glass_lance"));
  });

  test("evolved weapons hit materially harder than their base form", () => {
    const base = fireWeaponVolley(
      resolveLoadout(["nova"]).specs,
      { attack: 100 },
      liveEnemies(1),
      0,
    );
    const evo = fireWeaponVolley(
      resolveLoadout(["nova", "fireball"]).specs, // -> hellfire
      { attack: 100 },
      liveEnemies(1),
      0,
    );
    const novaDmg = base.hits.find((h) => h.wid === "nova").dmg;
    const hellDmg = evo.hits.find((h) => h.wid === "hellfire").dmg;
    assert.ok(hellDmg > novaDmg, `hellfire (${hellDmg}) > nova (${novaDmg})`);
  });
});

describe("gems: spawn + magnetize + pickup", () => {
  test("one gem spawns per kill at a ring position with a scaled value", () => {
    const run = { gems: [], gemSeq: 0 };
    const killed = [
      { kind: "normal", threat: 1 },
      { kind: "elite", threat: 3 },
      { kind: "boss", threat: 8 },
    ];
    const spawned = spawnGemsForKills(run, killed, 5);
    assert.equal(spawned.length, 3);
    assert.equal(run.gems.length, 3);
    // Elite + boss gems are worth strictly more than the normal gem.
    assert.ok(spawned[1].value > spawned[0].value);
    assert.ok(spawned[2].value > spawned[1].value);
    assert.equal(spawned[2].value, gemValue(killed[2]));
    // Positions sit on the arena ring, not on top of the player.
    for (const g of run.gems) assert.ok(Math.hypot(g.x, g.y) > 0);
  });

  test("gems magnetize to the player and grant exactly their value as XP", () => {
    const run = { gems: [], gemSeq: 0 };
    spawnGemsForKills(run, [{ kind: "normal", threat: 1 }], 1);
    const want = run.gems[0].value;
    let xp = 0;
    let guard = 0;
    while (run.gems.length && guard < 50) {
      xp += advanceGems(run).xp;
      guard += 1;
    }
    assert.equal(run.gems.length, 0, "gem eventually collected");
    assert.equal(xp, want, "collected XP equals the gem value");
  });

  test("a gem snapshot exposes id, pos, target and value for the overlay", () => {
    const run = { gems: [], gemSeq: 0 };
    spawnGemsForKills(run, [{ kind: "elite", threat: 4 }], 2);
    const snap = gemSnapshot(run);
    assert.equal(snap.length, 1);
    const g = snap[0];
    for (const k of ["id", "x", "y", "tx", "ty", "value"]) assert.ok(k in g, `snapshot has ${k}`);
    assert.equal(g.tx, 0); // target is the player at the center
    assert.equal(g.ty, 0);
  });

  test("gem economy is deterministic (same kills -> same trajectory + XP)", () => {
    const replay = () => {
      const run = { gems: [], gemSeq: 0 };
      const killed = [
        { kind: "normal", threat: 2 },
        { kind: "elite", threat: 3 },
      ];
      let xp = 0;
      for (let t = 0; t < 4; t += 1) xp += harvestVsTick({}, run, killed, t).collectedXp;
      return { xp, gems: run.gems.map((g) => `${g.id}:${g.x},${g.y}`) };
    };
    assert.deepEqual(replay(), replay());
  });
});

describe("faint -> lose the active weapon", () => {
  test("applyFaint removes the active weapon, frees the slot, is re-acquirable", () => {
    const c = { weapons: ["whip", "knife", "nova"], activeWeapon: "knife", fainted: 0 };
    const out = applyFaint(c);
    assert.equal(out.lostWeapon, "knife");
    assert.deepEqual(c.weapons, ["whip", "nova"]);
    assert.equal(c.lostWeapon, "knife");
    assert.equal(c.activeWeapon, "whip"); // active reassigned to a surviving slot
    assert.equal(c.fainted, 1);
    // Re-acquire: the freed slot accepts a different weapon (a new combo).
    c.weapons.push("knife");
    assert.equal(c.weapons.length, 3);
  });

  test("applyFaint defaults the active slot to the first weapon when unset", () => {
    const c = { weapons: ["beam", "wand"], activeWeapon: null, fainted: 2 };
    const out = applyFaint(c);
    assert.equal(out.lostWeapon, "beam");
    assert.deepEqual(c.weapons, ["wand"]);
    assert.equal(c.fainted, 3);
  });

  test("delveTick converts a VS death into a faint (not permadeath)", () => {
    // Root-cause fix proof: a VS sigma stands and fights (fleeHpFrac 0), so an
    // overwhelming pack actually drops it -> faint, not the unreachable death.
    const c = freshCharacter(7, "Faintee"); // seed chosen so the pack overwhelms
    c.weapons = ["whip", "knife"];
    c.activeWeapon = "whip";
    deployToZone(c, "abyss_ruins"); // tier-5, brutal
    // Throw a low-level fighter against deep, far-over-leveled foes.
    c.run.depth = 28;
    c.run.danger = 0.5;
    c.run.hp = derive(c.run, c).maxHp;
    const out = delveTick(c);
    assert.equal(out.type, "retreat");
    assert.equal(out.reason, "faint");
    assert.equal(out.faint.lostWeapon, "whip");
    assert.deepEqual(c.weapons, ["knife"]); // active weapon lost
    assert.equal(c.activeWeapon, "knife");
    assert.equal(c.fainted, 1);
    assert.equal(c.run.alive, true, "run survives a faint (not permadeath)");
    assert.ok(c.run.hp > 0, "stands back up");
  });

  test("the faint scenario is deterministic (same seed -> same outcome twice)", () => {
    const run1 = () => {
      const c = freshCharacter(909090, "Det");
      c.weapons = ["whip", "knife"];
      c.activeWeapon = "whip";
      deployToZone(c, "abyss_ruins");
      c.run.depth = 28;
      c.run.danger = 0.5;
      c.run.hp = derive(c.run, c).maxHp;
      const out = delveTick(c);
      return {
        type: out.type,
        reason: out.reason,
        lost: out.faint?.lostWeapon,
        rng: c.run.rngState,
      };
    };
    assert.deepEqual(run1(), run1());
  });
});

describe("determinism firewall (non-VS byte-identical)", () => {
  test("a sigma with no weapons advances identically with the VS code present", () => {
    const tick = (seed) => {
      const c = freshCharacter(seed, "Plain");
      deployToZone(c, "goblin_warrens");
      const states = [];
      for (let i = 0; i < 8; i += 1) {
        delveTick(c);
        states.push(`${c.run.level}/${c.run.depth}/${c.run.hp}/${c.run.rngState}`);
        if (!c.run.alive) break;
      }
      return states;
    };
    assert.deepEqual(tick(13579), tick(13579), "same seed -> identical stream");
    // A non-VS run never grows gems and never faints.
    const c = freshCharacter(24680, "Plain2");
    deployToZone(c, "goblin_warrens");
    for (let i = 0; i < 8 && c.run.alive; i += 1) delveTick(c);
    assert.equal(c.run.gems.length, 0);
    assert.equal(c.fainted, 0);
  });
});

describe("validate boundary", () => {
  test("vCharacter round-trips weapons/activeWeapon and drops unknown ids", () => {
    const v = vCharacter({
      weapons: ["whip", "whip", "nonsense", "garlic"],
      activeWeapon: "garlic",
      lostWeapon: "knife",
      fainted: 3,
      run: { gems: [{ id: "g1_0", x: 4, y: -2, value: 12 }], gemSeq: 9 },
    });
    assert.deepEqual(v.weapons, ["whip", "garlic"]); // de-duped, unknown dropped
    assert.equal(v.activeWeapon, "garlic");
    assert.equal(v.lostWeapon, "knife");
    assert.equal(v.fainted, 3);
    assert.equal(v.run.gems.length, 1);
    assert.equal(v.run.gems[0].value, 12);
    assert.equal(v.run.gemSeq, 9);
  });

  test("a stale active weapon coerces to a carried weapon (faint always has a target)", () => {
    const v = vCharacter({ weapons: ["beam", "wand"], activeWeapon: "knife", run: {} });
    assert.equal(v.activeWeapon, "beam"); // not in loadout -> first weapon
    const empty = vCharacter({ weapons: [], activeWeapon: "beam", run: {} });
    assert.equal(empty.activeWeapon, null);
  });

  test("the gem cap is enforced by the validator", () => {
    const many = [];
    for (let i = 0; i < VS_TUNABLES.gemMaxLive + 20; i += 1) {
      many.push({ id: `g_${i}`, x: 1, y: 1, value: 1 });
    }
    const v = vCharacter({ run: { gems: many } });
    assert.ok(v.run.gems.length <= VS_TUNABLES.gemMaxLive);
  });
});
