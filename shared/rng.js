// SIGMA ABYSS — deterministic seeded RNG (mulberry32).
//
// One uint32 of state → fully serializable. That is the whole reason
// offline progression works: we persist `rngState` with the run, and the
// offline simulator replays delve ticks to the exact outcome the live
// client would have produced. Every random decision in combat, loot, and
// progression draws from one of these — never Math.random().

export function makeRng(seed) {
  let s = seed >>> 0 || 1;

  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    chance(p) {
      return next() < p;
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)] ?? arr[0];
    },
    // entries: [[value, weight], ...] — weight need not be normalized.
    weighted(entries) {
      let total = 0;
      for (const e of entries) total += e[1];
      if (total <= 0) return entries[0]?.[0];
      let r = next() * total;
      for (const e of entries) {
        r -= e[1];
        if (r <= 0) return e[0];
      }
      return entries[entries.length - 1][0];
    },
    // Roll a normal-ish value in [0,1] by averaging — used for affix
    // quality so most rolls cluster mid-range and god-rolls stay rare.
    quality() {
      return (next() + next() + next()) / 3;
    },
    get state() {
      return s >>> 0;
    },
    set state(v) {
      s = v >>> 0 || 1;
    },
  };
}

// Deterministically fold two ints into a fresh seed (e.g. character seed
// + run index → that run's RNG seed).
export function mixSeed(a, b) {
  let h = (a >>> 0) ^ Math.imul(((b >>> 0) ^ 0x9e3779b9) >>> 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
