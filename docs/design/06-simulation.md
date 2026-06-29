# 06 — Simulation Architecture: Persistent Shared World

**Agent 6 — Simulation Architect**
Cross-references: `01-systems.md` (systems), `02-economy.md` (economy), `03-narrative.md` (narrative), `04-retention.md` (retention), `05-twitch.md` (twitch), `07-npc.md` (npc)

---

## Overview

SIGMA ABYSS today is a per-player isolated delve: each sigma runs their own `delveTick()` loop, offline sim is deterministic via `rng.js:makeRng`, and the "shared" world exists only in a social feed and leaderboard. The persistent world extension adds three orthogonal simulation layers **without replacing the existing per-player tick**:

1. **World Tick** — a server-authoritative background pulse that advances factions, zones, NPC schedules, markets, and emergent events while zero players are online.
2. **Zone Simulation** — each danger zone accumulates pressure from player actions and world events, affecting spawn tables, resource availability, and territorial control.
3. **Faction Engine** — five factions compete for zone territory via autonomous agent-like simulation; players and chatters influence outcomes by siding with a faction.

Every new system obeys the four hard invariants: pure ESM portable shared modules (no Node built-ins, no DOM), deterministic where shared/ is involved, RUN vs ACCOUNT split (faction reputation, zone marks, and market positions live on the account/world side), and all background loops run under `supervisor.js:superviseInterval`.

The scope is designed to be **incrementally shippable**: Phase 1 (World Tick + Zone Pressure) ships with zero client changes; Phase 2 (Factions) adds account fields and a single new endpoint; Phase 3 (NPC Scheduler + Market) completes the economy circuit.

---

## Mechanics

Each mechanic is grounded in an existing export it extends, not replaces.

### 1. World Tick Engine

**Extension of:** `server/supervisor.js:superviseInterval` (the OTP-style loop manager)

The world needs to advance while all players are offline — right now it does not. A new `worldTick()` function runs under a supervised interval every `WORLD_TICK_MS` (default 60,000 ms; see constants). One tick is logically equivalent to one "world minute": cheap, batched, no per-player heavy compute.

`worldTick()` is NOT deterministic in the `mulberry32` sense — it runs on wall-clock time and persists to the store. However, sub-calls that touch `shared/` modules (zone pressure recalc, NPC schedule advance) use seeded per-entity RNG derived from `rng.js:mixSeed(entitySeed, wallMinute)` so each entity's behavior within a wall-minute is reproducible for debugging.

```
// server/world-tick.js (new file)
import { superviseInterval } from './supervisor.js';
import * as store from './store.js';
import * as worldState from './world-state.js'; // new store document

export function startWorldTick(rt) {
  superviseInterval('world.tick', () => worldTick(rt), WORLD_TICK_MS);
}

function worldTick(rt) {
  const ws = store.getWorldState();         // atomic read
  advanceFactions(ws);                      // faction territory sim
  advanceZones(ws);                         // zone pressure decay/spike
  advanceNpcSchedules(ws);                  // NPC day-cycle positions
  advanceMarket(ws);                        // price drift + supply decay
  generateWorldEvents(ws);                  // emergent event queue
  store.putWorldState(ws);                  // atomic write
  rt.broadcast({ t: 'worldPulse', summary: worldPulseSummary(ws) });
}
```

**Scaling:** One world tick touches at most O(factions × zones × npc_roster_size). With 5 factions × 5 zones × ~20 NPCs per zone = 500 entities — trivially cheap. No per-player loop. Chat volume scales via the existing `arena.js:pingChatter` path; the world tick is independent.

---

### 2. Zone Pressure System

**Extension of:** `shared/zones.js:ZONES` (existing zone definitions), `shared/constants.js:DANGER_PER_TICK`

Each zone gains a **world-level pressure** `zonePressure` (0.0–1.0) separate from a player's per-run `danger`. Zone pressure represents the aggregate threat level of the zone in the persistent world — how much the zone's denizens have been disturbed, how many recent deaths have fertilized the zone's power, how long without a player raid.

Zone pressure affects players entering the zone:
- `zonePressure` adds to the initial `run.danger` on `deployToZone` (+0.1 per 0.2 pressure above 0.4)
- At pressure ≥ 0.8, elites appear even at low danger (`DANGER_ELITE_AT` threshold shifts down)
- At pressure ≥ 0.95, "zone eruption" world event fires, broadcasting a raid boss spawn

Pressure decays toward a baseline each world tick (players carving through it reduces it; player deaths increase it; player absence lets it grow slowly toward a "forgotten realm" state).

```
// In world-state.js worldZone shape:
{
  id: 'goblin_warrens',
  pressure: 0.3,          // 0-1 world threat level
  lastRaidAt: 0,          // timestamp of last player victory (boss_clear)
  conquestOwner: null,    // faction id that controls this zone, or null
  conquestSince: 0,
  killsThisHour: 0,       // player kills this tick window
  deathsThisHour: 0,
  resourceNodes: {},      // nodeId -> { qty, regenRate, depletedAt }
}
```

**Pressure dynamics per world tick:**
- Natural growth: `+0.003` per tick while `conquestOwner === null` (unclaimed zones fester)
- Player activity: `-0.008` per player boss_clear in last hour (victories relieve the zone)
- Player deaths: `+0.005` per death logged in last hour (the abyss feeds on fallen sigmas)
- Faction control bonus: controlling faction applies `+0.002` for enemy factions, `-0.004` for allied zone

**Integration with delveTick:** `server/server.js:POST /api/chat-ping/:login` after a boss_clear return from delveTick, call `store.notifyZoneEvent({ zoneId, kind: 'boss_clear', login })`. The world tick reads these events in batch.

---

### 3. Faction Engine

**Extension of:** `shared/zones.js:ZONES` (zone ownership), `shared/progression.js:freshCharacter` (account fields), `server/store.js` (new faction documents)

Five factions compete for zone territorial control. Faction membership is an ACCOUNT-side field (survives permadeath). Faction reputation is a number 0–1000 per faction on the character, unlocking abilities, NPC dialogue, and zone bonuses.

#### Faction Definitions (`shared/factions.js` — new shared module)

```javascript
// shared/factions.js
export const FACTIONS = {
  ironhollow_guard: {
    id: 'ironhollow_guard',
    name: 'Ironhollow Guard',
    blurb: 'The last wall. They hold so others don\'t have to.',
    homeZone: 'town',
    rivalFactions: ['void_order'],
    alliedFactions: ['crimson_pact'],
    colorHex: '#4aa3ff',
    // Reputation thresholds for title unlocks
    rankTitles: [
      { rep: 100, title: 'Recruit' },
      { rep: 300, title: 'Defender' },
      { rep: 600, title: 'Vanguard' },
      { rep: 900, title: 'Champion of Ironhollow' },
    ],
  },
  void_order: {
    id: 'void_order',
    name: 'Void Order',
    blurb: 'They study the abyss from inside it. Dangerous teachers.',
    homeZone: 'abyss_ruins',
    rivalFactions: ['ironhollow_guard', 'crimson_pact'],
    alliedFactions: ['bone_syndicate'],
    colorHex: '#b86bff',
    rankTitles: [
      { rep: 100, title: 'Initiate' },
      { rep: 300, title: 'Adept' },
      { rep: 600, title: 'Arcanist' },
      { rep: 900, title: 'Void Sage' },
    ],
  },
  crimson_pact: {
    id: 'crimson_pact',
    name: 'Crimson Pact',
    blurb: 'Blood contracts. Mutual benefit or mutual doom.',
    homeZone: 'infernal_highway',
    rivalFactions: ['void_order'],
    alliedFactions: ['ironhollow_guard'],
    colorHex: '#ff4d6d',
    rankTitles: [
      { rep: 100, title: 'Sworn' },
      { rep: 300, title: 'Blade-Bound' },
      { rep: 600, title: 'Pact-Keeper' },
      { rep: 900, title: 'The Crimson' },
    ],
  },
  bone_syndicate: {
    id: 'bone_syndicate',
    name: 'Bone Syndicate',
    blurb: 'Merchants of the dead. They profit from every death.',
    homeZone: 'demon_catacombs',
    rivalFactions: [],
    alliedFactions: ['void_order'],
    colorHex: '#ffe44d',
    rankTitles: [
      { rep: 100, title: 'Debtor' },
      { rep: 300, title: 'Creditor' },
      { rep: 600, title: 'Broker' },
      { rep: 900, title: 'Undying Merchant' },
    ],
  },
  wanderers: {
    id: 'wanderers',
    name: 'The Wanderers',
    blurb: 'No allegiance. They pass through and remember everything.',
    homeZone: 'cursed_forest',
    rivalFactions: [],
    alliedFactions: [],
    colorHex: '#5bd16a',
    rankTitles: [
      { rep: 100, title: 'Drifter' },
      { rep: 300, title: 'Wanderer' },
      { rep: 600, title: 'Pathfinder' },
      { rep: 900, title: 'The Unmapped' },
    ],
  },
};

export const FACTION_IDS = Object.keys(FACTIONS);
export const FACTION_MAX_REP = 1000;
export const FACTION_JOIN_COST_PRESTIGE = 5; // spent from account prestige

export function factionById(id) { return FACTIONS[id] || null; }

// Returns how much of a combat bonus a faction alignment grants in a zone
// controlled by that faction's rival. Range: [-0.2, +0.15].
export function factionZoneMod(factionId, zone) {
  const f = FACTIONS[factionId];
  if (!f) return 0;
  const ctrl = zone.conquestOwner;
  if (!ctrl) return 0;
  if (ctrl === factionId) return 0.15;
  if (f.rivalFactions.includes(ctrl)) return -0.1;
  if (f.alliedFactions.includes(ctrl)) return 0.05;
  return 0;
}

// Deterministic: given a world-tick seed and a zone, which faction
// makes an autonomous "raid" attempt on that zone this tick?
export function pickFactionRaider(worldSeed, zoneTick, candidates) {
  const rng = makeRng(mixSeed(worldSeed >>> 0, zoneTick >>> 0));
  return rng.pick(candidates);
}
```

**Determinism note:** `pickFactionRaider` is deterministic (uses `rng.js:makeRng` + `mixSeed`) and is safe in `shared/`. The world tick uses the current world epoch (an incrementing integer) as the zone-tick seed, stored in world state.

#### Faction Territory Simulation (per world tick)

Each world tick, faction territory resolves as:
1. For each contested zone, roll `pickFactionRaider(worldState.epoch, zone.tick, zone.contestantFactions)` to determine which faction "presses" the zone.
2. Pressing faction's control score increments by `(factionStrength × 0.01)`.
3. If a faction's control score reaches 1.0, `conquestOwner` flips and a world event fires.
4. Player boss_clears in a zone add `+0.05` to their joined faction's score for that zone.
5. Faction strength is computed from: (active player count in zone last hour × 2) + (NPC strength constant).

This creates emergent territorial warfare without any player interaction — factions shift while offline. Players who return find changed zone ownership, which changes their bonuses and the feed displays faction conquest events.

---

### 4. NPC Scheduler

**Extension of:** `shared/agent-world.js:AGENT_MONSTERS` (existing catalog), `shared/storyteller.js:rollEvent` (event engine)

NPCs are persistent entities with a **day-cycle schedule**: position, mood state, inventory, and dialogue history survive world ticks. They are not autonomous delvers — they have fixed behavior patterns (patrol, trade, heal, recruit) keyed to time-of-day (world epoch modulo 24 "hours").

NPC state lives in the world state document under `world.npcs`. Each NPC has:

```
{
  id: 'mira_the_fence',
  factionId: 'bone_syndicate',
  zoneId: 'town',
  schedulePhase: 'day',   // 'day'|'night'|'patrol'|'retreat'
  moodValue: 60,          // 0-100, same scale as player mood
  lastInteractedBy: null, // player login
  lastInteractAt: 0,
  memoryLog: [],          // [{login, eventKind, at}] last 10 interactions
  goods: {},              // item code -> qty (for trade NPCs)
  questActive: null,      // quest id if currently offering a quest
}
```

NPC schedules are defined in `shared/npc-defs.js` (new module, pure ESM, no Node built-ins). Each NPC def includes a `schedule` array mapping epoch-hour to behavior:

```javascript
// shared/npc-defs.js (excerpt)
export const NPC_DEFS = {
  mira_the_fence: {
    id: 'mira_the_fence',
    name: 'Mira the Fence',
    factionId: 'bone_syndicate',
    homeZone: 'town',
    blurb: 'She buys things no one should sell.',
    schedule: [
      { hours: [0,1,2,3,4,5], phase: 'night', zone: 'town', behavior: 'sleep' },
      { hours: [6,7,8,9,10,11], phase: 'day', zone: 'town', behavior: 'trade' },
      { hours: [12,13,14,15,16,17], phase: 'day', zone: 'goblin_warrens', behavior: 'patrol' },
      { hours: [18,19,20,21,22,23], phase: 'night', zone: 'town', behavior: 'trade' },
    ],
    tradeGoods: { common_potion: 30, health_tonic: 80 },
    questPool: ['fence_contract_01', 'rumor_catacombs'],
  },
};
export const NPC_IDS = Object.keys(NPC_DEFS);
```

NPC schedule advance in the world tick is trivially cheap: for each NPC, compute `epochHour = worldState.epoch % 24`, look up the schedule phase, update `npc.schedulePhase` and `npc.zoneId`. No RNG required (schedules are deterministic).

NPC mood drifts slowly each tick based on zone pressure: if the NPC's current zone has pressure ≥ 0.7, their mood drops 2 points/tick (they're frightened). If a player recently interacted and got a "good" outcome, mood recovers 5 points. This creates emergent states — an NPC who hasn't been talked to in hours slowly gets grumpy.

---

### 5. Persistent Market

**Extension of:** `shared/loot.js:sellValue` (existing valuation), `shared/loot.js:itemPower` (item comparison), `server/store.js` (new market document)

The market is a global supply/demand curve for each gear slot + rarity tier, not a full auction house. Players posting items to the market create supply; world demand ticks downward each hour (items become "stale"). Price is derived from `loot.js:itemPower` × demand scalar.

Market document in store:

```
// data/market.json (new store document)
{
  listings: [
    {
      id: 'lst_abc123',
      sellerLogin: 'darkwing42',
      item: { ...full item object },
      askPrice: 840,
      postedAt: 1717000000000,
      expiresAt: 1717604800000,  // 7-day TTL
      factionBonus: 'ironhollow_guard', // if seller has faction, buyer of same faction gets -10%
    }
  ],
  priceIndex: {
    // slot:rarity -> { recentSales: [{price, at}], movingAvg }
    'weapon:legendary': { recentSales: [], movingAvg: 1200 },
  }
}
```

**Per world tick:** expire listings past TTL, recompute moving averages, update `priceIndex`. Market is small at launch (capped at 200 active listings), cheap to process.

**No peer-to-peer RNG in market logic.** `askPrice` is set by the player (server validates against floor = `sellValue(item) × 0.5`, ceiling = `itemPower(item) × 3`). The moving average is a simple arithmetic mean of last 20 sales — no RNG, no shared determinism requirements.

**Integration with progression:** `server/server.js:POST /api/market/post` → validates item is in player's inventory → moves item from character inventory to market listing → removes from character via `store.putPlayer`. On purchase: gold transfer, item moves to buyer inventory, XP grant via `gainXp`.

---

### 6. World Event Queue

**Extension of:** `shared/storyteller.js:rollEvent` (per-player storyteller), `shared/constants.js:FEED_KINDS`

World events are **cross-player** — they affect all sigmas in a zone, not just one. They fire from the world tick and persist in a queue read by `delveTick` on the next player tick.

World event kinds (new `WORLD_EVENT_KINDS` constant):
- `faction_conquest` — a faction captures a zone
- `zone_eruption` — zone pressure ≥ 0.95, forced boss spawn world-wide
- `merchant_festival` — Bone Syndicate seasonal: gold values +25% for 1 hour
- `plague_wind` — all sigmas in a zone have 15% chance to contract disease on next tick
- `elder_drop` — rare: a legendary item appears as an unclaimed drop in a zone for 10 minutes
- `armistice` — two rival factions pause war for 1 hour (random event, zone pressure -0.3)

World events are stored as pending effects in `world.eventQueue`. When `delveTick` runs for a player in a zone that has pending world events, the event descriptor is applied in front of the encounter (same as storyteller events) and consumed from the queue.

```javascript
// shared/world-events.js (new, pure ESM, deterministic RNG-clean)
export const WORLD_EVENT_KINDS = [
  'faction_conquest', 'zone_eruption', 'merchant_festival',
  'plague_wind', 'elder_drop', 'armistice'
];

// Apply a world event effect to a single player's run state.
// Returns an effect descriptor matching storyteller.js shape.
export function applyWorldEvent(worldEvent, character, run) {
  switch (worldEvent.kind) {
    case 'plague_wind': return { disease: 'flu', text: worldEvent.text };
    case 'merchant_festival': return { gold: Math.round(character.gold * 0.05), text: worldEvent.text };
    case 'zone_eruption': return { dangerDelta: 0.25, text: worldEvent.text };
    case 'elder_drop': return { loot: [worldEvent.item], text: worldEvent.text };
    default: return {};
  }
}
```

`delveTick` integration point (line ~302 in `shared/progression.js`, after `maybeRollStoryteller`):

```javascript
// Inside delveTick, after maybeRollStoryteller, before buildEncounter:
const worldEvents = run._pendingWorldEvents || [];
run._pendingWorldEvents = [];  // consume once
for (const we of worldEvents) {
  const eff = applyWorldEvent(we, character, run);
  // apply same way as storyteller effects (lines 481-504)
}
```

The server populates `run._pendingWorldEvents` during the save mutation path (when `store.getPlayer` is called before a `POST /api/chat-ping`, inject world events for the player's current zone). This field is ephemeral — never persisted (the underscore prefix convention). The validator in `validate.js:vRun` must ignore it (treat `_pendingWorldEvents` as a stripped field).

---

### 7. Chat Commands for World Interaction

**Extension of:** `server/server.js` route table, chat-elixir bridge (`bridge.ex` POST /api/chat-ping)

New chat commands are new HTTP endpoints. Chat-elixir forwards them from Twitch chat as `POST /api/cmd/:kind/:login`. This keeps the MMO as the source of truth and chat-elixir as a thin forwarder.

| Command | Endpoint | Effect |
|---|---|---|
| `!join <faction>` | `POST /api/cmd/faction-join/:login` | Spend 5 prestige to join a faction; sets `character.factionId` |
| `!rep` | `GET /api/sigma/:login` (existing) | Chat-elixir reads `character.factionRep` and formats reply |
| `!market` | `GET /api/market/summary` | Returns top 5 cheapest items by slot; chat-elixir formats reply |
| `!sell` | `POST /api/market/post/:login` | Posts top inventory item to market at auto-calculated price |
| `!buy <id>` | `POST /api/market/buy/:login` | Purchases a market listing by short id |
| `!zone` | `GET /api/world/zones` | Returns zone pressure + faction control for all zones |
| `!npc <name>` | `GET /api/world/npc/:id` | NPC current state (location, mood, goods) |

All new endpoints go through `guard(where, handler)` and validate inputs via `validate.js` primitives.

**Throughput:** !rep and !zone are read-only and O(1). !join and !sell mutate one player record. !market and !buy require a market document read. At thousands of chatters, deduplicate via the existing `raidState` coalescing pattern — cache GET responses for 2 seconds before re-reading store.

---

## Data Model

### RUN vs ACCOUNT vs WORLD Split

The split extends cleanly:

| Field | Lives On | Destroyed by permadeath? |
|---|---|---|
| `factionId` | CHARACTER (account) | No |
| `factionRep` | CHARACTER (account), object `{factionId: rep}` | No |
| `factionPledgedAt` | CHARACTER (account) | No |
| `marketListings[]` | WORLD store document | No — independent of character |
| `worldZoneFlags` | CHARACTER (account), zone bonuses cache | No |
| NPC memory of player | WORLD store document (npc.memoryLog) | No |
| Zone pressure | WORLD store document | No |
| Faction territory | WORLD store document | No |
| `run._pendingWorldEvents` | RUN (ephemeral, underscore-prefixed) | Yes (ephemeral, not persisted) |

### New Character Account Fields

Added to `freshCharacter()` output and validated in `validate.js:vCharacter`:

```javascript
// In freshCharacter(seed, name):
character.factionId = null;           // string: faction id or null
character.factionRep = {};            // { [factionId]: number 0-1000 }
character.factionPledgedAt = null;    // timestamp of faction join
character.factionQuestsCompleted = 0; // lifetime count
character.marketListingIds = [];      // active listing ids (max 5)
```

### New World State Document

`server/store.js` gains `getWorldState()` / `putWorldState()` backed by `data/world.json`:

```javascript
// World state document shape
{
  epoch: 0,            // incrementing world tick counter
  worldSeed: 12345,    // fixed at server first-start, never changes
  zones: {
    goblin_warrens: {
      pressure: 0.3,
      conquestOwner: null,
      conquestSince: 0,
      contestantFactions: ['ironhollow_guard', 'void_order'],
      killsThisHour: 0,
      deathsThisHour: 0,
      lastPlayerAt: 0,
      resourceNodes: {
        goblin_ore: { qty: 100, maxQty: 100, regenPerTick: 2, depletedAt: null },
      },
    },
    // ... one entry per ZONE_IDS entry
  },
  factions: {
    ironhollow_guard: {
      strength: 1.0,        // 0-2 scalar, starts at 1.0
      activePlayers: 0,     // players with this factionId online recently
      zoneScores: {         // zone -> control score 0-1
        goblin_warrens: 0.5,
      },
    },
    // ... one entry per FACTION_IDS
  },
  npcs: {
    mira_the_fence: {
      schedulePhase: 'day',
      zoneId: 'town',
      moodValue: 62,
      lastInteractedBy: null,
      lastInteractAt: 0,
      memoryLog: [],
      goods: { common_potion: 30 },
      questActive: null,
    },
  },
  eventQueue: [
    // { id, kind, zoneId, effect, expiresAt, broadcastAt }
  ],
  market: {
    listings: [],
    priceIndex: {},
  },
  lastTickAt: 0,
  nextTickAt: 0,
}
```

### New Store Functions (server/store.js additions)

```javascript
export function getWorldState() { ... }  // reads data/world.json
export function putWorldState(ws) { ... } // writes atomically, sets worldDirty
export function notifyZoneEvent(ev) { ... } // appends to world.zones[zoneId] event buffer
```

---

## New Shared Modules

### `shared/factions.js`

**Deterministic: yes** (catalog definitions + `pickFactionRaider` uses `makeRng`/`mixSeed`)

Proposed exports:
```javascript
export const FACTIONS          // catalog object
export const FACTION_IDS       // string[]
export const FACTION_MAX_REP   // 1000
export const FACTION_JOIN_COST_PRESTIGE // 5
export function factionById(id)
export function factionRankTitle(factionId, rep)   // title string for rep threshold
export function factionZoneMod(factionId, zone)    // combat modifier -0.2..+0.15
export function rivalMod(factionId, targetFactionId) // -0.1 if rivals
export function pickFactionRaider(worldSeed, zoneTick, candidates) // deterministic pick
export function repGainForBossClear(factionId, zone) // number
export function repGainForNpcInteract(npcFactionId, playerFactionId) // number
```

### `shared/npc-defs.js`

**Deterministic: yes** (pure catalog, no RNG)

Proposed exports:
```javascript
export const NPC_DEFS          // catalog object
export const NPC_IDS           // string[]
export function npcById(id)
export function npcSchedulePhase(npcId, epochHour)  // { phase, zoneId, behavior }
export function npcTradeGoods(npcId)                // { code: basePrice }
export function npcMoodDrift(npc, zonePressure)     // number: mood delta this tick
```

### `shared/world-events.js`

**Deterministic: yes** (applies effects deterministically; event generation uses seeded RNG)

Proposed exports:
```javascript
export const WORLD_EVENT_KINDS  // string[]
export function applyWorldEvent(worldEvent, character, run)  // effect descriptor
export function worldEventText(kind, context)                // display string
export function rollWorldEvent(worldSeed, epoch, zones, factions)  // generates next event or null
```

### `server/world-tick.js`

**Deterministic: no** (runs on wall clock; each tick advances epoch and persists)

Proposed exports:
```javascript
export function startWorldTick(rt)          // mounts superviseInterval
export function worldTick(rt)               // one tick (exported for testing)
export function worldPulseSummary(ws)       // { epoch, pressure map, faction map }
// Internal:
function advanceFactions(ws)
function advanceZones(ws)
function advanceNpcSchedules(ws)
function advanceMarket(ws)
function generateWorldEvents(ws)
```

### `server/market.js`

**Deterministic: no** (wall-clock timestamps, UUID listing ids)

Proposed exports:
```javascript
export function postListing(sellerLogin, item, askPrice, factionId)  // returns listing id
export function buyListing(listingId, buyerLogin, buyerCharacter)     // returns { item, goldSpent }
export function getMarketSummary(slotFilter, limit)                   // public listing view
export function expireListings(market)                                // called by world tick
export function recomputePriceIndex(market)                           // moving average update
export const MARKET_LISTING_MAX     // 200
export const MARKET_LISTING_TTL_MS  // 7 * 24 * 3600 * 1000
export const MARKET_LISTING_PER_PLAYER_MAX  // 5
```

---

## New HTTP Endpoints / Chat Commands

| Verb | Kind | Path | Body | Effect |
|---|---|---|---|---|
| POST | http | `/api/cmd/faction-join/:login` | `{ factionId }` | Deducts 5 prestige, sets `character.factionId`, grants 50 starting rep; validates faction enum |
| POST | http | `/api/cmd/faction-leave/:login` | `{}` | Clears `character.factionId`; halves rep; costs 10 prestige |
| GET | http | `/api/world/zones` | — | Returns zone pressure + conquest owner for all zones; 2s cached |
| GET | http | `/api/world/npc/:id` | — | NPC current state: zone, mood, goods, schedule phase |
| POST | http | `/api/world/npc/:id/interact/:login` | `{ kind }` (trade\|talk\|quest) | NPC interaction: updates npc.memoryLog, returns dialogue + offer |
| POST | http | `/api/market/post/:login` | `{ itemIndex, askPrice? }` | Posts item at index from player inventory to market |
| GET | http | `/api/market` | — | Returns listings (paginated, 20/page); public |
| POST | http | `/api/market/buy/:login` | `{ listingId }` | Purchases listing; atomic gold transfer + item move |
| GET | http | `/api/market/summary` | — | Top 5 cheapest per slot (for chat !market command) |
| GET | http | `/api/world/factions` | — | Faction territory map + strength |
| GET | http | `/api/world/events` | — | Recent world events (last 20) |
| POST | http | `/api/world/zone-event` (internal, HMAC-signed) | `{ kind, zoneId, login? }` | Server-to-server: boss_clear, death, etc. notified from delveTick path |

**Chat commands map to HTTP:** chat-elixir's `Chat.Mmo.Bridge` already forwards all chat to `/api/chat-ping/:login`. New commands require new routing in bridge.ex to POST dedicated endpoints instead of the generic ping, or the MMO server can parse a `cmd` field in the chat-ping body (lower-friction option).

---

## New Constants (additions to `shared/constants.js`)

```javascript
// World tick
export const WORLD_TICK_MS = 60_000;           // 1 world minute = 1 real minute
export const WORLD_EPOCH_HOUR = 60;            // ticks per "world hour" (60 minutes)
export const WORLD_ZONE_PRESSURE_MAX = 1.0;
export const WORLD_ZONE_PRESSURE_DECAY = 0.003; // per tick, base decay
export const WORLD_ZONE_ERUPTION_AT = 0.95;    // pressure threshold for world event

// Faction
export const FACTION_IDS = [/* filled by shared/factions.js */];
export const FACTION_REP_MAX = 1000;
export const FACTION_JOIN_PRESTIGE_COST = 5;
export const FACTION_REP_BOSS_CLEAR = 20;      // rep gained for boss_clear in faction zone
export const FACTION_REP_DEATH_IN_ZONE = 5;    // rep gained for dying in a hostile zone (sacrifice recognized)

// Market
export const MARKET_LISTING_MAX = 200;
export const MARKET_LISTING_PER_PLAYER = 5;
export const MARKET_TTL_MS = 7 * 24 * 3600 * 1000;
export const MARKET_PRICE_FLOOR_MUL = 0.5;     // of sellValue(item)
export const MARKET_PRICE_CEIL_MUL = 3.0;      // of itemPower(item)

// NPC
export const NPC_MOOD_DECAY_PER_TICK = 0.5;    // mood drift toward neutral each tick
export const NPC_PRESSURE_MOOD_DRAIN = 2.0;    // mood drop per tick in high-pressure zone

// Feed kinds (appended to FEED_KINDS in constants.js)
// 'faction_conquest', 'zone_eruption', 'market_sale', 'npc_quest_complete'
```

---

## Validation Additions (`server/validate.js`)

Every new account field must be validated or it is silently dropped. Required additions to `vCharacter`:

```javascript
// In vCharacter(raw):
c.factionId = raw.factionId ? vEnum(raw.factionId, FACTION_IDS, null) : null;
c.factionRep = vFactionRep(raw.factionRep);   // new helper
c.factionPledgedAt = raw.factionPledgedAt ? vNum(raw.factionPledgedAt, 0, 1e15, 0) : null;
c.factionQuestsCompleted = vInt(raw.factionQuestsCompleted, 0, 1e6, 0);
c.marketListingIds = vArr(raw.marketListingIds || [], (x) => vStr(x, 1, 40)).slice(0, 5);

function vFactionRep(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const id of FACTION_IDS) {
    if (raw[id] !== undefined) out[id] = vInt(raw[id], 0, FACTION_REP_MAX, 0);
  }
  return out;
}
```

`vRun` additions: strip `_pendingWorldEvents` (ephemeral field — never trust client-sent value):

```javascript
// In vRun(r):
delete r._pendingWorldEvents; // always ephemeral, never accept from client
```

---

## Scaling & Anti-Abuse

### Thousands of Chatters

**Chat-ping cost:** The existing `/api/chat-ping` path is already O(1) per message (arena.pingChatter → raid.consumeChatTicks). Adding faction reputation grants happens only on boss_clear events (rare relative to chat volume), not on every ping. World events are injected into `run._pendingWorldEvents` at player save-read time, not per-message.

**Coalesce:** Zone events from boss_clears are batched in `store.notifyZoneEvent()` and consumed by the world tick in bulk. No per-event world state write. At 1000 chatters with a 5% boss_clear rate over 60s, that's ~50 zone events per world tick — trivially cheap to process in batch.

**Market reads:** Cached for 2 seconds server-side before re-reading the market document. At 1000 `!market` requests per minute, that's at most 500 real reads/minute against a small JSON document.

**Faction join/leave:** Rate-limited via the existing per-connection WS rate limiter (40 messages per 10 seconds). A new middleware check in the join/leave endpoints adds a 30-second per-login cooldown (`raidState`-style timestamp map, in-memory).

**NPC interact:** 5-second cooldown per (login, npcId) pair tracked in a small in-memory LRU (max 2000 entries, evict oldest). Chat-driven NPC spam cannot DOS the NPC state.

### World Tick Under Load

The world tick runs every 60 seconds under `superviseInterval`. One tick processes:
- 5 zones × faction scoring = 25 ops
- ~20 NPCs × schedule lookup = 20 ops
- Market expiry scan = O(listings), capped at 200
- World event generation = O(1) (one event roll per epoch)

Total: ~500 operations per tick, none of which involve disk I/O until `putWorldState()` at the end. The world state JSON is small (~50 KB). Atomic write via `writeJsonAtomic` (tmp + rename) takes <5ms on SSD.

### Determinism Boundary

Only `shared/` modules are deterministic. Server-side world tick is NOT deterministic — it uses wall clock. This is correct: the world tick is intentionally non-reproducible (it advances based on real time, not seeded simulation). What IS deterministic:

- `pickFactionRaider(worldSeed, epoch, candidates)` — given the same worldSeed and epoch, always picks the same faction. This makes faction behavior auditable/debuggable.
- `rollWorldEvent(worldSeed, epoch, ...)` — same: given the same epoch, same event rolls.
- `npcSchedulePhase(npcId, epochHour)` — pure deterministic mapping.

Player-side: `delveTick` determinism is preserved. The `_pendingWorldEvents` field injected by the server is consumed once and never persists (never touches `run.rngState`). World event effects use the same effect-descriptor shape as storyteller events (lines 481–504 of `progression.js`) — they are applied after all RNG draws, so they cannot desync the RNG stream.

---

## Balance Numbers (Anchored to Existing Constants)

| Parameter | Value | Rationale |
|---|---|---|
| `WORLD_TICK_MS` | 60,000 ms | "1 world minute" feels live; 1440 ticks/day = 1440 world advances |
| Zone pressure growth rate | +0.003/tick (unclaimed) | Reaches 0.95 eruption in ~316 minutes = ~5 hours of neglect |
| Zone pressure relief per boss_clear | -0.008 | ~4 boss clears in an hour neutralizes natural growth |
| Faction territory conquest threshold | control score 1.0 | At +0.05/boss_clear and 0.01/autonomous tick: ~12 clears OR ~100 world minutes for autonomous flip |
| `FACTION_JOIN_PRESTIGE_COST` | 5 | Milestone 1 (Survivor) is 10 prestige — joining costs half a milestone |
| `FACTION_REP_BOSS_CLEAR` | 20 | Rank 1 title (100 rep) = 5 boss clears; Rank 4 (900 rep) = 45 boss clears at max level |
| Market listing TTL | 7 days | Long enough items don't feel wasted; short enough stale listings clear |
| Market listing cap per player | 5 | Prevents warehouse hoarding; encourages active selling |
| NPC mood decay | 0.5/tick | At 60 ticks/hour, untouched NPC goes from 60 to ~30 in 1 hour = "getting grumpy" |
| World event queue cap | 10 events per zone | Prevents event spam during faction wars; oldest consumed first |

---

## New Feed Kinds

Add to `FEED_KINDS` in `shared/constants.js` (also add to `validate.js:vFeedEvent` enum):

```javascript
export const FEED_KINDS = [
  // existing
  'death', 'legendary', 'ascend', 'boss', 'milestone',
  // new
  'faction_conquest',   // faction captures a zone
  'zone_eruption',      // zone pressure maxed out
  'market_sale',        // legendary+ item sold on market
  'npc_quest_complete', // player completed an NPC quest
  'faction_join',       // player joined a faction (display name + faction)
  'world_event',        // generic world event broadcast
];
```

---

## Integration Points with Existing Code

### `shared/progression.js:delveTick`

Injection point at line ~302 (after `maybeRollStoryteller`, before `buildEncounter`):

```javascript
// Inject pending world events into this tick
if (run._pendingWorldEvents?.length) {
  for (const we of run._pendingWorldEvents) {
    const eff = applyWorldEvent(we, character, run);
    // apply using same pattern as lines 481-504 (storyteller effects)
    if (eff.dangerDelta) run.danger = Math.max(0, Math.min(DANGER_MAX, run.danger + eff.dangerDelta));
    if (eff.gold) character.gold += Math.round(eff.gold * econ.goldMul);
    if (eff.disease && !run.diseases?.[eff.disease]) infect(run, character, eff.disease);
    if (eff.loot) { for (const item of eff.loot) { /* same inventory logic */ } }
    if (eff.moodThought && character.mood) addMoodThought(character.mood, character, eff.moodThought);
  }
  run._pendingWorldEvents = [];
}
```

### `shared/progression.js:resolveDeath`

After prestige mint and before `freshRun`, notify zone of death:
```javascript
// server-side only (called from server routes, not shared/ pure functions)
// The server wraps resolveDeath and calls:
store.notifyZoneEvent({ zoneId: run.zone, kind: 'death', login: character.name });
```

This stays server-side; `resolveDeath` itself stays pure (no store imports in shared/).

### `shared/progression.js:deployToZone`

After setting `run.zone = zoneId`, apply faction zone modifier to starting stats:
```javascript
// deployToZone additions (server-side wrapper, not in shared/):
const worldZone = store.getWorldState()?.zones?.[zoneId];
const fmod = factionZoneMod(character.factionId, worldZone);
// Store as run._factionZoneMod (ephemeral, applied in derive() if exposed)
```

Alternatively: `derive()` in `stats.js` is the cleanest integration point — add `factionZoneMod` to the derived sheet as `sheet.factionZoneMod` by passing it in via `run._factionZoneMod`. Stats.js stays pure (receives the mod as data, doesn't import store or factions).

### `server/server.js` supervisor loops

Add two new `superviseInterval` calls in server startup:

```javascript
// After existing superviseInterval calls
const stopWorldTick = startWorldTick(rt);
onShutdown(() => { stopWorldTick(); store.flush(); });

// Market expiry (every 5 minutes — cheaper than world tick)
superviseInterval('market.expire', () => {
  const ws = store.getWorldState();
  expireListings(ws.market);
  store.putWorldState(ws);
}, 5 * 60_000);
```

### `server/validate.js:vCharacter`

Add the faction/market field validators as specified in the Data Model section above. Import `FACTION_IDS` from `shared/factions.js` (new).

### `server/realtime.js:leaderboard`

Extend the leaderboard map to include `factionId` and `factionRep` for the display layer:

```javascript
.map((c) => ({
  // existing fields...
  factionId: c.factionId || null,
  topFactionRep: c.factionId ? (c.factionRep?.[c.factionId] || 0) : 0,
}))
```

---

## Cross-Agent Dependencies

| Dependency | Agent Key | Why |
|---|---|---|
| Faction reputation unlocks and faction-gated content (quests, recipes) | `npc` (Agent 7) | NPC defs reference faction IDs; NPC quest rewards need to grant faction rep via `grantRepForQuest(login, factionId, amount)` endpoint |
| Economy: market price floors/ceilings anchored to item value | `economy` (Agent 2) | `sellValue()` and `itemPower()` are Agent 2's balance domain; market price bounds must be co-designed to not undercut or inflate the gold economy |
| Narrative: world events should feed the narrative engine | `narrative` (Agent 3) | `faction_conquest` and `zone_eruption` events are narrative beats — Agent 3 should define the text/lore surface; world-events.js defers `worldEventText(kind, context)` to Agent 3's narrative catalog |
| Retention: faction rank titles are a retention loop | `retention` (Agent 4) | Faction rank titles (Recruit → Champion) are milestone-style unlock beats; Agent 4 should define the prestige/engagement cadence so faction progress dovetails with battle pass / weekly goals |
| Twitch interaction: !join, !rep, !sell commands | `twitch` (Agent 5) | Agent 5 owns the Twitch command surface and chat-elixir routing; the MMO server exposes the endpoints but Agent 5 decides the reply format, cooldown messaging, and Twitch redemption hooks |
| NPC schedule + behavior | `npc` (Agent 7) | NPC_DEFS is authored by Agent 7; world-tick.js calls `npcSchedulePhase` but the schedule catalog content is Agent 7's domain |

---

## Open Conflicts

1. **Market vs Economy balance:** Agent 2 (economy) designs the gold economy. A player-driven market could deflate or inflate item prices relative to the NPC sell curve (`sellValue()`). Need agreement on whether market price floors are anchored to `sellValue` (conservative, safe) or `itemPower` (aggressive, story-rich). This doc proposes `sellValue × 0.5` as floor — Agent 2 must ratify.

2. **Faction join cost in prestige:** 5 prestige = half of the first milestone. If Agent 4 (retention) designs the first prestige milestone as a major moment, spending prestige on faction join may feel punitive for new players. Alternative: faction join is free but leaving costs prestige. Needs resolution with Agent 4.

3. **Faction rep + skill XP interaction:** Agent 1 (systems) may want faction rep to act as a skill-like system with passion flames. If so, `factionRep` should be stored in the skills structure and use `grantSkillXp` (skills.js) rather than a custom object. This design keeps them separate for simplicity; Agent 1 must decide.

4. **World event queue delivery:** This design uses `run._pendingWorldEvents` injected server-side at save-read time. An alternative is to deliver world events via the WS broadcast (`rt.broadcast`) and have the client apply them. The WS approach is simpler for the client but breaks offline-sim determinism (client can miss broadcasts). Server-injection is more complex but offline-safe. The WS approach is sufficient if we accept that offline players miss world events (reasonable for v1).

5. **NPC quest system scope:** NPC quests are referenced (`npc.questActive`, `questPool`) but the quest schema is not specified here — that is Agent 7's (npc) charter. This document reserves the fields and the `npc_quest_complete` feed kind. Agent 7 must define `shared/quests.js` and call `store.notifyZoneEvent` on quest completion.

6. **Market listings in store.js vs separate file:** This design stores market inside the world state JSON. At scale (200 listings × 5 KB/listing = ~1 MB world.json), this may become slow to atomic-write. Recommendation: split to `data/market.json` as a separate store document. Agent 2 should decide based on expected listing volume.

---

## Success Criteria

1. **Zone pressure advances while offline.** After server runs for 1 hour with no players online, all zones should have `pressure` values different from their starting state. Verified by querying `GET /api/world/zones` at start and after 1 hour.

2. **Faction conquest fires and broadcasts.** With two factions contesting a zone and player boss_clears feeding one faction, the controlling faction flips within a session. The `faction_conquest` feed event appears in `GET /api/feed` and a WS `worldPulse` broadcast confirms the flip.

3. **World event delivered to delveTick.** Manually insert a `plague_wind` world event for `goblin_warrens`. A player delving there within the next tick receives the disease effect (verified via disease list in character state).

4. **Market post + buy roundtrip.** Player A posts a legendary item via `POST /api/market/post`. Player B queries `GET /api/market`. Player B purchases via `POST /api/market/buy`. Item moves from A's inventory to B's inventory; gold transfers correctly.

5. **Faction join persists across permadeath.** Player joins `ironhollow_guard` (factionId set on character). Character dies (resolveDeath called). After freshRun, `character.factionId` is still `ironhollow_guard` (it's account-side, not run-side).

6. **NPC schedule advances on world tick.** After 6 world ticks (6 minutes real time), NPCs whose schedule puts them in a different zone during that epoch hour should show the updated `zoneId` in `GET /api/world/npc/:id`.

7. **World tick does not block the event loop.** World tick must complete in under 50ms (measurable via `console.time` in `worldTick`). At 500 entity operations, this is easily achievable without async I/O in the hot path.

8. **Chat command throughput.** `!zone` command (GET /api/world/zones) handles 1000 requests/minute without degrading other endpoints. Verified by load-testing with k6 or similar (not on streaming box — run on a separate machine).

9. **Validation rejects bad faction id.** `POST /api/cmd/faction-join/:login` with `{ factionId: 'evil_hax' }` returns a `ValidationError` / 400, not a server error.

10. **Offline sim parity maintained.** Run `pnpm run smoke` — the headless deterministic smoke test must still pass. No new RNG draws introduced in `shared/` that use `Math.random()`. Confirmed by grepping shared/ for `Math.random` (must return zero results).
