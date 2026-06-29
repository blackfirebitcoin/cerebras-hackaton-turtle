// SIGMA ABYSS — headless smoke test.  `npm run smoke`
//
// Exercises the deterministic sim end-to-end without a browser: fresh
// character, a live delve, permadeath, and — the load-bearing
// guarantee — that two same-seed offline simulations produce identical
// outcomes. Exits non-zero on any failure.

import { achievementScore, checkAchievements } from "../shared/achievements.js";
import { rollBackstory } from "../shared/backstory.js";
import { STAT_MIN } from "../shared/constants.js";
import { executeCraft } from "../shared/crafting.js";
import { infect, tickDiseases } from "../shared/diseases.js";
import { ENEMIES } from "../shared/enemies.js";
import { applyKillRep } from "../shared/faction-engine.js";
import { factionCombatMods, factionRank, STARTER_FACTION_IDS } from "../shared/factions.js";
import { healthMods, woundPart } from "../shared/health.js";
import { INSPIRATION_IDS, maybeStartInspiration } from "../shared/inspirations.js";
import { equippedSetBonuses, setModsForBonuses } from "../shared/item-sets.js";
import { makeItem } from "../shared/loot.js";
import { freshMarket, RUNE_DUST_PER_RARITY, SHARD_PER_PRESTIGE } from "../shared/market.js";
import { BREAK_IDS, maybeStartBreak } from "../shared/mental-breaks.js";
import { addMoodThought, recomputeMood, tickMood } from "../shared/mood.js";
import {
  decayRelationship,
  dispositionLabel,
  freshRelationship,
  rememberEpisode,
} from "../shared/npc-memory.js";
import { advanceObjectives, DAILY_COUNT, DAY_MS, rollDailies } from "../shared/objectives.js";
import {
  autoEquipBest,
  bankAtTown,
  delveTick,
  deployToZone,
  freshCharacter,
  freshRun,
  resolveDeath,
  retreatToTown,
  simulateOffline,
  xpForLevel,
} from "../shared/progression.js";
import {
  advanceQuest,
  ensureQuests,
  generateQuests,
  grantQuestReward,
  questLevelForXp,
} from "../shared/quests.js";
import { makeRng } from "../shared/rng.js";
import { talentMods } from "../shared/skill-talents.js";
import { grantSkillXp, rollSkills, SKILL_IDS } from "../shared/skills.js";
import { derive } from "../shared/stats.js";
import { applyWorldEvent, WORLD_EVENTS } from "../shared/storyteller.js";
import { rollTraits, TRAIT_IDS, traitMods } from "../shared/traits.js";
import { factionRepView, joinFaction } from "./commands.js";
import { equipFromInventory, loadoutInventory } from "./live-delve.js";
import * as market from "./market.js";
import { handleNpcInteract } from "./npc-world.js";
import {
  autoMuseumEnshrined,
  claimObjective,
  creditBestiary,
  ensureFreshObjectives,
  syncAchievements,
} from "./retention.js";
import { parseMessage, ValidationError } from "./validate.js";
import * as voting from "./voting.js";
import {
  advanceCrisis,
  contributeToCrisis,
  freshWorld,
  injectWorldState,
  worldTick,
} from "./world-tick.js";

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
};

// ── sim ───────────────────────────────────────────────────────────────
const c = freshCharacter(424242, "SmokeSigma");
ok(c.run.level === 1 && c.run.hp === derive(c.run, c).maxHp, "fresh character: level 1, full HP");
ok(xpForLevel(1) > 0 && xpForLevel(10) > xpForLevel(1), "xp curve climbs");

deployToZone(c, "goblin_warrens");
ok(c.run.zone === "goblin_warrens", "deploy moves into a zone");

let died = false,
  retreats = 0;
for (let i = 0; i < 300 && !died; i += 1) {
  const out = delveTick(c);
  if (out.type === "death") {
    resolveDeath(c, out);
    died = true;
  } else if (out.type === "retreat" || out.type === "boss_clear") {
    retreats += 1;
    retreatToTown(c);
    bankAtTown(c);
    deployToZone(c, "goblin_warrens");
  }
}
ok(c.lifetimeKills > 0, "live delve produces kills");
ok(retreats > 0 || died, "delve resolves (retreat or death)");

// ── determinism ───────────────────────────────────────────────────────
const a1 = freshCharacter(7777, "A");
const a2 = freshCharacter(7777, "B");
const r1 = simulateOffline(a1, 6 * 3600 * 1000);
const r2 = simulateOffline(a2, 6 * 3600 * 1000);
ok(r1.ran && r1.ticks > 0, "offline sim runs ticks");
ok(
  r1.kills === r2.kills &&
    r1.xpGained === r2.xpGained &&
    r1.itemsFound === r2.itemsFound &&
    r1.died === r2.died &&
    r1.endLevel === r2.endLevel &&
    r1.prestigeGained === r2.prestigeGained,
  "offline sim is deterministic for a fixed seed",
);

// ── rest posture ──────────────────────────────────────────────────────
const rester = freshCharacter(31337, "Rester");
rester.posture = "rest";
const beforeLevel = rester.run.level;
const restRep = simulateOffline(rester, 8 * 3600 * 1000);
ok(restRep.mode === "rest" && restRep.ran, "rest posture takes the rest path");
ok(!restRep.died && rester.run.alive, "a resting sigma cannot die");
ok(restRep.goldGained > 0 && restRep.prestigeGained > 0, "rest pays a gold + prestige trickle");
ok(
  rester.gold === restRep.goldGained && rester.prestige === restRep.prestigeGained,
  "rest trickle lands on the account",
);
ok(
  rester.run.level === beforeLevel && rester.run.zone === "town" && rester.run.xp === 0,
  "rest freezes the run — no run progress",
);

// rest while parked in a danger zone walks the sigma home, unharmed
const strayRester = freshCharacter(98765, "Stray");
strayRester.posture = "rest";
deployToZone(strayRester, "goblin_warrens");
simulateOffline(strayRester, 3 * 3600 * 1000);
ok(
  strayRester.run.zone === "town" && strayRester.run.alive,
  "rest from a danger zone retreats home before resting",
);

// ── validation boundary ───────────────────────────────────────────────
let rejected = false;
try {
  parseMessage("not json at all");
} catch (e) {
  rejected = e instanceof ValidationError;
}
ok(rejected, "validator rejects non-JSON");

const saved = parseMessage(JSON.stringify({ t: "save", character: c }));
ok(
  saved.t === "save" && saved.data.character.name === "SmokeSigma",
  "validator round-trips a real character",
);

const dirty = parseMessage(
  JSON.stringify({
    t: "save",
    character: { name: "x".repeat(9999), seed: -5, prestige: 1e30, run: { level: 99999 } },
  }),
);
ok(
  dirty.data.character.name.length <= 18 &&
    dirty.data.character.seed >= 1 &&
    dirty.data.character.run.level <= 200,
  "validator clamps hostile values into bounds",
);

// ── monsters actually appear and "chase" ──────────────────────────────
// User-visible promise: when you deploy, you SHOULD see monsters. Verify
// the bestiary is loaded, every wanderable zone has a non-empty enemy
// roster, every reachable enemy id resolves to a renderable LPC build,
// and delveTick spawns real enemies (not phantoms) when you tick.
ok(
  Object.keys(ENEMIES).length >= 10,
  `bestiary has ${Object.keys(ENEMIES).length} archetypes (>= 10)`,
);
ok(
  Object.values(ENEMIES).every((e) => e.lpc && typeof e.lpc === "object"),
  "every enemy archetype carries an LPC paperdoll spec",
);

// Walk a fresh sigma into goblin_warrens, tick until we collect at least
// one normal kill — that proves the wandering monsters in the delve scene
// have something to render and that the auto-battler tick produces them.
const hunter = freshCharacter(13579, "MonsterHunter");
deployToZone(hunter, "goblin_warrens");
const seenEnemyTags = new Set();
let ticksBeforeFirstFight = 0;
for (let i = 0; i < 30; i += 1) {
  const out = delveTick(hunter);
  ticksBeforeFirstFight += 1;
  if (out && Array.isArray(out.enemies)) for (const e of out.enemies) seenEnemyTags.add(e.tag);
  if (out && out.type === "death") {
    resolveDeath(hunter, out);
    deployToZone(hunter, "goblin_warrens");
  }
}
ok(
  hunter.lifetimeKills > 0,
  `delve produces real enemy kills (chase loop has prey): ${hunter.lifetimeKills} kills`,
);
ok(
  seenEnemyTags.size > 0,
  `delve surfaced ${seenEnemyTags.size} distinct enemy archetype(s) in ${ticksBeforeFirstFight} ticks: ${[...seenEnemyTags].join(", ")}`,
);

// ── Twitch redemption: elite-spawn flag fires on next tick ────────────
const eliteVictim = freshCharacter(24680, "EliteBait");
// Give it enough levels to face elites without instantly dying.
eliteVictim.run.level = 12;
deployToZone(eliteVictim, "cursed_forest"); // has elites: bone_colossus + cursed_gambler
eliteVictim.run._twitchEliteNext = true;
const out = delveTick(eliteVictim);
const eliteInEncounter = Array.isArray(out.enemies) && out.enemies.some((e) => e.kind === "elite");
ok(
  eliteInEncounter,
  `Twitch redemption "Spawn Elite" puts an elite in the very next encounter (saw: ${(out.enemies || []).map((e) => `${e.name}(${e.kind})`).join(", ") || "none"})`,
);
ok(!eliteVictim.run._twitchEliteNext, "elite-spawn flag is one-shot — consumed after firing");

// ── Twitch claim handshake parses cleanly ─────────────────────────────
const helloClaim = parseMessage(
  JSON.stringify({ t: "hello", token: null, name: null, twitch: "CoolChatter_42" }),
);
ok(
  helloClaim.t === "hello" && helloClaim.data.twitch === "coolchatter_42",
  "hello accepts + lowercases a valid twitch login claim",
);

const helloBad = parseMessage(JSON.stringify({ t: "hello", twitch: "has spaces!" }));
ok(
  helloBad.data.twitch === null,
  "hello rejects malformed twitch login (drops to null, does not crash)",
);

// ── RimWorld inspiration: traits/backstory/skills are deterministic ───
const tA = rollTraits(42424242);
const tB = rollTraits(42424242);
ok(
  JSON.stringify(tA) === JSON.stringify(tB) && tA.length >= 2,
  `traits are deterministic by seed (got ${tA.length}: ${tA.join(", ")})`,
);
ok(
  tA.every((id) => TRAIT_IDS.includes(id)),
  "rolled traits all exist in the catalogue",
);

const bsA = rollBackstory(99999);
const bsB = rollBackstory(99999);
ok(
  bsA.childhood === bsB.childhood && bsA.adulthood === bsB.adulthood,
  `backstory is deterministic (${bsA.childhood} / ${bsA.adulthood})`,
);

const sk = rollSkills(7777);
const passionCount = SKILL_IDS.reduce((n, id) => n + (sk[id]?.passion > 0 ? 1 : 0), 0);
ok(passionCount === 3, `rolled skills carry exactly 3 passions (got ${passionCount})`);

// ── Fresh character now ships with personality ───────────────────────
const rim = freshCharacter(123456, "RimChar");
ok(
  Array.isArray(rim.traits) && rim.traits.length >= 2,
  `fresh sigma has ${rim.traits.length} traits`,
);
ok(rim.backstory?.childhood && rim.backstory.adulthood, "fresh sigma has a backstory");
ok(
  rim.storyteller && ["cassandra", "phoebe", "randy"].includes(rim.storyteller),
  "fresh sigma has a storyteller",
);
ok(rim.skills && Object.keys(rim.skills).length === SKILL_IDS.length, "fresh sigma has skills");
ok(rim.mood && typeof rim.mood.value === "number", "fresh sigma has mood state");

// ── traitMods stack hpMul / atkMul ────────────────────────────────────
const toughMods = traitMods(["tough"]);
ok(toughMods.hpMul > 1, `tough trait bumps hpMul (${toughMods.hpMul.toFixed(2)})`);

// ── Skill XP cascades into levels ─────────────────────────────────────
const skLeveler = rollSkills(31415);
const before = skLeveler.melee.level;
grantSkillXp(skLeveler, "melee", 1_000_000); // overflow
ok(
  skLeveler.melee.level > before && skLeveler.melee.level <= 20,
  `grantSkillXp cascades levels (${before} → ${skLeveler.melee.level})`,
);

// ── Mood thoughts decay over ticks ────────────────────────────────────
const moodChar = freshCharacter(2222, "MoodTest");
const initialMood = moodChar.mood.value;
addMoodThought(moodChar.mood, moodChar, "ally_died");
recomputeMood(moodChar.mood, moodChar);
ok(moodChar.mood.value < initialMood, "ally_died thought lowers mood");
for (let i = 0; i < 100; i++) tickMood(moodChar.mood, moodChar);
ok(moodChar.mood.thoughts.length === 0, "mood thoughts decay back out after enough ticks");

// ── Mental breaks fire when mood is low ──────────────────────────────
const brkChar = freshCharacter(9911, "BreakBait");
brkChar.mood.value = 5; // shattered
const brkRun = brkChar.run;
brkRun.encounters = 50; // past cooldown
brkRun.lastBreakTickIdx = -100;
const brkRng = makeRng(1);
let fired = null;
for (let i = 0; i < 100 && !fired; i++) {
  fired = maybeStartBreak(brkRun, brkChar, brkRng);
}
ok(
  !!fired && BREAK_IDS.includes(fired.id),
  `mental break fires when mood is shattered (${fired?.id})`,
);

// ── Inspiration fires when mood is inspired ──────────────────────────
const inspChar = freshCharacter(8888, "Sunny");
inspChar.mood.value = 95;
const inspRun = inspChar.run;
inspRun.encounters = 100;
inspRun.lastInspirationIdx = -100;
const inspRng = makeRng(2);
let inspFired = null;
for (let i = 0; i < 300 && !inspFired; i++) {
  inspFired = maybeStartInspiration(inspRun, inspChar, inspRng);
}
ok(
  !!inspFired && INSPIRATION_IDS.includes(inspFired.id),
  `inspiration fires when mood is inspired (${inspFired?.id})`,
);

// ── Diseases progress and resolve ────────────────────────────────────
const sickChar = freshCharacter(54321, "Patient");
infect(sickChar.run, sickChar, "plague");
ok(sickChar.run.diseases?.plague, "infect adds a disease entry");
let diseaseEvents = [];
for (let i = 0; i < 50 && Object.keys(sickChar.run.diseases || {}).length; i++) {
  diseaseEvents = diseaseEvents.concat(tickDiseases(sickChar.run, sickChar, { resistMul: 1 }));
}
ok(
  diseaseEvents.some((e) => e.kind === "won" || e.kind === "lost"),
  `disease resolves to won/lost (events: ${diseaseEvents.map((e) => e.kind).join(", ")})`,
);

// ── Injuries persist and affect derived stats ────────────────────────
const woundChar = freshCharacter(11223, "Bruised");
const baselineHp = derive(woundChar.run, woundChar).maxHp;
const woundRng = makeRng(3);
woundPart(woundChar.run, "arm", "serious", woundRng);
woundPart(woundChar.run, "leg", "serious", woundRng);
const woundedHp = derive(woundChar.run, woundChar).maxHp;
const woundedAtk = derive(woundChar.run, woundChar).attack;
ok(
  woundedAtk <= derive(woundChar.run, woundChar).attack && healthMods(woundChar.run).atkMul < 1,
  `injured arm reduces attack mul (${healthMods(woundChar.run).atkMul.toFixed(2)})`,
);
void woundedHp;
void baselineHp;

// ── Validator round-trips new fields ─────────────────────────────────
const richSaved = parseMessage(JSON.stringify({ t: "save", character: rim }));
ok(
  richSaved.data.character.traits.length === rim.traits.length &&
    richSaved.data.character.backstory.childhood === rim.backstory.childhood &&
    richSaved.data.character.skills.melee &&
    typeof richSaved.data.character.mood.value === "number",
  "validator round-trips traits / backstory / skills / mood",
);

// Hostile values get clamped not crashed.
const dirtyRim = parseMessage(
  JSON.stringify({
    t: "save",
    character: {
      ...rim,
      traits: ["not_a_trait", "tough", "bloodlust", "tough"],
      backstory: { childhood: "nope", adulthood: "also_nope" },
      mood: {
        value: 999,
        baseline: -5000,
        thoughts: [{ id: "x".repeat(900), amount: 1e6, ticksLeft: -5 }],
      },
      skills: { melee: { level: 9999, xp: 1e30, passion: 8 } },
    },
  }),
);
ok(
  dirtyRim.data.character.traits.length <= 5 &&
    dirtyRim.data.character.traits.every((t) => TRAIT_IDS.includes(t)) &&
    dirtyRim.data.character.mood.value <= 100 &&
    dirtyRim.data.character.skills.melee.level <= 20 &&
    dirtyRim.data.character.skills.melee.passion <= 2,
  "validator clamps RimWorld fields to bounds",
);

// ── Determinism with RimWorld systems wired ──────────────────────────
const det1 = freshCharacter(0xc0ffee, "Det1");
const det2 = freshCharacter(0xc0ffee, "Det2");
const detR1 = simulateOffline(det1, 4 * 3600 * 1000);
const detR2 = simulateOffline(det2, 4 * 3600 * 1000);
ok(
  detR1.kills === detR2.kills &&
    detR1.endLevel === detR2.endLevel &&
    detR1.itemsFound === detR2.itemsFound &&
    detR1.died === detR2.died,
  `offline sim still deterministic with RimWorld layered on (kills ${detR1.kills} = ${detR2.kills})`,
);

// ── Milestone 1: Persistent Abyss — Factions Slice ───────────────────
// The vertical-slice exit gate. Proves: factions survive permadeath
// (account-side), the faction combat mod stacks into derive without
// changing pre-faction output, and the world tick runs cheap + persists.

// AUTO-ENROLL: every fresh sigma joins a starter faction (no !join needed),
// flagged auto-assigned so the first real !join is a free re-pick.
const enrolled = freshCharacter(12346, "Enrolled");
ok(
  enrolled.faction &&
    STARTER_FACTION_IDS.includes(enrolled.faction) &&
    enrolled.factionAutoAssigned === true,
  `fresh sigma is auto-enrolled into a faction (${enrolled.faction}, auto-assigned)`,
);
const repick = joinFaction(
  enrolled,
  enrolled.faction === "iron_veil" ? "crimson_pact" : "iron_veil",
  1000,
);
ok(
  repick.ok &&
    !repick.switched &&
    enrolled.factionAutoAssigned === false &&
    enrolled.factionDefectorUntil === 0,
  "first !join is a FREE re-pick (no cooldown / defector)",
);
const secondSwitch = joinFaction(enrolled, "void_order", 2000);
ok(
  !secondSwitch.ok && secondSwitch.error === "cooldown",
  "the next switch (after a real choice) hits the cooldown",
);

// (d) BACK-COMPAT: derive() is byte-identical when faction===null, and
//     stays byte-identical for a rep-0 (rank-0) member — the identity path.
const facBase = freshCharacter(555, "FacBase");
const sheetNull = JSON.stringify(derive(facBase.run, facBase));
const facJoin = joinFaction(facBase, "crimson_pact", 1000);
ok(facJoin.ok && facBase.faction === "crimson_pact", "joinFaction sets allegiance");
const sheetRep0 = JSON.stringify(derive(facBase.run, facBase));
ok(
  sheetNull === sheetRep0,
  "derive is byte-identical for a rep-0 member (rank-0 → identity → no back-compat break)",
);

// (b) derive faction mod is NON-ZERO at rep 300 (rank 3, offense faction).
const attack0 = JSON.parse(sheetNull).attack;
facBase.factionRep.crimson_pact = 300;
ok(factionRank(300) === 3, "rep 300 → rank 3 (Champion)");
const sheet300 = derive(facBase.run, facBase);
ok(
  sheet300.attack > attack0,
  `Crimson Pact at rep 300 raises attack (${attack0.toFixed(2)} → ${sheet300.attack.toFixed(2)})`,
);
// And factionCombatMods is pure identity for the null case.
const idMods = factionCombatMods(null, null, "goblin_warrens");
ok(
  idMods.atkMul === 1 && idMods.defMul === 1 && idMods.hpMul === 1 && idMods.lootRarityAdd === 0,
  "factionCombatMods returns exact identity for no faction",
);

// (a) faction + rep SURVIVE permadeath (account-side, not run-side).
const facer = freshCharacter(9090, "Factioneer");
joinFaction(facer, "iron_veil", 5000);
facer.factionRep.iron_veil = 320;
facer.factionRank = factionRank(320);
deployToZone(facer, "goblin_warrens");
const beforeRuns = facer.lifetimeRuns;
resolveDeath(facer, { deathBy: "the smoke test" });
ok(
  facer.faction === "iron_veil" &&
    facer.factionRep.iron_veil === 320 &&
    facer.lifetimeRuns === beforeRuns + 1,
  "faction + reputation survive permadeath (resolveDeath only resets the run)",
);

// faction core: re-joining the same faction is a no-op error; switching
// before cooldown is rejected; the prestige gate guards the Convergence.
const already = joinFaction(facer, "iron_veil", 6000);
ok(!already.ok && already.error === "already_member", "re-joining the same faction is a no-op");
const tooSoon = joinFaction(facer, "crimson_pact", 6000);
ok(!tooSoon.ok && tooSoon.error === "cooldown", "switching factions before cooldown is rejected");
const gated = joinFaction(freshCharacter(1, "Pleb"), "abyssal_convergence", 0);
ok(!gated.ok && gated.error === "prestige_gate", "Abyssal Convergence is prestige-gated");

// (c) the WORLD TICK runs, increments epoch, recomputes membership + zone
//     counters, persists, and is fast (<50ms).
const w = freshWorld();
ok(
  Object.keys(w.factions).length === 5 && Object.keys(w.zones).length === 5,
  "freshWorld seeds 5 factions on 5 danger zones",
);
const startEpoch = w.epoch;
const worldPlayers = [
  { faction: "iron_veil", lastSeen: Date.now() },
  { faction: "iron_veil", lastSeen: 0 }, // stale → counts as member, not active
  { faction: "crimson_pact", lastSeen: Date.now() },
  { faction: null, lastSeen: Date.now() },
];
const tStart = Date.now();
const sum = worldTick(w, worldPlayers, {
  now: Date.now(),
  zoneEvents: [
    { zoneId: "goblin_warrens", kind: "kill", n: 3 },
    { zoneId: "goblin_warrens", kind: "death", n: 1 },
  ],
});
const tickMs = Date.now() - tStart;
ok(w.epoch === startEpoch + 1 && sum.epoch === w.epoch, "world tick increments the epoch");
ok(
  w.factions.iron_veil.memberCount === 2 && w.factions.iron_veil.activePlayers === 1,
  `world tick recomputes faction membership (members ${w.factions.iron_veil.memberCount}, active ${w.factions.iron_veil.activePlayers})`,
);
ok(
  w.zones.goblin_warrens.killsThisHour === 3 && w.zones.goblin_warrens.deathsThisHour === 1,
  "world tick folds drained zone events into per-zone counters",
);
ok(tickMs < 50, `world tick is fast (<50ms): ${tickMs}ms`);

// validator round-trips + clamps the new faction fields.
const facRt = freshCharacter(4242, "FacRT");
joinFaction(facRt, "void_order", 1234);
facRt.factionRep.void_order = 275;
const facParsed = parseMessage(JSON.stringify({ t: "save", character: facRt }));
ok(
  facParsed.data.character.faction === "void_order" &&
    facParsed.data.character.factionRep.void_order === 275,
  "validator round-trips faction + reputation",
);
const facDirty = parseMessage(
  JSON.stringify({
    t: "save",
    character: {
      ...facRt,
      faction: "not_a_faction",
      factionRep: { void_order: 99999, bogus: 5 },
      factionRank: 99,
    },
  }),
);
ok(
  facDirty.data.character.faction === null &&
    facDirty.data.character.factionRep.void_order === 1000 &&
    facDirty.data.character.factionRep.bogus === undefined &&
    facDirty.data.character.factionRank <= 6,
  "validator clamps hostile faction fields (bad enum → null, rep clamped, unknown key dropped)",
);

// factionRepView reflects the joined faction + rank ladder for chat replies.
const view = factionRepView(facRt);
ok(
  view.faction === "void_order" && view.rank === factionRank(275) && view.repInFaction === 275,
  `factionRepView reports rank + standing (${view.title})`,
);

// ── Milestone 2: Economy foundation ──────────────────────────────────
// Currencies, salvage→dust, server-side reroll, the player market (list →
// buy across two accounts), vault expand, the sweep, and the validator.

// Shard minting on permadeath (deterministic, account-side).
const shardy = freshCharacter(20202, "Shardy");
deployToZone(shardy, "goblin_warrens");
const shardDeath = resolveDeath(shardy, { deathBy: "the smoke test" });
ok(
  shardy.shards === Math.floor(shardDeath.prestigeGained * SHARD_PER_PRESTIGE),
  `permadeath mints Prestige Shards (${shardy.shards} from ${shardDeath.prestigeGained} prestige)`,
);

// A minimal in-memory store stub so the server market engine runs headless.
function fakeStore() {
  const players = new Map();
  const links = new Map();
  let w = freshWorld();
  let m = freshMarket();
  const feed = [];
  return {
    getPlayer: (t) => players.get(t) || null,
    putPlayer: (t, c) => players.set(t, { character: c }),
    allPlayers: () => [...players.values()],
    getTokenByTwitch: (l) => links.get(l) || null,
    linkTwitch: (l, t) => links.set(l, t),
    getWorldState: () => w,
    putWorldState: (nw) => {
      w = nw;
    },
    getMarket: () => m,
    putMarket: (nm) => {
      m = nm;
    },
    pushFeed: (e) => {
      feed.push(e);
      return e;
    },
    _feed: feed,
  };
}

// Salvage → Rune Dust by rarity.
const st = fakeStore();
const salv = freshCharacter(30303, "Salvager");
st.putPlayer("tokSalv", salv);
salv.run.inventory = [
  { slot: "ring", rarity: "rare", power: 10, name: "Rare Ring", affixes: [] },
  { slot: "charm", rarity: "common", power: 1, name: "Common Charm", affixes: [] },
];
const salvRes = market.salvage({
  login: "salvager",
  token: "tokSalv",
  character: salv,
  store: st,
  now: 1,
  body: { all: true },
});
ok(
  salvRes.ok && salv.runeDust === RUNE_DUST_PER_RARITY.rare + RUNE_DUST_PER_RARITY.common,
  `salvage yields rune dust by rarity (got ${salv.runeDust})`,
);

// Reroll one affix using server-side RNG (does not touch run.rngState).
const roller = freshCharacter(40404, "Roller");
st.putPlayer("tokRoll", roller);
roller.runeDust = 100;
roller.run.gear.weapon = makeItem({ slot: "weapon", rarity: "rare", ilvl: 10, rng: makeRng(5) });
const dustBefore = roller.runeDust;
const rngStateBefore = roller.run.rngState;
const rr = market.reroll({
  token: "tokRoll",
  character: roller,
  store: st,
  now: 12345,
  body: { slot: "weapon" },
});
ok(
  rr.ok && roller.run.gear.weapon.rerolls === 1 && roller.runeDust < dustBefore,
  `reroll consumes dust + bumps the forged counter (${rr.cost} dust)`,
);
ok(
  roller.run.rngState === rngStateBefore,
  "reroll uses server RNG — run.rngState is untouched (offline-safe)",
);

// Player market: seller lists → buyer buys, fees + tax → treasury.
const seller = freshCharacter(50505, "Seller");
const buyer = freshCharacter(60606, "Buyer");
st.putPlayer("tokSell", seller);
st.linkTwitch("seller", "tokSell");
st.putPlayer("tokBuy", buyer);
st.linkTwitch("buyer", "tokBuy");
seller.gold = 1000;
buyer.gold = 5000;
seller.run.inventory = [makeItem({ slot: "ring", rarity: "epic", ilvl: 20, rng: makeRng(9) })];
const lr = market.listItem({
  login: "seller",
  token: "tokSell",
  character: seller,
  store: st,
  world: st.getWorldState(),
  market: st.getMarket(),
  now: 100,
  body: { slot: "ring", kind: "directSale", price: 2000 },
});
ok(lr.ok && seller.gold === 1000 - lr.fee, `list deducts the listing fee (${lr.fee}g) → treasury`);
const br = market.buyListing({
  login: "buyer",
  token: "tokBuy",
  character: buyer,
  store: st,
  world: st.getWorldState(),
  market: st.getMarket(),
  now: 101,
  body: { listingId: lr.listingId },
});
ok(br.ok && buyer.vault.length === 1, "buy delivers the item to the buyer's vault");
ok(
  st.getPlayer("tokSell").character.gold === 1000 - lr.fee + 2000,
  "seller receives the full sale price",
);
ok(
  st.getWorldState().economy.treasury >= lr.fee + br.taxPaid,
  `fees + 8% tax accrue to the world treasury (${st.getWorldState().economy.treasury}g)`,
);

// Vault expansion sink (shards).
const vaulter = freshCharacter(70707, "Vaulter");
st.putPlayer("tokVault", vaulter);
vaulter.shards = 150;
const ve = market.vaultExpand({ token: "tokVault", character: vaulter, store: st });
ok(
  ve.ok && vaulter.vaultCapacity === 40 && vaulter.shards === 50,
  "vault expand spends 100 shards → capacity 40",
);

// Sweep returns an expired listing to the seller's vault (no fee refund).
const expirer = freshCharacter(11111, "Expirer");
st.putPlayer("tokExp", expirer);
st.linkTwitch("expirer", "tokExp");
expirer.gold = 500;
expirer.run.inventory = [makeItem({ slot: "charm", rarity: "uncommon", ilvl: 5, rng: makeRng(2) })];
const el = market.listItem({
  login: "expirer",
  token: "tokExp",
  character: expirer,
  store: st,
  world: st.getWorldState(),
  market: st.getMarket(),
  now: 200,
  body: { slot: "charm", price: 100 },
});
st.getMarket().listings[el.listingId].expiresAt = 1; // force-expire
const sweepRes = market.sweep({ store: st, now: 9_999_999 });
ok(
  sweepRes.expired >= 1 && st.getPlayer("tokExp").character.vault.length >= 1,
  "sweep returns expired listings to the seller vault (no fee refund)",
);

// Validator round-trips + clamps the economy fields.
const eco = freshCharacter(80808, "Eco");
eco.shards = 42;
eco.runeDust = 7;
eco.gold = 100;
eco.goldEscrowed = 999_999_999; // hostile: must clamp to gold
eco.vault = [makeItem({ slot: "ring", rarity: "rare", ilvl: 5, rng: makeRng(1) })];
const ep = parseMessage(JSON.stringify({ t: "save", character: eco }));
ok(
  ep.data.character.shards === 42 &&
    ep.data.character.runeDust === 7 &&
    ep.data.character.vault.length === 1 &&
    ep.data.character.goldEscrowed === 100,
  "validator round-trips economy fields + clamps escrow to gold balance",
);

// ── Milestone 3: Crafting, talents, item sets, binding, scars ────────

// Talent/set mods are EXACT identity when empty → derive byte-identical.
const tmId = talentMods({});
ok(
  tmId.atkMul === 1 && tmId.defMul === 1 && tmId.critAdd === 0,
  "talentMods({}) is exact identity",
);
const smId = setModsForBonuses([]);
ok(smId.defMul === 1 && smId.hpMul === 1, "setModsForBonuses([]) is exact identity");

// Talent stacking flows into derive (Juggernaut Stance = +20% defense).
const talChar = freshCharacter(31413, "Talented");
const defBefore = derive(talChar.run, talChar).defense;
talChar.skillTalents = { melee: [null, "mel_juggernaut", null] };
const defAfter = derive(talChar.run, talChar).defense;
ok(
  defAfter > defBefore,
  `talent Juggernaut Stance raises defense in derive (${defBefore.toFixed(2)} → ${defAfter.toFixed(2)})`,
);

// Item set 2-piece bonus stacks into derive (Iron Veil Panoply = +10% def).
const setChar = freshCharacter(27182, "Setter");
const setDefBefore = derive(setChar.run, setChar).defense;
setChar.run.gear.armor = makeItem({ slot: "armor", rarity: "rare", ilvl: 10, rng: makeRng(11) });
setChar.run.gear.ring = makeItem({ slot: "ring", rarity: "rare", ilvl: 10, rng: makeRng(12) });
setChar.run.gear.armor.setId = "iron_veil_panoply";
setChar.run.gear.ring.setId = "iron_veil_panoply";
const bonuses = equippedSetBonuses(setChar.run.gear);
const setDefAfter = derive(setChar.run, setChar).defense;
ok(
  bonuses.includes("iron_veil_panoply:2"),
  `equippedSetBonuses detects the 2-piece (${bonuses.join(",")})`,
);
ok(setDefAfter > setDefBefore, "item-set 2-piece bonus raises defense in derive");

// Crafting: deterministic, deducts reagents + gold, output is account-bound.
const crafter = freshCharacter(16180, "Crafter");
crafter.faction = "ember_court";
crafter.factionRep = { ember_court: 300 }; // rank 3
crafter.reagents = { abyssal_core: 6 };
crafter.gold = 3000;
const rngStateBeforeCraft = crafter.run.rngState;
const craftRng = makeRng((crafter.run.rngState || crafter.run.rngSeed || 1) >>> 0);
const craftRes = executeCraft(crafter.run, crafter, "midas_ring", craftRng);
ok(craftRes.ok && craftRes.item.bound === "account", "craft forges an account-bound item");
ok(
  craftRes.item.effect === "midas" && craftRes.item.setId === "ember_treasury",
  "crafted Midas Ring carries its effect + set id",
);
ok(
  crafter.reagents.abyssal_core === 0 && crafter.gold === 1000,
  "craft deducts reagents (6) + gold (2000)",
);
ok(
  craftRng.state !== rngStateBeforeCraft,
  "craft advanced the run rng (server saves it back — deterministic)",
);
// Faction-rank gate blocks the unworthy.
const poorCrafter = freshCharacter(16181, "Poor");
poorCrafter.faction = "ember_court";
poorCrafter.factionRep = { ember_court: 0 };
poorCrafter.reagents = { abyssal_core: 6 };
poorCrafter.gold = 3000;
const blocked = executeCraft(poorCrafter.run, poorCrafter, "midas_ring", makeRng(7));
ok(!blocked.ok && blocked.error === "rank_too_low", "craft is gated by faction rank");

// Scars erode starting stats in freshRun, clamped to STAT_MIN (applied
// before backstory deltas — at most a 4-point drop from a 5-base stat).
const scarBase = freshCharacter(13231, "ScarBase");
const unscarredVit = freshRun(scarBase.seed, 5, null, scarBase).stats.vit;
scarBase.scars = [
  { stat: "vit", amount: -2, gainedAt: 0 },
  { stat: "vit", amount: -2, gainedAt: 0 },
  { stat: "vit", amount: -2, gainedAt: 0 },
];
const scarredVit = freshRun(scarBase.seed, 5, null, scarBase).stats.vit;
ok(
  scarredVit < unscarredVit && scarredVit >= STAT_MIN && unscarredVit - scarredVit <= 4,
  `scars erode starting stats, clamped to STAT_MIN (${unscarredVit} → ${scarredVit})`,
);

// New drops are unbound by default (tradeable).
const drop = makeItem({ slot: "ring", rarity: "rare", ilvl: 8, rng: makeRng(99) });
ok(drop.bound === "unbound" && drop.setId === null, "fresh drops are unbound, no set");

// Validator round-trips + clamps the M3 fields.
const m3 = freshCharacter(33333, "M3");
m3.skillTalents = { melee: ["mel_cleave", null, null], bogusSkill: ["x"] };
m3.reagents = { goblin_ear: 4, not_a_reagent: 9 };
m3.scars = [
  { stat: "str", amount: -2, gainedAt: 1 },
  { stat: "not_a_stat", amount: -99, gainedAt: 2 },
];
const m3p = parseMessage(JSON.stringify({ t: "save", character: m3 })).data.character;
ok(
  m3p.skillTalents.melee[0] === "mel_cleave" && m3p.skillTalents.bogusSkill === undefined,
  "validator keeps valid talents, drops unknown skills",
);
ok(
  m3p.reagents.goblin_ear === 4 && m3p.reagents.not_a_reagent === undefined,
  "validator keeps known reagents, drops unknown codes",
);
ok(
  m3p.scars.length === 2 && m3p.scars[1].amount >= -10,
  "validator clamps scar amounts into bounds",
);

// ── Milestone 4: World simulation depth ──────────────────────────────
// The world tick generates faction conquest + world events deterministically;
// injectWorldState moves them onto a run; delveTick consumes them post-RNG
// without desyncing offline sim.

// Run the world forward with an active faction; it should conquer territory
// and accrue a world-event queue (both deterministic from worldSeed+epoch).
const wsim = freshWorld(12345);
const ironMembers = Array.from({ length: 5 }, () => ({ faction: "iron_veil", lastSeen: 1 }));
let _lastConq = null;
for (let i = 0; i < 60; i += 1) {
  const sum = worldTick(wsim, ironMembers, {
    now: 1 + i * 60_000,
    zoneEvents: [{ zoneId: "goblin_warrens", kind: "death", n: 2 }],
  });
  if (sum.conquests?.length) _lastConq = sum.conquests;
}
const anyOwned = Object.values(wsim.zones).some((z) => z.conquestOwner);
ok(anyOwned, "world tick conquers zone territory over time (faction zoneScores → conquestOwner)");
ok(
  wsim.eventQueue.length > 0,
  `world tick generates a world-event queue (${wsim.eventQueue.length} queued)`,
);
ok(wsim.zones.goblin_warrens.pressure > 0.3, "zone pressure rises from death events");

// Same worldSeed + same epoch → identical event roll (deterministic/auditable).
const wA = freshWorld(999);
const wB = freshWorld(999);
worldTick(wA, [], { now: 1000 });
worldTick(wB, [], { now: 1000 });
ok(
  JSON.stringify(wA.eventQueue) === JSON.stringify(wB.eventQueue),
  "world-event generation is deterministic for a fixed worldSeed + epoch",
);

// injectWorldState moves zone events onto the run + sets the conquest mod.
const wInj = freshWorld(42);
wInj.epoch = 1;
wInj.lastTickAt = 5000;
wInj.eventQueue.push({
  zoneId: "goblin_warrens",
  event: { id: "void_convergence", name: "Void Convergence", effect: { dangerDelta: 0.4 } },
  createdAt: 4000,
  ttl: 1e15,
});
wInj.zones.goblin_warrens.conquestOwner = "iron_veil";
const delver = freshCharacter(70001, "Delver");
delver.faction = "iron_veil";
delver.run.zone = "goblin_warrens";
injectWorldState(delver, wInj);
ok(
  Array.isArray(delver.run._pendingWorldEvents) && delver.run._pendingWorldEvents.length === 1,
  "injectWorldState moves queued zone events onto run._pendingWorldEvents",
);
ok(
  delver.run._factionZoneMod > 0,
  "injectWorldState precomputes a positive conquest mod for the owning faction",
);
// Re-injecting does not double-deliver (watermark dedup).
injectWorldState(delver, wInj);
ok(
  !delver.run._pendingWorldEvents || delver.run._pendingWorldEvents.length <= 1,
  "world events are delivered once per player (lastWorldEventAt watermark)",
);

// delveTick consumes the pending world event (danger rises) WITHOUT touching
// the rng stream — two same-seed runs with the same event stay in parity.
function injectedRun(seed) {
  const ch = freshCharacter(seed, "WorldEventee");
  deployToZone(ch, "goblin_warrens");
  ch.run._pendingWorldEvents = [
    { id: "void_convergence", name: "Void Convergence", effect: { dangerDelta: 0.4 } },
  ];
  return ch;
}
const we1 = injectedRun(81818);
const we2 = injectedRun(81818);
const beforeDanger = we1.run.danger;
delveTick(we1);
delveTick(we2);
ok(we1.run.danger > beforeDanger, "delveTick applies the world-event danger spike");
ok(!we1.run._pendingWorldEvents.length, "world event is consumed once (cleared after applying)");
ok(
  we1.run.rngState === we2.run.rngState && we1.run.danger === we2.run.danger,
  "world events do not desync the deterministic stream",
);

// applyWorldEvent is rng-free (does not advance run.rngState).
const afChar = freshCharacter(60002, "AfTest");
const afState = afChar.run.rngState;
applyWorldEvent(WORLD_EVENTS.gold_rush, afChar, afChar.run);
ok(
  afChar.gold >= 200 && afChar.run.rngState === afState,
  "applyWorldEvent applies fixed deltas with no rng draw",
);

// derive faction-zone conquest mod stacks (identity at 0).
const zChar = freshCharacter(60003, "ZoneMod");
const atk0 = derive(zChar.run, zChar).attack;
zChar.run._factionZoneMod = 0;
ok(derive(zChar.run, zChar).attack === atk0, "run._factionZoneMod 0 → derive byte-identical");
zChar.run._factionZoneMod = 0.1;
ok(derive(zChar.run, zChar).attack > atk0, "run._factionZoneMod 0.1 raises attack in derive");

// vRun strips the transient world-event fields (client cannot forge them).
const forger = freshCharacter(60004, "Forger");
forger.run._pendingWorldEvents = [{ id: "void_convergence", effect: { dangerDelta: 9 } }];
forger.run._factionZoneMod = 99;
const cleaned = parseMessage(JSON.stringify({ t: "save", character: forger })).data.character;
ok(
  cleaned.run._pendingWorldEvents === undefined && cleaned.run._factionZoneMod === undefined,
  "vRun strips _pendingWorldEvents / _factionZoneMod (forge-proof)",
);

// ── Milestone 5: Narrative engine (crises + quests) ──────────────────

// Quest generation is deterministic; ensureQuests populates the board.
const qg1 = generateQuests(freshCharacter(7, "x"));
const qg2 = generateQuests(freshCharacter(7, "y"));
ok(
  JSON.stringify(qg1.map((q) => q.templateId)) === JSON.stringify(qg2.map((q) => q.templateId)),
  "quest generation is deterministic by character seed",
);
const quester = freshCharacter(44444, "Quester");
const added = ensureQuests(quester);
ok(
  added.length > 0 && quester.quests.length > 0,
  "ensureQuests populates a procedural quest board",
);

// advanceQuest completes a quest when its objective is met; reward pays XP.
const aq = quester.quests.find((q) => q.status === "active");
const obj0 = aq.objectives[0];
const completed = advanceQuest(quester, obj0.kind, obj0.target);
ok(
  completed.some((c) => c.templateId === aq.templateId),
  "advanceQuest completes a quest at its objective target",
);
const xpBefore = quester.questXp | 0;
const reward = grantQuestReward(quester, aq);
ok(quester.questXp > xpBefore && !!reward.questName, "grantQuestReward pays quest XP + reward");
ok(questLevelForXp(quester.questXp) === quester.questLevel, "quest level tracks quest XP");

// World crisis state machine: launch (crowd) → active → resolve (won) → conclude.
const wc = freshWorld(555);
let launched = null;
for (let i = 0; i < 300 && !launched; i += 1) {
  wc.epoch = i + 1;
  const r = advanceCrisis(wc, 5, 1000 + i * 1000);
  if (r?.kind === "launched") launched = r;
}
ok(
  !!launched && !!wc.crisis.activeCrisis,
  `a crisis launches with a crowd online (${launched?.name})`,
);
advanceCrisis(wc, 5, 9_000_000);
ok(wc.crisis.activeCrisis.phase === "active", "crisis advances brewing → active");
const target = wc.crisis.activeCrisis.target;
let lastContribute = null;
for (let i = 0; i < target; i += 1) lastContribute = contributeToCrisis(wc, `chatter${i % 10}`, 1);
ok(
  lastContribute?.ok && wc.crisis.activeCrisis.total >= target,
  "chat contributions accrue toward the crisis target",
);
advanceCrisis(wc, 5, 9_100_000);
ok(
  wc.crisis.activeCrisis.phase === "resolving" && wc.crisis.activeCrisis.outcome === "won",
  "crisis resolves as WON when the target is met",
);
const concluded = advanceCrisis(wc, 5, 9_200_000);
ok(
  concluded?.kind === "concluded" &&
    !wc.crisis.activeCrisis &&
    wc.crisis.history.length === 1 &&
    wc.crisis.cooldownUntil > 0,
  "crisis concludes — records history + arms the cooldown",
);

// An active crisis injects its persistent effect onto a delver every ping.
const wInj2 = freshWorld(1);
wInj2.crisis.activeCrisis = {
  id: "void_convergence",
  name: "Void Convergence",
  phase: "active",
  personalEffect: { dangerDelta: 0.4 },
  contributeVerb: "fight",
  target: 200,
  total: 0,
  contributions: {},
  endsAt: 1e15,
};
const crisisDelver = freshCharacter(222, "CrisisDelver");
crisisDelver.run.zone = "goblin_warrens";
injectWorldState(crisisDelver, wInj2);
ok(
  crisisDelver.run._pendingWorldEvents?.some((e) => e.crisis),
  "active crisis injects its effect onto the run",
);
crisisDelver.run._pendingWorldEvents = [];
injectWorldState(crisisDelver, wInj2);
ok(
  crisisDelver.run._pendingWorldEvents?.some((e) => e.crisis),
  "crisis effect re-injects every ping (persistent, not deduped)",
);

// Validator round-trips quests.
const qv = freshCharacter(50505, "QV");
ensureQuests(qv);
qv.questXp = 500;
qv.questLevel = 2;
const qvp = parseMessage(JSON.stringify({ t: "save", character: qv })).data.character;
ok(
  qvp.questXp === 500 &&
    qvp.questLevel === 2 &&
    Array.isArray(qvp.quests) &&
    qvp.quests.length >= 1,
  "validator round-trips quests + questXp/level",
);

// ── Milestone 6: NPC intelligence ────────────────────────────────────

// Faction kill-rep (deterministic, account-side, no-op for the unaligned).
const repGainer = freshCharacter(60011, "RepGainer");
repGainer.faction = "iron_veil";
repGainer.factionRep = { iron_veil: 0 };
const repGained = applyKillRep(repGainer, "goblin_warrens", "elite", 0);
ok(
  repGained > 0 && repGainer.factionRep.iron_veil === repGained,
  `applyKillRep grants home-zone faction rep (+${repGained})`,
);
const unaligned = freshCharacter(60012, "NoFac");
unaligned.faction = null; // sigmas auto-enroll; force the unaligned edge case
ok(
  applyKillRep(unaligned, "goblin_warrens", "elite", 0) === 0,
  "applyKillRep is a no-op for the unaligned",
);

// Faction members earn rep delving, deterministically (offline parity).
function factionDelve(seed) {
  const fd = freshCharacter(seed, "FactionDelver");
  fd.faction = "iron_veil";
  fd.factionRep = { iron_veil: 0 };
  deployToZone(fd, "goblin_warrens");
  for (let i = 0; i < 25; i += 1) {
    const o = delveTick(fd);
    if (o.type === "death") {
      resolveDeath(fd, o);
      deployToZone(fd, "goblin_warrens");
    }
  }
  return fd;
}
const fd1 = factionDelve(40404);
const fd2 = factionDelve(40404);
ok(fd1.factionRep.iron_veil > 0, "faction members earn rep delving their home zone");
ok(
  fd1.factionRep.iron_veil === fd2.factionRep.iron_veil && fd1.run.rngState === fd2.run.rngState,
  "kill-rep is deterministic (offline parity holds for faction members)",
);

// NPC memory: episodes warm/cool the relationship; it decays toward neutral.
const rel = freshRelationship(0);
rememberEpisode(rel, "gift", 1000);
ok(rel.score === 6, "rememberEpisode applies the episode weight (gift +6)");
rel.lastSeenAt = 1; // a real "seen" timestamp (0 = never-seen sentinel)
decayRelationship(rel, 3 * 24 * 3600 * 1000);
ok(rel.score < 6, "decayRelationship drifts toward neutral over days");
ok(
  dispositionLabel(80) === "ally" &&
    dispositionLabel(0) === "neutral" &&
    dispositionLabel(-80) === "hostile",
  "dispositionLabel bands the score",
);

// NPC interaction builds a relationship + returns a line.
const npcStore = fakeStore();
const greeter = freshCharacter(60013, "Greeter");
npcStore.putPlayer("tokGreet", greeter);
const greetRes = handleNpcInteract(
  {
    login: "greeter",
    token: "tokGreet",
    character: greeter,
    store: npcStore,
    body: { npc: "kael" },
    now: 1000,
  },
  "greet",
);
ok(
  greetRes.ok && !!greetRes.line && greeter.npcRelationships.kael.score > 0,
  `greeting an NPC builds a relationship + returns a line ("${greetRes.line}")`,
);

// World seeds + ticks the NPC cast.
const wnpc = freshWorld(3);
ok(Object.keys(wnpc.npcs).length === 5, "freshWorld seeds the 5-NPC cast");
worldTick(wnpc, [], { now: 1 });
ok(!!wnpc.npcs.kael.schedulePhase, "world tick advances NPC schedule phases");

// Validator keeps known NPC relationships, drops unknown ids.
const nv = freshCharacter(60014, "NV");
nv.npcRelationships = {
  kael: { score: 40, flags: ["met"], lastSeenAt: 5, episodes: [{ kind: "greet", w: 1, at: 5 }] },
  not_an_npc: { score: 99 },
};
const nvp = parseMessage(JSON.stringify({ t: "save", character: nv })).data.character;
ok(
  nvp.npcRelationships.kael.score === 40 && nvp.npcRelationships.not_an_npc === undefined,
  "validator keeps known NPC relationships, drops unknown ids",
);

// ── Milestone 7: Retention loops ─────────────────────────────────────

// Daily objectives generate deterministically + advance + claim.
const day0 = 100 * DAY_MS;
const d1 = rollDailies(day0);
const d2 = rollDailies(day0);
ok(
  d1.length === DAILY_COUNT && JSON.stringify(d1) === JSON.stringify(d2),
  "daily objectives generate deterministically per UTC day",
);
const killObj = d1.find((o) => o.kind === "kill") || d1[0];
const doneList = advanceObjectives(d1, killObj.kind, killObj.target);
ok(doneList.includes(killObj), "advanceObjectives marks an objective complete at its target");

// ensureFreshObjectives rerolls on day rollover; claimObjective pays once.
const ro = freshCharacter(70011, "RetentionOne");
ensureFreshObjectives(ro, day0);
ok(
  ro.dailyObjectives.length === DAILY_COUNT && ro.weeklyBounties.length > 0,
  "ensureFreshObjectives seeds the board",
);
const reset = ensureFreshObjectives(ro, day0 + 2 * DAY_MS);
ok(
  reset === true && ro.dailyDayIndex === Math.floor((day0 + 2 * DAY_MS) / DAY_MS),
  "ensureFreshObjectives rerolls on a new day",
);
const claimTarget = ro.dailyObjectives[0];
claimTarget.progress = claimTarget.target;
const goldBefore = ro.gold | 0;
const claim = claimObjective(ro, claimTarget.id);
ok(claim.ok && claimTarget.claimed, "claimObjective claims a completed daily");
const reclaim = claimObjective(ro, claimTarget.id);
ok(!reclaim.ok && reclaim.error === "already_claimed", "a daily cannot be double-claimed");
ok(ro.gold >= goldBefore, "daily reward credits the account");

// Achievements unlock from lifetime stats; syncAchievements records + scores.
const ach = freshCharacter(70012, "Achiever");
ach.lifetimeKills = 1200; // → centurion + slayer
const freshAch = checkAchievements(ach);
ok(
  freshAch.includes("centurion") && freshAch.includes("slayer"),
  "checkAchievements detects earned achievements",
);
const granted = syncAchievements(ach);
ok(
  granted.length >= 2 &&
    ach.achievements.earned.includes("slayer") &&
    ach.achievements.score === achievementScore(ach.achievements.earned),
  "syncAchievements records earned + computes score",
);
ok(syncAchievements(ach).length === 0, "achievements are not re-awarded");

// Bestiary records kills; museum enshrines the best item from a dead run.
const collector = freshCharacter(70013, "Collector");
creditBestiary(collector, "goblin", 5);
creditBestiary(collector, "goblin", 2);
ok(collector.bestiary.kills.goblin === 7, "creditBestiary tallies kills per archetype");
const dead = freshCharacter(70014, "Fallen");
dead.run.gear.weapon = makeItem({
  slot: "weapon",
  rarity: "legendary",
  ilvl: 40,
  rng: makeRng(77),
});
dead.run.inventory = [makeItem({ slot: "ring", rarity: "rare", ilvl: 10, rng: makeRng(78) })];
const enshrined = autoMuseumEnshrined(dead, dead.run);
ok(
  enshrined && dead.museum.length === 1 && dead.museum[0].rarity === "legendary",
  "autoMuseumEnshrined enshrines the dead run's best item",
);

// Validator round-trips the retention fields.
const rv = freshCharacter(70015, "RV");
ensureFreshObjectives(rv, day0);
rv.achievements = { earned: ["centurion", "not_a_real_achievement"], score: 10 };
rv.bestiary = { kills: { goblin: 9 }, firstKilledAt: {} };
rv.museum = [{ name: "Doomdrinker", rarity: "mythic", power: 999, at: 1 }];
const rvp = parseMessage(JSON.stringify({ t: "save", character: rv })).data.character;
ok(
  rvp.dailyObjectives.length === DAILY_COUNT &&
    rvp.achievements.earned.includes("centurion") &&
    !rvp.achievements.earned.includes("not_a_real_achievement") &&
    rvp.bestiary.kills.goblin === 9 &&
    rvp.museum.length === 1,
  "validator round-trips retention fields + drops unknown achievement ids",
);

// ── Milestone 8: Twitch surface — voting + scale ─────────────────────

// Chat voting: open → cast (one each) → close applies the winning effect.
const wv = freshWorld(8);
const open = voting.openVote({ options: ["loot_surge", "calm"], durationMs: 60_000, now: 1000 });
ok(open.ok && open.vote.options.length === 2, "openVote opens a multi-option vote");
voting.castVote("alice", "loot_surge");
voting.castVote("bob", "loot_surge");
voting.castVote("carol", "calm");
const dupVote = voting.castVote("alice", "calm");
ok(!dupVote.ok && dupVote.error === "already_voted", "a chatter votes only once");
const queuedBefore = wv.eventQueue.length;
const closed = voting.closeVote(wv, 2000);
ok(
  closed.ok && closed.result.winner === "loot_surge" && closed.result.votes === 2,
  "closeVote tallies the winning option",
);
ok(
  wv.eventQueue.length > queuedBefore,
  "the winning vote effect mutates the shared world (loot surge queued)",
);
ok(!voting.voteState(), "the vote clears after closing");

// Scale pass: one world tick with 500 players + 200 zone events stays <50ms,
// honoring the bounded-work / PSU-safety contract (one cheap loop).
const wscale = freshWorld(9);
const manyPlayers = Array.from({ length: 500 }, (_, i) => ({
  faction: i % 2 ? "iron_veil" : "crimson_pact",
  lastSeen: 1,
  run: { zone: "goblin_warrens" },
}));
const manyEvents = Array.from({ length: 200 }, () => ({
  zoneId: "goblin_warrens",
  kind: "kill",
  n: 1,
}));
const tScale = Date.now();
worldTick(wscale, manyPlayers, { now: 1, zoneEvents: manyEvents });
const scaleMs = Date.now() - tScale;
ok(scaleMs < 50, `world tick scales to 500 players + 200 events in <50ms (${scaleMs}ms)`);
ok(
  wscale.factions.iron_veil.memberCount === 250 && wscale.factions.crimson_pact.memberCount === 250,
  "world tick correctly tallies 500 players across factions",
);

// ── Combat-gear manual equip (loadout backend) ───────────────────────
// The /loadout + /equip endpoints' pure swap helper: validate strictly,
// move inventory→gear, return the displaced piece to the bag.
const equipper = freshCharacter(90901, "Equipper");
equipper.run.gear.weapon = makeItem({
  slot: "weapon",
  rarity: "common",
  ilvl: 5,
  rng: makeRng(40),
});
const betterWeapon = makeItem({ slot: "weapon", rarity: "epic", ilvl: 20, rng: makeRng(41) });
const aRing = makeItem({ slot: "ring", rarity: "rare", ilvl: 10, rng: makeRng(42) });
equipper.run.inventory = [betterWeapon, aRing];

// loadoutInventory only surfaces equippable items, tagged with their index.
const surfaced = loadoutInventory(equipper.run);
ok(
  surfaced.length === 2 && surfaced[0].index === 0 && surfaced[0].slot === "weapon",
  "loadoutInventory projects the equippable bag with array indices",
);

// Slot mismatch is rejected (a ring cannot go in the weapon slot).
const mismatch = equipFromInventory(equipper.run, "weapon", 1);
ok(!mismatch.ok && mismatch.error === "slot_mismatch", "equip rejects a slot/item mismatch");
// Out-of-range + bad slot are rejected.
ok(!equipFromInventory(equipper.run, "weapon", 9).ok, "equip rejects an out-of-range index");
ok(!equipFromInventory(equipper.run, "not_a_slot", 0).ok, "equip rejects an unknown slot");

// Valid equip: the new weapon goes on; the old real weapon returns to the bag.
const oldWeapon = equipper.run.gear.weapon;
const swap = equipFromInventory(equipper.run, "weapon", 0);
ok(
  swap.ok && equipper.run.gear.weapon === betterWeapon,
  "equip moves the chosen item into its gear slot",
);
ok(
  equipper.run.inventory.includes(oldWeapon) && !equipper.run.inventory.includes(betterWeapon),
  "equip benches the previously-worn piece back into the bag",
);

// A power-0 placeholder (the starter Bare Fists) is discarded on swap, not
// benched — the bag must not grow with worthless presence items.
const starterSwap = freshCharacter(90902, "StarterSwap");
starterSwap.run.gear.weapon = { slot: "weapon", name: "Bare Fists", power: 0, starter: true };
const realWeapon = makeItem({ slot: "weapon", rarity: "rare", ilvl: 10, rng: makeRng(43) });
starterSwap.run.inventory = [realWeapon];
const invLenBefore = starterSwap.run.inventory.length;
equipFromInventory(starterSwap.run, "weapon", 0);
ok(
  starterSwap.run.gear.weapon === realWeapon &&
    starterSwap.run.inventory.length === invLenBefore - 1,
  "equipping over a power-0 starter discards it (placeholder, not benched)",
);

// ── Regression: a legendary in the bag at retreat is EQUIPPED, not vendored ──
// The autopilot + offline sim both retreat → bankAtTown (sells the whole bag).
// autoEquipBest MUST run first or a freshly-dropped upgrade is auto-sold before
// it can ever be worn (the "hellojester993 can't find his legendary hexblade"
// bug: a boss legendary dropped, boss_clear banked the bag, and the post-loop
// auto-equip never saw it — only bestItemPower kept a trace).
const haul = freshCharacter(13371, "Haul");
const wornWeapon = makeItem({ slot: "weapon", rarity: "rare", ilvl: 20, rng: makeRng(110) });
haul.run.gear.weapon = wornWeapon; // a real rare weapon (well under the legendary)
const legendary = makeItem({ slot: "weapon", rarity: "legendary", ilvl: 32, rng: makeRng(239) });
legendary.power = 239; // pin the fingerprint power so the assert is unambiguous
haul.run.inventory = [legendary];
ok(wornWeapon.power < legendary.power, "test setup: worn rare is weaker than the legendary");
const goldBeforeHaul = haul.gold | 0;
// Exact retreat ordering the live + offline loops now use.
autoEquipBest(haul.run);
retreatToTown(haul);
bankAtTown(haul);
ok(
  haul.run.gear.weapon === legendary && haul.run.inventory.length === 0,
  "retreat equips a bagged legendary before banking (not vendored to gold)",
);
ok(
  haul.gold - goldBeforeHaul < 239,
  "the equipped legendary is NOT in the banked gold (it was worn, not sold)",
);

// ── Regression: an item's display name carries its OWN base noun ──────────────
// nameFor() used to re-roll a fresh noun, so a base:"Hexblade" weapon could be
// named "Vicious Coilgun" — unrecognisable next to the HUD badge (which shows
// base). The name must now always contain the item's actual base noun.
let nameMatchesBase = true;
for (let s = 1; s <= 40 && nameMatchesBase; s += 1) {
  for (const rarity of ["common", "rare", "epic", "legendary"]) {
    const it = makeItem({ slot: "weapon", rarity, ilvl: 20, rng: makeRng(s * 31 + 7) });
    if (!String(it.name).includes(it.base)) {
      nameMatchesBase = false;
      console.log(`    ✗ name "${it.name}" does not contain base "${it.base}" (${rarity})`);
    }
  }
}
ok(nameMatchesBase, "item display name always contains its own base noun (no re-rolled noun)");

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
