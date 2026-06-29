// SIGMA ABYSS — crafting / talents / scars server actions (master §M3).
//
// Server-side handlers for the M3 progression surface. Crafting threads the
// RUN's rng (restore → craft → save state) so it stays deterministic +
// offline-sim-safe (master §4.2). Talents + scars are pure account-state
// mutations. Each handler takes a ctx {login, token, character, store, body,
// now} and returns a small result the HTTP endpoint / chat reply echoes.

import { INVENTORY_MAX } from "../shared/constants.js";
import { canCraft, executeCraft, RECIPES } from "../shared/crafting.js";
import { factionRank } from "../shared/factions.js";
import { sellValue } from "../shared/loot.js";
import { makeRng } from "../shared/rng.js";
import {
  SKILL_TALENTS,
  TALENT_TIER_GATES,
  talentById,
  talentPrestigeCost,
  talentUnlocked,
} from "../shared/skill-talents.js";

function summarize(item) {
  if (!item) return null;
  return {
    name: item.name,
    slot: item.slot,
    rarity: item.rarity,
    power: item.power | 0,
    effect: item.effect || null,
    bound: item.bound,
    setId: item.setId || null,
  };
}

// Place a freshly-forged item: inventory → vault → auto-sell (gold) if both full.
function placeItem(character, item) {
  if (!Array.isArray(character.run.inventory)) character.run.inventory = [];
  if (character.run.inventory.length < INVENTORY_MAX) {
    character.run.inventory.push(item);
    return "inventory";
  }
  if (!Array.isArray(character.vault)) character.vault = [];
  if (character.vault.length < (character.vaultCapacity || 20)) {
    character.vault.push(item);
    return "vault";
  }
  character.gold = (character.gold | 0) + sellValue(item);
  return "autosold";
}

// ── Craft ───────────────────────────────────────────────────────────
export function craft(ctx) {
  const { token, character, store } = ctx;
  const recipeId = String(ctx.body?.recipe_id || ctx.body?.recipe || "");
  // Restore the run rng, forge, save the advanced state back (deterministic).
  const rng = makeRng((character.run?.rngState || character.run?.rngSeed || 1) >>> 0);
  const res = executeCraft(character.run, character, recipeId, rng);
  if (character.run) character.run.rngState = rng.state;
  if (!res.ok) {
    store.putPlayer(token, character);
    return res;
  }
  const where = placeItem(character, res.item);
  store.putPlayer(token, character);
  store.pushFeed?.({
    kind: "milestone",
    login: ctx.login,
    name: character.name,
    detail: `forged ${res.item.name} (${res.item.rarity})`,
  });
  return {
    ok: true,
    item: summarize(res.item),
    recipe: res.recipe,
    placed: where,
    gold: character.gold,
  };
}

export function recipesView(ctx) {
  const { character } = ctx;
  const recipes = Object.values(RECIPES).map((r) => ({
    id: r.id,
    name: r.name,
    faction: r.faction,
    rank: r.rank,
    gold: r.gold,
    reagents: r.reagents,
    craftable: canCraft(character.run, character, r.id).ok,
  }));
  return { ok: true, recipes };
}

// ── Talents ─────────────────────────────────────────────────────────
export function talentsView(ctx) {
  const { character } = ctx;
  const out = {};
  for (const skillId of Object.keys(SKILL_TALENTS)) {
    const lvl = character.skills?.[skillId]?.level || 0;
    out[skillId] = {
      level: lvl,
      chosen: character.skillTalents?.[skillId] || [null, null, null],
      tiers: SKILL_TALENTS[skillId].map((tier, ti) => ({
        unlocked: talentUnlocked(skillId, ti, lvl),
        gate: TALENT_TIER_GATES[ti],
        options: tier.map((t) => ({
          id: t.id,
          name: t.name,
          desc: t.desc,
          cost: talentPrestigeCost(t.id),
        })),
      })),
    };
  }
  return { ok: true, talents: out, prestige: character.prestige | 0 };
}

export function talentUnlock(ctx) {
  const { token, character, store } = ctx;
  const skillId = String(ctx.body?.skill_id || "");
  const tier = Number(ctx.body?.tier);
  const talentId = String(ctx.body?.talent_id || "");
  const tal = talentById(talentId);
  if (!tal || tal.skillId !== skillId || tal.tier !== tier)
    return { ok: false, error: "bad_talent" };
  const skillLevel = character.skills?.[skillId]?.level || 0;
  if (!talentUnlocked(skillId, tier, skillLevel)) {
    return { ok: false, error: "skill_too_low", needLevel: TALENT_TIER_GATES[tier] };
  }
  const existing = character.skillTalents?.[skillId]?.[tier] || null;
  if (existing === talentId) return { ok: false, error: "already_unlocked" };
  const respec = !!existing;
  const cost = talentPrestigeCost(talentId, respec);
  if ((character.prestige | 0) < cost)
    return { ok: false, error: "insufficient_prestige", need: cost };
  character.prestige -= cost;
  if (!character.skillTalents || typeof character.skillTalents !== "object")
    character.skillTalents = {};
  if (!Array.isArray(character.skillTalents[skillId]))
    character.skillTalents[skillId] = [null, null, null];
  character.skillTalents[skillId][tier] = talentId;
  store.putPlayer(token, character);
  return {
    ok: true,
    talent: talentId,
    skillId,
    tier,
    respec,
    prestigeSpent: cost,
    prestige: character.prestige,
  };
}

export function talentRespec(ctx) {
  const { token, character, store } = ctx;
  const skillId = String(ctx.body?.skill_id || "");
  const tier = Number(ctx.body?.tier);
  const existing = character.skillTalents?.[skillId]?.[tier] || null;
  if (!existing) return { ok: false, error: "nothing_to_respec" };
  character.skillTalents[skillId][tier] = null;
  store.putPlayer(token, character);
  return { ok: true, cleared: existing, skillId, tier };
}

// ── Scar cleanse (Fear & Hunger relief) ─────────────────────────────
export function scarCleanse(ctx) {
  const { token, character, store } = ctx;
  if (!character.scars?.length) return { ok: false, error: "no_scars" };
  const ironRank =
    character.faction === "iron_veil" ? factionRank(character.factionRep?.iron_veil || 0) : 0;
  const byRank = ironRank >= 3;
  const byGold = (character.gold | 0) >= 500;
  if (!byRank && !byGold)
    return { ok: false, error: "cannot_cleanse", need: "Iron Veil rank 3 or 500 gold" };
  if (!byRank) character.gold -= 500;
  const removed = character.scars.shift();
  store.putPlayer(token, character);
  store.pushFeed?.({
    kind: "scar_cleansed",
    login: ctx.login,
    name: character.name,
    detail: `cleansed a ${removed?.stat} scar`,
  });
  return { ok: true, removed, scarsLeft: character.scars.length, viaGold: !byRank };
}
