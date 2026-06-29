// SIGMA ABYSS — progression: XP, the delve tick, permadeath, offline sim.
//
// This is the glue. delveTick() is THE tick — the live client calls it on
// a real-time timer, the offline simulator calls it in a loop, and both
// get identical results because every roll runs through the run's
// persisted RNG state. delveTick mutates the run from the encounter but
// never moves the character between zones; the caller orchestrates
// retreat / death / redeploy transitions.

import { backstoryProfile, rollBackstory } from "./backstory.js";
import { resolveEncounter } from "./combat.js";
import {
  AI_DEFAULTS,
  DANGER_BOSS_AT,
  DANGER_ELITE_AT,
  DANGER_MAX,
  DANGER_PER_TICK,
  DEPTH_MAX,
  GEAR_SLOTS,
  INVENTORY_MAX,
  LEVEL_MAX,
  OFFLINE_CAP_MS,
  OFFLINE_TICK_MS,
  RARITY_RANK,
  REST_GOLD_PER_HOUR,
  REST_PRESTIGE_PER_HOUR,
  SCHEMA_VERSION,
  START_STATS,
  STAT_KEYS,
  STAT_MIN,
  STAT_POINTS_PER_LEVEL,
  XP_BASE,
  XP_GROWTH,
} from "./constants.js";
import { reagentDrop } from "./crafting.js";
import { ambientInfectionChance, infect, tickDiseases } from "./diseases.js";
import { MARKET_LISTING_MAX_BASE } from "./economy-constants.js";
import { makeEnemy } from "./enemies.js";
import { applyKillRep } from "./faction-engine.js";
import { starterFactionForSeed } from "./factions.js";
import { rollHitPart, tickHealth, townHeal, woundPart } from "./health.js";
import { maybeStartInspiration, tickInspiration } from "./inspirations.js";
import { bareFists, rollDrop, sellValue } from "./loot.js";
import { SHARD_PER_PRESTIGE, VAULT_BASE_CAPACITY } from "./market.js";
import { maybeStartBreak, tickBreak } from "./mental-breaks.js";
import { addMoodThought, freshMood, tickMood } from "./mood.js";
import { starterClassForSeed } from "./passive-tree.js";
import { makeRng, mixSeed } from "./rng.js";
import { applyBackstoryXp, creditEncounterSkills, rollSkills } from "./skills.js";
import { derive } from "./stats.js";
import { applyWorldEvent, rollEvent, rollStoryteller, tickEventChance } from "./storyteller.js";
import { rollTraits, traitDiseaseProfile, traitEconomy, traitMoodProfile } from "./traits.js";
import { applyFaint, harvestVsTick, resolveLoadout, VS_TUNABLES } from "./vampire-survivors.js";
import { familyForBase } from "./weapons.js";
import { recommendedZone, zoneById } from "./zones.js";

// ── XP curve ──────────────────────────────────────────────────────────
export function xpForLevel(n) {
  return Math.round(XP_BASE * XP_GROWTH ** Math.max(0, n - 1));
}
function baseXpForLevel(level) {
  return 6 + level * 2.5;
}

export function gainXp(run, amount, character = null) {
  let leveled = false,
    levelsGained = 0,
    statPointsGained = 0;
  run.xp += Math.max(0, Math.round(amount));
  while (run.level < LEVEL_MAX && run.xp >= xpForLevel(run.level)) {
    run.xp -= xpForLevel(run.level);
    run.level += 1;
    run.statPoints += STAT_POINTS_PER_LEVEL;
    levelsGained += 1;
    statPointsGained += STAT_POINTS_PER_LEVEL;
    leveled = true;
  }
  if (leveled) {
    // A level-up patches you up — but only town fully heals.
    const mh = derive(run, character).maxHp;
    run.hp = Math.min(mh, run.hp + Math.round(mh * 0.3 * levelsGained));
    if (character?.mood) addMoodThought(character.mood, character, "leveled_up");
  }
  return { leveled, levelsGained, statPointsGained, newLevel: run.level };
}

// ── Fresh state ───────────────────────────────────────────────────────
export function freshRun(seed, runIndex, aiConfig, character = null) {
  const rngSeed = mixSeed(seed >>> 0, runIndex >>> 0);
  const run = {
    alive: true,
    level: 1,
    xp: 0,
    statPoints: 0,
    stats: { ...START_STATS },
    hp: 0,
    potions: 5, // a real heal buffer to learn the loop before the first restock
    gear: { weapon: bareFists(), armor: null, ring: null, relic: null, charm: null },
    // Dual specialization (Inc6): the INACTIVE set's gear loadout lives here,
    // run-side, so permadeath erases both sets' gear equally. null until the
    // player first materializes Set B (swapBuildSet). A pre-Inc6 run loads with
    // gearB null → exact-identity (derive only ever reads the active `gear`).
    gearB: null,
    inventory: [],
    // Vampire-Survivors layer (run-side, transient combat state). `gems` are the
    // in-flight XP pickups exposed in the combat snapshot; `gemSeq` is a stable
    // per-run counter for deterministic gem ids. Empty for a fresh run → the VS
    // layer is inert until the player equips a weapon loadout (account-side).
    gems: [],
    gemSeq: 0,
    zone: "town",
    depth: 0,
    danger: 0,
    ai: { ...AI_DEFAULTS, ...(aiConfig || {}) },
    rngSeed,
    rngState: rngSeed,
    kills: 0,
    encounters: 0,
    startedAt: Date.now(),
    // RimWorld run-side state.
    diseases: {},
    injuries: {},
    activeBreak: null,
    activeInspiration: null,
    eventsFired: 0,
    lastBreakTickIdx: -9999,
    lastInspirationIdx: -9999,
  };
  // Fear & Hunger scars — permanent account-side stat erosion (master §3.7).
  // Applied BEFORE backstory deltas and clamped to STAT_MIN, so a scarred
  // stat floors at 1 before backstory can lift it. Pure account data → the
  // offline sim applies them identically each run (deterministic).
  if (Array.isArray(character?.scars)) {
    for (const scar of character.scars) {
      if (scar && STAT_KEYS.includes(scar.stat)) {
        run.stats[scar.stat] = Math.max(STAT_MIN, (run.stats[scar.stat] || 0) + (scar.amount || 0));
      }
    }
  }
  // Backstory bumps starting stats — bake the deltas onto START_STATS so
  // the new run starts with the personality already showing.
  if (character?.backstory) {
    const bs = backstoryProfile(character.backstory.childhood, character.backstory.adulthood);
    if (bs.stats) {
      for (const k of Object.keys(bs.stats)) {
        run.stats[k] = (run.stats[k] || 0) + bs.stats[k];
      }
    }
  }
  run.hp = derive(run, character).maxHp;
  return run;
}

export function freshCharacter(seed, name) {
  const s = seed >>> 0 || 1;
  const hatStyles = ["cap", "beanie", "tophat", "cowboy", "wizard", "bare"];
  const hairStyles = ["short", "long", "bob", "ponytail", "spiky", "afro"];

  // RimWorld-style personality: roll backstory + traits + storyteller +
  // skills deterministically off the seed so two same-seed sigmas have
  // identical inner lives.
  const backstory = rollBackstory(s);
  let traits = rollTraits(s);
  for (const bt of backstory.bonusTraits || []) {
    if (!traits.includes(bt)) traits.push(bt);
  }
  // Cap at 5 so the trait list stays readable on the character sheet.
  if (traits.length > 5) traits = traits.slice(0, 5);

  const storyteller = rollStoryteller(s);
  const skills = rollSkills(s);

  // Backstory skill grants — applied AFTER passions are rolled so passion
  // multipliers bake the bonus XP at the right rate.
  const econ = traitEconomy(traits);
  const bsProfile = backstoryProfile(backstory.childhood, backstory.adulthood);
  applyBackstoryXp(skills, bsProfile.skills, econ.skillXpMul);

  const character = {
    v: SCHEMA_VERSION,
    name: name || `Sigma${(s % 9000) + 1000}`,
    seed: s,
    cosmetics: {
      hat_style: hatStyles[s % hatStyles.length],
      hair_style: hairStyles[(s >>> 3) % hairStyles.length],
    },
    prestige: 0,
    gold: bsProfile.gold || 0,
    titles: [],
    cosmeticsUnlocked: [],
    lifetimeKills: 0,
    lifetimeRuns: 0,
    bestDepth: 0,
    bestLevel: 1,
    highestLevel: 1,
    bestStreak: 0,
    streak: 0,
    bestItemPower: 0,
    posture: "delve",
    // RimWorld additions — account-side state.
    traits,
    backstory: { childhood: backstory.childhood, adulthood: backstory.adulthood },
    storyteller,
    skills,
    mood: freshMood(traits),
    // Persistent-world faction allegiance — ACCOUNT-side, so it survives
    // permadeath (resolveDeath only resets `run`). Master design §0.2:
    //   faction              the ONE faction you joined (!join), or null
    //   factionRep           {factionId: int 0..1000} standing with each
    //   factionRank          cached rank (0..6) for the joined faction
    //   factionJoinedAt      last-join ms (drives the re-pledge cooldown)
    //   factionDefectorUntil "traitor" window end after switching sides
    // Auto-enrolled: every sigma joins a faction at creation (no !join needed).
    // `factionAutoAssigned` marks it so the player's FIRST `!join` is a free
    // re-pick (no cooldown / defector penalty) — see commands.js:joinFaction.
    faction: starterFactionForSeed(s),
    factionRep: { [starterFactionForSeed(s)]: 0 },
    factionRank: 0,
    factionJoinedAt: Date.now(),
    factionDefectorUntil: 0,
    factionAutoAssigned: true,
    // Economy — ACCOUNT-side (survives permadeath). Master design §2.2 [A2].
    //   shards         non-transferable Prestige Shards (slots, lore stamps)
    //   runeDust       salvage product → affix rerolls (the crafting sink)
    //   vault          off-run item storage, safe from permadeath
    //   marketSlots    simultaneous listings (1, expand to 3 with shards)
    //   goldEscrowed   gold locked in open buy orders (free = gold-escrowed)
    //   activeListings/activeBuyOrders  ids into data/market.json (O(1) index)
    shards: 0,
    runeDust: 0,
    vault: [],
    vaultCapacity: VAULT_BASE_CAPACITY,
    marketSlots: MARKET_LISTING_MAX_BASE,
    goldEscrowed: 0,
    activeListings: [],
    activeBuyOrders: [],
    economyStats: {
      totalSold: 0,
      totalBought: 0,
      totalListingFees: 0,
      totalTaxPaid: 0,
      totalSalvaged: 0,
    },
    // Crafting/talents/scars — ACCOUNT-side (master §3.3/§3.5/§3.7).
    //   skillTalents  {skillId: [t0|null, t1|null, t2|null]} prestige talents
    //   reagents      {code: count} crafting inputs (survive permadeath)
    //   scars         permanent stat erosion from vital-wound deaths (≤5)
    skillTalents: {},
    reagents: {},
    scars: [],
    // Spirit reservations (Project Ascendant Inc7 — aura/minion/totem buffs).
    // Account-side: the player's chosen aura loadout survives permadeath.
    // Starts empty (no reservations) — exact-identity derive() for new chars.
    reserved: [],
    // Passive tree (Project Ascendant Inc4). Account-side build identity —
    // survives permadeath, never crosses the run/account line. `passiveStart`
    // is the class start zone (the BFS connectivity anchor); `passives` is the
    // allocated node-id list, empty for a new sigma so derive() is exact-identity
    // (×1/+0) and byte-identical to a pre-passive character. Points budget is
    // derived from highestLevel + prestige (passivePointsFor) — not stored.
    passiveStart: starterClassForSeed(s),
    passives: [],
    // Dual specialization (Project Ascendant Inc6). `activeSet` is the active
    // combat profile; "A" is the canonical single loadout every existing
    // character already has, so a fresh sigma starts on "A" with `setB` null —
    // exact-identity derive()/delveTick (the second set is materialized lazily
    // on the first swap). Account-side build identity: survives permadeath
    // (resolveDeath keeps `setB`); the gear half of each set lives on the run
    // (`run.gear` / `run.gearB`) so permadeath erases both loadouts equally.
    activeSet: "A",
    setB: null,
    // Vampire-Survivors loadout (master VS layer). Account-side build identity
    // (like passives): survives permadeath, never crosses the run/account line.
    // `weapons` is the chosen auto-fire loadout (ids, capped to maxWeaponSlots);
    // `activeWeapon` is the slot lost on a FAINT; `lostWeapon`/`fainted` are
    // read-only feedback. Empty for a fresh sigma → the VS layer is inert and
    // delveTick is byte-identical to a pre-VS character.
    weapons: [],
    activeWeapon: null,
    lostWeapon: null,
    fainted: 0,
    // Last world-event injection watermark (master §M4) — each player sees
    // each zone's world event once. Account-side.
    lastWorldEventAt: 0,
    // Procedural quests (master §M5) — account-side, survive permadeath.
    quests: [],
    questXp: 0,
    questLevel: 0,
    // NPC relationships (master §M6) — {npcId: {score,flags,lastSeenAt,episodes}}.
    npcRelationships: {},
    // Retention (master §M7) — daily/weekly objectives, achievements,
    // bestiary, museum, season. All account-side.
    dailyObjectives: [],
    dailyDayIndex: 0,
    weeklyBounties: [],
    weeklyWeekIndex: 0,
    achievements: { earned: [], score: 0 },
    bestiary: { kills: {}, firstKilledAt: {} },
    museum: [],
    season: { points: 0, tier: 0 },
    activeTitle: null,
    lastSeen: Date.now(),
    createdAt: Date.now(),
  };
  character.run = freshRun(s, 0, null, character);
  return character;
}

// ── Prestige milestones — titles + (avatar-system) cosmetics ──────────
const MILESTONES = [
  { prestige: 10, title: "Survivor" },
  { prestige: 25, title: "Delver", cosmetic: "aura_bronze" },
  { prestige: 60, title: "Abyss-Touched", cosmetic: "aura_silver" },
  { prestige: 120, title: "Sigma", cosmetic: "aura_royal" },
  { prestige: 250, title: "Voidlord", cosmetic: "aura_diamond" },
  { prestige: 500, title: "The Permadeath", cosmetic: "aura_mythic" },
];

// Idempotent: grants anything earned-but-ungranted, returns the new bits.
export function checkUnlocks(character) {
  const fresh = [];
  for (const m of MILESTONES) {
    if (character.prestige < m.prestige) continue;
    if (m.title && !character.titles.includes(m.title)) {
      character.titles.push(m.title);
      fresh.push({ kind: "title", value: m.title });
    }
    if (m.cosmetic && !character.cosmeticsUnlocked.includes(m.cosmetic)) {
      character.cosmeticsUnlocked.push(m.cosmetic);
      fresh.push({ kind: "cosmetic", value: m.cosmetic });
    }
  }
  return fresh;
}

// ── Encounter generation ──────────────────────────────────────────────
function buildEncounter(run, zone, rng) {
  const enemies = [];
  const depth = run.depth;
  const danger = run.danger;
  const ai = run.ai;
  const baseXp = baseXpForLevel(run.level);

  const stamp = (id) => {
    const e = makeEnemy(id, run.level + Math.floor(depth / 2), depth, rng);
    e.xpValue = Math.round(baseXp * e.xp * zone.xpMult * (1 + depth * 0.04));
    return e;
  };

  // Boss — past the boss threshold, the chance ramps each tick.
  if (danger >= DANGER_BOSS_AT && zone.boss && rng.chance(0.35 + (danger - DANGER_BOSS_AT) * 3)) {
    return { enemies: [stamp(zone.boss)], isBoss: true };
  }

  // Twitch redemption — "Spawn Elite In My Delve" forces an elite pack on
  // the next tick regardless of danger. One-shot flag, consumed here so it
  // can't loop. Falls through to the natural elite/trash path if the zone
  // has no elite roster (lowest tier won't, but every gated zone does).
  if (run._twitchEliteNext && zone.elites.length) {
    delete run._twitchEliteNext;
    enemies.push(stamp(rng.pick(zone.elites)));
    if (rng.chance(0.4)) enemies.push(stamp(rng.pick(zone.enemies)));
    return { enemies, isBoss: false };
  }

  // Elite — frequency bent by greedMode / avoidElites.
  let eliteChance = 0;
  if (danger >= DANGER_ELITE_AT && zone.elites.length) {
    eliteChance = ai.greedMode ? 0.6 : ai.avoidElites ? 0.18 : 0.35;
  }
  if (eliteChance > 0 && rng.chance(eliteChance)) {
    enemies.push(stamp(rng.pick(zone.elites)));
    if (rng.chance(0.4)) enemies.push(stamp(rng.pick(zone.enemies)));
    return { enemies, isBoss: false };
  }

  // Trash pack — grows with depth.
  const packSize = 1 + Math.min(3, Math.floor(depth / 4) + (rng.chance(0.5) ? 1 : 0));
  for (let i = 0; i < packSize; i++) enemies.push(stamp(rng.pick(zone.enemies)));
  return { enemies, isBoss: false };
}

// Self-heal hook for runs that pre-date the bare-fists starter (saves
// from before the change have `gear.weapon: null`). Stat-neutral, so it
// does not break sim determinism — derive() reads mods from affixes and
// bare fists has affixes=[].
export function ensureStarterGear(character) {
  const run = character?.run;
  if (!run) return;
  if (!run.gear) run.gear = { weapon: null, armor: null, ring: null, relic: null, charm: null };
  if (!run.gear.weapon) run.gear.weapon = bareFists();
  // Backfill the weapon family/plus fields for runs that pre-date the
  // class system. Classes are derived from the base noun so existing
  // saves "become" a class on the next tick without a migration.
  const w = run.gear.weapon;
  if (w && !w.family) w.family = familyForBase(w.base);
  if (w && w.plus == null) w.plus = 0;
}

// ── Dual specialization (Project Ascendant Inc6) ──────────────────────
// A character carries two combat profiles. The ACTIVE set's data is always
// the canonical storage: `run.gear` (gear) + `character.{passives,passiveStart,
// reserved,position,skillTalents}` (account-side build identity). The INACTIVE
// set is parked in `character.setB` (account fields) + `run.gearB` (gear). Gear
// for BOTH sets lives in the run, so permadeath erases both loadouts equally —
// build IDENTITY (passives/reserved/...) is account-side and survives, gear is
// run-side and does not, exactly mirroring the single-set run/account split.
//
// A swap is a pure data shuffle, run ONLY between ticks (never inside
// resolveEncounter), so derive() sees a fixed build for the whole encounter and
// the rng stream is never shifted. No rng draw here — deterministic.

// Account-side build fields that make up a set (gear is handled separately
// because it lives on the run).
const SET_ACCOUNT_FIELDS = ["passives", "passiveStart", "reserved", "position", "skillTalents"];

// Deep, rng-free clone of plain build data (gear trees + id arrays + talent
// maps). Used to materialize a fresh Set B from the current loadout the first
// time the player switches, so they get a working second profile to diverge.
function cloneBuildData(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

// A blank gear loadout (bare fists, no armor/ring/relic/charm) — the gear half
// of a freshly-materialized Set B when there is no current run gear to clone.
function emptyGearLoadout() {
  return { weapon: bareFists(), armor: null, ring: null, relic: null, charm: null };
}

// Build the inactive-set snapshot (account fields + gear) from a source. When
// `source` is the live character/run this captures the current loadout; when
// null it produces a fresh default Set B.
function snapshotSetFrom(character) {
  const snap = {};
  for (const f of SET_ACCOUNT_FIELDS) {
    snap[f] = cloneBuildData(
      character?.[f] ?? (f === "position" ? "mid" : f === "skillTalents" ? {} : []),
    );
  }
  return snap;
}

// Swap the active build set to `target` ("A"|"B"). Returns the now-active set id.
// - No-op (and returns current) when already on `target`.
// - Lazily materializes Set B (a clone of the current loadout) the first time
//   the player switches to "B" so they have a working second profile to edit.
// Exchanges the canonical top-level account fields with `character.setB` and
// `run.gear` with `run.gearB`, then flips `activeSet`. Deterministic, no rng;
// MUST be called between ticks only.
export function swapBuildSet(character, target) {
  if (!character) return "A";
  const want = target === "B" ? "B" : "A";
  const current = character.activeSet === "B" ? "B" : "A";
  // Normalize the active-set marker even on a no-op so a coerced-away value heals.
  character.activeSet = current;
  if (want === current) return current;

  const run = character.run || null;
  // Materialize Set B on first switch: snapshot the current (active) loadout as
  // the starting point for B so the player edits a working copy, not a blank.
  if (!character.setB) {
    character.setB = snapshotSetFrom(character);
    if (run) run.gearB = cloneBuildData(run.gear) || emptyGearLoadout();
  }

  // Exchange the account-side build fields with the parked set.
  const parked = character.setB;
  const nextParked = {};
  for (const f of SET_ACCOUNT_FIELDS) {
    nextParked[f] = character[f];
    character[f] = parked[f] ?? (f === "position" ? "mid" : f === "skillTalents" ? {} : []);
  }
  character.setB = nextParked;

  // Exchange the run gear with the parked gear (both run-side).
  if (run) {
    const parkedGear = run.gearB || emptyGearLoadout();
    run.gearB = run.gear || emptyGearLoadout();
    run.gear = parkedGear;
  }

  character.activeSet = want;
  return want;
}

// ── THE TICK ──────────────────────────────────────────────────────────
export function delveTick(character) {
  ensureStarterGear(character);
  const run = character.run;
  const zone = zoneById(run.zone);
  if (!zone || zone.safe) return { type: "idle" };

  const rng = makeRng(run.rngSeed || 1);
  rng.state = run.rngState || run.rngSeed || 1;

  // ── Pre-encounter RimWorld stack ──────────────────────────────────
  // Mental break / inspiration roll BEFORE the sheet derives so their
  // overrides land in this tick's combat math.
  if (character.mood) tickMood(character.mood, character);
  maybeStartBreak(run, character, rng);
  maybeStartInspiration(run, character, rng);
  // Inspired Recovery heals on entry.
  if (run.activeInspiration?.id === "inspired_recovery") {
    const ai = run.activeInspiration;
    const def = derive(run, character);
    const heal = Math.round(def.maxHp * 0.7);
    run.hp = Math.min(def.maxHp, run.hp + heal);
    run.activeInspiration = null; // consumed
    void ai;
  }

  const sheet = derive(run, character);
  const econ = traitEconomy(character?.traits);
  const moodProfile = traitMoodProfile(character?.traits);

  // Storyteller may fire an event in front of this tick's encounter.
  const story = maybeRollStoryteller(character, run, rng, zone);

  // Mental-break behaviour overrides on the AI level.
  // Vampire-Survivors players STAND AND FIGHT (fleeHpFrac 0) so a faint is
  // reachable — the autopilot's flee-at-32%-HP guard is exactly why "not a
  // single person has fainted". The override is gated on a real loadout and
  // spread into a COPY so a non-VS sigma keeps the identical ai object (and
  // run.ai is never mutated). vsActive also turns on the gem economy + the
  // faint-instead-of-permadeath conversion below.
  const vsActive = Array.isArray(character.weapons) && character.weapons.length > 0;
  const aiBase = ai_for(run, character);
  const ai = vsActive ? { ...aiBase, fleeHpFrac: 0 } : aiBase;
  const fighter = {
    hp: run.hp,
    maxHp: sheet.maxHp,
    attack: sheet.attack,
    defense: sheet.defense,
    critChance: sheet.critChance,
    critMult: sheet.critMult,
    speed: sheet.speed,
    dodge: sheet.dodge,
    overload: sheet.overload,
    deathSave: sheet.deathSave,
    effects: sheet.effects,
    potions: run.potions,
    weaponFamily: run.gear?.weapon?.family || "fists",
    weaponPlus: run.gear?.weapon?.plus | 0,
    // Mental-break / inspiration / trait pass-through:
    breakMods: sheet.breakMods,
    inspMods: sheet.inspMods,
    incomingMul: sheet.incomingMul || 1,
    immuneCurse: sheet.traitFlags?.immuneCurse,
    traits: character?.traits || [],
  };
  // Resolve the VS loadout to effective weapon specs (with evolutions applied)
  // and hand it to resolveEncounter. Absent for a non-VS sigma → the volley
  // block in combat.js is skipped and NO rng is drawn (byte-identical).
  if (vsActive) {
    fighter.weapons = resolveLoadout(character.weapons, character.passives || []).specs;
  }
  const { enemies, isBoss } = buildEncounter(run, zone, rng);
  const result = resolveEncounter({ fighter, enemies, ai, rng, inventory: run.inventory });

  // ── Loot rolls (still RNG-consuming — must precede the state save) ──
  const loot = [];
  for (const enemy of result.killed) {
    const bias = zone.lootBias + (enemy.lootBonus || 0) + sheet.lootRarity * 4;
    let qty = Math.floor(sheet.lootQty);
    if (rng.chance(sheet.lootQty - qty)) qty += 1;
    if (enemy.kind === "normal") {
      qty = rng.chance(0.6 + sheet.lootQty * 0.12) ? Math.max(1, qty) : 0;
    } else if (enemy.kind === "elite") {
      qty = Math.max(1, qty);
    } else if (enemy.kind === "boss") {
      qty = Math.max(3, qty + 2);
    }
    for (let i = 0; i < qty; i++) {
      loot.push(rollDrop({ rng, level: run.level, depth: run.depth, bias }));
    }
  }

  // ── Reagent gathering (crafting input) ────────────────────────────
  // One deterministic roll per killing-encounter, drawn from the run rng so
  // offline sim matches live. Credits the ACCOUNT reagent pouch (survives
  // permadeath); faction members gather faster in their home zone.
  if (result.killed.length && character) {
    const reagent = reagentDrop(run.zone, character.faction || null, rng);
    if (reagent) {
      if (!character.reagents) character.reagents = {};
      character.reagents[reagent.code] = (character.reagents[reagent.code] || 0) + 1;
    }
  }

  // ── Roll any new injuries from this fight ─────────────────────────
  // One-tick light wounds are common, escalating with how much HP the
  // sigma actually lost. Vital part loss flips the run to death.
  let vitalKill = null;
  const hpFracLost = Math.max(0, run.hp - result.hpAfter) / Math.max(1, sheet.maxHp);
  const hitsTaken = result.events.filter((e) => e.t === "enemyhit").length;
  if (hitsTaken > 0 && hpFracLost > 0.18) {
    const sev = hpFracLost > 0.6 ? "serious" : hpFracLost > 0.35 ? "serious" : "light";
    if (rng.chance(Math.min(0.7, 0.2 + hpFracLost))) {
      const partId = rollHitPart(rng);
      const wound = woundPart(run, partId, sev, rng);
      if (wound?.vitalKill) vitalKill = wound;
    }
  }

  // All RNG draws are done — persist the stream position.
  run.rngState = rng.state;

  // ── Apply the encounter ───────────────────────────────────────────
  run.hp = result.hpAfter;
  run.potions = result.potionsAfter;
  run.encounters += 1;
  run.kills += result.kills;
  character.lifetimeKills += result.kills;

  // ── Mood thoughts from the encounter ──────────────────────────────
  if (character.mood) {
    if (result.kills > 0) {
      // bloodlust trait: a kill is a mood spike
      if (character.traits?.includes("bloodlust")) {
        addMoodThought(character.mood, character, "killed_elite");
      }
    }
    if (result.killed.some((e) => e.kind === "elite")) {
      addMoodThought(character.mood, character, "killed_elite");
    }
    if (isBoss && result.outcome === "win") {
      addMoodThought(character.mood, character, "killed_boss");
    }
    if (result.stolen?.length) {
      for (let i = 0; i < result.stolen.length; i++) {
        addMoodThought(character.mood, character, "item_stolen");
      }
    }
    if (hpFracLost > 0.3) addMoodThought(character.mood, character, "badly_hurt");
  }

  let goldGained = Math.round(result.goldGained * econ.goldMul);
  let legendaryDropped = false;
  for (const item of loot) {
    // "Pick it up and start swinging it." A legendary-or-better WEAPON that
    // beats the held one equips straight off the ground, so the chatter visibly
    // wields the drop instead of leaving it in the bag. The previously-held
    // weapon falls back to the bag (or auto-sells when the bag is full) — never
    // silently lost. Pure swap, no RNG, so offline + live + the on-stream
    // chat-ping delve all behave identically (determinism firewall). The client
    // detects the swap by run.gear.weapon.id to fire the "item get" flourish.
    const equipsLegendary =
      item.slot === "weapon" &&
      (RARITY_RANK[item.rarity] || 0) >= RARITY_RANK.legendary &&
      (item.power || 0) >= (run.gear.weapon?.power || 0);
    if (equipsLegendary) {
      const old = run.gear.weapon;
      run.gear.weapon = item;
      if (old && (old.power || 0) > 0) {
        if (!old.family) old.family = familyForBase(old.base);
        if (run.inventory.length < INVENTORY_MAX) run.inventory.push(old);
        else goldGained += Math.round(sellValue(old) * econ.goldMul);
      }
    } else if (run.inventory.length < INVENTORY_MAX) {
      run.inventory.push(item);
    } else {
      goldGained += Math.round(sellValue(item) * econ.goldMul); // full bag → overflow auto-sells
    }
    if (item.power > (character.bestItemPower || 0)) character.bestItemPower = item.power;
    if (character.mood) {
      if (item.rarity === "legendary" || item.rarity === "mythic" || item.rarity === "oneofone") {
        addMoodThought(character.mood, character, "legendary_drop");
        legendaryDropped = true;
      } else if (item.rarity === "rare" || item.rarity === "epic") {
        addMoodThought(character.mood, character, "rare_drop");
      }
    }
  }
  if (!loot.length && result.kills > 0 && character.mood) {
    addMoodThought(character.mood, character, "no_loot");
  }
  character.gold += goldGained;

  // Inspiration goldMul on top — buffed sigma's sales hit harder.
  if (sheet.inspMods?.goldMul && sheet.inspMods.goldMul > 1) {
    const bonus = Math.round(goldGained * (sheet.inspMods.goldMul - 1));
    character.gold += bonus;
    goldGained += bonus;
  }

  // XP + level-up.
  const xpScaled = Math.round((result.xpGained || 0) * econ.xpMul * (sheet.inspMods?.xpMul || 1));
  const xpRes = gainXp(run, xpScaled, character);
  if (run.level > character.highestLevel) character.highestLevel = run.level;

  // Skill XP — passion + trait skillXpMul applied inside the helper.
  const skillEvents = creditEncounterSkills(
    character?.skills,
    fighter.weaponFamily,
    { ...result, itemsLooted: loot.length },
    econ.skillXpMul,
  );

  // ── Vampire-Survivors layer (post-RNG-save, PURE — gated on a loadout) ─
  // Spawn XP gems from this tick's kills, magnetize them to the player, and
  // grant the collected XP ("Sigma tokens"). Then, when the encounter would
  // have been a death, convert it to a FAINT: lose the active weapon and stand
  // back up instead of permadeath. Everything here draws ZERO rng and runs
  // only for a VS sigma, so a non-VS character is byte-identical.
  let vsTick = null;
  if (vsActive) {
    vsTick = harvestVsTick(character, run, result.killed, run.encounters);
    if (vsTick.collectedXp > 0) {
      gainXp(run, vsTick.collectedXp, character);
      if (run.level > character.highestLevel) character.highestLevel = run.level;
    }
    if (result.outcome === "death") {
      const faint = applyFaint(character);
      run.hp = Math.max(1, Math.round(sheet.maxHp * VS_TUNABLES.faintReviveHpFrac));
      if (character.mood) addMoodThought(character.mood, character, "badly_hurt");
      // Return as a RETREAT so the caller (live-delve / game.js / offline sim)
      // banks the haul, heals in town and redeploys — the haul is kept, only the
      // active weapon is lost. The run survives (run.alive stays true).
      return {
        type: "retreat",
        reason: "faint",
        faint,
        vs: vsTick,
        result,
        enemies,
        zone,
        loot,
        isBoss,
        xpRes,
        storyEvent: story,
        skillEvents,
        diseaseEvents: [],
      };
    }
  }

  // ── Tick disease + injury timers ──────────────────────────────────
  const diseaseEvents = tickDiseases(run, character, traitDiseaseProfile(character?.traits));
  if (character.mood) {
    for (const ev of diseaseEvents) {
      if (ev.kind === "lost") {
        addMoodThought(character.mood, character, "diseased");
        if (ev.def.deathOnLoss) {
          // The plague claimed them.
          run.alive = false;
          return {
            type: "death",
            result,
            enemies,
            zone,
            loot,
            isBoss,
            xpRes,
            deathBy: ev.def.name,
            storyEvent: story,
            skillEvents,
            diseaseEvents,
          };
        }
      }
    }
  }
  tickHealth(run);
  // Ambient infection — rare.
  if (rng.chance(ambientInfectionChance(run, traitDiseaseProfile(character?.traits)))) {
    const id = rng.pick(["flu", "gut_worms", "malaria"]);
    if (!run.diseases?.[id]) infect(run, character, id);
  }

  // ── Tick break + inspiration durations ────────────────────────────
  const brkEnd = tickBreak(run, character);
  const inspEnd = tickInspiration(run);
  void brkEnd;
  void inspEnd;

  run.danger = Math.min(
    DANGER_MAX,
    run.danger + DANGER_PER_TICK * zone.dangerMult * sheet.dangerMult,
  );

  // ── Storyteller side-effects (mutates run / character) ────────────
  if (story?.effect) {
    const eff = story.effect;
    if (eff.dangerDelta)
      run.danger = Math.max(0, Math.min(DANGER_MAX, run.danger + eff.dangerDelta));
    if (eff.gold) character.gold += Math.round(eff.gold * econ.goldMul);
    if (eff.potions) run.potions = Math.max(0, Math.min(20, run.potions + eff.potions));
    if (eff.heal) {
      const heal = Math.round(sheet.maxHp * eff.heal);
      run.hp = Math.min(sheet.maxHp, run.hp + heal);
    }
    if (eff.damage) {
      run.hp = Math.max(0, run.hp - eff.damage);
    }
    if (eff.loot && Array.isArray(eff.loot)) {
      for (const item of eff.loot) {
        if (run.inventory.length < INVENTORY_MAX) run.inventory.push(item);
        else character.gold += Math.round(sellValue(item) * econ.goldMul);
        if (item.power > (character.bestItemPower || 0)) character.bestItemPower = item.power;
      }
    }
    if (eff.disease && !run.diseases?.[eff.disease]) infect(run, character, eff.disease);
    if (eff.moodThought) addMoodThought(character.mood, character, eff.moodThought);
    run.eventsFired = (run.eventsFired || 0) + 1;
  }

  // ── World-event consumption (master §M4/§4.2) ─────────────────────
  // Server-injected, transient (run._pendingWorldEvents), consumed ONCE here
  // — AFTER the rng-state save, drawing NO rng — so offline sim stays in
  // parity. The field is stripped by validate.js:vRun on every save, so a
  // client cannot forge it.
  if (Array.isArray(run._pendingWorldEvents) && run._pendingWorldEvents.length) {
    for (const we of run._pendingWorldEvents) applyWorldEvent(we, character, run);
    run._pendingWorldEvents = [];
  }

  // ── Faction kill-rep (master §M6) ─────────────────────────────────
  // One rep grant per killing-encounter for faction members, scaled by the
  // toughest kill + home-zone bias. Deterministic (no rng, now=0 → no
  // wall-clock cap) so offline sim stays in parity; account-side (survives
  // permadeath). No-op for the unaligned.
  if (character?.faction && result.killed.length) {
    const killKind = result.killed.some((e) => e.kind === "boss")
      ? "boss"
      : result.killed.some((e) => e.kind === "elite")
        ? "elite"
        : "normal";
    applyKillRep(character, run.zone, killKind, 0);
  }

  // Vital-part injury → run death after applying loot.
  if (vitalKill) {
    run.alive = false;
    return {
      type: "death",
      result,
      enemies,
      zone,
      loot,
      isBoss,
      xpRes,
      deathBy: `lost ${vitalKill.partId}`,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }

  // ── Death — caller invokes resolveDeath() ─────────────────────────
  if (result.outcome === "death") {
    run.alive = false;
    if (character.mood && !moodProfile.ignoreDeathMood) {
      addMoodThought(character.mood, character, "ally_died");
    }
    const deathEv = result.events.filter((e) => e.t === "death").pop();
    const deathBy = deathEv && enemies[deathEv.src] ? enemies[deathEv.src].name : "the abyss";
    return {
      type: "death",
      result,
      enemies,
      zone,
      loot,
      isBoss,
      xpRes,
      deathBy,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }

  // A survived encounter takes you one step deeper.
  run.depth = Math.min(DEPTH_MAX, run.depth + 1);
  if (run.depth > character.bestDepth) character.bestDepth = run.depth;

  // ── Boss cleared — zone conquered, forced victorious retreat ──────
  if (isBoss && result.outcome === "win") {
    return {
      type: "boss_clear",
      result,
      enemies,
      zone,
      loot,
      xpRes,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }
  // ── Retreat conditions ────────────────────────────────────────────
  if (result.outcome === "flee") {
    return {
      type: "retreat",
      reason: "fled",
      result,
      enemies,
      zone,
      loot,
      xpRes,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }
  if (run.danger >= run.ai.retreatDanger) {
    return {
      type: "retreat",
      reason: "danger",
      result,
      enemies,
      zone,
      loot,
      xpRes,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }
  if (run.depth >= run.ai.retreatDepth) {
    return {
      type: "retreat",
      reason: "depth",
      result,
      enemies,
      zone,
      loot,
      xpRes,
      storyEvent: story,
      skillEvents,
      diseaseEvents,
    };
  }
  return {
    type: "continue",
    result,
    enemies,
    zone,
    loot,
    isBoss,
    xpRes,
    storyEvent: story,
    skillEvents,
    diseaseEvents,
    legendaryDropped,
  };
}

// AI override — break states force certain targeting / behaviours.
function ai_for(run, _character) {
  const base = run?.ai || {};
  const br = run?.activeBreak;
  if (!br) return base;
  const out = { ...base };
  if (br.id === "berserk" || br.id === "murderous_rage" || br.id === "death_wish") {
    out.targetPriority = br.id === "murderous_rage" ? "highest_threat" : "lowest_hp";
    out.fleeHpFrac = 0;
    out.greedMode = true;
  }
  if (br.id === "fugue") {
    out.fleeHpFrac = 0; // cannot flee, the immortal flag keeps them upright
  }
  return out;
}

// Storyteller fire — one event per N ticks, weighted by storyteller.
function maybeRollStoryteller(character, run, rng, _zone) {
  if (!character?.storyteller) return null;
  const chance = tickEventChance(character.storyteller, run);
  if (chance <= 0 || !rng.chance(chance)) return null;
  return rollEvent(character.storyteller, character, run, rng);
}

// ── Zone transitions (caller-driven) ──────────────────────────────────
export function deployToZone(character, zoneId) {
  const zone = zoneById(zoneId);
  if (!zone || zone.safe) return { ok: false };
  const run = character.run;
  if (!run.alive) return { ok: false };
  run.zone = zone.id;
  run.danger = 0;
  run.depth = 0;
  return { ok: true, zone };
}

export function retreatToTown(character) {
  const run = character.run;
  const from = zoneById(run.zone);
  const survivedADelve = !from.safe;
  run.zone = "town";
  run.danger = 0;
  run.depth = 0;
  // Town heal: clear scars, drop active breaks/inspirations.
  const scarsCleared = townHeal(run);
  run.activeBreak = null;
  run.activeInspiration = null;
  // Diseases linger but immunity progresses one big step on rest.
  if (run.diseases) {
    for (const id of Object.keys(run.diseases)) {
      run.diseases[id].immunity = Math.min(1, run.diseases[id].immunity + 0.25);
      if (run.diseases[id].immunity >= 1) delete run.diseases[id];
    }
  }
  run.hp = derive(run, character).maxHp; // town rest = full heal
  if (survivedADelve) {
    character.streak += 1;
    if (character.streak > character.bestStreak) character.bestStreak = character.streak;
  }
  return { healed: true, streak: character.streak, scarsCleared };
}

// Sell the whole bag for gold + a prestige trickle. The deliberate
// "secure your haul" action — equip what you want first.
export function bankAtTown(character) {
  const run = character.run;
  const econ = traitEconomy(character?.traits);
  let gold = 0,
    count = 0;
  for (const it of run.inventory) {
    gold += sellValue(it);
    count += 1;
  }
  gold = Math.round(gold * econ.goldMul);
  run.inventory = [];
  character.gold += gold;
  const prestige = Math.floor((gold / 80) * econ.prestigeMul);
  character.prestige += prestige;
  if (character?.mood && count > 0) addMoodThought(character.mood, character, "banked_haul");
  const unlocks = checkUnlocks(character);
  if (character?.mood && unlocks.some((u) => u.kind === "cosmetic")) {
    addMoodThought(character.mood, character, "cosmetic_unlocked");
  }
  return { gold, prestige, itemsSold: count, unlocks };
}

// Equip the highest-power inventory item for each slot when it beats what's
// worn; the displaced piece drops back to the bag. Pure (no rng), so it runs
// identically offline and live and never perturbs run.rngState. This MUST be
// called before bankAtTown() on a retreat — bankAtTown sells the whole bag, so
// a freshly-dropped upgrade (e.g. a legendary that hasn't auto-equipped yet)
// would otherwise be vendored to gold before it could ever be worn. Returns a
// summary [{slot,name,rarity,power}] for the event feed.
export function autoEquipBest(run) {
  const equipped = [];
  if (!run?.gear || !Array.isArray(run.inventory)) return equipped;
  for (const slot of GEAR_SLOTS) {
    let bestIdx = -1;
    let bestPow = run.gear[slot]?.power || 0;
    for (let i = 0; i < run.inventory.length; i += 1) {
      const it = run.inventory[i];
      if (it?.slot === slot && (it.power || 0) > bestPow) {
        bestPow = it.power || 0;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const it = run.inventory.splice(bestIdx, 1)[0];
      const old = run.gear[slot];
      run.gear[slot] = it;
      if (old && (old.power || 0) > 0) run.inventory.push(old);
      equipped.push({ slot, name: it.name, rarity: it.rarity, power: it.power });
    }
  }
  return equipped;
}

export function sellOne(character, index) {
  const inv = character.run.inventory;
  if (index < 0 || index >= inv.length) return { ok: false };
  const item = inv.splice(index, 1)[0];
  const gold = sellValue(item);
  character.gold += gold;
  return { ok: true, gold, item };
}

// Permadeath. The run is erased; the account keeps prestige, gold,
// cosmetics, titles and records — and the death itself pays out prestige
// scaled by how far the run got, so dying is conversion, not pure loss.
//
// RimWorld-side state that persists across permadeath: traits, backstory,
// storyteller, skills, mood. (Skills are an account asset; you don't
// forget how to swing a sword because your body died.)
export function resolveDeath(character, deathInfo) {
  const run = character.run;
  const zone = deathInfo?.zone || zoneById(run.zone);
  // Snapshot the prior account record BEFORE the bestLevel bump below, so the
  // death screen can honestly say "new best" only when this run actually beat it.
  const prevBestLevel = character.bestLevel || 1;
  const econ = traitEconomy(character?.traits);
  const prestigeGained = Math.max(
    1,
    Math.floor(
      (run.level * 0.6 + run.depth * 0.9 + zone.tier * 4 + run.kills * 0.12) * econ.prestigeMul,
    ),
  );
  character.prestige += prestigeGained;
  // Prestige Shards mint alongside prestige (master §1.2 [A2]). Pure
  // arithmetic on prestigeGained — no RNG — so offline & live deaths mint
  // identically and the determinism canary is unaffected. Account-side.
  character.shards = (character.shards || 0) + Math.floor(prestigeGained * SHARD_PER_PRESTIGE);
  character.lifetimeRuns += 1;
  if (run.level > (character.bestLevel || 1)) character.bestLevel = run.level;
  character.streak = 0;

  // Mood: dying is hard on the head — unless the trait says otherwise.
  if (character.mood) addMoodThought(character.mood, character, "ally_died");

  const summary = {
    level: run.level,
    depth: run.depth,
    kills: run.kills,
    zoneName: zone.name,
    prestigeGained,
    deathBy: deathInfo?.deathBy || "the abyss",
    unlocks: checkUnlocks(character),
    // Conversion framing (read-only — no sim/rng effect): what the death BANKED
    // and what the account now holds, so the death screen leads with permanent
    // gain instead of run loss. See ui.showDeath / F5.
    shardsGained: Math.floor(prestigeGained * SHARD_PER_PRESTIGE),
    prestige: character.prestige,
    highestLevel: character.highestLevel,
    beatLevel: run.level > prevBestLevel,
  };
  const aiKeep = { ...run.ai };
  character.run = freshRun(character.seed, character.lifetimeRuns, aiKeep, character);

  return {
    prestigeGained,
    summary,
    feedEntry: {
      kind: "death",
      name: character.name,
      detail: `fell to ${summary.deathBy} in the ${zone.name} — Lv ${summary.level}, depth ${summary.depth}`,
    },
  };
}

// ── Rest posture — safe idle progression ──────────────────────────────
// The "sleep with the stream on" path. The sigma shelters in Ironhollow:
// it cannot be attacked, the run is frozen exactly as left, and a small
// trickle accrues to the ACCOUNT — never the run. Keeping rest gains on
// the account side of the split is what lets permadeath stay meaningful.
function simulateRest(character, cappedMs) {
  const report = {
    ran: false,
    mode: "rest",
    durationMs: cappedMs,
    goldGained: 0,
    prestigeGained: 0,
    unlocks: [],
  };
  // A rest implies town. If the sigma was parked in a danger zone, walk
  // it home first — full heal, run intact, nothing banked or lost.
  if (!zoneById(character.run.zone).safe) retreatToTown(character);

  const hours = cappedMs / 3_600_000;
  const econ = traitEconomy(character?.traits);
  // QuickSleeper trait bumps rest economy through restMul.
  const gold = Math.round(REST_GOLD_PER_HOUR * hours * econ.restMul * econ.goldMul);
  const prestige = Math.floor(REST_PRESTIGE_PER_HOUR * hours * econ.restMul * econ.prestigeMul);
  if (gold <= 0 && prestige <= 0) return report;

  report.ran = true;
  character.gold += gold;
  character.prestige += prestige;
  report.goldGained = gold;
  report.prestigeGained = prestige;
  report.unlocks = checkUnlocks(character);
  character.lastSeen = Date.now();
  return report;
}

// ── Deterministic offline progression ─────────────────────────────────
// The sigma is always active. Delving, it keeps the current delve going;
// parked in town it deploys itself to the best zone it has earned. Stops
// on the first death — that is the "check your character" moment. A
// resting sigma takes the safe simulateRest() path instead.
export function simulateOffline(character, elapsedMs) {
  const cappedMs = Math.min(Math.max(0, elapsedMs), OFFLINE_CAP_MS);
  if (character.posture === "rest") return simulateRest(character, cappedMs);

  const ticks = Math.min(5000, Math.floor(cappedMs / OFFLINE_TICK_MS));
  const report = {
    ran: false,
    mode: "delve",
    ticks: 0,
    durationMs: cappedMs,
    startLevel: character.run.level,
    endLevel: character.run.level,
    kills: 0,
    xpGained: 0,
    levelsGained: 0,
    itemsFound: 0,
    bestItem: null,
    bestItemPower: 0,
    bossKills: 0,
    retreats: 0,
    died: false,
    deathBy: null,
    deathSummary: null,
  };
  if (ticks <= 0) return report;
  report.ran = true;

  const goldBefore = character.gold;
  const prestigeBefore = character.prestige;

  if (zoneById(character.run.zone).safe) {
    deployToZone(character, recommendedZone(character).id);
    report.redeployedTo = zoneById(character.run.zone).name;
  }

  for (let i = 0; i < ticks; i++) {
    const out = delveTick(character);
    report.ticks += 1;
    if (out.result) {
      report.kills += out.result.kills || 0;
      report.xpGained += out.result.xpGained || 0;
    }
    if (out.xpRes) report.levelsGained += out.xpRes.levelsGained || 0;
    if (out.loot) {
      for (const it of out.loot) {
        report.itemsFound += 1;
        if (it.power > report.bestItemPower) {
          report.bestItemPower = it.power;
          report.bestItem = it;
        }
      }
    }

    if (out.type === "death") {
      report.died = true;
      report.deathBy = out.deathBy;
      report.endLevel = character.run.level;
      report.deathSummary = resolveDeath(character, out).summary;
      break;
    }
    if (out.type === "retreat" || out.type === "boss_clear") {
      if (out.type === "boss_clear") report.bossKills += 1;
      report.retreats += 1;
      // Equip the best of the haul BEFORE banking — bankAtTown sells the whole
      // bag, so an un-equipped upgrade (a legendary that dropped this delve)
      // would otherwise be auto-vendored to gold and lost. Equipping first also
      // means retreatToTown's town heal uses the new gear's maxHp.
      autoEquipBest(character.run);
      retreatToTown(character);
      bankAtTown(character);
      deployToZone(character, recommendedZone(character).id);
    }
    // 'continue' / 'idle' → next tick rolls on.
  }

  if (!report.died) report.endLevel = character.run.level;
  report.goldGained = character.gold - goldBefore;
  report.prestigeGained = character.prestige - prestigeBefore;
  character.lastSeen = Date.now();
  return report;
}
