// SIGMA ABYSS — crafting (master design §3.5 / 01-systems.md, [A1]).
//
// Reagents drop from kills (one per zone), are spent with gold + faction rank
// to forge faction-exclusive gear. executeCraft threads the RUN's rng so it
// stays deterministic + offline-sim-safe (master §4.2): the caller restores
// run.rngState into the rng, crafts, and saves rng.state back. PURE ESM,
// no Math.random, no Node built-ins.

import { factionById, factionRank } from "./factions.js";
import { itemPower, makeItem, sellValue } from "./loot.js";

// One reagent per danger zone (master §3.5).
export const ZONE_REAGENT = {
  goblin_warrens: "goblin_ear",
  cursed_forest: "cursed_bark",
  infernal_highway: "chrome_shard",
  demon_catacombs: "void_crystal",
  abyss_ruins: "abyssal_core",
};
export const REAGENT_NAME = {
  goblin_ear: "Goblin Ear",
  cursed_bark: "Cursed Bark",
  chrome_shard: "Chrome Shard",
  void_crystal: "Void Crystal",
  abyssal_core: "Abyssal Core",
};
export const REAGENT_CODES = Object.keys(REAGENT_NAME);

export const REAGENT_HOME_CHANCE = 0.08; // per killing-encounter in your faction home zone
export const REAGENT_AWAY_CHANCE = 0.02; // elsewhere

// Faction-exclusive recipes. `out` = forged item template.
export const RECIPES = {
  iron_barrier: {
    id: "iron_barrier",
    name: "Iron Barrier",
    faction: "iron_veil",
    rank: 1,
    gold: 200,
    reagents: { goblin_ear: 3, cursed_bark: 2 },
    out: { slot: "armor", rarity: "epic", setId: "iron_veil_panoply" },
  },
  blood_oath_blade: {
    id: "blood_oath_blade",
    name: "Blood Oath Blade",
    faction: "crimson_pact",
    rank: 2,
    gold: 500,
    reagents: { cursed_bark: 5, void_crystal: 1 },
    out: { slot: "weapon", rarity: "legendary", effect: "berserk", setId: "crimson_covenant" },
  },
  void_staff: {
    id: "void_staff",
    name: "Void Staff",
    faction: "void_order",
    rank: 2,
    gold: 800,
    reagents: { chrome_shard: 4, void_crystal: 2 },
    out: { slot: "weapon", rarity: "legendary", effect: "executioner", setId: "void_codex" },
  },
  midas_ring: {
    id: "midas_ring",
    name: "Midas Ring",
    faction: "ember_court",
    rank: 3,
    gold: 2000,
    reagents: { abyssal_core: 6 },
    out: { slot: "ring", rarity: "mythic", effect: "midas", setId: "ember_treasury" },
  },
};
export const RECIPE_IDS = Object.keys(RECIPES);

export function recipeById(id) {
  return RECIPES[id] || null;
}

// Does a kill in `zoneId` yield a reagent this encounter? Faster in your
// faction's home zone. Deterministic — draws ONE value from the run rng.
export function reagentDrop(zoneId, factionId, rng) {
  const code = ZONE_REAGENT[zoneId];
  if (!code) return null;
  const f = factionById(factionId);
  const chance = f && f.homeZone === zoneId ? REAGENT_HOME_CHANCE : REAGENT_AWAY_CHANCE;
  if (!rng.chance(chance)) return null;
  return { code, name: REAGENT_NAME[code], zone: zoneId };
}

export function canCraft(_run, character, recipeId) {
  const r = RECIPES[recipeId];
  if (!r) return { ok: false, error: "no_such_recipe" };
  if (character.faction !== r.faction) {
    return {
      ok: false,
      error: "wrong_faction",
      need: r.faction,
      needName: factionById(r.faction)?.name,
    };
  }
  const rep = character.factionRep?.[r.faction] || 0;
  if (factionRank(rep) < r.rank) return { ok: false, error: "rank_too_low", needRank: r.rank };
  const reagents = character.reagents || {};
  for (const code of Object.keys(r.reagents)) {
    if ((reagents[code] || 0) < r.reagents[code]) {
      return {
        ok: false,
        error: "missing_reagents",
        code,
        need: r.reagents[code],
        have: reagents[code] || 0,
      };
    }
  }
  if ((character.gold | 0) < r.gold) return { ok: false, error: "insufficient_gold", need: r.gold };
  return { ok: true, recipe: r };
}

// Forge the item. Caller has already restored run.rngState into `rng` and
// will save rng.state back afterward (keeps the deterministic stream intact).
export function executeCraft(run, character, recipeId, rng) {
  const check = canCraft(run, character, recipeId);
  if (!check.ok) return check;
  const r = check.recipe;
  if (!character.reagents) character.reagents = {};
  for (const code of Object.keys(r.reagents)) character.reagents[code] -= r.reagents[code];
  character.gold -= r.gold;

  const ilvl = Math.max(1, (run?.level || character.highestLevel || 1) + 2);
  const item = makeItem({ slot: r.out.slot, rarity: r.out.rarity, ilvl, rng });
  item.bound = "account"; // crafted items are account-bound (master §3.6)
  if (r.out.effect) item.effect = r.out.effect;
  if (r.out.setId) item.setId = r.out.setId;
  item.crafted = true;
  // Recompute the derived numbers now that we've stamped effect/set.
  item.power = itemPower(item);
  item.value = sellValue(item);
  return { ok: true, item, recipe: r.id };
}
