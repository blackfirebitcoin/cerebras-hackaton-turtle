// SIGMA ABYSS — factions & reputation (the persistent-world allegiance layer).
//
// This is the single canonical faction module (master design §0.6) — the
// merge of the five different `factions.js` the design team independently
// proposed. Five factions map 1:1 onto the five real danger zones
// (shared/zones.js). Everything here is **pure**: a static catalog plus
// pure math, with exactly one deterministic helper (`pickFactionRaider`,
// seeded via rng.js). No Math.random, no Node built-ins, no DOM — so it
// runs byte-identically in the browser and in Node (invariants 1 + 2).
//
// Reputation model (master §0.2): a character has ONE joined `faction`
// (string|null) and a `factionRep` map `{ [factionId]: int 0..1000 }`.
// The joined faction's value is the 0..1000 rank ladder (§0.3); standing
// with other factions sits around a neutral baseline of 500. One field,
// one clamp regime — no negative domain.
//
// The combat-stacking entry point is `factionCombatMods`, called from
// `stats.js:derive`. It returns EXACT identity (×1, +0) whenever the
// character has no faction or sits at rank 0, so `derive` output stays
// byte-identical for every pre-faction character (IEEE754: x×1===x,
// x+0===x) — the back-compat guarantee the determinism canary depends on.

import { makeRng, mixSeed } from "./rng.js";

// ── Reputation scale (master §0.2) ────────────────────────────────────
export const FACTION_MAX_REP = 1000;
export const FACTION_REP_NEUTRAL = 500; // standing baseline with non-joined factions
export const FACTION_JOIN_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // re-pledge lockout after a switch
export const FACTION_DEFECTOR_MS = 24 * 3600 * 1000; // "traitor" window after defecting
export const FACTION_ABYSSAL_PRESTIGE_GATE = 500; // prestige needed to join the Convergence

// ── The five canonical factions (master §0.1) ─────────────────────────
// `homeZone` is a real `shared/zones.js` id. `rival`/`allied` are faction
// ids (or 'all'/null for the Convergence). `archetype` keys the combat
// lean in ARCHETYPES below so each faction plays differently.
export const FACTIONS = {
  iron_veil: {
    id: "iron_veil",
    name: "Iron Veil",
    blurb: "Wardens of Ironhollow. They hold the line so others can dig.",
    homeZone: "goblin_warrens",
    archetype: "defense",
    rival: "crimson_pact",
    allied: "void_order",
    color: "#4aa3ff",
  },
  crimson_pact: {
    id: "crimson_pact",
    name: "Crimson Pact",
    blurb: "Blood-oath berserkers. Every kill is a sacrament; every wound a prayer.",
    homeZone: "cursed_forest",
    archetype: "offense",
    rival: "iron_veil",
    allied: "ember_court",
    color: "#ff4d6d",
  },
  void_order: {
    id: "void_order",
    name: "Void Order",
    blurb: "Scholars of the dark between. They read the Abyss like a grimoire.",
    homeZone: "infernal_highway",
    archetype: "sorcery",
    rival: "ember_court",
    allied: "iron_veil",
    color: "#b86bff",
  },
  ember_court: {
    id: "ember_court",
    name: "Ember Court",
    blurb: "Merchant-kings. They do not fight the Abyss — they price it.",
    homeZone: "demon_catacombs",
    archetype: "economy",
    rival: "void_order",
    allied: "crimson_pact",
    color: "#ffe44d",
  },
  abyssal_convergence: {
    id: "abyssal_convergence",
    name: "Abyssal Convergence",
    blurb: "Those who stopped fighting the dark and joined it. Rival to all.",
    homeZone: "abyss_ruins",
    archetype: "chaos",
    rival: "all",
    allied: null,
    color: "#5bd16a",
    prestigeGate: FACTION_ABYSSAL_PRESTIGE_GATE,
  },
};

export const FACTION_IDS = Object.keys(FACTIONS);

// Factions a brand-new sigma can be auto-enrolled into (every chatter joins the
// MMO automatically — no !join needed). Excludes the prestige-gated endgame
// faction. `starterFactionForSeed` makes the pick deterministic + ~uniform.
export const STARTER_FACTION_IDS = FACTION_IDS.filter((id) => !FACTIONS[id].prestigeGate);

export function starterFactionForSeed(seed) {
  return STARTER_FACTION_IDS[(seed >>> 0) % STARTER_FACTION_IDS.length];
}

// Combat leanings per archetype. These are *weights*; the magnitude is
// applied by `factionCombatMods` scaled by rank (and doubled in the home
// zone). Distinct profiles = distinct viable playstyles, no dominant one:
//   defense  → tanky wardens (Iron Veil)
//   offense  → glass berserkers (Crimson Pact)
//   sorcery  → crit casters (Void Order)
//   economy  → loot-focused, combat-light (Ember Court)
//   chaos    → high-risk all-rounder, courts danger (Abyssal Convergence)
const ARCHETYPES = {
  defense: { hp: 0.6, atk: 0.0, def: 1.0, crit: 0.0, loot: 0.0, dangerReduce: 1.0 },
  offense: { hp: 0.0, atk: 1.0, def: -0.3, crit: 0.4, loot: 0.0, dangerReduce: -0.4 },
  sorcery: { hp: 0.0, atk: 0.3, def: 0.2, crit: 1.0, loot: 0.3, dangerReduce: 0.0 },
  economy: { hp: 0.0, atk: 0.0, def: 0.2, crit: 0.0, loot: 1.0, dangerReduce: 0.2 },
  chaos: { hp: 0.4, atk: 0.6, def: -0.3, crit: 0.3, loot: 0.4, dangerReduce: -0.8 },
};

// Exact identity: returned for no-faction / rank-0 so derive stays
// byte-identical. Frozen so a caller can never mutate the shared object.
const IDENTITY_MODS = Object.freeze({
  hpMul: 1,
  atkMul: 1,
  defMul: 1,
  critAdd: 0,
  lootRarityAdd: 0,
  lootQtyAdd: 0,
  dangerMul: 1,
});

// ── Rank ladder (master §0.3) ─────────────────────────────────────────
const RANK_LABELS = [
  "Outsider",
  "Initiate",
  "Member",
  "Champion",
  "Vanguard",
  "Warlord",
  "Sovereign",
];

export function factionById(id) {
  return FACTIONS[id] || null;
}

// rep (0..1000) → rank (0..6) per the §0.3 ladder thresholds.
export function factionRank(rep) {
  const r = Number.isFinite(rep) ? rep | 0 : 0;
  if (r >= 1000) return 6;
  if (r >= 750) return 5;
  if (r >= 500) return 4;
  if (r >= 300) return 3;
  if (r >= 150) return 2;
  if (r >= 50) return 1;
  return 0;
}

export function factionRankLabel(rank) {
  return RANK_LABELS[Math.max(0, Math.min(6, rank | 0))] || "Outsider";
}

// "Iron Veil Champion" — used in chat replies + the overlay nameplate.
export function factionRankTitle(factionId, rep) {
  const f = factionById(factionId);
  if (!f) return null;
  return `${f.name} ${factionRankLabel(factionRank(rep))}`;
}

// Symmetric rivalry. The Convergence (rival:'all') opposes everyone.
export function isRival(a, b) {
  if (!a || !b || a === b) return false;
  const fa = factionById(a);
  const fb = factionById(b);
  if (!fa || !fb) return false;
  if (fa.rival === "all" || fb.rival === "all") return true;
  return fa.rival === b || fb.rival === a;
}

export function isAllied(a, b) {
  if (!a || !b || a === b) return false;
  const fa = factionById(a);
  const fb = factionById(b);
  if (!fa || !fb) return false;
  return fa.allied === b || fb.allied === a;
}

// A small combat edge fighting on contested ground against a rival, used
// by later milestones' duel/war hooks. Pure scalar; 0 when not rivals.
export function rivalMod(a, b) {
  return isRival(a, b) ? 0.05 : 0;
}

// ── THE derive() stacker (master §0.6, pure) ──────────────────────────
// Returns identity for no-faction / rank-0 so `derive` is byte-identical
// for every existing character (back-compat). Otherwise applies the
// archetype lean scaled by rank, doubled in the faction's home zone.
export function factionCombatMods(factionId, factionRep, zoneId) {
  if (!factionId) return IDENTITY_MODS;
  const f = factionById(factionId);
  if (!f) return IDENTITY_MODS;
  const rep = factionRep && Number.isFinite(factionRep[factionId]) ? factionRep[factionId] : 0;
  const rank = factionRank(rep);
  if (rank <= 0) return IDENTITY_MODS; // a rep-0 member fights exactly like a non-member
  const arch = ARCHETYPES[f.archetype];
  if (!arch) return IDENTITY_MODS;
  const home = zoneId && zoneId === f.homeZone ? 2 : 1; // home advantage doubles the lean
  const k = rank * 0.02 * home; // rank 6 in home zone ≈ +24% headline
  return {
    hpMul: 1 + arch.hp * k,
    atkMul: 1 + arch.atk * k,
    defMul: 1 + arch.def * k,
    critAdd: arch.crit * k * 0.5,
    lootRarityAdd: arch.loot * k * 3,
    lootQtyAdd: arch.loot * k * 0.5,
    dangerMul: 1 - arch.dangerReduce * k * 0.5,
  };
}

// ── Faction territory conquest bonus (master §0.6, pure) ──────────────
// `worldZone` is a `world.zones[zoneId]` snapshot. Members fight a little
// better in zones their faction holds, a little worse in a rival's.
export function factionZoneMod(factionId, worldZone) {
  if (!factionId || !worldZone?.conquestOwner) return 0;
  const owner = worldZone.conquestOwner;
  if (owner === factionId) return 0.1;
  if (isRival(owner, factionId)) return -0.1;
  return 0;
}

// Weapon arts unlocked by rank (master §0.3 perks). Pure lookup.
const FACTION_ARTS = {
  iron_veil: ["bulwark", "aegis_wall", "last_stand"],
  crimson_pact: ["blood_frenzy", "crimson_rite", "exsanguinate"],
  void_order: ["void_bolt", "entropy_sigil", "unmake"],
  ember_court: ["gilded_strike", "tithe", "midas_decree"],
  abyssal_convergence: ["maw", "dissolution", "convergence"],
};
export function factionArts(factionId, rank) {
  const arts = FACTION_ARTS[factionId];
  if (!arts) return [];
  // Champion (3) unlocks the first art, Vanguard (4) the second, Warlord (5) the third.
  const n = Math.max(0, Math.min(arts.length, (rank | 0) - 2));
  return arts.slice(0, n);
}

// Rep earned for a kill, biased toward your faction's home zone and the
// kill's significance. Pure; the side-effecting application lives in the
// (future) shared/faction-engine.js.
export function factionRepGainForKill(zoneId, factionId, killKind) {
  if (!factionId) return 0;
  const f = factionById(factionId);
  if (!f) return 0;
  const base = killKind === "boss" ? 10 : killKind === "elite" ? 3 : 1;
  const homeBonus = zoneId && zoneId === f.homeZone ? 2 : 1;
  return base * homeBonus;
}

// Band label for standing with a non-joined faction (around neutral 500).
export function factionDisposition(factionRep, factionId) {
  const rep =
    factionRep && Number.isFinite(factionRep[factionId])
      ? factionRep[factionId]
      : FACTION_REP_NEUTRAL;
  if (rep >= 800) return "honored";
  if (rep >= 650) return "friendly";
  if (rep > 350) return "neutral";
  if (rep > 200) return "wary";
  return "hostile";
}

// Vendor price multiplier from standing: honored buys cheaper, hostile
// pays a surcharge. Clamped to a sane band. Pure.
export function priceMultiplier(factionRep, factionId) {
  const rep =
    factionRep && Number.isFinite(factionRep[factionId])
      ? factionRep[factionId]
      : FACTION_REP_NEUTRAL;
  // 1000 → 0.8 (20% off), 0 → 1.2 (20% surcharge), linear, clamped.
  const m = 1.2 - (rep / FACTION_MAX_REP) * 0.4;
  return Math.max(0.8, Math.min(1.2, m));
}

// ── Deterministic faction territory raider (master §0.6) ──────────────
// The ONE deterministic helper. Given the immutable world seed and a tick
// counter, picks which contesting faction presses a zone this tick —
// reproducible for audit (master §4.1) and never touches a player's run
// RNG state, so it cannot desync offline sim.
export function pickFactionRaider(worldSeed, zoneTick, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const rng = makeRng(mixSeed(worldSeed >>> 0, zoneTick >>> 0));
  return rng.pick(candidates);
}
