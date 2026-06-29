// SIGMA ABYSS — disease & plague.
//
// RimWorld diseases are a clock-vs-clock race: severity climbs each
// tick, immunity climbs each tick, whichever reaches 1.0 first decides
// the outcome. If severity wins you take a permanent run-injury (or
// die outright on the worst diseases); if immunity wins you shake the
// illness with a fading penalty.
//
// All RNG draws go through the run's RNG. Disease state lives on the
// run (so it clears at permadeath, mirroring how RimWorld diseases
// reset between save reloads).

export const DISEASES = {
  flu: {
    id: "flu",
    name: "Flu",
    description: "Aches. Slows the sigma down.",
    severityPerTick: 0.045,
    immunityPerTick: 0.06,
    statPenalty: { speedMul: 0.92, atkMul: 0.95 },
    deathOnLoss: false,
  },
  malaria: {
    id: "malaria",
    name: "Malaria",
    description: "Cyclic fever. Hits hard and clears slow.",
    severityPerTick: 0.055,
    immunityPerTick: 0.05,
    statPenalty: { hpMul: 0.9, defMul: 0.92 },
    deathOnLoss: false,
  },
  plague: {
    id: "plague",
    name: "Plague",
    description: "Old killer. Wins if you don't fight it.",
    severityPerTick: 0.08,
    immunityPerTick: 0.05,
    statPenalty: { hpMul: 0.85, atkMul: 0.9 },
    deathOnLoss: true,
  },
  gut_worms: {
    id: "gut_worms",
    name: "Gut Worms",
    description: "You feel them.",
    severityPerTick: 0.025,
    immunityPerTick: 0.04,
    statPenalty: { speedMul: 0.95 },
    deathOnLoss: false,
  },
  sleeping_sickness: {
    id: "sleeping_sickness",
    name: "Sleeping Sickness",
    description: "Eyes heavy. The fight is slow.",
    severityPerTick: 0.035,
    immunityPerTick: 0.045,
    statPenalty: { speedMul: 0.85, dodgeAdd: -0.1 },
    deathOnLoss: false,
  },
};

export const DISEASE_IDS = Object.keys(DISEASES);

// Start a disease on the run. Caller checks if one is already active.
// Diseases stack only by id — same disease re-roll refreshes the
// immunity track to a fresh worst case.
export function infect(run, _character, diseaseId) {
  const def = DISEASES[diseaseId];
  if (!run || !def) return null;
  run.diseases = run.diseases || {};
  run.diseases[diseaseId] = { severity: 0, immunity: 0, ticks: 0 };
  return def;
}

// Advance one tick. Returns an array of resolution events for this
// tick: [{ kind: "won"|"lost", id, def }]. Caller applies side-effects
// (mood thought, optional run-death on deathOnLoss).
export function tickDiseases(run, _character, traitDiseaseProfile) {
  const out = [];
  if (!run?.diseases) return out;
  const resist = traitDiseaseProfile?.resistMul ?? 1;
  for (const id of Object.keys(run.diseases)) {
    const state = run.diseases[id];
    const def = DISEASES[id];
    if (!def) {
      delete run.diseases[id];
      continue;
    }
    state.severity += def.severityPerTick * resist;
    state.immunity += def.immunityPerTick;
    state.ticks += 1;
    if (state.immunity >= 1) {
      delete run.diseases[id];
      out.push({ kind: "won", id, def });
    } else if (state.severity >= 1) {
      delete run.diseases[id];
      out.push({ kind: "lost", id, def });
    }
  }
  return out;
}

// Read-side: derive the active-disease stat penalty bundle. Combined
// with traits / gear in stats.js.
export function diseaseMods(run) {
  const out = { hpMul: 1, atkMul: 1, defMul: 1, speedMul: 1, dodgeAdd: 0 };
  if (!run?.diseases) return out;
  for (const id of Object.keys(run.diseases)) {
    const def = DISEASES[id];
    if (!def?.statPenalty) continue;
    const p = def.statPenalty;
    if (p.hpMul) out.hpMul *= p.hpMul;
    if (p.atkMul) out.atkMul *= p.atkMul;
    if (p.defMul) out.defMul *= p.defMul;
    if (p.speedMul) out.speedMul *= p.speedMul;
    if (p.dodgeAdd) out.dodgeAdd += p.dodgeAdd;
  }
  return out;
}

// Random ambient infection chance — a passive trickle so traits like
// sickly have a way to procure their flavour without an event.
export function ambientInfectionChance(run, traitDiseaseProfile) {
  const baseline = 0.001 + (run?.depth || 0) * 0.0002;
  return Math.max(0, baseline + (traitDiseaseProfile?.chance || 0));
}

export function diseaseList(run) {
  if (!run?.diseases) return [];
  return Object.keys(run.diseases).map((id) => ({
    id,
    name: DISEASES[id]?.name || id,
    description: DISEASES[id]?.description || "",
    severity: run.diseases[id].severity,
    immunity: run.diseases[id].immunity,
  }));
}

export function diseaseById(id) {
  return DISEASES[id] || null;
}
