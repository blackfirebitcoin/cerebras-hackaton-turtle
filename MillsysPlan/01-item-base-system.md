# Phase 1: Item Base System

## Goal
Replace procedural `BASE_NOUNS` in `shared/loot.js` with explicit PoE-style base types in `shared/item-bases.js`.

## Files to Create/Modify

### New: `shared/item-bases.js`
```js
// SIGMA ABYSS — explicit item base types (PoE-style)
// Dual-runtime pure ESM. No Math.random, no Date, no network.

export const ITEM_BASES = {
  // WEAPONS
  vaal_axe: {
    id: "vaal_axe",
    name: "Vaal Axe",
    slot: "weapon",
    family: "axe",
    implicit: [{ stat: "physical_dmg_pct", min: 120, max: 160 }],
    req: { str: 113, level: 48 },
    tags: ["axe", "strength", "two_hand"]
  },
  coral_sword: {
    id: "coral_sword",
    name: "Coral Sword",
    slot: "weapon",
    family: "sword",
    implicit: [{ stat: "attack_speed_pct", min: 10, max: 20 }],
    req: { str: 65, agi: 65, level: 32 },
    tags: ["sword", "dexterity"]
  },
  // ... 50+ bases across all 5 slots
};

export const BASE_IDS = Object.keys(ITEM_BASES);
export const BASES_BY_SLOT = Object.groupBy(BASE_IDS, id => ITEM_BASES[id].slot);

// Weighted selection for drop tables
export const BASE_WEIGHTS = {
  weapon: { vaal_axe: 10, coral_sword: 15, /* ... */ },
  armor: { /* ... */ },
  ring: { /* ... */ },
  relic: { /* ... */ },
  charm: { /* ... */ }
};

export function pickBaseForSlot(rng, slot) {
  const weights = BASE_WEIGHTS[slot] || {};
  const entries = Object.entries(weights);
  return rng.weighted(entries);
}
```

### Modify: `shared/constants.js`
Add export for `ITEM_BASES` and base type enums.

### Modify: `shared/loot.js`
- Remove `BASE_NOUNS` object
- Import `pickBaseForSlot` from `item-bases.js`
- Update `makeItem()` to use base type → implicit mods → name generation
- Name format: `"{BaseName} {Prefix} {Suffix}"` or `"{BaseName}, {MythTitle}"` for legendary+

## Base Type Categories (50+)

| Slot | Count | Examples |
|------|-------|----------|
| weapon | 18 | vaal_axe, coral_sword, hollow_staff, void_bow, sigil_dagger |
| armor | 12 | plate_hauberk, cursed_trenchcoat, ember_carapace, void_shroud |
| ring | 8 | coral_ring, gold_signet, void_loop, abyssal_knuckle |
| relic | 8 | goblin_idol, druid_sigil, chrome_reliquary, hollow_effigy |
| charm | 6 | lucky_die, greedy_coin, fate_token, doom_trinket |

## Implicit Mods
Each base has 1-2 fixed implicit mods (like PoE). Examples:
- `vaal_axe`: `physical_dmg_pct` 120-160%
- `coral_ring`: `life_regen` 15-25/sec
- `hollow_staff`: `spell_dmg_pct` 80-120%

## Testing
- `makeItem()` produces items with `baseType` field referencing `ITEM_BASES[id]`
- `itemPower()` includes implicit mod values
- Deterministic: same RNG seed → same base type selection