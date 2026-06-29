// SIGMA ABYSS — procedural quests (master design §3.4 / 03-narrative.md, [A3]+[A7]).
//
// ONE unified quest system (canon §3.4 merges [A3] trait/backstory/world quests
// and [A7] NPC questlines). Quests are ACCOUNT-side (survive permadeath). Quest
// GENERATION is deterministic (seeded from character.seed); ADVANCEMENT is
// server-driven by the actions the player already takes. PURE ESM, dual-runtime.

import { makeRng, mixSeed } from "./rng.js";

export const QUEST_MAX_ACTIVE = 20;

// Templates. `gate` decides eligibility from account state; objectives are
// anchored to existing actions (kills, depth, gold, bosses). reward is paid on
// completion. A null gate = always eligible (starter chain everyone can run).
export const QUEST_TEMPLATES = {
  first_blood: {
    id: "first_blood",
    name: "First Blood",
    blurb: "Cut your teeth — 25 kills in the Abyss.",
    gate: null,
    objectives: [{ kind: "kill", target: 25 }],
    reward: { gold: 150, prestige: 2, questXp: 60 },
  },
  deeper: {
    id: "deeper",
    name: "Go Deeper",
    blurb: "Push to depth 6 in any danger zone.",
    gate: null,
    objectives: [{ kind: "reach_depth", target: 6 }],
    reward: { gold: 200, prestige: 3, questXp: 80 },
  },
  bloodthirst_trial: {
    id: "bloodthirst_trial",
    name: "The Bloodthirst Trial",
    blurb: "Prove the lust — slay 40 elites.",
    gate: { trait: "bloodlust" },
    objectives: [{ kind: "elite_kill", target: 40 }],
    reward: { gold: 500, prestige: 8, title: "Bloodthirsty", questXp: 200 },
  },
  iron_will: {
    id: "iron_will",
    name: "Iron Will",
    blurb: "Tough it out — survive 8 boss fights.",
    gate: { trait: "tough" },
    objectives: [{ kind: "boss_kill", target: 8 }],
    reward: { gold: 400, prestige: 10, title: "Unbroken", questXp: 250 },
  },
  fortune_seeker: {
    id: "fortune_seeker",
    name: "Fortune Seeker",
    blurb: "Bank 4000 gold across your runs.",
    gate: { trait: "greedy" },
    objectives: [{ kind: "gold_banked", target: 4000 }],
    reward: { gold: 800, prestige: 12, title: "Gilded", questXp: 350 },
  },
  faithful: {
    id: "faithful",
    name: "The Faithful",
    blurb: "Pledge a faction and reach Champion (rep 300).",
    gate: { faction: true },
    objectives: [{ kind: "faction_rep", target: 300 }],
    reward: { gold: 600, prestige: 9, questXp: 220 },
  },
};
export const QUEST_TEMPLATE_IDS = Object.keys(QUEST_TEMPLATES);

export function questTemplateById(id) {
  return QUEST_TEMPLATES[id] || null;
}

// Quest XP → quest level (gentle curve; level is a prestige-y collection stat).
export function questLevelForXp(xp) {
  return Math.max(0, Math.min(50, Math.floor(Math.sqrt(Math.max(0, xp) / 100))));
}

function eligible(template, character) {
  const g = template.gate;
  if (!g) return true;
  if (g.trait && !(character.traits || []).includes(g.trait)) return false;
  if (g.faction && !character.faction) return false;
  return true;
}

// Deterministically pick up to `max` eligible templates the character isn't
// already running. Seeded from character.seed so the same sigma rolls the same
// quest board (until ones complete and free slots).
export function generateQuests(character, max = 3) {
  const rng = makeRng(
    mixSeed((character.seed || 1) >>> 0, (character.quests?.length || 0) >>> 0) || 1,
  );
  const have = new Set((character.quests || []).map((q) => q.templateId));
  const pool = QUEST_TEMPLATE_IDS.filter(
    (id) => eligible(QUEST_TEMPLATES[id], character) && !have.has(id),
  );
  const out = [];
  while (pool.length && out.length < max) {
    const idx = rng.int(0, pool.length - 1);
    const id = pool.splice(idx, 1)[0];
    out.push(makeQuestInstance(QUEST_TEMPLATES[id]));
  }
  return out;
}

function makeQuestInstance(template) {
  return {
    templateId: template.id,
    name: template.name,
    objectives: template.objectives.map((o) => ({ kind: o.kind, target: o.target, progress: 0 })),
    status: "active",
    startedAt: 0,
  };
}

// Ensure a character has an active quest board (called on first touch + when
// slots free). Mutates character.quests. Returns the freshly added instances.
export function ensureQuests(character) {
  if (!Array.isArray(character.quests)) character.quests = [];
  const active = character.quests.filter((q) => q.status === "active");
  if (active.length >= 3) return [];
  const fresh = generateQuests(character, 3 - active.length);
  character.quests.push(...fresh);
  if (character.quests.length > QUEST_MAX_ACTIVE) {
    character.quests = character.quests.slice(-QUEST_MAX_ACTIVE);
  }
  return fresh;
}

// Advance every active quest objective of `kind` by `amount` (or to an absolute
// value for "reach_*"/"*_rep" kinds). Returns the list of quests that just
// completed (caller pays the reward + emits the feed line). Pure mutation.
export function advanceQuest(character, kind, value) {
  if (!Array.isArray(character.quests)) return [];
  const ABSOLUTE = new Set(["reach_depth", "faction_rep", "gold_banked"]);
  const completed = [];
  for (const q of character.quests) {
    if (q.status !== "active") continue;
    let allDone = true;
    for (const o of q.objectives) {
      if (o.kind === kind) {
        o.progress = ABSOLUTE.has(kind) ? Math.max(o.progress, value) : o.progress + value;
      }
      if (o.progress < o.target) allDone = false;
    }
    if (allDone) {
      q.status = "completed";
      completed.push(q);
    }
  }
  return completed;
}

// Apply a completed quest's reward to the account. Returns the reward summary.
export function grantQuestReward(character, quest) {
  const t = QUEST_TEMPLATES[quest.templateId];
  if (!t) return null;
  const r = t.reward || {};
  if (r.gold) character.gold = (character.gold | 0) + r.gold;
  if (r.prestige) character.prestige = (character.prestige | 0) + r.prestige;
  if (r.questXp) {
    character.questXp = (character.questXp | 0) + r.questXp;
    character.questLevel = questLevelForXp(character.questXp);
  }
  if (r.title && !(character.titles || []).includes(r.title)) {
    character.titles = [...(character.titles || []), r.title];
  }
  if (r.cosmetic && !(character.cosmeticsUnlocked || []).includes(r.cosmetic)) {
    character.cosmeticsUnlocked = [...(character.cosmeticsUnlocked || []), r.cosmetic];
  }
  return { ...r, questName: t.name };
}
