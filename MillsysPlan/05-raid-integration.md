# Phase 5: Raid Integration

## Goal
Modify `server/server.js` `endRaid()` to award deterministic drop instantly + enqueue async enrichment.

## Files to Modify

### Modify: `server/server.js`

#### Import
```js
import { enrichBossDrop } from "./boss-drop-enricher.js";
```

#### Replace `endRaid()` Drop Logic (around line 2367)

```js
// BEFORE:
// const item = forgeRaidDrop(raid.boss_id, lvl);
// placeItem...

// AFTER:
import { enrichBossDrop } from "./boss-drop-enricher.js";

// 1. AWARD DETERMINISTIC DROP INSTANTLY (existing forgeRaidDrop)
const baseDrop = forgeRaidDrop(raid.boss_id, lvl);
let dropForKiller = null;

if (baseDrop) {
  const inv = rec.character.run?.inventory;
  if (Array.isArray(inv) && inv.length < INVENTORY_MAX) {
    inv.push(baseDrop);
    dropForKiller = { stored: "inventory", name: baseDrop.name, rarity: baseDrop.rarity, slot: baseDrop.slot, effect: baseDrop.effect, flavor: baseDrop.flavor };
  } else {
    rec.character.gold += baseDrop.value || 0;
    dropForKiller = { stored: "sold", name: baseDrop.name, rarity: baseDrop.rarity, slot: baseDrop.slot, effect: baseDrop.effect, flavor: baseDrop.flavor, gold: baseDrop.value || 0 };
  }
}

// 2. ENQUEUE ENRICHMENT (fire-and-forget, non-blocking)
if (baseDrop && dropForKiller) {
  const zone = ZONE_BY_ID[raid.bossZone] || ZONE_BY_ID[raid.boss_id];
  
  enrichBossDrop(baseDrop, {
    bossId: raid.boss_id,
    bossName: RAID_BOSS_DROPS[raid.boss_id]?.name || raid.boss_id,
    bossLore: RAID_BOSS_DROPS[raid.boss_id]?.flavor || "",
    zoneName: zone?.name || "Unknown",
    zoneTier: zone?.tier || 0,
    killerLevel: lvl,
    killerClass: rec.character.run?.gear?.weapon?.family || "unknown",
    killerBuild: rec.character.activeSet || "A",
    recentDrops: getRecentBossDrops(raid.boss_id, 5)
  }).then(enriched => {
    if (enriched.enriched && enriched.source === "gemma") {
      // SWAP: remove baseDrop, place enriched
      swapDropForPlayer(rec.character, baseDrop.id, enriched);
      
      // Feed notification
      store.pushFeed?.({
        kind: "boss_enriched",
        detail: `${enriched.name} awakened with new power.`,
        at: Date.now()
      });
      
      // Broadcast to clients
      rt.broadcast?.({ t: "bossDropEnriched", bossId: raid.boss_id, item: enriched });
    }
  }).catch(() => {
    // Silent — base drop already awarded
  });
}

// Helper: get recent drops for anti-dupe context
function getRecentBossDrops(bossId, limit = 5) {
  const feed = store.getFeed?.() || [];
  return feed
    .filter(e => e.kind === "boss" && e.boss_id === bossId && e.drop)
    .slice(-limit)
    .map(e => ({ name: e.drop.name, rarity: e.drop.rarity, effect: e.drop.effect }));
}

// Helper: swap base drop for enriched
function swapDropForPlayer(character, baseDropId, enriched) {
  const inv = character.run?.inventory;
  if (!Array.isArray(inv)) return;
  
  const idx = inv.findIndex(i => i.id === baseDropId);
  if (idx >= 0) {
    // Replace in-place, preserving position
    inv[idx] = { ...enriched, id: baseDropId }; // keep original ID for tracking
    return;
  }
  
  // If not in inventory (sold/vaulted), add enriched to vault
  if (!Array.isArray(character.vault)) character.vault = [];
  if (character.vault.length < (character.vaultCapacity || 20)) {
    character.vault.push({ ...enriched, id: baseDropId });
  }
}
```

## Key Points

1. **Zero latency on kill** — `forgeRaidDrop` runs synchronously, player gets item immediately
2. **Enrichment is async** — `enrichBossDrop` runs after `endRaid` returns
3. **Swap preserves inventory slot** — replaces item at same index
4. **Fallback is silent** — if enrichment fails, player keeps deterministic drop
5. **Feed notification** — `boss_enriched` event when swap happens

## Broadcast Event
```js
// Client receives:
{ t: "bossDropEnriched", bossId: "goblin_king", item: { ...enrichedItem } }
```

## Testing
1. Kill boss → item appears instantly in inventory
2. Wait ~2-5s → item name/affixes update, feed shows "awakened"
3. Kill same boss again → different enrichment (cache key includes class)
4. LLM down → item stays deterministic, no error