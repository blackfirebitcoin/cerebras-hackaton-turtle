// SIGMA ABYSS — mood & thoughts.
//
// Mood is a single 0-100 number derived each tick from a stack of
// timed "thoughts" (RimWorld's mental health system). Every notable
// event posts a thought with a magnitude and a lifespan; thoughts
// decay each tick toward zero and the mood number is the baseline
// (50 + trait moodBase) shifted by the sum of live thoughts.
//
// Mood drives mental-break and inspiration rolls. Both are owned by
// neighbouring modules — this one just maintains the state.
//
// Pure ESM. No live RNG draws (mood lives outside the run RNG so the
// account-side mood is consistent across runs).

import { traitMoodProfile } from "./traits.js";

export const MOOD_MIN = 0;
export const MOOD_MAX = 100;
export const MOOD_BASE = 50;

// ── Thought catalogue ─────────────────────────────────────────────────
// Each thought:
//   id        unique tag
//   amount    +mood (positive thought) / -mood (negative)
//   ticks     how many delve ticks it lasts before decaying out
//   stacks    max copies of this id that may stack (extras are dropped)
//
// `amount` is the magnitude before trait gain/loss multipliers. Mood
// updates pre-multiply once at addMoodThought() time so the live stack
// stays trait-aware.
export const THOUGHTS = {
  // Negative — death, damage, loss, low gear
  ally_died: { amount: -22, ticks: 80, stacks: 3 },
  rival_thrived: { amount: -8, ticks: 30, stacks: 1 },
  badly_hurt: { amount: -12, ticks: 24, stacks: 2 },
  cursed_in_combat: { amount: -10, ticks: 30, stacks: 2 },
  item_stolen: { amount: -8, ticks: 20, stacks: 4 },
  no_loot: { amount: -3, ticks: 8, stacks: 6 },
  hungry: { amount: -6, ticks: 18, stacks: 1 },
  exhausted: { amount: -10, ticks: 20, stacks: 1 },
  diseased: { amount: -14, ticks: 60, stacks: 2 },
  encounter_drain: { amount: -1, ticks: 6, stacks: 8 },
  rival_win: { amount: -5, ticks: 20, stacks: 2 },

  // Positive — kills, drops, level-ups
  killed_elite: { amount: 6, ticks: 30, stacks: 4 },
  killed_boss: { amount: 22, ticks: 80, stacks: 1 },
  legendary_drop: { amount: 18, ticks: 60, stacks: 3 },
  rare_drop: { amount: 4, ticks: 16, stacks: 6 },
  leveled_up: { amount: 8, ticks: 26, stacks: 4 },
  banked_haul: { amount: 6, ticks: 20, stacks: 2 },
  potion_quaffed: { amount: 2, ticks: 10, stacks: 4 },
  cosmetic_unlocked: { amount: 10, ticks: 60, stacks: 1 },
  inspired: { amount: 6, ticks: 18, stacks: 2 },
};

// ── State helpers ─────────────────────────────────────────────────────
export function freshMood(traitIds = []) {
  const profile = traitMoodProfile(traitIds);
  return {
    baseline: MOOD_BASE + profile.base,
    thoughts: [], // [{ id, amount, ticksLeft }]
    value: MOOD_BASE + profile.base,
    breakProgress: 0, // climbs while mood is below threshold
    lastBreakTick: -9999,
  };
}

export function moodValue(mood) {
  if (!mood) return MOOD_BASE;
  return clamp(mood.value, MOOD_MIN, MOOD_MAX);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Post a thought. `id` keys the catalogue; multipliers from the
// character's trait profile apply once at insertion. Returns the live
// thought entry (or null when stacks were already full).
export function addMoodThought(mood, character, id) {
  if (!mood) return null;
  const def = THOUGHTS[id];
  if (!def) return null;
  const profile = traitMoodProfile(character?.traits);
  if (id === "ally_died" && profile.ignoreDeathMood) return null;

  const live = mood.thoughts.filter((t) => t.id === id);
  if (live.length >= (def.stacks || 1)) return null;

  const mul = def.amount >= 0 ? profile.gainMul : profile.lossMul;
  const amount = Math.round(def.amount * mul);
  const entry = { id, amount, ticksLeft: def.ticks };
  mood.thoughts.push(entry);
  recomputeMood(mood, character);
  return entry;
}

// Tick the mood stack one delve tick forward. Drops expired thoughts,
// recomputes the value, returns the new value.
export function tickMood(mood, character) {
  if (!mood) return MOOD_BASE;
  let _dropped = 0;
  for (const t of mood.thoughts) t.ticksLeft -= 1;
  for (let i = mood.thoughts.length - 1; i >= 0; i--) {
    if (mood.thoughts[i].ticksLeft <= 0) {
      mood.thoughts.splice(i, 1);
      _dropped += 1;
    }
  }
  // Cap stack size — defensive against schema drift.
  if (mood.thoughts.length > 32) mood.thoughts.length = 32;

  // Persistent personality thoughts (per-encounter).
  const profile = traitMoodProfile(character?.traits);
  if (profile.moodPerEncounter) {
    addMoodThought(mood, character, "encounter_drain");
  }
  recomputeMood(mood, character);
  return mood.value;
}

export function recomputeMood(mood, character) {
  if (!mood) return MOOD_BASE;
  const profile = traitMoodProfile(character?.traits);
  mood.baseline = MOOD_BASE + (profile.base || 0);
  let total = mood.baseline;
  for (const t of mood.thoughts) total += t.amount || 0;
  mood.value = clamp(total, MOOD_MIN, MOOD_MAX);
  return mood.value;
}

// ── Status banding ────────────────────────────────────────────────────
// UI / break thresholds key off these bands rather than raw numbers.
export function moodBand(value) {
  if (value >= 88) return "inspired";
  if (value >= 70) return "content";
  if (value >= 45) return "neutral";
  if (value >= 25) return "stressed";
  if (value >= 12) return "broken";
  return "shattered";
}

export const MOOD_BAND_LABEL = {
  inspired: "Inspired",
  content: "Content",
  neutral: "Neutral",
  stressed: "Stressed",
  broken: "On Edge",
  shattered: "Shattered",
};

export const MOOD_BAND_COLOR = {
  inspired: "#ffe44d",
  content: "#5bd16a",
  neutral: "#9aa4b2",
  stressed: "#ff9d2e",
  broken: "#ff4d6d",
  shattered: "#b86bff",
};

// One-shot mood tweak (used by inspirations / break end).
export function adjustMood(mood, _character, delta) {
  if (!mood) return MOOD_BASE;
  mood.value = clamp((mood.value || MOOD_BASE) + (delta || 0), MOOD_MIN, MOOD_MAX);
  return mood.value;
}
