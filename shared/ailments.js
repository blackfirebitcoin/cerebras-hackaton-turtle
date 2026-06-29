// SIGMA ABYSS — status ailments + elemental combos (Project Ascendant Inc 2).
//
// "The heart of combat." Weapons and arts inflict status AILMENTS on
// enemies (Wet, Burning, Chilled, Bleeding, Stunned). When a follow-up
// hit carries the right elemental TRIGGER and the target already wears a
// matching ailment, a COMBO detonates for big bonus damage / AOE / a
// shatter — the payoff loop.
//
// ── DETERMINISM FIREWALL (the binding constraint) ─────────────────────
// This module is pure data + pure functions: NO rng, NO Math.random, no
// Node built-ins, no DOM. It is dual-runtime (browser ESM + Node) like
// the rest of shared/.
//
// The ONE place a die is rolled (does an ailment proc this swing?) lives
// in combat.js, and is GATED behind `weaponAilment(family)` returning a
// non-null spec. A weapon family that applies NO ailment (sword, bow,
// greatsword, spear) returns null here → combat.js draws ZERO extra rng
// → resolveEncounter / derive output stays byte-identical for every
// pre-ailment character. This is the same "exact-identity when absent"
// discipline as factionCombatMods / talentMods / setModsForBonuses
// (×1 / +0 when empty). Combo DETECTION reads only pre-existing target
// state — it never draws.

// ── Ailment catalog ───────────────────────────────────────────────────
// Each ailment: id, human label, default stack count when applied, ttl in
// ticks (how long it lingers untouched), and flags combat.js keys on:
//   dot       — deals damage-over-time each enemy phase (bleeding, burning)
//   skipTurn  — the afflicted enemy loses its next action (stunned)
//   element   — the elemental "school" it belongs to (for combo matching)
export const AILMENTS = {
  wet: {
    id: "wet",
    label: "Wet",
    stacks: 1,
    ttl: 4,
    dot: false,
    skipTurn: false,
    element: "water",
  },
  burning: {
    id: "burning",
    label: "Burning",
    stacks: 1,
    ttl: 3,
    dot: true,
    skipTurn: false,
    element: "fire",
    // DoT pulse = this fraction of the AILMENT SOURCE's attack, per stack.
    dotFrac: 0.22,
  },
  chilled: {
    id: "chilled",
    label: "Chilled",
    stacks: 1,
    ttl: 3,
    dot: false,
    skipTurn: false,
    element: "ice",
  },
  bleeding: {
    id: "bleeding",
    label: "Bleeding",
    stacks: 1,
    ttl: 3,
    dot: true,
    skipTurn: false,
    element: "physical",
    dotFrac: 0.18,
  },
  stunned: {
    id: "stunned",
    label: "Stunned",
    stacks: 1,
    ttl: 1,
    dot: false,
    skipTurn: true,
    element: "physical",
  },
};

export const AILMENT_IDS = Object.keys(AILMENTS);

// ── Weapon-family → ailment ───────────────────────────────────────────
// THE determinism gate. Families NOT listed here return null → no proc
// draw at all in combat.js → byte-identical to pre-Inc2 for those
// characters. (sword, greatsword, bow, spear apply no ailment by family.)
//
//   axe / dagger → Bleeding (cutting edges)
//   staff / wand → Burning  (spellfire)
//   hammer / fists → Stunned (concussive blunt / guard-break)
//
// procChance is the per-qualifying-swing chance the ailment lands; scaled
// up a touch by weapon plus in weaponAilment().
const FAMILY_AILMENT = {
  axe: { id: "bleeding", baseChance: 0.35 },
  dagger: { id: "bleeding", baseChance: 0.3 },
  staff: { id: "burning", baseChance: 0.32 },
  wand: { id: "burning", baseChance: 0.3 },
  hammer: { id: "stunned", baseChance: 0.22 },
  fists: { id: "stunned", baseChance: 0.16 },
};

// Resolve the ailment a wielded weapon can inflict. Returns null when the
// family applies none — combat.js MUST treat null as "draw nothing".
// `plus` (weapon upgrade tier 0..10) nudges proc chance up modestly.
export function weaponAilment(family, plus = 0) {
  const f = FAMILY_AILMENT[family];
  if (!f) return null;
  const base = AILMENTS[f.id];
  const p = Math.max(0, Math.min(10, plus | 0));
  // +1.2% chance per plus, capped so a +10 stays believable, never 100%.
  const procChance = Math.min(0.6, f.baseChance + p * 0.012);
  return { id: f.id, procChance, stacks: base.stacks, ttl: base.ttl };
}

// ── Art-driven ailments + combo triggers ──────────────────────────────
// Some weapon arts carry an elemental payload independent of the family
// proc. This is pure lookup — NO rng. An art either APPLIES an ailment
// (apply) and/or carries a combo TRIGGER tag (trigger) that detonates a
// pre-existing ailment on the target.
//
//   trigger tags: "shatter" (vs Chilled), "lightning" (vs Wet),
//                 "fire" (vs Wet→steam / vs Burning→ignite spread)
const ART_AILMENT = {
  // staff cold art → Chilled, and the dark-moon burst also shatters.
  rannis_dark_moon: { apply: "chilled", trigger: "shatter" },
  // moonlight wave is a heavy shatter trigger (sword endgame).
  moonveil: { trigger: "shatter" },
  // earthshatter — the hammer's literal shatter.
  earthshatter: { trigger: "shatter" },
  // void_ray reads as arcane lightning → detonates Wet.
  void_ray: { trigger: "lightning" },
  // arcane_torrent — rapid bolts, lightning trigger.
  arcane_torrent: { trigger: "lightning" },
  // comet — a falling firebrand → applies Burning + a fire trigger.
  comet: { apply: "burning", trigger: "fire" },
  // overload_surge — wand fire overload → fire trigger (ignite spread).
  overload_surge: { trigger: "fire" },
};

export function artAilment(artId) {
  return ART_AILMENT[artId] || null;
}

// ── Combos ────────────────────────────────────────────────────────────
// Each combo: a TRIGGER tag carried by the landing hit + a REQUIRED
// pre-existing ailment on the target → an effect.
//   mul    damage multiplier applied to the triggering hit
//   aoe    if set, splash a fraction of the bonus to one other live foe
//   spread if set, also apply this ailment to that splashed foe
// Detection is deterministic (reads target ailment state, draws nothing).
export const COMBOS = {
  // Chilled + a shatter hit → SHATTER: brittle ice cracks for +200% dmg.
  shatter: {
    id: "shatter",
    label: "SHATTER",
    requires: "chilled",
    trigger: "shatter",
    mul: 3.0, // +200%
    consumes: true, // the chill is spent shattering
  },
  // Wet + Lightning → ELECTROCUTE: water conducts for +100% dmg, arcs to
  // a nearby foe.
  electrocute: {
    id: "electrocute",
    label: "ELECTROCUTE",
    requires: "wet",
    trigger: "lightning",
    mul: 2.0, // +100%
    aoe: 0.5, // half the bonus arcs to one other foe
    consumes: true, // the wet boils off
  },
  // Wet + Fire → no big detonation (steam) but it CLEANSES the wet so the
  // target can burn next; small bonus. Kept light so it is not a strict
  // upgrade over electrocute.
  steam: {
    id: "steam",
    label: "STEAM",
    requires: "wet",
    trigger: "fire",
    mul: 1.25,
    consumes: true,
  },
  // Burning + Fire → IGNITE: a fresh fire hit on a burning foe explodes
  // into an AOE burn that spreads Burning to a neighbour.
  ignite: {
    id: "ignite",
    label: "IGNITE",
    requires: "burning",
    trigger: "fire",
    mul: 1.8, // +80%
    aoe: 0.45,
    spread: "burning",
    consumes: false, // the fire keeps burning
  },
};

// Find the combo a landing hit triggers, given the trigger tag it carries
// and the set/array of ailment ids currently on the target. Returns the
// combo spec or null. PURE — no rng, no side effects.
export function detectCombo(trigger, targetAilmentIds) {
  if (!trigger || !targetAilmentIds) return null;
  const has = Array.isArray(targetAilmentIds)
    ? (id) => targetAilmentIds.includes(id)
    : (id) => targetAilmentIds.has(id);
  for (const key of Object.keys(COMBOS)) {
    const c = COMBOS[key];
    if (c.trigger === trigger && has(c.requires)) return c;
  }
  return null;
}

// Convenience: does this family/weapon carry an innate combo trigger on a
// basic swing? Bleeding/Stunned families do not; only elemental sources
// trigger via arts. Returns a trigger tag or null. PURE.
//   staff/wand basic spellfire carries a "fire" trigger;
//   a cold source carries "ice"/"shatter" only via arts (handled there).
const FAMILY_TRIGGER = {
  staff: "fire",
  wand: "fire",
};
export function familyTrigger(family) {
  return FAMILY_TRIGGER[family] || null;
}
