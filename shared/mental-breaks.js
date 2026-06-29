// SIGMA ABYSS — mental breaks.
//
// When mood sinks past a band, the sigma rolls for a break each tick.
// A break is a TEMPORARY combat-behaviour override that lasts a few
// encounters, paid for by a small mood debt on entry and (sometimes) a
// mood rebound on exit. There are three severities — minor, major,
// extreme — each with two-to-three flavours, drawn weighted by the
// active mood band.
//
// All RNG draws go through the run's RNG so breaks stay deterministic
// alongside the rest of the sim.
//
// Pure ESM. Read mood + traits, write break state onto the run.

import { adjustMood } from "./mood.js";
import { traitBreakProfile } from "./traits.js";

// ── Catalogue ─────────────────────────────────────────────────────────
// Each break:
//   severity        "minor" | "major" | "extreme"
//   ticks           how many encounters the override lasts
//   weight          per-band roll weight (heavier = more common)
//   moodOnStart     one-shot mood delta when the break begins
//   moodOnEnd       one-shot mood delta when the break clears
//   description     UI line
//
// Combat effects (read in combat.js → applyBreak):
//   atkMul, defMul, speedMul, dodgeAdd        sheet shifts
//   ignoreAi                                  fighter ignores ai.targetPriority
//   forceTarget                               "weakest" | "strongest"
//   noPotions                                 cannot quaff
//   stunPerEncounter                          % chance to skip a turn
//   immortal                                  cannot die during the break
export const BREAKS = {
  // ── Minor (mood < 35) ─────────────────────────────────────────────
  sad_wander: {
    id: "sad_wander",
    name: "Sad Wander",
    severity: "minor",
    ticks: 3,
    weight: 5,
    moodOnStart: -3,
    moodOnEnd: 6,
    description: "Mind elsewhere. Misses easy swings.",
    speedMul: 0.8,
    stunPerEncounter: 0.18,
  },
  binging: {
    id: "binging",
    name: "Potion Binge",
    severity: "minor",
    ticks: 2,
    weight: 4,
    moodOnStart: 4,
    moodOnEnd: -2,
    description: "Drinks every potion they own.",
    noPotions: false,
    potionGreedy: true,
  },
  insult_spree: {
    id: "insult_spree",
    name: "Insult Spree",
    severity: "minor",
    ticks: 2,
    weight: 3,
    moodOnStart: 2,
    moodOnEnd: -2,
    description: "Roasts the enemy mid-fight. Foes hit harder, swings faster.",
    speedMul: 1.15,
    incomingMul: 1.15,
  },

  // ── Major (mood < 22) ─────────────────────────────────────────────
  catatonic: {
    id: "catatonic",
    name: "Catatonic",
    severity: "major",
    ticks: 2,
    weight: 5,
    moodOnStart: -8,
    moodOnEnd: 8,
    description: "Curls up. Doesn't fight back, takes less damage.",
    atkMul: 0.0,
    defMul: 2.5,
    stunPerEncounter: 0.5,
  },
  berserk: {
    id: "berserk",
    name: "Berserk",
    severity: "major",
    ticks: 3,
    weight: 6,
    moodOnStart: -6,
    moodOnEnd: 12,
    description: "All offence, no defence.",
    atkMul: 1.6,
    defMul: 0.55,
    speedMul: 1.2,
    ignoreAi: true,
  },
  daze: {
    id: "daze",
    name: "Daze",
    severity: "major",
    ticks: 3,
    weight: 4,
    moodOnStart: -4,
    moodOnEnd: 5,
    description: "Glassy-eyed. Slower, but somehow harder to hit.",
    speedMul: 0.7,
    dodgeAdd: 0.18,
    noPotions: true,
  },

  // ── Extreme (mood < 10) ───────────────────────────────────────────
  murderous_rage: {
    id: "murderous_rage",
    name: "Murderous Rage",
    severity: "extreme",
    ticks: 4,
    weight: 5,
    moodOnStart: -12,
    moodOnEnd: 14,
    description: "Hunts the biggest thing in the room.",
    atkMul: 1.9,
    defMul: 0.4,
    forceTarget: "strongest",
    ignoreAi: true,
  },
  death_wish: {
    id: "death_wish",
    name: "Death Wish",
    severity: "extreme",
    ticks: 3,
    weight: 4,
    moodOnStart: -10,
    moodOnEnd: 6,
    description: "Walks into every blow. Crits hit twice as hard.",
    atkMul: 1.5,
    critMultAdd: 1.0,
    defMul: 0.3,
    ignoreAi: true,
  },
  fugue: {
    id: "fugue",
    name: "Fugue",
    severity: "extreme",
    ticks: 2,
    weight: 3,
    moodOnStart: -6,
    moodOnEnd: 4,
    description: "Cannot die — for now. Doesn't quite remember why.",
    immortal: true,
    speedMul: 0.85,
    atkMul: 0.8,
  },
};

export const BREAK_IDS = Object.keys(BREAKS);

// Severity-by-mood thresholds. Trait breakThresholdMod shifts these so
// hot-headed/volatile pawns break sooner, stoics later.
function thresholds(traitIds) {
  const profile = traitBreakProfile(traitIds);
  return {
    minor: 35 + profile.thresholdMod,
    major: 22 + profile.thresholdMod,
    extreme: 10 + profile.thresholdMod,
  };
}

export function brkChanceFor(mood, traitIds) {
  if (!mood) return 0;
  const t = thresholds(traitIds);
  const profile = traitBreakProfile(traitIds);
  let base = 0;
  if (mood.value < t.extreme) base = 0.18;
  else if (mood.value < t.major) base = 0.09;
  else if (mood.value < t.minor) base = 0.035;
  else base = 0;
  return Math.max(0, base * profile.chanceMul);
}

function poolFor(mood, traitIds) {
  const t = thresholds(traitIds);
  let severity = null;
  if (mood.value < t.extreme) severity = "extreme";
  else if (mood.value < t.major) severity = "major";
  else if (mood.value < t.minor) severity = "minor";
  if (!severity) return [];
  return BREAK_IDS.filter((id) => BREAKS[id].severity === severity);
}

// Roll for a break this tick. Mutates `run.activeBreak` on hit; reads
// from `character.mood` and `character.traits`. Returns the started
// break definition or null.
export function maybeStartBreak(run, character, rng) {
  if (!character?.mood || !run) return null;
  if (run.activeBreak && run.activeBreak.ticksLeft > 0) return null;
  // Cooldown — at least 6 ticks between breaks so a chronically-sad
  // sigma doesn't break every encounter.
  if (run.lastBreakTickIdx != null && (run.encounters | 0) - run.lastBreakTickIdx < 6) {
    return null;
  }
  const chance = brkChanceFor(character.mood, character.traits);
  if (chance <= 0 || !rng.chance(chance)) return null;
  const pool = poolFor(character.mood, character.traits);
  if (!pool.length) return null;
  const id = rng.weighted(pool.map((b) => [b, BREAKS[b].weight || 1]));
  const def = BREAKS[id];
  if (!def) return null;
  run.activeBreak = { id, ticksLeft: def.ticks };
  run.lastBreakTickIdx = run.encounters | 0;
  if (def.moodOnStart) adjustMood(character.mood, character, def.moodOnStart);
  return def;
}

// Tick the active break forward. Calls `onEnd` when it clears.
export function tickBreak(run, character) {
  const ab = run?.activeBreak;
  if (!ab) return null;
  ab.ticksLeft -= 1;
  if (ab.ticksLeft <= 0) {
    const def = BREAKS[ab.id];
    if (def?.moodOnEnd) adjustMood(character.mood, character, def.moodOnEnd);
    run.activeBreak = null;
    return { ended: ab.id };
  }
  return null;
}

// Return the live override block for combat.js. Caller layers this on
// top of the derived sheet for the duration of the break.
export function breakOverride(run) {
  const ab = run?.activeBreak;
  if (!ab) return null;
  const def = BREAKS[ab.id];
  if (!def) return null;
  return {
    id: ab.id,
    atkMul: def.atkMul ?? 1,
    defMul: def.defMul ?? 1,
    speedMul: def.speedMul ?? 1,
    dodgeAdd: def.dodgeAdd ?? 0,
    critMultAdd: def.critMultAdd ?? 0,
    incomingMul: def.incomingMul ?? 1,
    ignoreAi: !!def.ignoreAi,
    forceTarget: def.forceTarget || null,
    noPotions: !!def.noPotions,
    potionGreedy: !!def.potionGreedy,
    stunPerEncounter: def.stunPerEncounter ?? 0,
    immortal: !!def.immortal,
  };
}

export function breakById(id) {
  return BREAKS[id] || null;
}
