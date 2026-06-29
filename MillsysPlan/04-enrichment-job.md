# Phase 4: Off-Tick Boss Drop Enrichment

## Goal
Async enrichment job in `server/boss-drop-enricher.js` that runs after `endRaid()` awards deterministic drop.

## Files to Create

### New: `server/boss-drop-enricher.js`
```js
// SIGMA ABYSS — boss drop enrichment job
// Runs OFF the raid resolution tick. Cache-first, fallback-safe.

import { chat } from "./llm.js";
import { validateBossDrop, fallbackDrop } from "../shared/boss-drops.js";
import { RAID_BOSS_DROPS } from "../shared/loot.js";
import { makeRng } from "../shared/rng.js";

// Cache: Map<`${bossId}|${class}|${tier}`, { drop, generatedAt, useCount }>
const enrichmentCache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 200;

const TIER_MAP = {
  common: "normal", uncommon: "normal", rare: "rare",
  epic: "rare", legendary: "legendary", mythic: "legendary+", oneofone: "legendary+"
};

const PROMPT = `Generate a Path of Exile style boss drop as JSON.
Boss: {bossName} ({bossId})
Lore: {bossLore}
Zone: {zoneName} (tier {zoneTier})
Killer: level {killerLevel}, class {killerClass}, build {killerBuild}
Recent drops to avoid: {recentDrops}

Output ONLY valid JSON:
{
  "baseType": "vaal_axe",
  "rarity": "legendary",
  "ilvl": 75,
  "affixes": [
    {"stat":"physical_dmg_pct","value":156,"kind":"prefix","pct":false},
    {"stat":"attack_speed_pct","value":22,"kind":"suffix","pct":true}
  ],
  "effect": "executioner",
  "name": "Soulrender's Vaal Axe",
  "flavor": "Forged in the warrens' deepest heat."
}`;

export async function enrichBossDrop(deterministicDrop, context) {
  const cacheKey = buildCacheKey(context);
  const cached = enrichmentCache.get(cacheKey);
  
  if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
    cached.useCount++;
    return { ...cached.drop, source: "gemma", enriched: true, cached: true };
  }

  try {
    const prompt = buildPrompt(context);
    const raw = await chat([{ role: "user", content: prompt }], { 
      temp: 0.8, 
      maxTokens: 1500 
    });
    
    const validation = validateBossDrop(raw);
    if (!validation.ok) throw new Error(validation.errors.join(", "));
    
    const drop = { ...validation.drop, source: "gemma" };
    
    // Update cache
    if (enrichmentCache.size >= MAX_CACHE_SIZE) {
      evictOldest();
    }
    enrichmentCache.set(cacheKey, { drop, generatedAt: Date.now(), useCount: 1 });
    
    return { ...drop, enriched: true };
  } catch (e) {
    // Hard fallback — deterministic drop unchanged
    const fb = fallbackDrop(context.bossId, context.killerLevel);
    return { ...fb, source: "deterministic", enrichmentError: e.message };
  }
}

function buildCacheKey(ctx) {
  const tier = TIER_MAP[ctx.rarity] || "rare";
  return `${ctx.bossId}|${ctx.killerClass}|${tier}`;
}

function buildPrompt(ctx) {
  return PROMPT
    .replace("{bossName}", ctx.bossName || ctx.bossId)
    .replace("{bossId}", ctx.bossId)
    .replace("{bossLore}", ctx.bossLore || RAID_BOSS_DROPS[ctx.bossId]?.flavor || "")
    .replace("{zoneName}", ctx.zoneName || "Unknown Zone")
    .replace("{zoneTier}", ctx.zoneTier || 1)
    .replace("{killerLevel}", ctx.killerLevel || 1)
    .replace("{killerClass}", ctx.killerClass || "unknown")
    .replace("{killerBuild}", ctx.killerBuild || "A")
    .replace("{recentDrops}", JSON.stringify(ctx.recentDrops || []));
}

function evictOldest() {
  let oldest = null, oldestKey = null;
  for (const [key, val] of enrichmentCache) {
    if (!oldest || val.generatedAt < oldest) {
      oldest = val.generatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) enrichmentCache.delete(oldestKey);
}

// Called by server.js on startup to warm cache for active bosses
export async function warmCache(bossIds, defaultContext) {
  for (const bossId of bossIds) {
    const ctx = { ...defaultContext, bossId };
    // Pre-generate for each class/tier combo? Or on-demand only.
  }
}

export function getCacheStats() {
  return {
    size: enrichmentCache.size,
    entries: Array.from(enrichmentCache.entries()).map(([k, v]) => ({
      key: k,
      generatedAt: new Date(v.generatedAt).toISOString(),
      useCount: v.useCount
    }))
  };
}
```

## Integration Point: `server/server.js` — `endRaid()`

```js
// In endRaid() — AFTER placing deterministic drop:
import { enrichBossDrop } from "./boss-drop-enricher.js";

// 1. Award deterministic drop INSTANTLY (existing code)
const baseDrop = forgeRaidDrop(raid.boss_id, lvl);
placeItem(lastHitCharacter, baseDrop);

// 2. Fire-and-forget enrichment (non-blocking)
const zone = ZONE_BY_ID[raid.bossZone] || {};
enrichBossDrop(baseDrop, {
  bossId: raid.boss_id,
  bossName: RAID_BOSS_DROPS[raid.boss_id]?.name || raid.boss_id,
  bossLore: RAID_BOSS_DROPS[raid.boss_id]?.flavor || "",
  zoneName: zone.name || raid.bossZone,
  zoneTier: zone.tier || 1,
  killerLevel: lvl,
  killerClass: lastHitCharacter.run?.gear?.weapon?.family || "unknown",
  killerBuild: lastHitCharacter.activeSet || "A",
  recentDrops: getRecentBossDrops(raid.boss_id, 5)
}).then(enriched => {
  if (enriched.enriched && enriched.source === "gemma") {
    swapDrop(lastHitCharacter, baseDrop.id, enriched);
    store.pushFeed?.({ 
      kind: "boss_enriched", 
      detail: `${enriched.name} awakened with new power.` 
    });
  }
}).catch(() => {}); // Silent — base drop already awarded
```

## Swap Logic
```js
function swapDrop(character, oldId, newDrop) {
  const inv = character.run?.inventory;
  if (!Array.isArray(inv)) return;
  
  const idx = inv.findIndex(i => i.id === oldId);
  if (idx === -1) return; // Already moved/vaulted/sold
  
  // Build full item from enriched schema
  const fullItem = buildItemFromSchema(newDrop, inv[idx]);
  inv[idx] = fullItem;
}
```

## Cache Behavior
- **Key**: `bossId|killerClass|tier` (e.g., `goblin_king|axe|legendary+`)
- **TTL**: 7 days
- **Max entries**: 200 (evicts oldest)
- **Hit**: Returns cached instantly, no LLM call
- **Miss**: Calls LLM, validates, caches, returns

## Testing
- `enrichBossDrop()` with mock LLM → validates output
- Cache hit/miss/eviction
- Fallback on LLM failure / invalid JSON / validation error
- `getCacheStats()` for monitoring