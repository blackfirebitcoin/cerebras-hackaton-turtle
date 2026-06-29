# Phase 7: Fail-Closed Re-Validation on Load

## Goal
Re-validate cached Gemma drops on server startup / world load. Any drop failing validation reverts to deterministic equivalent.

## Files to Modify

### Modify: `server/validate.js`

#### Add `vBossDrop` Validator
```js
// In validate.js — add after vItem (around line 280)

import { validateBossDrop } from "../shared/boss-drops.js";
import { RAID_BOSS_DROPS, forgeRaidDrop } from "../shared/loot.js";

export function vBossDrop(item) {
  // Standard item validation first
  const validated = vItem(item);
  
  // Only re-validate Gemma-sourced drops
  if (validated.source !== "gemma") return validated;
  
  // Re-validate against boss drop schema
  const reval = validateBossDrop(validated);
  if (reval.ok) {
    return { ...reval.drop, source: "gemma", revalidated: true };
  }
  
  // FAIL CLOSED: Revert to deterministic equivalent
  const bossId = validated.raidDrop || "goblin_king";
  const ilvl = validated.ilvl || 50;
  const fallback = forgeRaidDrop(bossId, Math.max(1, Math.round(ilvl / 1.5 - 8)));
  
  if (fallback) {
    // Preserve identity fields
    return {
      ...vItem(fallback),
      source: "deterministic",
      revalidationFailed: true,
      originalErrors: reval.errors
    };
  }
  
  // Ultimate fallback
  return { ...validated, source: "deterministic", revalidationFailed: true };
}
```

#### Integration Point: Character/Run Load
```js
// In vCharacter or wherever items are loaded (vRun, vPlayer, etc.)

function vCharacter(character) {
  // ... existing validation ...
  
  // Re-validate inventory items
  if (Array.isArray(character.run?.inventory)) {
    character.run.inventory = character.run.inventory.map(vBossDrop);
  }
  
  // Re-validate vault items
  if (Array.isArray(character.vault)) {
    character.vault = character.vault.map(vBossDrop);
  }
  
  // Re-validate gear
  if (character.run?.gear) {
    for (const slot of GEAR_SLOTS) {
      if (character.run.gear[slot]) {
        character.run.gear[slot] = vBossDrop(character.run.gear[slot]);
      }
    }
  }
  
  return character;
}
```

#### Schema Change Detection (optional enhancement)
```js
// In shared/boss-drops.js — add schema version

export const BOSS_DROP_SCHEMA_VERSION = 1;

export function validateBossDrop(drop) {
  // If schema version changed, fail all cached drops
  if (drop.schemaVersion && drop.schemaVersion < BOSS_DROP_SCHEMA_VERSION) {
    return { ok: false, errors: [`schema version ${drop.schemaVersion} < ${BOSS_DROP_SCHEMA_VERSION}`] };
  }
  // ... rest of validation ...
  return { ok: true, drop: { ...cleaned, schemaVersion: BOSS_DROP_SCHEMA_VERSION } };
}
```

## Behavior

| Scenario | Result |
|----------|--------|
| Valid Gemma drop | Returns with `revalidated: true` |
| Invalid affix value | Clamped, returns cleaned |
| Unknown baseType | Reverts to `forgeRaidDrop(bossId, ilvl)` |
| Invalid effect | Set to null, keeps item |
| Schema version bump | All cached drops revert |
| Missing `source` field | Treated as deterministic |

## Testing
1. Start server with valid cached Gemma drops → all pass re-validation
2. Corrupt cache (edit JSON, change affix to 9999) → reverts to deterministic
3. Change `BOSS_DROP_SCHEMA_VERSION` → all cached drops revert
4. Missing `ITEM_BASES` entry → reverts to deterministic equivalent
5. Verify `revalidationFailed` flag appears on reverted items

## Monitoring
```js
// Log re-validation stats on startup
let revalidated = 0, reverted = 0;
for (const item of allItems) {
  if (item.source === "gemma") {
    const result = vBossDrop(item);
    if (result.revalidated) revalidated++;
    if (result.revalidationFailed) reverted++;
  }
}
console.log(`[reval] ${revalidated} ok, ${reverted} reverted`);
```