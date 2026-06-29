// SIGMA ABYSS — retention server actions (master design §M7, [A4]).
//
// Daily/weekly objective freshness + claims, bestiary collection, museum
// enshrinement, and achievement sync. All ACCOUNT-side. The premium season
// pass is out of repo scope → premiumUnlocked is hardwired false (canon C21).

import { achievementById, achievementScore, checkAchievements } from "../shared/achievements.js";
import { itemPower } from "../shared/loot.js";
import { dayIndex, rollDailies, rollWeeklies, weekIndex } from "../shared/objectives.js";

export const MUSEUM_MAX = 20;
export const PREMIUM_UNLOCKED = false; // free build — no paid season pass (canon C21)

// Pay a small reward bundle to the account. Shared by objectives + quests.
export function grantReward(character, reward) {
  if (!reward) return;
  if (reward.gold) character.gold = (character.gold | 0) + reward.gold;
  if (reward.shards) character.shards = (character.shards | 0) + reward.shards;
  if (reward.prestige) character.prestige = (character.prestige | 0) + reward.prestige;
  if (reward.questXp) character.questXp = (character.questXp | 0) + reward.questXp;
  if (reward.title && !(character.titles || []).includes(reward.title)) {
    character.titles = [...(character.titles || []), reward.title];
  }
}

// Reroll the daily board when the UTC day rolls over; ensure weeklies exist.
export function ensureFreshObjectives(character, now) {
  let reset = false;
  const di = dayIndex(now);
  if (character.dailyDayIndex !== di || !Array.isArray(character.dailyObjectives)) {
    character.dailyObjectives = rollDailies(now);
    character.dailyDayIndex = di;
    reset = true;
  }
  const wi = weekIndex(now);
  if (character.weeklyWeekIndex !== wi || !Array.isArray(character.weeklyBounties)) {
    character.weeklyBounties = rollWeeklies(now);
    character.weeklyWeekIndex = wi;
  }
  return reset;
}

// Claim a completed daily objective; pays its reward once.
export function claimObjective(character, objId) {
  const list = character.dailyObjectives || [];
  const o = list.find((x) => x.id === objId);
  if (!o) return { ok: false, error: "no_such_objective" };
  if (o.claimed) return { ok: false, error: "already_claimed" };
  if (o.progress < o.target)
    return { ok: false, error: "incomplete", progress: o.progress, target: o.target };
  o.claimed = true;
  grantReward(character, o.reward);
  return { ok: true, reward: o.reward };
}

// Record a kill in the lifetime bestiary collection.
export function creditBestiary(character, enemyId, n = 1) {
  if (!enemyId) return;
  if (!character.bestiary || typeof character.bestiary !== "object")
    character.bestiary = { kills: {}, firstKilledAt: {} };
  character.bestiary.kills[enemyId] = (character.bestiary.kills[enemyId] || 0) + n;
}

// Enshrine the best item from a dying run into the museum (before run reset).
// Called by the server death wrapper (canon C19 — keeps resolveDeath pure).
export function autoMuseumEnshrined(character, deadRun) {
  if (!deadRun) return null;
  const candidates = [...Object.values(deadRun.gear || {}), ...(deadRun.inventory || [])].filter(
    Boolean,
  );
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const it of candidates) if ((itemPower(it) | 0) > (itemPower(best) | 0)) best = it;
  if (!Array.isArray(character.museum)) character.museum = [];
  const entry = {
    name: best.name,
    rarity: best.rarity,
    power: itemPower(best) | 0,
    at: deadRun.startedAt || 0,
  };
  // Keep the top-MUSEUM_MAX by power.
  character.museum.push(entry);
  character.museum.sort((a, b) => (b.power | 0) - (a.power | 0));
  if (character.museum.length > MUSEUM_MAX)
    character.museum = character.museum.slice(0, MUSEUM_MAX);
  return entry;
}

// Sync achievements: newly-earned ids are recorded + the score recomputed.
export function syncAchievements(character) {
  if (!character.achievements || typeof character.achievements !== "object") {
    character.achievements = { earned: [], score: 0 };
  }
  const fresh = checkAchievements(character);
  if (fresh.length) {
    character.achievements.earned = [...character.achievements.earned, ...fresh];
    character.achievements.score = achievementScore(character.achievements.earned);
  }
  return fresh.map((id) => achievementById(id));
}
