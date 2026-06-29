// SIGMA ABYSS — body parts & persistent injuries.
//
// RimWorld's health system in miniature. Each sigma has a set of body
// parts that can take injuries during a delve. Light injuries shake
// off naturally between encounters; serious wounds persist through
// town visits until they scar (permanent stat penalty) or are healed
// via the bank/heal flow. A few parts (heart, spine, brain) are
// "vital" — a serious wound there is a run-ender.
//
// Body part state lives on the RUN (clears at permadeath, just like
// RimWorld's clear-on-death). Trait + injury totals fold into stats.js
// → derive() as `healthMods`.
//
// Pure ESM, dual-runtime. RNG draws use the caller's rng.

export const BODY_PARTS = {
  head: { name: "Head", vital: false, count: 1, capStat: null },
  eye: { name: "Eyes", vital: false, count: 2, capStat: "critChance" },
  ear: { name: "Ears", vital: false, count: 2, capStat: null },
  nose: { name: "Nose", vital: false, count: 1, capStat: null },
  brain: { name: "Brain", vital: true, count: 1, capStat: null },
  heart: { name: "Heart", vital: true, count: 1, capStat: "hp" },
  lung: { name: "Lungs", vital: false, count: 2, capStat: "speed" },
  liver: { name: "Liver", vital: false, count: 1, capStat: null },
  spine: { name: "Spine", vital: true, count: 1, capStat: "speed" },
  arm: { name: "Arms", vital: false, count: 2, capStat: "attack" },
  hand: { name: "Hands", vital: false, count: 2, capStat: "speed" },
  leg: { name: "Legs", vital: false, count: 2, capStat: "speed" },
  foot: { name: "Feet", vital: false, count: 2, capStat: "speed" },
};

export const BODY_PART_IDS = Object.keys(BODY_PARTS);

// Wound severities — light heals fast, scar is permanent until town
// heal, lost is permanent for the rest of the run.
export const WOUND = {
  light: { label: "Bruised", penalty: 0.04, ticksToHeal: 4 },
  serious: { label: "Wounded", penalty: 0.1, ticksToHeal: 16 },
  scar: { label: "Scarred", penalty: 0.08, ticksToHeal: Infinity },
  lost: { label: "Lost", penalty: 0.4, ticksToHeal: Infinity },
};

// Pick a part by a hit-location distribution. Trunk parts and limbs
// are common, head + heart rare. Returns the part id.
const HIT_WEIGHTS = [
  ["leg", 18],
  ["arm", 16],
  ["hand", 10],
  ["foot", 10],
  ["lung", 6],
  ["liver", 5],
  ["spine", 4],
  ["head", 6],
  ["eye", 4],
  ["ear", 3],
  ["nose", 4],
  ["heart", 2],
  ["brain", 2],
];

export function rollHitPart(rng) {
  return rng.weighted(HIT_WEIGHTS);
}

// Add a wound. Returns { partId, severity, vitalKill }.
// vitalKill === true means progression.js should resolve a run death.
export function woundPart(run, partId, severity, _rng) {
  if (!run) return null;
  run.injuries = run.injuries || {};
  run.injuries[partId] = run.injuries[partId] || { parts: [] };
  // Cap entries per part by its count so a 2-eye sigma can't accrue
  // five separate eye wounds.
  const part = BODY_PARTS[partId];
  if (!part) return null;
  const list = run.injuries[partId].parts;
  if (list.length >= part.count && severity !== "scar" && severity !== "lost") {
    severity = upgrade(severity); // already wounded → escalate
  }
  list.push({ severity, ticksLeft: WOUND[severity]?.ticksToHeal ?? 0 });
  if (list.length > part.count) list.shift();

  // Vital part lost = run death.
  if (part.vital && severity === "lost") {
    return { partId, severity, vitalKill: true };
  }
  return { partId, severity, vitalKill: false };
}

function upgrade(severity) {
  if (severity === "light") return "serious";
  if (severity === "serious") return "scar";
  return severity;
}

// Tick light wounds toward healing. Serious wounds tick toward "scar".
// Scars and lost wounds never heal here — town heal does that.
export function tickHealth(run) {
  if (!run?.injuries) return;
  for (const id of Object.keys(run.injuries)) {
    const slot = run.injuries[id];
    const remaining = [];
    for (const w of slot.parts) {
      if (w.severity === "scar" || w.severity === "lost") {
        remaining.push(w);
        continue;
      }
      w.ticksLeft -= 1;
      if (w.ticksLeft <= 0) {
        if (w.severity === "serious") {
          remaining.push({ severity: "scar", ticksLeft: Infinity });
        }
        // light → gone
      } else {
        remaining.push(w);
      }
    }
    if (remaining.length) slot.parts = remaining;
    else delete run.injuries[id];
  }
}

// Town heal — clears scars on a sigma sleeping in Ironhollow. (Lost
// parts stay lost for the run.) Returns the count of scars cleared.
export function townHeal(run) {
  if (!run?.injuries) return 0;
  let cleared = 0;
  for (const id of Object.keys(run.injuries)) {
    const slot = run.injuries[id];
    slot.parts = slot.parts.filter((w) => {
      if (w.severity === "scar") {
        cleared += 1;
        return false;
      }
      return w.severity === "lost";
    });
    if (!slot.parts.length) delete run.injuries[id];
  }
  return cleared;
}

// Aggregate stat penalties from current injuries.
export function healthMods(run) {
  const out = { hpMul: 1, atkMul: 1, speedMul: 1, defMul: 1, critAdd: 0 };
  if (!run?.injuries) return out;
  for (const id of Object.keys(run.injuries)) {
    const def = BODY_PARTS[id];
    if (!def) continue;
    let totalPenalty = 0;
    for (const w of run.injuries[id].parts) totalPenalty += WOUND[w.severity]?.penalty || 0;
    if (totalPenalty <= 0) continue;
    switch (def.capStat) {
      case "attack":
        out.atkMul *= Math.max(0.4, 1 - totalPenalty);
        break;
      case "speed":
        out.speedMul *= Math.max(0.4, 1 - totalPenalty);
        break;
      case "hp":
        out.hpMul *= Math.max(0.5, 1 - totalPenalty);
        break;
      case "critChance":
        out.critAdd -= totalPenalty * 0.4;
        break;
      default:
        // Mild general defence hit for un-capped parts (face, ear).
        out.defMul *= Math.max(0.6, 1 - totalPenalty * 0.5);
    }
  }
  return out;
}

export function injuryList(run) {
  if (!run?.injuries) return [];
  const out = [];
  for (const id of Object.keys(run.injuries)) {
    const def = BODY_PARTS[id];
    if (!def) continue;
    for (const w of run.injuries[id].parts) {
      out.push({
        partId: id,
        partName: def.name,
        severity: w.severity,
        label: WOUND[w.severity]?.label || w.severity,
        ticksLeft: w.ticksLeft,
      });
    }
  }
  return out;
}
