// SIGMA ABYSS — faction item sets (master design §3.6, [A1]).
//
// Each faction has one signature set dropped from its boss zone. Equipping 2
// or 4 pieces (matched by item.setId) activates stacking bonuses folded into
// derive() via setModsForBonuses(equippedSetBonuses(gear)). PURE + RNG-free.
// Returns EXACT identity when no set is active → byte-identical derive.

export const ITEM_SETS = {
  iron_veil_panoply: {
    id: "iron_veil_panoply",
    name: "Iron Veil Panoply",
    factionId: "iron_veil",
    pieces: ["armor", "ring", "relic", "charm"],
    bonuses: {
      2: { mods: { defMul: 1.1 }, desc: "+10% defense" },
      4: {
        mods: { defMul: 1.18, hpMul: 1.1 },
        desc: "Bulwark — heavy defense + HP",
        flag: "set_block",
      },
    },
  },
  crimson_covenant: {
    id: "crimson_covenant",
    name: "Crimson Covenant",
    factionId: "crimson_pact",
    pieces: ["weapon", "armor", "ring", "charm"],
    bonuses: {
      2: { mods: { hpMul: 1.05 }, desc: "Kills heal 3% max HP", flag: "set_lifesteal" },
      4: { mods: { atkMul: 1.2 }, desc: "Blood Oath fires every swing", flag: "set_bloodoath" },
    },
  },
  void_codex: {
    id: "void_codex",
    name: "Void Codex",
    factionId: "void_order",
    pieces: ["weapon", "ring", "relic", "charm"],
    bonuses: {
      2: { mods: { critAdd: 0.05 }, desc: "+15% overload" },
      4: { mods: { atkMul: 1.12, critAdd: 0.08 }, desc: "Void Rupture 2× proc", flag: "set_void" },
    },
  },
  ember_treasury: {
    id: "ember_treasury",
    name: "Ember Treasury",
    factionId: "ember_court",
    pieces: ["weapon", "armor", "ring", "relic", "charm"],
    bonuses: {
      2: {
        mods: { lootQtyAdd: 0.15, lootRarityAdd: 0.5 },
        desc: "Midas always active",
        flag: "set_midas",
      },
      4: { mods: { lootRarityAdd: 1.2 }, desc: "Double gold from bosses", flag: "set_bossgold" },
    },
  },
  abyss_fracture: {
    id: "abyss_fracture",
    name: "Abyss Fracture",
    factionId: "abyssal_convergence",
    pieces: ["weapon", "armor", "relic"],
    bonuses: {
      2: { mods: { critAdd: 0.2 }, desc: "+20% crit" },
      // 3-piece (this set only has 3 pieces) treated as the capstone.
      3: {
        mods: { critAdd: 0.25, atkMul: 1.1 },
        desc: "5% on-kill encounter clear",
        flag: "set_fracture",
      },
    },
  },
};

export const SET_IDS = Object.keys(ITEM_SETS);

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

// Active set-bonus ids from current gear, e.g. ["iron_veil_panoply:2"].
// A bonus tier fires when the equipped piece count reaches its threshold.
export function equippedSetBonuses(gear) {
  if (!gear || typeof gear !== "object") return [];
  const counts = {};
  for (const slot of Object.keys(gear)) {
    const item = gear[slot];
    if (item?.setId && ITEM_SETS[item.setId]) {
      counts[item.setId] = (counts[item.setId] || 0) + 1;
    }
  }
  const out = [];
  for (const setId of Object.keys(counts)) {
    const n = counts[setId];
    for (const threshold of Object.keys(ITEM_SETS[setId].bonuses)) {
      if (n >= Number(threshold)) out.push(`${setId}:${threshold}`);
    }
  }
  return out;
}

// Combined combat-sheet mods for a list of active bonus ids. Identity when
// the list is empty. Pure.
export function setModsForBonuses(bonusIds) {
  if (!Array.isArray(bonusIds) || bonusIds.length === 0) return IDENTITY;
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
  let any = false;
  for (const bid of bonusIds) {
    const [setId, threshold] = String(bid).split(":");
    const bonus = ITEM_SETS[setId]?.bonuses?.[threshold];
    if (!bonus) continue;
    any = true;
    const m = bonus.mods || {};
    if (m.hpMul) out.hpMul *= m.hpMul;
    if (m.atkMul) out.atkMul *= m.atkMul;
    if (m.defMul) out.defMul *= m.defMul;
    if (m.speedMul) out.speedMul *= m.speedMul;
    if (m.dangerMul) out.dangerMul *= m.dangerMul;
    if (m.critAdd) out.critAdd += m.critAdd;
    if (m.lootRarityAdd) out.lootRarityAdd += m.lootRarityAdd;
    if (m.lootQtyAdd) out.lootQtyAdd += m.lootQtyAdd;
  }
  return any ? out : IDENTITY;
}

// Behavioural set flags (combat.js reads later).
export function setFlags(bonusIds) {
  const flags = {};
  if (!Array.isArray(bonusIds)) return flags;
  for (const bid of bonusIds) {
    const [setId, threshold] = String(bid).split(":");
    const f = ITEM_SETS[setId]?.bonuses?.[threshold]?.flag;
    if (f) flags[f] = true;
  }
  return flags;
}
