// SIGMA ABYSS — RimWorld-style backstories.
//
// A sigma's life before the abyss colours how it starts: each character
// gets one Childhood + one Adulthood backstory, deterministically rolled
// from the seed. Both grant a small starting bonus (skill XP, gold,
// stat shaping, sometimes a free trait) and a one-line biography that
// the UI shows on the character sheet. The seed is the only input —
// freshCharacter() can call rollBackstory(seed) and bake the result onto
// the account so it survives permadeath.
//
// Pure ESM, dual-runtime. No live RNG draws.

import { makeRng, mixSeed } from "./rng.js";

// Childhood backstories — what a sigma was before they could fight.
// `skills` is a map of skillId → XP (banked into skills.js).
// `stats` is a partial stats delta merged onto START_STATS at creation.
// `disables` lists work classes the sigma is bad at (informational; the
// auto-battler does not literally lock these out, but stats reflect it).
export const CHILDHOODS = [
  {
    id: "street_urchin",
    name: "Street Urchin",
    bio: "Scrabbled in alleys. Knife in one hand, bread in the other.",
    skills: { melee: 600, stealth: 800, looting: 400 },
    stats: { agi: 2, luck: 1 },
  },
  {
    id: "tribal_warrior",
    name: "Tribal Warrior",
    bio: "Raised on the long trail. Hunted what would hunt them.",
    skills: { melee: 900, survival: 800 },
    stats: { str: 2, vit: 1 },
  },
  {
    id: "noble_heir",
    name: "Noble Heir",
    bio: "Velvet rooms, fencing tutors, very little dirt.",
    skills: { social: 800, magic: 400 },
    stats: { int: 2 },
    gold: 250,
  },
  {
    id: "cult_acolyte",
    name: "Cult Acolyte",
    bio: "Chanted in a basement. Saw something they cannot un-see.",
    skills: { magic: 1000, social: 200 },
    stats: { int: 2, resolve: 1 },
    trait: "depressive",
  },
  {
    id: "farmboy",
    name: "Farmboy",
    bio: "Up with the sun, in bed with the rain. Strong from honest work.",
    skills: { melee: 300, survival: 700 },
    stats: { str: 1, vit: 2 },
  },
  {
    id: "library_brat",
    name: "Library Brat",
    bio: "Hid in the stacks. Read everything that was not nailed down.",
    skills: { magic: 900, social: 300 },
    stats: { int: 3 },
    trait: "bookworm",
  },
  {
    id: "merchant_kid",
    name: "Merchant's Kid",
    bio: "Counted coins before they could count to ten.",
    skills: { bargaining: 1000, social: 400 },
    stats: { luck: 1, greed: 2 },
    gold: 150,
  },
  {
    id: "orphan_apprentice",
    name: "Orphan Apprentice",
    bio: "Workshop floors and master's belt. Calloused, watchful.",
    skills: { looting: 600, stealth: 500, melee: 200 },
    stats: { agi: 1, resolve: 1 },
  },
  {
    id: "feral_child",
    name: "Feral Child",
    bio: "Raised by something with teeth. Speaks a language no one else does.",
    skills: { survival: 1100, melee: 500 },
    stats: { agi: 2, vit: 1 },
    trait: "tough",
  },
  {
    id: "monastery_novice",
    name: "Monastery Novice",
    bio: "Bowed at dawn, swept at dusk. Found stillness — and a knife.",
    skills: { melee: 500, magic: 500, social: 300 },
    stats: { resolve: 2 },
    trait: "stoic",
  },
  {
    id: "gambler_brood",
    name: "Gambler's Brood",
    bio: "Learned at the felt. Won, lost, learned the difference.",
    skills: { bargaining: 600, looting: 600 },
    stats: { luck: 3 },
    trait: "lucky",
  },
  {
    id: "barracks_kid",
    name: "Barracks Kid",
    bio: "Slept under bunks. Stole sword polish, swung wooden blades.",
    skills: { melee: 800, ranged: 500 },
    stats: { str: 1, agi: 1, resolve: 1 },
  },
  {
    id: "wandering_bard",
    name: "Wandering Bard",
    bio: "Strummed by firelight. Knew every face on the road.",
    skills: { social: 1000, magic: 400 },
    stats: { int: 1, luck: 1 },
    trait: "kind",
  },
  {
    id: "plague_orphan",
    name: "Plague Orphan",
    bio: "Outlived the fever. Outlived their family. Kept walking.",
    skills: { survival: 600, magic: 300 },
    stats: { resolve: 2, vit: 1 },
    trait: "ironStomach",
  },
  {
    id: "miner_kid",
    name: "Miner's Kid",
    bio: "Soot in the lungs, callus on the hand. Knew the pickaxe before the alphabet.",
    skills: { melee: 600, survival: 400 },
    stats: { str: 2, vit: 1 },
  },
];

// Adulthood — what a sigma did right before the abyss called.
export const ADULTHOODS = [
  {
    id: "sellsword",
    name: "Sellsword",
    bio: "Worked for whoever paid. Walked away from one too many bad jobs.",
    skills: { melee: 1500, ranged: 600 },
    stats: { str: 2, agi: 1 },
  },
  {
    id: "plague_doctor",
    name: "Plague Doctor",
    bio: "Birdmask and bone-saw. Saved some, buried most.",
    skills: { magic: 1300, social: 400 },
    stats: { int: 2, resolve: 1 },
    trait: "ironStomach",
  },
  {
    id: "highwayman",
    name: "Highwayman",
    bio: "Worked the lonely roads. Took only what they could carry.",
    skills: { ranged: 1000, stealth: 800, looting: 800 },
    stats: { agi: 2, greed: 1 },
  },
  {
    id: "knight_errant",
    name: "Knight Errant",
    bio: "Lost their lord. Kept the sword.",
    skills: { melee: 1800, social: 400 },
    stats: { str: 2, resolve: 2 },
    trait: "ironWilled",
  },
  {
    id: "burned_priest",
    name: "Burned Priest",
    bio: "Lost faith. Kept the fire.",
    skills: { magic: 1500, social: 600 },
    stats: { int: 2, resolve: 1 },
    trait: "pyromaniac",
  },
  {
    id: "pit_fighter",
    name: "Pit Fighter",
    bio: "Forty wins, twelve scars. The forty-first paid for the abyss.",
    skills: { melee: 2000, survival: 400 },
    stats: { str: 3, vit: 1 },
    trait: "tough",
  },
  {
    id: "exile_scholar",
    name: "Exile Scholar",
    bio: "Asked the wrong question of the wrong patron. Now they ask the abyss.",
    skills: { magic: 1700, bargaining: 400 },
    stats: { int: 3 },
    trait: "fastLearner",
  },
  {
    id: "treasure_hunter",
    name: "Treasure Hunter",
    bio: "Maps. Rumours. A nose for old gold.",
    skills: { looting: 1500, survival: 700 },
    stats: { luck: 2, greed: 2 },
    trait: "greedy",
  },
  {
    id: "deserter",
    name: "Deserter",
    bio: "Walked off the battlefield. Hasn't stopped walking.",
    skills: { stealth: 1200, melee: 800 },
    stats: { agi: 2, resolve: 1 },
    trait: "nervous",
  },
  {
    id: "freelance_wizard",
    name: "Freelance Wizard",
    bio: "Gig spells, gig payment. The abyss pays best.",
    skills: { magic: 1600, bargaining: 500 },
    stats: { int: 2, luck: 1 },
  },
  {
    id: "carnival_blade",
    name: "Carnival Blade",
    bio: "Threw knives in a striped tent. Now throws them at gods.",
    skills: { ranged: 1400, social: 600 },
    stats: { agi: 2, luck: 1 },
    trait: "sharpshooter",
  },
  {
    id: "wandering_hermit",
    name: "Wandering Hermit",
    bio: "Lived on roots and starlight. Came down for the noise.",
    skills: { survival: 1800, magic: 500 },
    stats: { resolve: 3, vit: 1 },
    trait: "ascetic",
  },
  {
    id: "gambler",
    name: "Gambler",
    bio: "Owes a man. Owes the man's brother. Owes the abyss.",
    skills: { bargaining: 1400, looting: 600 },
    stats: { luck: 3, greed: 1 },
    trait: "lucky",
  },
  {
    id: "cursed_warrior",
    name: "Cursed Warrior",
    bio: "Won the wrong battle. Took home the wrong prize.",
    skills: { melee: 1400, magic: 600 },
    stats: { str: 2, resolve: 1 },
    trait: "cursed",
  },
  {
    id: "guild_assassin",
    name: "Guild Assassin",
    bio: "Wore black. Did not miss. Took one contract that should have been refused.",
    skills: { stealth: 1500, melee: 1000, ranged: 700 },
    stats: { agi: 3 },
    trait: "careful",
  },
  {
    id: "tavern_keeper",
    name: "Tavern Keeper",
    bio: "Poured beers, broke up brawls. Closed the tavern when the abyss opened.",
    skills: { social: 1300, bargaining: 900, melee: 600 },
    stats: { vit: 2, int: 1 },
    trait: "kind",
  },
];

const CHILDHOOD_IDS = CHILDHOODS.map((c) => c.id);
const ADULTHOOD_IDS = ADULTHOODS.map((a) => a.id);

const CHILDHOOD_BY_ID = Object.fromEntries(CHILDHOODS.map((c) => [c.id, c]));
const ADULTHOOD_BY_ID = Object.fromEntries(ADULTHOODS.map((a) => [a.id, a]));

// Deterministic roll. Returns { childhood, adulthood, bonusTrait? }.
// The bonusTrait is granted on top of whatever rollTraits() produces —
// trait pickers in traits.js / freshCharacter should fold it in and let
// the conflict filter deduplicate.
export function rollBackstory(seed) {
  const rng = makeRng(mixSeed(seed >>> 0, 0xc0fffee5));
  const child = rng.pick(CHILDHOOD_IDS);
  let adult = rng.pick(ADULTHOOD_IDS);
  // Avoid the same flavour twice — re-roll once if childhood and
  // adulthood share an id stem (e.g. "gambler_brood" + "gambler").
  if (adult.startsWith(child.split("_")[0])) {
    adult = rng.pick(ADULTHOOD_IDS.filter((a) => !a.startsWith(child.split("_")[0])));
  }
  const cDef = CHILDHOOD_BY_ID[child];
  const aDef = ADULTHOOD_BY_ID[adult];
  const bonusTraits = [];
  if (cDef?.trait) bonusTraits.push(cDef.trait);
  if (aDef?.trait && aDef.trait !== cDef?.trait) bonusTraits.push(aDef.trait);
  return { childhood: child, adulthood: adult, bonusTraits };
}

// Starting state mods (combined). Caller folds these into the new
// character so the early game already reflects who the sigma was.
export function backstoryProfile(childhood, adulthood) {
  const c = CHILDHOOD_BY_ID[childhood];
  const a = ADULTHOOD_BY_ID[adulthood];
  const stats = {};
  const skills = {};
  let gold = 0;
  for (const def of [c, a]) {
    if (!def) continue;
    if (def.stats)
      for (const k of Object.keys(def.stats)) stats[k] = (stats[k] || 0) + def.stats[k];
    if (def.skills)
      for (const k of Object.keys(def.skills)) skills[k] = (skills[k] || 0) + def.skills[k];
    if (def.gold) gold += def.gold;
  }
  return { stats, skills, gold };
}

export function backstoryById(id) {
  return CHILDHOOD_BY_ID[id] || ADULTHOOD_BY_ID[id] || null;
}

export function backstoryBio(childhood, adulthood) {
  const c = CHILDHOOD_BY_ID[childhood];
  const a = ADULTHOOD_BY_ID[adulthood];
  return {
    childhood: c?.name || "Unknown",
    adulthood: a?.name || "Unknown",
    childBio: c?.bio || "",
    adultBio: a?.bio || "",
  };
}
