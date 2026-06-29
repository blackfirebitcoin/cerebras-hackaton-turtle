# SIGMA ABYSS — Systems Design (Agent 1: Lead Systems Designer)

> **Role:** Core gameplay loops — character progression, skills/leveling,
> crafting, equipment, combat, factions, reputation, and risk/reward.
> This document is the machine-readable contract for the synthesis step and
> the implementation-ready spec handed to coders. Every mechanic cites the real
> export it extends. No code files are edited here.

---

## 1. Overview

SIGMA ABYSS already ships a solid vertical slice: deterministic auto-battler,
RimWorld personality sim, seven-stat loot engine, permadeath-with-prestige, and
a live Twitch-chat social layer. The gaps that prevent it from becoming a
months-to-years MMO are:

1. No factions or reputation — characters have no allegiances and no standing.
2. No player-to-player economy — gear only moves via NPC vendor.
3. No meaningful crafting — only Agent Realm has craft stubs.
4. No Twitch-chat command language beyond `!fight` / `!delve`.
5. No persistent shared world state — only the feed and leaderboard are shared.

This document designs those systems as **extensions of existing exports**. Every
mechanic threads through the same `delveTick → derive → resolveEncounter`
pipeline and respects the five hard invariants:

- `shared/` stays pure ESM, dual-runtime, no `Math.random()`.
- `delveTick` remains THE tick; new world-ticks follow the same deterministic
  caller-orchestrated shape.
- RUN vs ACCOUNT split is enforced — new persistent MMO state lives on the
  ACCOUNT side (or a new WORLD document), never in `run`.
- `server/validate.js` is the trust boundary — every new field gets a validator.
- All background loops run under `supervisor.superviseInterval`.

---

## 2. Design Principles Applied

| Principle | Mechanic it drives |
|---|---|
| Every action advances progression | Faction XP on every chat command, skill XP every encounter, reputation on every kill |
| Every system creates stories | Faction wars generate feed events; NPC memory produces emergent rumors |
| Failure creates opportunities | Losing faction standing opens rival faction questlines; death grants prestige |
| Scarcity creates value | Reagents deplete; crafting recipes require rare drops; faction vendors have weekly caps |
| Social interaction is a core mechanic | Factions are chosen in chat; guild banks are shared; reputation visible on leaderboard |
| The world persists continuously | `world.json` evolves under `superviseInterval` even with zero players online |
| Viewers can influence outcomes | Twitch Bits / channel-point redemptions trigger faction events; chat votes on guild decisions |
| Emergent gameplay beats scripted | Faction war outcomes are computed, not authored |
| Risk creates excitement | High-danger delves risk faction-debt items; PvP duels wager faction standing |
| Mastery takes months/years | Faction rep cap requires ~200 prestige-days; skill 20 in all 8 skills requires ~6 months of daily play |

---

## 3. Mechanics

### 3.1 Faction System

#### Concept

Five factions occupy the existing zone geography. Each faction controls one or
more zones, sells faction-exclusive gear, offers reputation-gated quests, and
wages wars with rival factions. Characters belong to exactly one faction at a
time (or none — freelancer). Faction membership is account-level, surviving
permadeath.

#### The Five Factions

| ID | Name | Zone affinity | Archetype | Rival |
|---|---|---|---|---|
| `iron_veil` | Iron Veil | goblin_warrens | Disciplined warriors, defense-first | `crimson_pact` |
| `crimson_pact` | Crimson Pact | cursed_forest | Blood-oath berserkers, offense-first | `iron_veil` |
| `void_order` | Void Order | infernal_highway | Sorcerers and scholars, magic-first | `ember_court` |
| `ember_court` | Ember Court | demon_catacombs | Merchant-kings, economy-first | `void_order` |
| `abyssal_convergence` | Abyssal Convergence | abyss_ruins | Nihilists, chaos-first; requires 500 prestige to join | all others |

#### Joining a Faction (chat command `!join <faction>`)

- Cooldown: one join per 7 real days (stored as `character.factionJoinedAt`).
- Switching factions sets `character.factionRep` to 0 and adds a "defector"
  tag for 3 days that halves rep gain (encourages loyalty).
- `!join` is forwarded by chat-elixir → `POST /api/faction/join/:login`.

#### Extension points

- `progression.js:freshCharacter` — add `faction: null, factionRep: 0,
  factionRank: 0, factionJoinedAt: 0, factionDefectorUntil: 0` to account state.
- `progression.js:resolveDeath` — does NOT reset faction fields (account-side).
- `shared/factions.js` (new, deterministic) — exports `FACTIONS`, `FACTION_IDS`,
  `factionById(id)`, `factionRank(rep)`, `factionRepCap`, `factionRankLabel(rank)`.
- `server/validate.js:vCharacter` — add `vFaction(raw.faction)` and
  `vInt(raw.factionRep, 0, FACTION_REP_CAP)`.

---

### 3.2 Reputation System

#### Concept

Reputation is a 0–1000 integer per faction. Players gain rep by:

1. Killing enemies in the faction's home zone (via `delveTick` post-encounter hook).
2. Completing faction quests (via `POST /api/faction/quest/complete`).
3. Winning a shared raid boss that the faction claims (via `endRaid`).
4. Donating gold to the faction treasury (via `POST /api/faction/donate`).

Rep is lost by:

1. Killing faction-aligned NPCs (future; currently all enemies are neutral — when
   factions are assigned to enemy archetypes this fires automatically).
2. Joining a rival faction (rep resets to 0).
3. PvP duel loss against a high-rep member of a rival faction (`POST /api/duel/resolve`).

#### Rank thresholds

| Rep | Rank | Label | Perks |
|---|---|---|---|
| 0–49 | 0 | Outsider | Can enter zone; no perks |
| 50–149 | 1 | Initiate | +5% gold from zone enemies; faction vendor access |
| 150–299 | 2 | Member | Faction-exclusive crafting recipes; guild bank read |
| 300–499 | 3 | Champion | Faction-exclusive weapon art unlock (see §3.4); guild bank write |
| 500–749 | 4 | Vanguard | +15% XP in home zone; spawn a faction elite once per hour |
| 750–999 | 5 | Warlord | +25% loot bias in home zone; faction title cosmetic |
| 1000 | 6 | Sovereign | Unique one-of-one faction weapon drop eligibility |

#### Faction rep in the combat pipeline

`delveTick` calls `derive(run, character)` before combat. The new
`factionCombatMods(character.faction, character.factionRep, zone.id)` function
(in `shared/factions.js`) returns an additive sheet modifier object that
`derive` stacks alongside `skillCombatMods` — this is a deterministic pure
function and safe for dual-runtime use.

```js
// shared/factions.js (proposed export signature)
export function factionCombatMods(factionId, rep, zoneId) {
  // Returns { atkAdd, defAdd, xpMul, goldMul, lootBiasAdd, dangerMul }
  // All zero if factionId is null or rep < 50.
}
```

`stats.js:derive(run, character)` gains one additional stacking step:

```js
// stats.js — inside derive(), after skillCombatMods:
const factionMods = factionCombatMods(character?.faction, character?.factionRep, run?.zone);
sheet.attack     += factionMods.atkAdd;
sheet.defense    += factionMods.defAdd;
sheet.xpMul      *= factionMods.xpMul;
// etc.
```

This preserves the deterministic contract because `factionCombatMods` is a pure
function of account-level state, not run-level RNG.

---

### 3.3 Character Progression Tree

#### Existing foundation

- `progression.js:xpForLevel(n)` — exponential XP curve (base 40, growth 1.16).
- `progression.js:gainXp(run, amount, character)` — cascades level-ups, awards
  stat points (3 per level via `STAT_POINTS_PER_LEVEL`), partial-heals on level-up.
- `stats.js:derive(run, character)` — computes full combat sheet from 7 stats +
  gear + traits + skills + breaks + diseases.
- `skills.js:SKILLS` — 8 account-persisting skills (melee/ranged/magic/survival/
  looting/bargaining/stealth/social), level 0–20.

#### New: Skill Trees (Prestige Talent System)

Each skill gains a three-tier talent tree unlocked at skill levels 5, 10, 15.
Talents are account-persistent, cost prestige to unlock, and provide meaningful
build-defining choices — not just numeric amplifiers.

Each skill has exactly three talent tiers. Each tier has exactly two mutually
exclusive talents. Once chosen, a talent can be re-selected only by spending
double the prestige cost (a permanent account action, not run-scoped).

**Example — Melee skill talents:**

| Level gate | Talent A | Talent B |
|---|---|---|
| Melee 5 | **Cleave**: attacks hit all enemies simultaneously (60% damage to non-primary targets) | **Precision**: every 3rd melee strike is a guaranteed crit |
| Melee 10 | **Juggernaut Stance**: +20% defense while wielding melee, -10% speed | **Blood Frenzy**: each kill grants +8% attack for 3 encounters, stacking |
| Melee 15 | **Titan's Reach**: greatsword arts fire on every swing (not probabilistic) | **Duelist's Edge**: all melee damage ignores 30% of enemy defense |

**Example — Social skill talents:**

| Level gate | Talent A | Talent B |
|---|---|---|
| Social 5 | **Charisma**: faction rep gains +20% | **Intimidation**: enemies have 10% lower attack in the first encounter of each delve |
| Social 10 | **Rally**: when mood > 70, deal +15% damage | **Diplomat**: switching factions costs no defector penalty |
| Social 15 | **War Cry**: once per run, +50% party damage for 5 encounters (broadcast to raid) | **Negotiator**: faction vendor prices -25% |

**Data model:**

```
character.skillTalents: {
  [skillId]: [talentTierId | null, talentTierId | null, talentTierId | null]
}
```

Lives on the ACCOUNT side (not the run). `validate.js:vSkillTalents()` validates
against the talent catalogue in `shared/skill-talents.js`.

**New shared module:** `shared/skill-talents.js`
- Exports: `SKILL_TALENTS`, `TALENT_IDS`, `talentMods(skillTalents, skillLevels)`,
  `talentById(id)`, `talentUnlocked(skillId, tier, skillLevel)`.
- Deterministic: pure function of account state, no RNG.
- `stats.js:derive` calls `talentMods(character.skillTalents, character.skills)`
  and stacks results alongside `skillCombatMods`.

**Prestige cost table:**

| Talent tier | Prestige cost | Respec cost |
|---|---|---|
| Tier 1 (skill 5) | 15 prestige | 30 prestige |
| Tier 2 (skill 10) | 40 prestige | 80 prestige |
| Tier 3 (skill 15) | 100 prestige | 200 prestige |

With average prestige-per-run of ~25 (mid-game), this means 6 runs to unlock
a single Tier 3 talent. Full skill tree mastery across all 8 skills × 3 tiers
costs 24 × (15 + 40 + 100) = 3,720 prestige — approximately 150 mid-game runs
or 300 hours of play. This is the year-scale mastery target.

---

### 3.4 Faction-Exclusive Weapon Arts

`weapons.js:unlockedArts(family, plus)` currently returns arts gated by upgrade
tier (+0..+10). Factions add a second gating dimension: faction rank.

**Proposed extension:**

```js
// weapons.js — extend unlockedArts signature:
export function unlockedArts(family, plus, factionId = null, factionRank = 0)
```

Faction arts are defined in `shared/factions.js` alongside the faction catalogue
and layered on top of the base art ladder. They do not replace base arts; they
are appended. This preserves backward compatibility (null faction = no faction
arts appended).

**Example faction arts:**

| Faction | Weapon family | Art name | Rank gate | Effect |
|---|---|---|---|---|
| Iron Veil | hammer | Iron Bulwark | Rank 2 | On proc: next incoming hit is blocked (0 damage) |
| Crimson Pact | sword/greatsword | Blood Oath Strike | Rank 2 | Deals 180% damage; you lose 8% max HP |
| Void Order | staff | Void Rupture | Rank 3 | Overload fires guaranteed for 2 ticks |
| Ember Court | dagger | Gold Fingers | Rank 1 | On kill: +50% gold from this encounter |
| Abyssal Convergence | any | Permadeath Wave | Rank 5 | Kills all remaining enemies; 20% chance to kill player too |

The combat pipeline (`combat.js:resolveEncounter`) already has the switch for
weapon arts — faction arts are new entries in the per-family art ladder. No
structural combat changes required.

---

### 3.5 Crafting System

#### Motivation

Scarcity creates value. Crafting creates a gold sink and a reason to grind
specific zone drops rather than auto-banking everything.

#### Ingredients

Reagents are dropped by specific enemy archetypes (not by all enemies), at low
probability, via an extension to `loot.js:rollDrop`. They are NOT gear — they
have no power, no affixes — they are pure crafting inputs that take an inventory
slot.

```js
// loot.js — rollDrop gains optional reagentChance parameter:
// If a reagent roll fires, returns a reagent item { kind: 'reagent', code, name, zone }
// instead of a gear item. Reagent probability: 8% per kill in home zone (reduced
// to 2% out-of-zone). Governed by the same RNG stream — deterministic.
```

**Reagent table (one per zone):**

| Zone | Reagent code | Name |
|---|---|---|
| goblin_warrens | `goblin_ear` | Goblin Ear |
| cursed_forest | `cursed_bark` | Cursed Bark |
| infernal_highway | `chrome_shard` | Chrome Shard |
| demon_catacombs | `void_crystal` | Void Crystal |
| abyss_ruins | `abyssal_core` | Abyssal Core |

#### Crafting Recipes

Recipes are stored in `shared/crafting.js` (new module). Each recipe specifies:
input reagents, gold cost, output item template (slot + forced affix set +
rarity floor). Recipes are unlocked by faction rank.

**Example recipes:**

| Recipe | Ingredients | Gold | Output | Faction rank gate |
|---|---|---|---|---|
| Iron Barrier | 3× goblin_ear + 2× cursed_bark | 200g | Epic armor (+def affix locked) | Iron Veil rank 1 |
| Blood Oath Blade | 5× cursed_bark + 1× void_crystal | 500g | Legendary sword (Blood Oath Strike art pre-unlocked) | Crimson Pact rank 2 |
| Void Staff | 4× chrome_shard + 2× void_crystal | 800g | Legendary staff (Void Rupture art pre-unlocked) | Void Order rank 2 |
| Midas Ring | 6× abyssal_core | 2000g | Mythic ring (midas effect) | Ember Court rank 3 |

**Crafting endpoint:**

`POST /api/craft/:login` — body `{ recipe_id }` — validates ingredients in
inventory, deducts reagents, deducts gold, calls `shared/crafting.js:executeCraft(run, character, recipeId, rng)` which returns the crafted item via `loot.js:makeItem` with forced affixes. The crafted item is added to inventory or auto-sold if full.

The `rng` parameter keeps crafting deterministic: caller passes `makeRng(run.rngSeed)` with current `run.rngState` before the craft roll, advances state after.

**New shared module:** `shared/crafting.js`
- Exports: `RECIPES`, `RECIPE_IDS`, `recipeById(id)`, `canCraft(run, character, recipeId)`,
  `executeCraft(run, character, recipeId, rng)`.
- Deterministic: uses passed-in RNG, no `Math.random()`.
- `canCraft` checks: faction rank gate, inventory has ingredients, gold >= cost.

---

### 3.6 Equipment System Extensions

#### Existing foundation

- `loot.js` — 7 rarity tiers, 5 gear slots, affix pool, 10 named effects.
- `weapons.js` — 8 weapon families, +0..+10 upgrade, art ladders.
- `stats.js:derive` — reads all gear affixes and stacks them.

#### New: Item Binding

To prevent economy exploits while enabling a trading layer (designed by Agent 2 –
economy), introduce item binding:

```
item.bound: 'unbound' | 'account' | 'faction'
```

- **Unbound**: freely tradeable. Default for all common/uncommon/rare drops.
- **Account-bound**: cannot be traded; only sellable to NPC vendor. Applied to
  all crafted items and all legendaries found by the player's own character.
- **Faction-bound**: can be traded within the same faction guild bank only.
  Applied to faction-exclusive craft outputs and faction boss drops.

`loot.js:rollDrop` sets `bound: 'unbound'` by default. `executeCraft` sets
`bound: 'account'`. Faction-exclusive items set `bound: 'faction'`.
`validate.js:vItem` is extended to validate the `bound` field.

#### New: Item Sets

Sets are defined in `shared/item-sets.js` (new module). Equipping 2, 3, or 4
pieces of the same set activates set bonuses stacked into `derive`.

Each faction has one signature item set, dropped exclusively from its boss zone:

| Set | Pieces | 2-piece bonus | 4-piece bonus |
|---|---|---|---|
| Iron Veil Panoply | armor, ring, relic, charm | +10% defense | All incoming damage is blocked 10% of the time |
| Crimson Covenant | weapon, armor, ring, charm | Kills heal 3% max HP | Blood Oath Strike fires on every swing |
| Void Codex | weapon, ring, relic, charm | +15% overload | Void Rupture fires at 2× proc rate |
| Ember Treasury | all 5 slots | Midas effect always active | Double gold from bosses |
| Abyss Fracture | weapon, armor, relic | +20% crit | 5% chance on kill to instantly clear the encounter |

**New shared module:** `shared/item-sets.js`
- Exports: `ITEM_SETS`, `SET_IDS`, `equippedSetBonuses(gear)`,
  `setModsForBonuses(bonusIds)`.
- Deterministic: pure function of gear state, no RNG.
- `stats.js:derive` calls `setModsForBonuses(equippedSetBonuses(run.gear))` and
  stacks resulting sheet modifiers.

---

### 3.7 Risk/Reward Mechanics

#### The Danger Dial (existing, extended)

`constants.js:DANGER_PER_TICK = 0.02` and `DANGER_MAX = 1.0` already provide a
danger ramp. The new faction system adds a **faction debt mechanic**:

When a character dies while carrying faction-bound items in the inventory, those
items are NOT transferred to the next run (respecting the RUN/ACCOUNT split) but
are also NOT sold for prestige. Instead they are "lost in the abyss" and generate
a one-time debt: next time the character visits that zone, a special **Debt
Collector** elite spawns with the lost items in its loot table. Killing it
recovers 1d4 of the lost faction items.

This is implemented as `character.factionDebt: { [zoneId]: itemCount }` on the
ACCOUNT side. `buildEncounter` in `progression.js` checks `character.factionDebt`
for the current zone and injects the Debt Collector encounter once when debt > 0.

#### Fear & Hunger permanent stakes (new)

Inspired by Fear & Hunger's permanent consequences:

1. **Scar accumulation across runs** (account-level): each permadeath that
   involves a vital-part wound (`health.js:rollHitPart` → vital part) adds a
   permanent `character.scars` array entry. Scars apply a small permanent penalty
   (`-2` to a random stat, capped at 5 active scars). Scars can be cleansed by
   reaching Rank 3 in Iron Veil (the healer faction) or by spending 500 gold
   at the Ironhollow shrine. This erodes run-to-run power for reckless players
   and rewards caution.

2. **Cursed items** (new legendary effect): `loot.js:EFFECTS` gains `'cursed'`:
   massive stat bonus (+40% all combat stats) but the item is account-bound AND
   adds the `'cursed'` trait to the next run. The `cursed` trait (`traits.js`)
   causes the character to take double damage from elites. Players must decide
   whether the power spike is worth the long-term liability.

3. **RuneScape death cost**: when a character dies in a danger zone with items
   worth more than 50 gold total (by `loot.js:sellValue`), a "grave" is created
   in `world.json`. Other players can loot the grave (first come, first served)
   via `POST /api/grave/loot/:graveId`. The dead player can race back (on their
   new run) to reclaim it first. Graves expire after 15 minutes.

---

### 3.8 Combat System Extensions

#### Faction-aware enemy generation

`progression.js:buildEncounter` currently picks enemies from `zone.enemies` and
`zone.elites` arrays. The faction system adds **faction-tagged enemies** that
appear when a character has negative reputation with a specific faction (future
state; initially all enemies are neutral).

When a character's `factionRep` for the zone's controlling faction is negative
(possible after defection with accumulated rep > 0 then reset), the encounter
builder injects one faction-hostile enemy per pack with 20% probability.

Extension point: `buildEncounter` receives `character` already (it reads
`character.mood`, `character.traits` indirectly through `derive`). Adding a
faction-hostile spawn check is a 3-line addition at the end of `buildEncounter`.

#### Social combat effects (multiplayer raid)

The existing `raid-state.js` and `server.js:fireRaidSwing` handle shared combat.
New faction mechanics layer onto this:

- **Faction Rally**: when 5+ members of the same faction are active in a raid,
  all faction members get +10% damage. Computed in `fireRaidSwing` by querying
  the faction field of contributing players' characters.
- **Faction War Event**: once per stream (triggered by `POST /api/faction/war`
  from the operator), two rival factions are set as "at war". For 30 minutes, any
  PvP duel between their members doubles the rep change on both sides (win/lose).
  Stored in `world.json:activeFactionWar`.

---

## 4. Data Model

### 4.1 RUN vs ACCOUNT vs WORLD split

```
RUN (erased on permadeath — run.* in character.run):
  No new fields from faction/rep system. Faction mods read
  from account state inside derive(); the run itself is clean.
  New run-scoped fields (transient only):
    run._factionDebtEncounterFired: bool  (cleared on retreat/death)

ACCOUNT (survives permadeath — character.*):
  faction: string | null           — faction ID or null (freelancer)
  factionRep: number               — 0..1000
  factionRank: number              — 0..6 (derived, but cached for perf)
  factionJoinedAt: number          — Unix ms; gate for 7-day cooldown
  factionDefectorUntil: number     — Unix ms; halves rep gain during window
  factionDebt: { [zoneId]: number }  — items lost on death per zone
  scars: Array<{ stat: string, amount: number, gainedAt: number }>  — max 5
  skillTalents: { [skillId]: [string|null, string|null, string|null] }
  guildId: string | null           — future; reserved field

WORLD (shared, server-authoritative — data/world.json):
  factions: {
    [factionId]: {
      treasury: number             — shared gold pool
      memberCount: number          — updated on join/leave
      sovereignty: string | null   — current Sovereign login (rep 1000)
      weeklyKills: number          — reset Sunday 00:00 UTC
      weeklyGoldDonated: number
    }
  }
  activeFactionWar: {
    factionA: string, factionB: string, expiresAt: number
  } | null
  graves: [{ id, login, zoneId, items: Item[], expiresAt: number }]
  activeRepEvents: []              — timed global rep bonus events (operator-triggered)
```

### 4.2 New store documents

`store.js` gains two new document types alongside `players.json`:

- `world.json` — the WORLD document above. Initialized on first boot with empty
  faction objects for all 5 factions. Flushed on the same debounce cycle as
  `players.json`.
- `graves.json` — extracted from `world.json` for isolation (high write
  frequency on death/claim). Also flushed on debounce.

New store exports:

```js
export function getWorld()          // → world object (in-memory)
export function putWorld(world)     // marks dirty
export function getGraves()         // → graves array
export function pushGrave(grave)    // adds, marks dirty
export function removeGrave(id)     // removes, marks dirty
```

---

## 5. New Shared Modules

### 5.1 `shared/factions.js`

| Export | Deterministic? | Description |
|---|---|---|
| `FACTIONS` | yes | Catalogue of 5 faction definitions |
| `FACTION_IDS` | yes | Array of faction id strings |
| `factionById(id)` | yes | Lookup; returns null for unknown id |
| `factionRank(rep)` | yes | Maps rep number → rank 0–6 |
| `factionRankLabel(rank)` | yes | Human label for rank |
| `factionRepCap` | yes | Constant 1000 |
| `factionRepGain(zoneId, factionId, killKind)` | yes | Base rep gain per kill (0 if mismatch) |
| `factionCombatMods(factionId, rep, zoneId)` | yes | Sheet modifier object for derive() |
| `factionArts(factionId, rank)` | yes | Array of faction weapon arts to append to unlockedArts |
| `isRival(factionA, factionB)` | yes | Boolean rivalry check |

Pure ESM, no node built-ins, no RNG. Safe for browser.

### 5.2 `shared/skill-talents.js`

| Export | Deterministic? | Description |
|---|---|---|
| `SKILL_TALENTS` | yes | Nested catalogue: { [skillId]: { tier: 1|2|3, talents: [{id, name, prestigeCost, mods, mutuallyExclusiveWith}] }[] } |
| `TALENT_IDS` | yes | Flat array of all talent id strings |
| `talentById(id)` | yes | Lookup |
| `talentUnlocked(skillId, tier, skillLevel)` | yes | Boolean gate check |
| `talentMods(skillTalents, skillLevels)` | yes | Aggregated modifier object for derive() |
| `talentPrestigeCost(talentId)` | yes | Cost to unlock |

Pure ESM, no RNG.

### 5.3 `shared/crafting.js`

| Export | Deterministic? | Description |
|---|---|---|
| `RECIPES` | yes | Catalogue of all crafting recipes |
| `RECIPE_IDS` | yes | Array of recipe id strings |
| `recipeById(id)` | yes | Lookup |
| `canCraft(run, character, recipeId)` | yes | Validates ingredients + gold + faction rank |
| `executeCraft(run, character, recipeId, rng)` | yes | Deducts inputs, calls makeItem, returns item |
| `reagentDrop(enemyId, zoneId, rng)` | yes | Rolls a reagent drop (called by rollDrop extension); returns reagent item or null |

`executeCraft` uses passed-in `rng` for all rolls. Caller (server) saves
`run.rngState = rng.state` after the call to maintain RNG continuity.

### 5.4 `shared/item-sets.js`

| Export | Deterministic? | Description |
|---|---|---|
| `ITEM_SETS` | yes | Catalogue of 5 faction item sets |
| `SET_IDS` | yes | Array of set id strings |
| `equippedSetBonuses(gear)` | yes | Returns array of active set bonus ids from current gear |
| `setModsForBonuses(bonusIds)` | yes | Returns stacked sheet modifier object |

Pure ESM, no RNG.

---

## 6. New HTTP Endpoints and Chat Commands

All new endpoints follow the existing pattern: `guard(where, handler)` wrapping,
`vCharacter` / custom validators on all body/param inputs, `store.getPlayer` →
mutate → `store.putPlayer`, `rt.broadcast` for social events.

### 6.1 Faction Management

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/faction/join/:login` | `{ faction_id }` | Join faction; validates 7-day cooldown; sets defector window if switching; pushes feed event; broadcasts faction membership update |
| GET | `/api/faction/:factionId` | — | Returns faction world state (treasury, member count, sovereignty, weekly stats) |
| POST | `/api/faction/donate/:login` | `{ gold }` | Deducts gold from character, adds to faction treasury, grants rep; validates gold >= 10, player in faction |
| POST | `/api/faction/war` | `{ factionA, factionB }` (HMAC-signed) | Operator triggers faction war for 30 min; stored in world.json |

Chat command: `!join <faction>` → chat-elixir → `POST /api/faction/join/:login`

### 6.2 Crafting

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/recipes/:login` | — | Returns list of recipes the player can see (faction-filtered + what they lack) |
| POST | `/api/craft/:login` | `{ recipe_id }` | Validates canCraft; calls executeCraft; updates character; returns crafted item |

Chat command: `!craft <recipe_id>` → `POST /api/craft/:login`

### 6.3 Talent System

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/talents/:login` | — | Returns full talent tree state for character |
| POST | `/api/talent/unlock/:login` | `{ skill_id, tier, talent_id }` | Validates skill level gate + prestige cost; deducts prestige; sets talent; validates no other talent active at same tier |
| POST | `/api/talent/respec/:login` | `{ skill_id, tier }` | Clears talent at tier; deducts double prestige cost |

Chat command: `!talent <skill> <tier> <a|b>` → `POST /api/talent/unlock/:login`

### 6.4 Graves (death economy)

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/graves` | — | Returns list of active graves (id, login, zone, item count, expiresAt) |
| POST | `/api/grave/loot/:graveId` | `{ login }` | First-come-first-served claim; adds items to inventory or auto-sells; removes grave; broadcasts feed event |

### 6.5 Reputation and World Queries

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/world` | — | Returns world.json public snapshot (no treasury internals) |
| POST | `/api/faction/rep-event` | `{ faction_id, bonusMul, durationMs }` (HMAC-signed) | Operator triggers timed global rep bonus event (stream hype) |

### 6.6 Scar Management

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/scars/cleanse/:login` | — | Validates Iron Veil rank >= 3 OR character.gold >= 500; removes oldest scar; pushes feed event |

---

## 7. Scaling and Anti-Abuse

### 7.1 Thousands of chatters

Every `POST /api/chat-ping/:login` is already on the hot path. The faction rep
gain per kill is computed in `factionRepGain()` (a cheap pure function lookup)
and applied post-encounter inside `delveTick` — no additional DB reads per message.

The `world.json` faction treasury is in-memory (same debounced flush as
`players.json`) so donation writes are O(1) in-memory updates. Under 10,000
concurrent donors the flush queue handles contention; beyond that, treasury
updates should be aggregated via a batched commit (a `pendingTreasuryDeltas` Map
cleared on each flush tick is sufficient).

### 7.2 Rep farming prevention

- Rep gains are **per-encounter**, not per-kill. Trash packs of 4 goblins yield
  the same rep as a single elite kill — removing the incentive to spam lowest-zone
  farming.
- Rep gains are **capped per hour**: `character.repGainedThisHour` (Unix hour
  bucket). Hard cap: 50 rep/hour via kills (unlimited via donations, which cost
  gold — a natural economic limiter).
- Cooldowns: `!join` 7 days; `!craft` rate-limited to 1 per 30 seconds (server-
  side, checked against `character.lastCraftAt`).

### 7.3 Grave griefing

Graves are visible to all players but looting a grave belonging to your own
faction awards only 50% of items (the other 50% is destroyed as a "looting fee").
Looting a rival faction's grave awards 100% and grants 5 rep with your own
faction. This prevents farming alts and makes grave looting a meaningful
risk-vs-reward decision.

### 7.4 Determinism under load

`executeCraft` and any new tick-side function must take the run's persisted RNG
state as input, advance it deterministically, and save back `run.rngState`. The
server is the authority; the client receives the resulting character state via WS
`save` frame. No client-side simulation of crafting (crafting is server-side only).
This is safe because the existing `shared/` sim is already server-authoritative
for all writes that matter.

---

## 8. Balance Numbers

All numbers are tied to existing constants where possible.

| Parameter | Value | Tied to |
|---|---|---|
| Faction rep cap | 1000 | New constant `FACTION_REP_CAP = 1000` in `constants.js` |
| Faction join cooldown | 7 days (604800000 ms) | New constant `FACTION_JOIN_COOLDOWN_MS` |
| Faction rep per kill (home zone) | 2 | Base; scaled by `factionRank` bonuses |
| Faction rep per kill (neutral zone) | 0 | No cross-zone farming |
| Faction rep via donation | 1 rep per 10 gold donated | Gold sink; aligns with `REST_GOLD_PER_HOUR = 50` |
| Rep hourly kill cap | 50 rep | ~25 kills worth; approx 1 delve at comfortable pace |
| Prestige for Tier 1 talent | 15 | Reachable in ~1 good run (avg 25 prestige/run) |
| Prestige for Tier 3 talent | 100 | ~4 runs; meaningful gate |
| Scar stat penalty | -2 per scar | Against `STAT_MIN = 1`; max 5 scars = -10 stat |
| Scar cleanse via gold | 500 gold | Against `REST_GOLD_PER_HOUR = 50`; 10h equivalent |
| Craft rate limit | 1 per 30s | Prevents macro abuse |
| Grave expiry | 900000 ms (15 min) | Consistent with `RAID_TIMEOUT_MS = 360000` (6 min) order of magnitude |
| Grave loot own-faction penalty | 50% items | Discourages alt-farming |
| Reagent drop chance (home zone) | 8% per encounter | Requires ~12 kills for 1 reagent |
| Reagent drop chance (non-home) | 2% per encounter | Cross-zone gathering is inefficient |
| Faction war duration | 1800000 ms (30 min) | Operator-controlled; 5× `RAID_TIMEOUT_MS` |
| Faction Rally bonus | +10% attack (5+ same-faction raiders) | Stacks with `RAID_XP_MULT` incentive |

---

## 9. Progression Flow (End-to-End Story)

A new viewer types `!join iron_veil` in chat. The chat-elixir bridge forwards
this to `POST /api/faction/join/newviewer`. The server calls
`resolveTwitchSigma('newviewer')` (minting a character if first visit via
`freshCharacter`), validates the join, sets `character.faction = 'iron_veil'`,
pushes a feed event, and broadcasts the faction badge update. The viewer's next
`delveTick` in the goblin_warrens (Iron Veil's home zone) now returns
`factionCombatMods('iron_veil', 0, 'goblin_warrens') = { goldMul: 1.05 }` —
a 5% gold bonus for being in faction.

After 50 rep (Initiate rank), the faction vendor opens. The viewer saves up
200 gold and 3 goblin ears and 2 cursed bark, types `!craft iron_barrier`, and
receives an Epic armor piece account-bound with a locked defense affix. This
item is better than anything they'd get from RNG at their level — but it cannot
be traded, creating a reason to keep delving for unbound gear to sell/trade.

After 500 rep (Vanguard rank), they can unlock the Iron Bulwark weapon art via
`!talent melee 1 a` (spending 15 prestige). Now their hammer build has a block
proc that synergizes with the Iron Veil faction combat mod's defense bonus. They
have found a build identity that will take months to fully optimize across all 8
skill trees. Every delve advances something: faction rep, skill XP, prestige, and
the world treasury — all simultaneously.

---

## 10. Cross-Agent Dependencies

| Agent | Key | Dependency |
|---|---|---|
| Economy Designer | `economy` | Faction treasury drain rates, grave loot economy, crafting price curves, vendor markup |
| Narrative Systems | `narrative` | Faction war event text, grave epitaphs, Debt Collector encounter flavor, scar lore |
| Retention Designer | `retention` | Weekly faction kill board reset timing, seasonal faction reputation events, talent respec cooldowns |
| Twitch MMO Interaction | `twitch` | `!join`, `!craft`, `!talent`, `!rep`, `!war` chat command dispatch; faction badge overlay; faction war announcement |
| Simulation Architect | `simulation` | World tick loop for grave expiry, faction war countdown, weekly treasury reset, rep event timers — all under `superviseInterval` |
| AI NPC Designer | `npc` | Faction NPC dialogue trees keyed on `factionRank`; Debt Collector NPC behavior; faction vendor NPC schedule |

---

## 11. Open Conflicts

1. **Agent 2 (economy) trades vs item binding**: the `bound` field prevents
   free trade. Agent 2 needs to design what fraction of drops remain unbound
   and how the market clears. Conflict: if too many items are account-bound,
   the economy is thin; if too few, crafting is devalued. Resolution owner:
   Agent 2 defines unbound drop rates; this document defines the binding rules.

2. **Agent 5 (twitch) chat command routing**: `!join`, `!craft`, `!talent` need
   chat-elixir `Chat.Mmo.Bridge` to parse command verbs and POST the right
   endpoint. Agent 5 must specify the command routing table and any argument
   parsing (faction short names, recipe aliases). This document assumes the
   routing exists; Agent 5 designs it.

3. **Agent 6 (simulation) world tick frequency**: grave expiry, faction war
   countdown, and rep event timers all need a world tick under
   `superviseInterval`. The tick frequency must be agreed: too fast wastes CPU
   (PSU power safety); too slow means 15-minute graves might linger 20+ minutes.
   Proposed: 60-second world tick. Agent 6 owns the implementation.

4. **Scar system interaction with Fear & Hunger**: account-level stat penalties
   from scars interact with the RUN's starting stats. The scar penalty must be
   applied in `freshRun` (reading from `character.scars`) and stack before
   `backstoryProfile` stat deltas. The exact application order needs to be
   confirmed with whoever edits `freshRun` (this document proposes it; the
   implementer must verify it does not break existing stat validation bounds in
   `validate.js`).

5. **Faction-hostile enemy generation and combat determinism**: adding
   faction-hostile enemies to `buildEncounter` reads `character.faction` (account
   state) inside a function that runs in both live and offline mode. This is safe
   because `character` is already passed to `delveTick` and available in
   `buildEncounter`. However, the offline simulation (`simulateOffline`) passes
   the same character object, so offline sims correctly model faction penalties.
   No conflict expected, but implementer should verify `simulateOffline` passes
   `character` (not just `run`) to all calls — it currently does via the outer
   `delveTick(character)` call.

---

## 12. Success Criteria

1. A character with `faction: 'iron_veil'` and `factionRep: 300` delving in
   `goblin_warrens` receives `factionCombatMods` returning a non-zero defense
   bonus, visibly applied in the HUD derived sheet.

2. `!join iron_veil` via chat results in `POST /api/faction/join/:login` setting
   `character.faction = 'iron_veil'` and pushing a feed event of kind
   `faction_join` within 2 seconds of the chat message.

3. `!craft iron_barrier` with the correct reagents and gold in inventory produces
   an Epic armor item with `bound: 'account'` added to inventory (or auto-sold
   with gold credited if inventory full).

4. Permadeath of a character carrying faction-bound items in a danger zone
   creates a grave entry in `world.json` visible via `GET /api/graves` for 15
   minutes.

5. Dying with 3 faction-bound items in a zone sets `character.factionDebt[zoneId]
   = 3`, and the next delve in that zone spawns a Debt Collector encounter exactly
   once (flag cleared after spawn).

6. Unlocking a Melee Tier 1 talent via `POST /api/talent/unlock/:login` deducts
   15 prestige from `character.prestige`, sets `character.skillTalents.melee[0]`
   to the selected talent id, and the next `derive(run, character)` call returns
   a sheet that reflects the talent modifier.

7. `simulateOffline(character, elapsedMs)` with a character in Iron Veil in
   goblin_warrens produces the same gold/XP totals as the equivalent number of
   live `delveTick` calls — faction mods are deterministic and offline-compatible.

8. Under a simulated 1,000 concurrent chat-ping load (stress test via `smoke.js`
   extension), faction rep updates complete without blocking the WS broadcast
   loop (no tick > 50ms).

9. The talent system requires a character with Melee 15 and 100 prestige to
   unlock a Tier 3 talent — attempting with Melee 14 or 99 prestige returns a
   `ValidationError` from the server.

10. `shared/factions.js`, `shared/skill-talents.js`, `shared/crafting.js`, and
    `shared/item-sets.js` import cleanly in both `node --input-type=module` and
    a browser ESM context (no node built-ins, no `Math.random()`).
