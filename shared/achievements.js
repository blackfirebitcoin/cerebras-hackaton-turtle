// SIGMA ABYSS — achievements + collections (master design §M7, [A4]).
//
// Long-tail collection goals checked against ACCOUNT lifetime stats. PURE ESM,
// RNG-free — checkAchievements is a deterministic function of account state.

export const ACHIEVEMENTS = {
  first_death: {
    id: "first_death",
    name: "Memento Mori",
    points: 5,
    check: (c) => (c.lifetimeRuns | 0) >= 1,
  },
  centurion: {
    id: "centurion",
    name: "Centurion",
    points: 10,
    check: (c) => (c.lifetimeKills | 0) >= 100,
  },
  slayer: { id: "slayer", name: "Slayer", points: 25, check: (c) => (c.lifetimeKills | 0) >= 1000 },
  deep_diver: {
    id: "deep_diver",
    name: "Deep Diver",
    points: 15,
    check: (c) => (c.bestDepth | 0) >= 20,
  },
  ascendant: {
    id: "ascendant",
    name: "Ascendant",
    points: 20,
    check: (c) => (c.prestige | 0) >= 120,
  },
  the_permadeath: {
    id: "the_permadeath",
    name: "The Permadeath",
    points: 50,
    check: (c) => (c.prestige | 0) >= 500,
  },
  pledged: { id: "pledged", name: "Pledged", points: 5, check: (c) => !!c.faction },
  champion: {
    id: "champion",
    name: "Faction Champion",
    points: 20,
    check: (c) => c.faction && (c.factionRep?.[c.faction] | 0) >= 300,
  },
  hoarder: { id: "hoarder", name: "Hoarder", points: 15, check: (c) => (c.gold | 0) >= 100000 },
  artisan: {
    id: "artisan",
    name: "Artisan",
    points: 15,
    check: (c) => (c.economyStats?.totalSold | 0) >= 25,
  },
};
export const ACHIEVEMENT_IDS = Object.keys(ACHIEVEMENTS);

export function achievementById(id) {
  return ACHIEVEMENTS[id] || null;
}

// Returns the ids newly earned this check (not already in earned[]). Pure.
export function checkAchievements(character) {
  const earned = new Set(character.achievements?.earned || []);
  const fresh = [];
  for (const id of ACHIEVEMENT_IDS) {
    if (earned.has(id)) continue;
    try {
      if (ACHIEVEMENTS[id].check(character)) fresh.push(id);
    } catch {
      /* defensive: a malformed character never crashes the check */
    }
  }
  return fresh;
}

export function achievementScore(earnedIds) {
  let s = 0;
  for (const id of earnedIds || []) s += ACHIEVEMENTS[id]?.points || 0;
  return s;
}
