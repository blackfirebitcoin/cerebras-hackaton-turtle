// SIGMA ABYSS — daily / weekly objectives (master design §M7, [A4]).
//
// Habit loops: a fresh deterministic set of daily objectives (rerolled per UTC
// day) + weekly bounties, anchored to actions the player already takes. PURE
// ESM, dual-runtime. Generation is deterministic (seeded by day index) so the
// whole server agrees on "today's" board without coordination.

import { makeRng, mixSeed } from "./rng.js";

export const DAY_MS = 24 * 3600 * 1000;
export const WEEK_MS = 7 * DAY_MS;

// kind = the advancement signal; target scales the grind. reward is account-side.
export const OBJECTIVE_POOL = [
  {
    id: "obj_kill",
    kind: "kill",
    target: 50,
    reward: { gold: 200, questXp: 30 },
    label: "Kill 50 enemies",
  },
  {
    id: "obj_elite",
    kind: "elite_kill",
    target: 8,
    reward: { gold: 350, questXp: 50 },
    label: "Slay 8 elites",
  },
  {
    id: "obj_depth",
    kind: "reach_depth",
    target: 8,
    reward: { gold: 250, questXp: 40 },
    label: "Reach depth 8",
  },
  {
    id: "obj_loot",
    kind: "loot",
    target: 15,
    reward: { gold: 200, questXp: 30 },
    label: "Loot 15 items",
  },
  {
    id: "obj_bank",
    kind: "gold_banked",
    target: 1500,
    reward: { shards: 3, questXp: 40 },
    label: "Bank 1500 gold",
  },
  {
    id: "obj_boss",
    kind: "boss_kill",
    target: 2,
    reward: { gold: 500, questXp: 80 },
    label: "Down 2 bosses",
  },
];

export const WEEKLY_POOL = [
  {
    id: "wk_kills",
    kind: "kill",
    target: 400,
    reward: { gold: 2000, shards: 10 },
    label: "Kill 400 enemies this week",
  },
  {
    id: "wk_rep",
    kind: "faction_rep",
    target: 500,
    reward: { gold: 1500, shards: 8 },
    label: "Reach 500 faction rep",
  },
  {
    id: "wk_craft",
    kind: "craft",
    target: 3,
    reward: { gold: 1800, shards: 8 },
    label: "Craft 3 items",
  },
];

export const DAILY_COUNT = 3;

export function dayIndex(now) {
  return Math.floor(now / DAY_MS);
}
export function weekIndex(now) {
  return Math.floor(now / WEEK_MS);
}

// Deterministically pick today's objectives from the pool (same for everyone).
export function rollDailies(now) {
  const di = dayIndex(now);
  const rng = makeRng(mixSeed(0xda11, di >>> 0) || 1);
  const pool = [...OBJECTIVE_POOL];
  const out = [];
  while (pool.length && out.length < DAILY_COUNT) {
    const o = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    out.push({
      id: o.id,
      kind: o.kind,
      target: o.target,
      label: o.label,
      reward: o.reward,
      progress: 0,
      claimed: false,
      dayIndex: di,
    });
  }
  return out;
}

export function rollWeeklies(now) {
  const wi = weekIndex(now);
  return WEEKLY_POOL.map((o) => ({
    id: o.id,
    kind: o.kind,
    target: o.target,
    label: o.label,
    reward: o.reward,
    progress: 0,
    claimed: false,
    weekIndex: wi,
  }));
}

// Advance all matching objectives in a list. `absolute` kinds set; others add.
const ABSOLUTE = new Set(["reach_depth", "faction_rep", "gold_banked"]);
export function advanceObjectives(list, kind, value) {
  if (!Array.isArray(list)) return [];
  const done = [];
  for (const o of list) {
    if (o.kind !== kind || o.claimed) continue;
    o.progress = ABSOLUTE.has(kind) ? Math.max(o.progress, value) : o.progress + value;
    if (o.progress >= o.target) done.push(o);
  }
  return done;
}
