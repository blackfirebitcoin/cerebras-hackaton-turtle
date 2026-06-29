// Party turn-based autobattler resolver (demo P3). The novel piece: combat.js is
// single-fighter-vs-N and load-bearing for live-delve/offline-sim/arena, so this is
// a SEPARATE, self-contained resolver that leaves combat.js byte-identical.
//
// Pure + deterministic: all randomness comes from a seeded mulberry32 PRNG (no Date,
// no Math.random); the only import is the pure damageMul. Bounded: MAX_ROUNDS +
// MAX_LOG. v1 fidelity = strike / crit / overload burst / dodge / death / ally flee
// + per-enemy kill attribution (for loot). Weapon arts, traits, mental-breaks, and
// the VS volley are deferred (they add no determinism risk when absent).
//
// A combatant is { id, name, isPlayer, sheet:{maxHp,attack,defense,critChance,
// critMult,speed,dodge,overload}, hp }. The resolver never mutates its inputs.

import { damageMul } from "./stats.js";

export const MAX_ROUNDS = 40;
export const MAX_LOG = 240;
export const OVERLOAD_CHANCE = 0.12; // chance of a flashy burst strike
export const FLEE_HP_FRAC = 0.12; // a wounded ally below this may flee
export const FLEE_CHANCE = 0.25;

// mulberry32 — deterministic uint32-seeded PRNG in [0,1).
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const aliveOf = (side) => side.filter((c) => c.hp > 0 && !c.fled);

// Focus-fire: 70% lowest-hp on the opposing side (deterministic id tiebreak), else a
// seeded random target — keeps fights tactical but varied.
function pickTarget(opponents, rnd) {
  const alive = aliveOf(opponents);
  if (!alive.length) return null;
  if (rnd() < 0.7) {
    return alive.slice().sort((a, b) => a.hp - b.hp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  }
  return alive[Math.floor(rnd() * alive.length)];
}

const mk = (c, side) => ({
  id: c.id,
  name: c.name,
  isPlayer: !!c.isPlayer,
  side,
  sheet: c.sheet,
  hp: c.hp ?? c.sheet.maxHp,
  kills: 0,
  fled: false,
  killedBy: null,
});

export function resolvePartyEncounter({ party = [], enemies = [], seed = 1, maxRounds = MAX_ROUNDS } = {}) {
  const rnd = prng((seed >>> 0) || 1);
  const P = party.map((c) => mk(c, "party"));
  const E = enemies.map((c) => mk(c, "enemy"));
  const log = [];
  const push = (e) => { if (log.length < MAX_LOG) log.push(e); };
  let round = 0;

  while (round < maxRounds && aliveOf(P).length && aliveOf(E).length) {
    round += 1;
    // Speed-priority queue over everyone alive; deterministic tiebreak (side, id).
    const order = [...aliveOf(P), ...aliveOf(E)].sort(
      (a, b) =>
        (b.sheet.speed || 0) - (a.sheet.speed || 0) ||
        (a.side < b.side ? -1 : a.side > b.side ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const actor of order) {
      if (actor.hp <= 0 || actor.fled) continue; // died/fled earlier this round
      const target = pickTarget(actor.side === "party" ? E : P, rnd);
      if (!target) break; // opposing side wiped mid-round
      if (rnd() < (target.sheet.dodge || 0)) {
        push({ round, actor: actor.id, target: target.id, kind: "dodge" });
        continue;
      }
      const crit = rnd() < (actor.sheet.critChance || 0);
      const overload = rnd() < OVERLOAD_CHANCE;
      const variance = 0.9 + rnd() * 0.2;
      let dmg = (actor.sheet.attack || 1) * damageMul(target.sheet.defense || 0) * variance;
      if (crit) dmg *= actor.sheet.critMult || 1.5;
      if (overload) dmg *= 1 + Math.min(1, actor.sheet.overload || 0);
      dmg = Math.max(1, Math.round(dmg));
      target.hp -= dmg;
      push({
        round,
        actor: actor.id,
        target: target.id,
        kind: overload ? "overload" : crit ? "crit" : "strike",
        amount: dmg,
        targetHp: Math.max(0, target.hp),
      });
      if (target.hp <= 0) {
        target.killedBy = actor.id;
        actor.kills += 1;
        push({ round, actor: actor.id, target: target.id, kind: "death" });
      }
    }
    // Independent flee: a wounded NPC ally may break off (survives, leaves the fight).
    for (const c of P) {
      if (!c.isPlayer && c.hp > 0 && !c.fled && c.hp < c.sheet.maxHp * FLEE_HP_FRAC && rnd() < FLEE_CHANCE) {
        c.fled = true;
        push({ round, actor: c.id, kind: "flee" });
      }
    }
  }

  const outcome = !aliveOf(E).length ? "victory" : !aliveOf(P).length ? "defeat" : "timeout";
  return {
    outcome,
    rounds: round,
    party: P.map((c) => ({ id: c.id, name: c.name, isPlayer: c.isPlayer, hp: Math.max(0, c.hp), alive: c.hp > 0, fled: c.fled, kills: c.kills })),
    enemies: E.map((c) => ({ id: c.id, name: c.name, hp: Math.max(0, c.hp), alive: c.hp > 0, killedBy: c.killedBy })),
    kills: E.filter((c) => c.hp <= 0).map((c) => ({ enemyId: c.id, by: c.killedBy })),
    log,
  };
}
