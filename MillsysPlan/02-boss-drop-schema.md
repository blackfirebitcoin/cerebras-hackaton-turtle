# Phase 2: Boss Drop Schema & Validation

## Goal
Pure ESM schema + validator for boss drops in `shared/boss-drops.js`. Used by:
- `server/boss-drop-enricher.js` (validation after LLM generation)
- `server/server.js` (fallback re-validation on load)

## Files to Create

### New: `shared/boss-drops.js`
```js
// SIGMA ABYSS — boss drop schema & validation
// Dual-runtime pure ESM. Zero network/Date/Math.random.

import { RARITIES, RARITY_RANK, EFFECT_IDS, ITEM_BASES } from "./constants.js";
import { AFFIX_POOL } from "./loot.js";

// 1. Canonical schema
export const BOSS_DROP_SCHEMA = {
  baseType: { type: "string", enum: Object.keys(ITEM_BASES) },
  rarity: { type: "string", enum: RARITIES },
  ilvl: { type: "integer", minimum: 1, maximum: 99999 },
  affixes: {
    type: "array",
    items: {
      stat: { type: "string" },
      value: { type: "number" },
      kind: { type: "string", enum: ["prefix", "suffix"] },
      pct: { type: "boolean" }
    },
    maxItems: 6
  },
  effect: { type: ["string", "null"], enum: [...EFFECT_IDS, null] },
  name: { type: "string", maxLength: 60 },
  flavor: { type: "string", maxLength: 120 },
  source: { type: "string", enum: ["deterministic", "gemma"] }
};

// 2. Mod-pool clamping (matches forgeRaidDrop bands)
export function clampAffixValue(stat, ilvl, value) {
  const pool = AFFIX_POOL.find(a => a.stat === stat);
  if (!pool) return 0;
  const max = pool.base + pool.per * ilvl * 1.0; // qualityFloor = 1.0
  return Math.max(pool.base, Math.min(max, value));
}

function clampAffixes(affixes, ilvl) {
  return affixes.map(a => ({
    ...a,
    value: clampAffixValue(a.stat, ilvl, a.value)
  })).filter(a => a.value > 0);
}

// 3. Validator — drops invalid affixes, clamps values, never throws
export function validateBossDrop(drop) {
  const errors = [];
  
  // baseType
  const base = ITEM_BASES[drop.baseType];
  if (!base) errors.push(`unknown baseType: ${drop.baseType}`);
  
  // rarity
  if (!RARITIES.includes(drop.rarity)) errors.push(`invalid rarity: ${drop.rarity}`);
  
  // ilvl
  const ilvl = Math.max(1, Math.min(99999, Math.trunc(drop.ilvl) || 1));
  
  // affixes
  let affixes = Array.isArray(drop.affixes) ? drop.affixes : [];
  affixes = affixes.slice(0, 6);
  const validStats = new Set(AFFIX_POOL.map(a => a.stat));
  affixes = affixes.filter(a => validStats.has(a.stat) && ["prefix", "suffix"].includes(a.kind));
  affixes = clampAffixes(affixes, ilvl);
  
  // effect
  let effect = drop.effect;
  if (effect && !EFFECT_IDS.includes(effect)) effect = null;
  
  // name/flavor
  const name = String(drop.name || "").slice(0, 60);
  const flavor = drop.flavor ? String(drop.flavor).slice(0, 120) : null;
  
  const cleaned = {
    baseType: base ? drop.baseType : "vaal_axe",
    rarity: RARITIES.includes(drop.rarity) ? drop.rarity : "mythic",
    ilvl,
    affixes,
    effect,
    name: name || `${base?.name || "Vaal Axe"} of the Fallen`,
    flavor,
    source: drop.source || "deterministic"
  };
  
  return { ok: errors.length === 0, drop: cleaned, errors };
}

// 4. Deterministic fallback (RAID_BOSS_DROPS format → schema)
export function fallbackDrop(bossId, killerLevel = 1) {
  // Import from loot.js to avoid circular dep
  const { RAID_BOSS_DROPS, forgeRaidDrop } = require("./loot.js");
  const item = forgeRaidDrop(bossId, killerLevel);
  if (!item) return null;
  
  return {
    baseType: item.base.toLowerCase().replace(/ /g, "_"),
    rarity: item.rarity,
    ilvl: item.ilvl,
    affixes: item.affixes,
    effect: item.effect,
    name: item.name,
    flavor: item.flavor,
    source: "deterministic"
  };
}
```

## Key Principles
- **Drops bad affixes** rather than rejecting entire drop (same as `vNpcProposals`)
- **Clamps to mod-pool bands** — no power exploits via LLM
- **Fails closed** — any validation error → deterministic fallback
- **Pure** — no side effects, no network, deterministic