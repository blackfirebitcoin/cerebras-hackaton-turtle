// SIGMA ABYSS — storyteller events.
//
// RimWorld's narrative engine: a small bestiary of random events that
// drop into the delve at unpredictable intervals. We expose three
// storyteller "personalities", picked by the character seed:
//
//   Cassandra Classic  — steady escalation, more events as level climbs.
//   Phoebe Chillax     — relaxed; events are rare and usually positive.
//   Randy Random       — anything goes, both ways.
//
// Each event is a small effect bundle (heal, free loot, disease,
// danger spike, etc.). All RNG draws go through the run's RNG so two
// same-seed runs draw the same events.
//
// Pure ESM. Reads progression state, returns an effect descriptor that
// progression.js applies.

import { infect } from "./diseases.js";
import { rollDrop } from "./loot.js";
import { addMoodThought } from "./mood.js";
import { makeRng, mixSeed } from "./rng.js";

export const STORYTELLERS = {
  cassandra: {
    id: "cassandra",
    name: "Cassandra Classic",
    blurb: "Steady drumbeat. Threats and gifts climb with the run.",
    baseChance: 0.05,
    perDepth: 0.005,
    biasGood: 0.5,
  },
  phoebe: {
    id: "phoebe",
    name: "Phoebe Chillax",
    blurb: "Rare events, leans kind. The chill streamer's pick.",
    baseChance: 0.025,
    perDepth: 0.002,
    biasGood: 0.75,
  },
  randy: {
    id: "randy",
    name: "Randy Random",
    blurb: "Chaos. Loot showers and plagues land in the same hour.",
    baseChance: 0.08,
    perDepth: 0.004,
    biasGood: 0.5,
  },
};

export const STORYTELLER_IDS = Object.keys(STORYTELLERS);

// Pick the sigma's storyteller from the seed. RimWorld lets the player
// pick; we let the seed pick (it's flavour, swappable later).
export function rollStoryteller(seed) {
  // Stable: take the seed mod 3.
  const idx = (seed >>> 0) % STORYTELLER_IDS.length;
  return STORYTELLER_IDS[idx];
}

// ── Event catalogue ───────────────────────────────────────────────────
// Each event:
//   id, name, kind ("good"|"bad"), description
//   apply(character, run, rng) → effect descriptor
//
// Effect descriptor shape — progression.js reads these flags:
//   heal           % of maxHp to restore
//   damage         flat hp to remove
//   gold           gold delta
//   potions        potion delta (clamped at POTION_MAX)
//   dangerDelta    danger delta (positive = spike, negative = relief)
//   moodThought    id to add to the mood stack
//   loot           [items]
//   disease        disease id to start
//   skipNext       set _twitchEliteNext-like one-shot flags
//   text           one-line stream feed snippet
const EVENTS = {
  // ── Good events ───────────────────────────────────────────────────
  drop_pod: {
    id: "drop_pod",
    name: "Mysterious Drop Pod",
    kind: "good",
    description: "A burning canister punches through the ceiling. Loot spills out.",
    apply: (_char, run, rng) => {
      const count = rng.int(1, 3);
      const loot = [];
      for (let i = 0; i < count; i++) {
        loot.push(rollDrop({ rng, level: run.level, depth: run.depth, bias: 2 }));
      }
      return { loot, text: "A drop pod hisses open at their feet." };
    },
  },
  trader_caravan: {
    id: "trader_caravan",
    name: "Trader Caravan",
    kind: "good",
    description: "Wandering merchants. They pay top coin for excess loot.",
    apply: (_char, run, rng) => {
      const gold = rng.int(60, 220) * Math.max(1, run.level >> 1);
      return { gold, moodThought: "banked_haul", text: `A caravan paid ${gold}g for road tales.` };
    },
  },
  refugee_grateful: {
    id: "refugee_grateful",
    name: "Grateful Refugee",
    kind: "good",
    description: "A survivor presses a healing potion into your hand.",
    apply: (_char, _run, rng) => ({
      potions: rng.int(1, 3),
      text: "A refugee handed over potions.",
    }),
  },
  divine_blessing: {
    id: "divine_blessing",
    name: "Divine Blessing",
    kind: "good",
    description: "Wounds knit. Mind clears.",
    apply: () => ({ heal: 0.6, moodThought: "inspired", text: "A warm light settled the wounds." }),
  },
  ancient_shrine: {
    id: "ancient_shrine",
    name: "Ancient Shrine",
    kind: "good",
    description: "Old altar. The right offering quiets the danger.",
    apply: () => ({ dangerDelta: -0.18, text: "An old shrine calmed the abyss for a while." }),
  },
  buried_stash: {
    id: "buried_stash",
    name: "Buried Stash",
    kind: "good",
    description: "Loose stone covers a stash long forgotten.",
    apply: (_char, run, rng) => {
      const gold = rng.int(80, 320);
      const loot = rng.chance(0.4)
        ? [rollDrop({ rng, level: run.level, depth: run.depth, bias: 3 })]
        : [];
      return { gold, loot, text: `${gold}g and rumours of more in a buried cache.` };
    },
  },
  // ── Bad events ────────────────────────────────────────────────────
  ambush: {
    id: "ambush",
    name: "Ambush",
    kind: "bad",
    description: "A pack falls on the sigma from above.",
    apply: () => ({ dangerDelta: 0.18, text: "An ambush sent danger climbing." }),
  },
  toxic_fallout: {
    id: "toxic_fallout",
    name: "Toxic Fallout",
    kind: "bad",
    description: "A cloud of black rain. Burns the lungs.",
    apply: (_char, run, rng) => ({
      damage: Math.round(rng.int(5, 14) * Math.max(1, run.level / 5)),
      moodThought: "badly_hurt",
      text: "Toxic fallout chewed at the lungs.",
    }),
  },
  plague_carrier: {
    id: "plague_carrier",
    name: "Plague Carrier",
    kind: "bad",
    description: "A coughing wretch staggered past. Something stuck.",
    apply: (_char, _run, rng) => ({
      disease: rng.pick(["plague", "flu", "malaria", "gut_worms"]),
      text: "A plague carrier left them coughing.",
    }),
  },
  cursed_relic: {
    id: "cursed_relic",
    name: "Cursed Relic",
    kind: "bad",
    description: "An old idol whispers. They drop a potion.",
    apply: (_char, run) => {
      const lost = Math.min(2, run.potions || 0);
      return {
        potions: -lost,
        moodThought: "cursed_in_combat",
        text: "A relic ate potions whole.",
      };
    },
  },
  bad_dream: {
    id: "bad_dream",
    name: "Bad Dream",
    kind: "bad",
    description: "Whatever they saw stays with them.",
    apply: () => ({ moodThought: "rival_thrived", text: "A nightmare clung between fights." }),
  },
  // ── Neutral / strategic ───────────────────────────────────────────
  wanderer_joins: {
    id: "wanderer_joins",
    name: "Wandering Helper",
    kind: "good",
    description: "A stranger walks beside them for a while.",
    apply: (_char, run, rng) => ({
      heal: 0.3,
      potions: 1,
      loot: rng.chance(0.5) ? [rollDrop({ rng, level: run.level, depth: run.depth, bias: 1 })] : [],
      text: "A stranger walked beside them and shared their pack.",
    }),
  },
  solar_flare: {
    id: "solar_flare",
    name: "Solar Flare",
    kind: "bad",
    description: "Enchantments fail. Weapons lose their edge briefly.",
    apply: () => ({ dangerDelta: 0.08, dampensArts: 4, text: "A solar flare killed the magic." }),
  },
  cold_snap: {
    id: "cold_snap",
    name: "Cold Snap",
    kind: "bad",
    description: "Everything slows.",
    apply: () => ({ dangerDelta: -0.05, slowsForTicks: 4, text: "A cold snap slowed everyone." }),
  },
};

export const EVENT_IDS = Object.keys(EVENTS);

// Per-tick incidence — caller checks this and rolls one event when it
// fires. Slightly accelerates with depth so deep delves see more drama.
export function tickEventChance(storytellerId, run) {
  const teller = STORYTELLERS[storytellerId] || STORYTELLERS.cassandra;
  return teller.baseChance + (run?.depth || 0) * teller.perDepth;
}

// Roll one event. Returns { def, effect } or null. Caller applies the
// effect descriptor inside delveTick.
export function rollEvent(storytellerId, character, run, rng) {
  const teller = STORYTELLERS[storytellerId] || STORYTELLERS.cassandra;
  // Choose good/bad pool by storyteller bias, then weight inside.
  const goodPool = EVENT_IDS.filter((id) => EVENTS[id].kind === "good");
  const badPool = EVENT_IDS.filter((id) => EVENTS[id].kind === "bad");
  const wantGood = rng.chance(teller.biasGood);
  const pool = wantGood && goodPool.length ? goodPool : badPool.length ? badPool : EVENT_IDS;
  const id = rng.pick(pool);
  const def = EVENTS[id];
  if (!def) return null;
  const effect = def.apply(character, run, rng) || {};
  return { def, effect };
}

export function eventById(id) {
  return EVENTS[id] || null;
}

// ── WORLD events (master design §M4/§5, [A3]+[A6]) ────────────────────
// World events are zone-wide crises generated by the server world tick and
// injected into each delver's run._pendingWorldEvents, consumed ONCE in
// delveTick's post-RNG effect block. Unlike storyteller events they are NOT
// rolled inside delveTick and applyWorldEvent draws NO rng — so they cannot
// desync offline sim (master §4.2 determinism firewall). Effects are fixed
// deltas only.
export const WORLD_EVENTS = {
  void_convergence: {
    id: "void_convergence",
    name: "Void Convergence",
    blurb: "The dark thickens — every step costs more.",
    weight: 3,
    effect: { dangerDelta: 0.4, moodThought: "ally_died" },
  },
  blood_moon: {
    id: "blood_moon",
    name: "Blood Moon",
    blurb: "Risk and reward both spike under the red light.",
    weight: 3,
    effect: { dangerDelta: 0.25, lootBias: 2 },
  },
  abyssal_calm: {
    id: "abyssal_calm",
    name: "Abyssal Calm",
    blurb: "A rare lull — the Abyss exhales.",
    weight: 2,
    effect: { dangerDelta: -0.2, heal: 0.2 },
  },
  plague_wind: {
    id: "plague_wind",
    name: "Plague Wind",
    blurb: "A sickness rides the air through the whole zone.",
    weight: 2,
    effect: { disease: "plague", dangerDelta: 0.1 },
  },
  gold_rush: {
    id: "gold_rush",
    name: "Gold Rush",
    blurb: "The Ember Court's coffers spill into the deep.",
    weight: 2,
    effect: { gold: 200 },
  },
};
export const WORLD_EVENT_IDS = Object.keys(WORLD_EVENTS);

export function worldEventById(id) {
  return WORLD_EVENTS[id] || null;
}

// Deterministic, auditable per (worldSeed, epoch, zone) — SERVER-ONLY (called
// from the world tick, never delveTick). `pFire` is the per-tick chance a zone
// spawns an event. Returns a world-event descriptor {id, name, effect, ...} or
// null. Deterministic so a replay of the world from its seed reproduces it.
export function rollWorldEvent(worldSeed, zoneId, epoch, pFire = 0.06) {
  let zh = 2166136261;
  for (let i = 0; i < zoneId.length; i += 1) {
    zh ^= zoneId.charCodeAt(i);
    zh = Math.imul(zh, 16777619);
  }
  const rng = makeRng(mixSeed(worldSeed >>> 0, mixSeed(epoch >>> 0, zh >>> 0)));
  if (!rng.chance(pFire)) return null;
  const entries = WORLD_EVENT_IDS.map((id) => [id, WORLD_EVENTS[id].weight || 1]);
  const id = rng.weighted(entries);
  const def = WORLD_EVENTS[id];
  return { id, name: def.name, blurb: def.blurb, effect: { ...def.effect } };
}

// ── WORLD CRISES (master §2.1, [A3]) — the world-level event engine ───
// A crisis is a time-boxed, collectively-resolved event with phases
// brewing → active → resolving → concluded. Chatters contribute via its
// `contributeVerb` until `target` is met (or it times out). While active, its
// `personalEffect` is injected into delvers' runs. Catalog is server-driven
// (world tick); pure data here.
export const WORLD_CRISES = {
  void_convergence: {
    id: "void_convergence",
    name: "Void Convergence",
    brewingText: "Cracks in the stone. Something stirs below.",
    activeText: "The Void Convergence is open — danger surges abyss-wide.",
    contributeVerb: "fight",
    target: 200,
    personalEffect: { dangerDelta: 0.4 },
    weight: 3,
  },
  plague_wind: {
    id: "plague_wind",
    name: "Plague Wind",
    brewingText: "Smoke where there is no fire.",
    activeText: "Plague Wind howls through every zone.",
    contributeVerb: "pray",
    target: 150,
    personalEffect: { disease: "plague" },
    weight: 2,
  },
  loot_surge: {
    id: "loot_surge",
    name: "Loot Surge",
    brewingText: "A rumble from below. The vaults are cracking.",
    activeText: "A Loot Surge floods the deep.",
    contributeVerb: "gather",
    target: 120,
    personalEffect: { gold: 50 },
    weight: 2,
  },
  iron_siege: {
    id: "iron_siege",
    name: "Iron Siege",
    brewingText: "Hammering at the gates.",
    activeText: "Iron Siege blocks the gates — the town is under pressure.",
    contributeVerb: "fight",
    target: 220,
    personalEffect: { dangerDelta: 0.25 },
    weight: 2,
  },
};
export const WORLD_CRISIS_IDS = Object.keys(WORLD_CRISES);

export function worldCrisisById(id) {
  return WORLD_CRISES[id] || null;
}

// Deterministic crisis roll for the world tick (server-only). pFire is the
// per-eligible-tick launch chance. Returns a crisis descriptor or null.
export function rollCrisis(worldSeed, epoch, pFire = 0.15) {
  const rng = makeRng(mixSeed(worldSeed >>> 0, mixSeed(epoch >>> 0, 0x9e3779b9)));
  if (!rng.chance(pFire)) return null;
  const entries = WORLD_CRISIS_IDS.map((id) => [id, WORLD_CRISES[id].weight || 1]);
  const id = rng.weighted(entries);
  const def = WORLD_CRISES[id];
  return {
    id,
    name: def.name,
    contributeVerb: def.contributeVerb,
    target: def.target,
    personalEffect: { ...def.personalEffect },
    brewingText: def.brewingText,
    activeText: def.activeText,
  };
}

// Apply a world event's fixed deltas to a run/character. NO rng draws → safe
// to call in delveTick after the rng-state save (offline-sim-safe). Returns a
// short summary for the feed.
export function applyWorldEvent(worldEvent, character, run) {
  const eff = worldEvent?.effect;
  if (!eff || !run) return null;
  if (eff.dangerDelta) run.danger = Math.max(0, Math.min(1, (run.danger || 0) + eff.dangerDelta));
  if (eff.gold && character) character.gold = (character.gold | 0) + eff.gold;
  if (eff.heal) run.hp = Math.max(1, run.hp); // calm soothes; full heal handled by caller's sheet if desired
  if (eff.disease && character && !run.diseases?.[eff.disease]) {
    infect(run, character, eff.disease); // rng-free; same path the storyteller block uses
  }
  if (eff.moodThought && character?.mood)
    addMoodThought(character.mood, character, eff.moodThought);
  return { id: worldEvent.id, name: worldEvent.name };
}
