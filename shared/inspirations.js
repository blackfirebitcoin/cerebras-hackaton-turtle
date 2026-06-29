// SIGMA ABYSS — inspirations.
//
// The bright counterpart to mental-breaks: when mood sits in the
// "inspired" band, the sigma occasionally enters a temporary buff
// state. Inspirations are a small drama lever — a moment to make the
// stream pop — but the multipliers are deliberately modest so they
// can't carry a bad build.
//
// All RNG draws go through the run's RNG.

import { addMoodThought, adjustMood, moodBand } from "./mood.js";

// ── Catalogue ─────────────────────────────────────────────────────────
// Each inspiration:
//   ticks         encounters the buff lasts
//   weight        roll weight
//   description   UI line
//
// Effects (read in combat.js + progression.js):
//   atkMul, critAdd, speedMul          combat sheet shifts
//   lootRarityAdd, lootQtyAdd          loot rolls
//   xpMul, goldMul                     economy
//   healOnStart                        % of maxHp healed when triggered
export const INSPIRATIONS = {
  inspired_combat: {
    id: "inspired_combat",
    name: "Inspired Combat",
    ticks: 4,
    weight: 6,
    description: "Every swing lands cleaner.",
    atkMul: 1.35,
    critAdd: 0.08,
    speedMul: 1.08,
  },
  inspired_looting: {
    id: "inspired_looting",
    name: "Inspired Looting",
    ticks: 4,
    weight: 5,
    description: "Spotted the good stuff in every corner.",
    lootRarityAdd: 0.12,
    lootQtyAdd: 0.3,
  },
  inspired_trade: {
    id: "inspired_trade",
    name: "Inspired Trade",
    ticks: 6,
    weight: 4,
    description: "Knows what every coin is worth.",
    goldMul: 1.35,
  },
  inspired_recovery: {
    id: "inspired_recovery",
    name: "Inspired Recovery",
    ticks: 1,
    weight: 4,
    description: "A flash of clarity heals body and head.",
    healOnStart: 0.7,
  },
  inspired_focus: {
    id: "inspired_focus",
    name: "Inspired Focus",
    ticks: 5,
    weight: 5,
    description: "Lessons land twice as hard.",
    xpMul: 1.6,
  },
  inspired_dance: {
    id: "inspired_dance",
    name: "Inspired Dance",
    ticks: 4,
    weight: 3,
    description: "Untouchable. For a moment.",
    speedMul: 1.2,
    dodgeAdd: 0.18,
  },
};

export const INSPIRATION_IDS = Object.keys(INSPIRATIONS);

const INSPIRED_BAND_CHANCE = 0.05;
const HIGH_BAND_CHANCE = 0.02;

export function inspirationChance(mood) {
  if (!mood) return 0;
  const band = moodBand(mood.value);
  if (band === "inspired") return INSPIRED_BAND_CHANCE;
  if (band === "content" && mood.value >= 80) return HIGH_BAND_CHANCE;
  return 0;
}

// Roll for an inspiration. Mutates `run.activeInspiration` on hit.
// Returns the started inspiration definition or null.
export function maybeStartInspiration(run, character, rng) {
  if (!character?.mood || !run) return null;
  if (run.activeInspiration && run.activeInspiration.ticksLeft > 0) return null;
  // Cooldown — keeps the buff scarce so it stays meaningful.
  if (run.lastInspirationIdx != null && (run.encounters | 0) - run.lastInspirationIdx < 12) {
    return null;
  }
  const chance = inspirationChance(character.mood);
  if (chance <= 0 || !rng.chance(chance)) return null;
  const id = rng.weighted(INSPIRATION_IDS.map((i) => [i, INSPIRATIONS[i].weight || 1]));
  const def = INSPIRATIONS[id];
  if (!def) return null;
  run.activeInspiration = { id, ticksLeft: def.ticks };
  run.lastInspirationIdx = run.encounters | 0;
  // Inspirations post a small "inspired" thought so the buzz lingers
  // past the buff ticks themselves.
  addMoodThought(character.mood, character, "inspired");
  // Bleed a little mood debt — sustained inspirations would otherwise
  // self-perpetuate. Small enough that one inspiration won't drop the
  // sigma out of the "content" band.
  adjustMood(character.mood, character, -4);
  return def;
}

export function tickInspiration(run) {
  const ai = run?.activeInspiration;
  if (!ai) return null;
  ai.ticksLeft -= 1;
  if (ai.ticksLeft <= 0) {
    const ended = ai.id;
    run.activeInspiration = null;
    return { ended };
  }
  return null;
}

export function inspirationOverride(run) {
  const ai = run?.activeInspiration;
  if (!ai) return null;
  const def = INSPIRATIONS[ai.id];
  if (!def) return null;
  return {
    id: ai.id,
    atkMul: def.atkMul ?? 1,
    critAdd: def.critAdd ?? 0,
    speedMul: def.speedMul ?? 1,
    dodgeAdd: def.dodgeAdd ?? 0,
    lootRarityAdd: def.lootRarityAdd ?? 0,
    lootQtyAdd: def.lootQtyAdd ?? 0,
    xpMul: def.xpMul ?? 1,
    goldMul: def.goldMul ?? 1,
    healOnStart: def.healOnStart ?? 0,
  };
}

export function inspirationById(id) {
  return INSPIRATIONS[id] || null;
}
