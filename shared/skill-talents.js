// SIGMA ABYSS — prestige talent trees (master design §3.3, [A1]).
//
// Each of the 8 skills gets a 3-tier tree (gates at skill 5/10/15). Each
// tier offers two mutually-exclusive talents bought with prestige. Numeric
// talents fold into derive() via talentMods(); behavioural talents (Cleave,
// guaranteed crits, …) carry a `flag` that combat.js can read later — for
// now they're identity mods so derive output is byte-identical until chosen.
//
// PURE + RNG-free (account-state only) → dual-runtime safe. talentMods()
// returns EXACT identity (×1 / +0) when no talents are selected, so derive
// stays byte-identical for every pre-talent character (the back-compat rule).

import { SKILL_IDS } from "./skills.js";

export const TALENT_TIER_GATES = [5, 10, 15]; // skill level needed per tier
export const TALENT_TIER_COST = [15, 40, 100]; // prestige to unlock
export const TALENT_RESPEC_MUL = 2; // respec costs double

// A talent: { id, name, mods, flag?, desc }. `mods` is a partial combat-sheet
// modifier (missing keys = identity). `flag` marks a behavioural talent.
function t(id, name, mods, desc, flag) {
  return { id, name, mods: mods || {}, flag: flag || null, desc };
}

// [skillId]: [ tier0:[A,B], tier1:[A,B], tier2:[A,B] ]
export const SKILL_TALENTS = {
  melee: [
    [
      t("mel_cleave", "Cleave", {}, "Hit all enemies (60% to non-primary).", "cleave"),
      t(
        "mel_precision",
        "Precision",
        { critAdd: 0.04 },
        "Every 3rd melee strike crits.",
        "precision",
      ),
    ],
    [
      t(
        "mel_juggernaut",
        "Juggernaut Stance",
        { defMul: 1.2, speedMul: 0.9 },
        "+20% defense, -10% speed.",
      ),
      t(
        "mel_frenzy",
        "Blood Frenzy",
        { atkMul: 1.08 },
        "Kills stack attack for 3 encounters.",
        "frenzy",
      ),
    ],
    [
      t("mel_titan", "Titan's Reach", {}, "Greatsword arts fire every swing.", "titan"),
      t(
        "mel_duelist",
        "Duelist's Edge",
        { atkMul: 1.1 },
        "Melee ignores 30% enemy defense.",
        "armor_pen",
      ),
    ],
  ],
  ranged: [
    [
      t(
        "rng_pierce",
        "Piercing Shot",
        { atkMul: 1.06 },
        "Shots pierce one extra target.",
        "pierce",
      ),
      t("rng_quick", "Quickdraw", { speedMul: 1.12 }, "+12% attack speed."),
    ],
    [
      t("rng_hunter", "Hunter's Mark", { critAdd: 0.05 }, "+5% crit on marked foes."),
      t("rng_volley", "Volley", { lootQtyAdd: 0.1 }, "Trash packs take splash damage.", "volley"),
    ],
    [
      t("rng_deadeye", "Deadeye", { critAdd: 0.08 }, "+8% crit, +20% crit damage."),
      t("rng_rain", "Arrow Rain", { atkMul: 1.12 }, "Boss fights gain a damage-over-time.", "dot"),
    ],
  ],
  magic: [
    [
      t("mag_focus", "Arcane Focus", { critAdd: 0.04 }, "+overload buildup."),
      t("mag_ward", "Mana Ward", { defMul: 1.12 }, "+12% defense from intellect."),
    ],
    [
      t("mag_overcharge", "Overcharge", { atkMul: 1.12, hpMul: 0.95 }, "+12% attack, -5% HP."),
      t("mag_siphon", "Spirit Siphon", { hpMul: 1.08 }, "Heal on overload procs.", "siphon"),
    ],
    [
      t(
        "mag_singularity",
        "Singularity",
        { atkMul: 1.15 },
        "Overload fires guaranteed for 2 ticks.",
        "overload_guarantee",
      ),
      t(
        "mag_eternal",
        "Eternal Flame",
        { critAdd: 0.06, dangerMul: 0.95 },
        "Burn persists between encounters.",
        "burn",
      ),
    ],
  ],
  survival: [
    [
      t("sur_tough", "Toughness", { hpMul: 1.1 }, "+10% max HP."),
      t("sur_evasive", "Evasive", { dangerMul: 0.92 }, "-8% danger accrual."),
    ],
    [
      t("sur_regen", "Regeneration", { hpMul: 1.06 }, "Heal a sliver each encounter.", "regen"),
      t("sur_forager", "Forager", { lootQtyAdd: 0.15 }, "+reagent + loot quantity."),
    ],
    [
      t(
        "sur_undying",
        "Undying",
        { hpMul: 1.15, defMul: 1.05 },
        "+15% HP, survive one lethal hit.",
        "death_save",
      ),
      t("sur_pathfinder", "Pathfinder", { dangerMul: 0.85 }, "-15% danger; deeper delves safer."),
    ],
  ],
  looting: [
    [
      t("loo_greedy", "Greedy Hands", { lootQtyAdd: 0.2 }, "+20% loot quantity."),
      t("loo_lucky", "Lucky Find", { lootRarityAdd: 0.6 }, "+loot rarity bias."),
    ],
    [
      t("loo_magnet", "Loot Magnet", { lootQtyAdd: 0.25 }, "+25% loot quantity."),
      t("loo_appraiser", "Appraiser", { lootRarityAdd: 1.0 }, "Big loot rarity bias."),
    ],
    [
      t("loo_jackpot", "Jackpot", { lootRarityAdd: 1.6 }, "Major rarity bias."),
      t("loo_hoarder", "Hoarder", { lootQtyAdd: 0.4 }, "+40% loot quantity."),
    ],
  ],
  bargaining: [
    [
      t("bar_haggler", "Haggler", {}, "NPC sell +10%.", "sell_bonus"),
      t("bar_thrift", "Thrift", {}, "Potions -20% cost.", "potion_discount"),
    ],
    [
      t("bar_broker", "Broker", {}, "Market listing fees -25%.", "fee_discount"),
      t("bar_investor", "Investor", {}, "Rest gold +30%.", "rest_bonus"),
    ],
    [
      t("bar_tycoon", "Tycoon", { lootRarityAdd: 0.4 }, "Vendor stock rarer.", "vendor_rarity"),
      t("bar_magnate", "Magnate", {}, "Faction donations +50% rep.", "donate_bonus"),
    ],
  ],
  stealth: [
    [
      t("ste_sneak", "Sneak", { dangerMul: 0.9 }, "-10% danger."),
      t("ste_ambush", "Ambush", { critAdd: 0.05 }, "First strike each encounter crits.", "ambush"),
    ],
    [
      t("ste_shadow", "Shadowstep", { speedMul: 1.1 }, "+10% speed."),
      t("ste_vanish", "Vanish", { dangerMul: 0.85 }, "Flee never takes damage.", "safe_flee"),
    ],
    [
      t("ste_assassin", "Assassin", { critAdd: 0.08, atkMul: 1.06 }, "+crit & attack from behind."),
      t(
        "ste_phantom",
        "Phantom",
        { dangerMul: 0.75 },
        "Elites ignore you 25% of the time.",
        "elite_evade",
      ),
    ],
  ],
  social: [
    [
      t("soc_charisma", "Charisma", {}, "Faction rep +20%.", "rep_bonus"),
      t("soc_intimidate", "Intimidation", { atkMul: 1.05 }, "Enemies hit -10% first encounter."),
    ],
    [
      t("soc_rally", "Rally", { atkMul: 1.08 }, "When mood>70, +15% damage.", "mood_damage"),
      t("soc_diplomat", "Diplomat", {}, "No defector penalty on faction switch.", "no_defector"),
    ],
    [
      t("soc_warcry", "War Cry", { atkMul: 1.1 }, "Once/run: +50% party damage.", "war_cry"),
      t("soc_negotiator", "Negotiator", {}, "Faction vendor -25%.", "vendor_discount"),
    ],
  ],
};

const TALENT_INDEX = (() => {
  const idx = {};
  for (const skillId of Object.keys(SKILL_TALENTS)) {
    SKILL_TALENTS[skillId].forEach((tier, ti) => {
      for (const tal of tier) idx[tal.id] = { ...tal, skillId, tier: ti };
    });
  }
  return idx;
})();

export const TALENT_IDS = Object.keys(TALENT_INDEX);

export function talentById(id) {
  return TALENT_INDEX[id] || null;
}

// A talent at tier (0/1/2) is unlockable once the skill hits its gate.
export function talentUnlocked(_skillId, tier, skillLevel) {
  return (skillLevel | 0) >= (TALENT_TIER_GATES[tier] ?? 999);
}

export function talentPrestigeCost(talentId, respec = false) {
  const t2 = talentById(talentId);
  if (!t2) return Infinity;
  const base = TALENT_TIER_COST[t2.tier] ?? 100;
  return respec ? base * TALENT_RESPEC_MUL : base;
}

const IDENTITY = Object.freeze({
  hpMul: 1,
  atkMul: 1,
  defMul: 1,
  speedMul: 1,
  critAdd: 0,
  lootRarityAdd: 0,
  lootQtyAdd: 0,
  dangerMul: 1,
});

// Aggregate the combat-sheet mods of every SELECTED talent. Returns exact
// identity when the character has none (byte-identical derive). Pure.
export function talentMods(skillTalents) {
  if (!skillTalents || typeof skillTalents !== "object") return IDENTITY;
  let any = false;
  const out = {
    hpMul: 1,
    atkMul: 1,
    defMul: 1,
    speedMul: 1,
    critAdd: 0,
    lootRarityAdd: 0,
    lootQtyAdd: 0,
    dangerMul: 1,
  };
  for (const skillId of SKILL_IDS) {
    const chosen = skillTalents[skillId];
    if (!Array.isArray(chosen)) continue;
    for (const talId of chosen) {
      if (!talId) continue;
      const tal = TALENT_INDEX[talId];
      if (!tal) continue;
      any = true;
      const m = tal.mods;
      if (m.hpMul) out.hpMul *= m.hpMul;
      if (m.atkMul) out.atkMul *= m.atkMul;
      if (m.defMul) out.defMul *= m.defMul;
      if (m.speedMul) out.speedMul *= m.speedMul;
      if (m.dangerMul) out.dangerMul *= m.dangerMul;
      if (m.critAdd) out.critAdd += m.critAdd;
      if (m.lootRarityAdd) out.lootRarityAdd += m.lootRarityAdd;
      if (m.lootQtyAdd) out.lootQtyAdd += m.lootQtyAdd;
    }
  }
  return any ? out : IDENTITY;
}

// Behavioural flags active for a character (combat.js reads these later).
export function talentFlags(skillTalents) {
  const flags = {};
  if (!skillTalents || typeof skillTalents !== "object") return flags;
  for (const skillId of SKILL_IDS) {
    const chosen = skillTalents[skillId];
    if (!Array.isArray(chosen)) continue;
    for (const talId of chosen) {
      const tal = talId && TALENT_INDEX[talId];
      if (tal?.flag) flags[tal.flag] = true;
    }
  }
  return flags;
}
