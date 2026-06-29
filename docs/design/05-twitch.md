# 05 — Twitch MMO Interaction Design

Agent 5 — Twitch MMO Interaction Designer  
`docs/design/05-twitch.md`

---

## Overview

SIGMA ABYSS is fundamentally a **chat-first game**. The primary input device is Twitch chat. Tens — eventually thousands — of chatters will interact simultaneously, and the system must make every single line of chat feel consequential while keeping per-message server work cheap enough to handle bursts without compute spikes.

The existing pipe already works: `Chat.Mmo.Bridge` (chat-elixir:`lib/chat/mmo/bridge.ex`) subscribes to every incoming Twitch message and POSTs to `POST /api/chat-ping/:login` on the MMO server, coalescing bursts per-login into a `lines: N` body. The raid state machine (`server/raid-state.js`) translates chat cadence into weapon swings via `chatsPerSwing(speedMul)`. The arena roster (`server/arena.js`) tracks all active chatters with `pingChatter(login, source)` and runs round-robin auto-battle spectacle via `tick()`.

What is missing is the **command layer**: a rich vocabulary that transforms passive chatters into active players. This document specifies that layer end-to-end — commands, voting systems, crowd events, faction mechanics, and anti-abuse strategy — designed as additive extensions to the existing codebase.

### Design Principles Applied

- Every chat message already drives arena swings — commands expand what that engagement *means*.
- Commands must dispatch in < 5ms per message. All heavy work (persistence, broadcasts) happens after the HTTP response returns.
- Failure creates opportunity: !raid defeat = grief event + revenge quest seed.
- Social reputation is visible: chat sees skill announcements, prestige unlocks, faction declarations.
- Scarcity drives action: faction seats are capped, trade offers expire, vote windows close.

---

## Mechanics

Each mechanic is grounded in a real existing export, designed as an extension rather than a replacement.

### 1. Command Dispatch Layer

**How it works today**: `POST /api/chat-ping/:login` is the sole inbound command path. It mints sigmas, drives arena swings, and handles raid engagement. Commands like `!fight` redirect to `POST /api/raid/fight/:login`.

**Extension**: A new `server/commands.js` module intercepts commands embedded in the `text` field forwarded from `Chat.Mmo.Bridge`. The bridge already sees the raw message text — we add a new field `cmd` and `args` to the ping body. The MMO server dispatches on `cmd` after the base chat-ping work completes.

**Chat-elixir change**: `lib/chat/mmo/bridge.ex` adds a minimal command parser. If `text` starts with `!`, extract `cmd = hd(parts)` and `args = tl(parts)`, include in the POST body as `{lines, cmd?, args?}`. This is the only change needed in chat-elixir — the MMO is the source of truth for all command effects.

**Rate limit**: The bridge's existing 8s coalesce window (`@cooldown_ms 8_000`) provides natural rate-limiting for most commands. Commands that are inherently expensive (e.g., `!craft`) get an additional server-side per-login cooldown enforced in `server/commands.js` independently of the coalesce window.

### 2. !join / Identity

**Grounded in**: `resolveTwitchSigma(login)` in `server/server.js`; `freshCharacter(seed, name)` in `shared/progression.js`.

**What it does**: Minting already happens automatically on first chat-ping. `!join` is a *vanity command* that gives a new player an explicit acknowledgment — chat sees their sigma's traits and backstory teaser announced in the feed. No mechanical difference from auto-mint, just social ceremony.

**Feed entry**: `{ kind: "player_join", login, name, traits: traitNames(character.traits), backstoryTeaser }`. This entry is broadcast via `rt.broadcast({ t: "feed", entry })`.

**Implementation**: `POST /api/cmd/join/:login` — calls `resolveTwitchSigma(login)`, reads `character.traits` and `backstoryBio(childhood, adulthood)` from `shared/backstory.js`, pushes feed. Response: `{ ok, isNew, sigma: { name, level, traits, backstory } }`.

### 3. !sigma / !loot / !status (Read Commands)

**Grounded in**: `GET /api/sigma/:login` already exists; `derive(run, character)` in `shared/stats.js`; `injuryList(run)` in `shared/health.js`; `diseaseList(run)` in `shared/diseases.js`.

**Extension**: Chat-elixir's Twitch bot (`lib/chat/bots/twitch.ex`) should respond to these commands by calling the MMO server and posting a formatted reply to chat. The MMO server provides the data; the bot formats the string.

- `!sigma` → level, zone, HP, prestige, title
- `!loot` → top 2 inventory items by `itemPower(item)` (from `shared/loot.js`)
- `!status` → active diseases (`diseaseList(run)`), active injuries (`injuryList(run)`), mood band (`moodBand(value)` from `shared/mood.js`)
- `!skills` → skill levels for the 8 `SKILL_IDS`, highlighting passion flames

All are read-only HTTP GETs. No state mutation. They serve as onboarding — spectators learn the game exists by seeing other chatters' stats scrolling by.

### 4. !fight (Existing, Extended)

**Grounded in**: `POST /api/raid/fight/:login`; `raidState.engage(login, weapon)` in `server/raid-state.js`; `fireRaidSwing(login, source)` in `server/server.js`.

**Extension — faction bonuses**: When factions are added (see Data Model), `fireRaidSwing` checks `character.factionId` against `currentRaid.boss_id`. If the faction has a declared rivalry with the boss type (stored in `FACTION_DEFS` in the new `shared/factions.js`), apply a +15% attack multiplier. This is computed inside the existing `derive(run, character)` path via a new `factionMods(character.factionId, bossId)` function in `shared/factions.js`.

**Extension — tier challenges**: A new `!fight hard` variant requests an elite encounter instead of the next FIGHT_MONSTER_POOL entry. Server bumps `DANGER_ELITE_AT` threshold locally for that encounter roll. Returns higher XP via `RAID_XP_MULT * 1.4`.

### 5. !gather (New — Crowd Resource Mechanic)

**Grounded in**: `AGENT_RESOURCES` in `shared/agent-world.js`; `store.pushFeed` in `server/store.js`; `superviseInterval` in `server/supervisor.js`.

**What it does**: Opens a 60-second gathering window for a named resource. Chatters type `!gather wood` / `!gather ore` / `!gather herbs`. Each unique chatter who types the command during the window contributes 1 unit. The aggregate total is deposited into a **world resource pool** in `data/world-state.json` (a new store-backed document). Resources are consumed by crafting (`!craft`) and faction projects.

**Anti-spam**: Each login can contribute to a resource at most once per window (server dedupes). The window itself is rate-limited: no new gather window opens within 5 minutes of the previous one (per resource type). Maximum 200 unique contributors per window (GATHER_MAX_CONTRIBUTORS = 200) — beyond that, extras are accepted but contribute 0 units (still feel included).

**Endpoint**: `POST /api/cmd/gather/:login` body `{ resource }`. Validates resource against `AGENT_RESOURCES` enum. Updates in-memory gather window state. After window expires (superviseInterval check every 10s), commits result to world store.

**Feed event**: `{ kind: "gather_complete", resource, units, contributors, at }` — crowd sees what they collectively harvested.

### 6. !craft (New — World Progression)

**Grounded in**: `AGENT_RECIPES` in `shared/agent-world.js`; `resolveTwitchSigma(login)` in `server/server.js`; `rollDrop(rng, level, depth, bias, slot)` in `shared/loot.js`.

**What it does**: A chatter spends their own gold to craft an item from a recipe. Recipes require world resources (from `!gather`) plus gold. Output is a specific item type with rarity determined by a roll through `rollRarity(rng, bias)`. Items are added to the chatter's `character.run.inventory` (bounded by `INVENTORY_MAX = 40` from `shared/constants.js`).

**Crafting recipes**: Defined in `shared/factions.js` as `CRAFT_RECIPES` (deterministic, not seeded per-call — the output rarity *is* seeded per call using the chatter's `run.rngState` for consistency). Example: `{ id: "iron_sword", inputs: { ore: 3, gold: 50 }, outputSlot: "weapon", rarityBias: 1 }`.

**Endpoint**: `POST /api/cmd/craft/:login` body `{ recipe_id }`. Validates world resources are available (deducted from world pool), deducts gold from `character.gold`, generates item via `rollDrop`, appends to inventory. Response: `{ ok, item, goldSpent, worldResourcesUsed }`.

**Rate limit**: One craft per login per 30 seconds (server-side cooldown in `commands.js` state).

### 7. !trade (New — Player Economy)

**Grounded in**: `store.getPlayer(token)` / `store.putPlayer(token, character)` in `server/store.js`; `itemPower(item)` in `shared/loot.js`; `sellValue(item)` in `shared/loot.js`.

**What it does**: Two-step trade protocol. `!trade offer <item_index> <asking_gold>` posts a trade listing. `!trade accept <login>` accepts the top-listed offer from that chatter. Trade is atomic — both characters are loaded, items swapped, gold transferred, both saved.

**Safety**: Item index validated against `character.run.inventory` length. Gold check: buyer must have `asking_gold` in `character.gold`. Starter gear is flagged `starter: true` and cannot be traded (same check used by existing weapon upgrade endpoint). No trading run-ephemeral items — trades only happen between non-starter items.

**Expiry**: Trade offers expire after 120 seconds. `superviseInterval("trade.reap", fn, 30_000)` cleans stale offers from in-memory `pendingTrades` map.

**Endpoint pair**:
- `POST /api/cmd/trade-offer/:login` body `{ item_index, asking_gold }` → creates offer in `pendingTrades`
- `POST /api/cmd/trade-accept/:login` body `{ from_login }` → executes if offer valid

**RUN vs ACCOUNT**: Items live in `character.run.inventory` (erased on permadeath). Players must account for this risk. Gold is account-level (`character.gold`) and survives permadeath — gold trades are always safe. The trade modal should warn about run-inventory risk.

### 8. !faction (New — Social Allegiance)

**Grounded in**: `rollTraits(seed)` and `traitMods(traitIds)` in `shared/traits.js`; `character.prestige` (account-level, survives permadeath); `store.putPlayer` for persistence.

**What it does**: A chatter declares allegiance to one of four factions. Faction membership is account-level (survives permadeath). Faction provides passive combat bonuses via a new `factionMods(factionId)` function inserted into the `derive(run, character)` pipeline in `shared/stats.js`.

**Factions** (defined in new `shared/factions.js`):

| id | name | bonus | lore |
|----|------|-------|------|
| `void_order` | Void Order | +12% int scaling, +8% magic damage | Scholars of the Abyss |
| `crimson_pact` | Crimson Pact | +10% str scaling, lifesteal 2% on kill | Blood-oath warriors |
| `iron_conclave` | Iron Conclave | +15% def, +5% max HP | Fortress builders |
| `shadow_web` | Shadow Web | +18% crit chance, +10% stealth dodge | Assassin network |

**Cap**: Each faction has a seat cap of `FACTION_CAP = 500`. Once full, `!faction join <id>` returns `{ error: "faction_full" }`. This creates *scarcity and social pressure* — chatters recruit faction mates.

**Endpoint**: `POST /api/cmd/faction/:login` body `{ action: "join"|"leave"|"info" }`.

**Faction wars**: Factions accumulate `faction_contribution` points from: raid participation, successful crafts, votes won. The leading faction each week (by contribution) gets a global 5% XP bonus for all members. This is tracked in `data/world-state.json` under `factionScores`.

**Account field**: `character.factionId` (string | null). Lives on the account (not run) side of the permadeath boundary.

### 9. !vote (New — Democratic World Events)

**Grounded in**: `rollEvent(storytellerId, character, run, rng)` in `shared/storyteller.js`; `store.pushFeed`; `rt.broadcast`.

**What it does**: The streamer (or a scheduled cron) opens a **world vote**. Chatters type `!vote A` / `!vote B` / `!vote C`. After the window closes (60–120 seconds), the winning option is applied as a world event. Votes are tallied server-side; each login counts once.

**Vote kinds**:
1. **Zone modifier** — A: "Goblin Warrens floods (enemies +20% HP)" / B: "A shrine appears (+10% XP this hour)" / C: "Nothing changes"
2. **Faction decree** — voted by faction members only: split gold reward between faction projects vs. individual payout
3. **Boss selection** — which boss spawns next during the next natural raid trigger (from SPAWNABLE_BOSSES set)
4. **Mercy vote** — when a raid boss has < 10% HP and has been up for > 4 minutes: vote to let it flee for a rare mercy drop vs. kill for normal payout

**Scale**: Votes are designed for thousands of voters. The server accumulates votes in an in-memory `Map<login, choice>` (one entry per voter) and announces results via a single broadcast when the window closes. No per-vote database write — only the final tally is persisted to feed.

**Endpoint**: `POST /api/vote/:login` body `{ choice }`. Returns `{ ok, choice, tally_snapshot: { A: N, B: N, C: N } }`. Tally snapshot is a coarse (±10%) view to prevent last-second gaming.

**Streamer control**: `POST /api/vote/open` (HMAC-signed) body `{ kind, options: [{ id, label, effect }], windowMs }` opens a vote. `POST /api/vote/close` (HMAC-signed) forces early close and applies winner.

**Effect application**: The winning option's `effect` descriptor is a string key into a `VOTE_EFFECTS` registry in `server/commands.js`. Each effect is a plain function `(state) => void` that mutates in-memory world state and/or persists to `data/world-state.json`. Effects are isolated by `guard()` from `server/supervisor.js`.

### 10. !raid (New — Volunteer Raid Leader)

**Grounded in**: `startRaid(boss_id, reason, fromLogin)` in `server/server.js`; `fireRaidSwing` and `endRaid`; `raidState.engage/disengage`.

**What it does**: High-prestige chatters can volunteer to lead a community raid. The raid leader calls `!raid <boss_id>` (requires `character.prestige >= RAID_LEAD_PRESTIGE_REQ = 500`). The server starts a 30-second countdown broadcast during which chatters `!join-raid` to enlist. Minimum 5 raiders required to start. Once started, the raid uses the existing `startRaid` / `fireRaidSwing` pipeline.

**Raid leader bonus**: The volunteer login is stored as `currentRaid.fromLogin`. In `endRaid()` — which already grants gold split by damage — the raid leader receives an additional flat bonus of `RAID_LEAD_BONUS_GOLD = 200` gold (account-level, survives permadeath). This is the only mechanical benefit: the prestige is social (chat recognition, feed highlight).

**Endpoint**: `POST /api/cmd/raid/:login` body `{ boss_id }`. Validates prestige. Starts countdown. `POST /api/cmd/raid-join/:login` enlists into the forming raid.

### 11. !duel (Existing, Extended)

**Grounded in**: `POST /api/duel/challenge`; `activeDuel` state machine in `server/server.js`.

**Extension — spectator voting**: During a duel, chatters type `!cheer <login>` to bet on a side. Each cheer posts 10 gold from `character.gold` into a spectator pot. Pot is split evenly among chatters who cheered the winner. This uses the existing `rt.broadcast` stream — no new persistent state, just an in-memory `duelSpectators` Map for the duration of the duel.

**Extension — prestige wagers**: In addition to gold wagers (existing), high-level duels can optionally wager prestige. Body `{ prestige_wager: N }` is added to the challenge. Server validates `character.prestige >= prestige_wager`. Prestige is account-level — losing prestige in a duel is a genuine Fear & Hunger-style permanent consequence.

### 12. !prestige (Read + Cosmetic Command)

**Grounded in**: `character.prestige`; `character.titles`; `checkUnlocks(character)` in `shared/progression.js`.

**What it does**: `!prestige` posts the chatter's current prestige score, unlocked titles, and the next milestone to chat. Purely a social command — creates aspirational tension when a chatter is 50 prestige away from a new title and chat sees it.

**Endpoint**: `GET /api/sigma/:login` already returns all this. Chat-elixir bot formats the reply.

---

## Voting Architecture

The vote system is designed to scale to thousands of simultaneous voters without per-vote I/O.

### In-Memory Accumulator

```
activeVote = {
  id: string,           // uuid
  kind: string,         // "zone_modifier"|"boss_select"|"mercy"|"faction_decree"
  options: [{ id, label, effect }],
  votes: Map<login, choiceId>,   // one entry per voter
  openAt: timestamp,
  closeAt: timestamp,
  factionOnly: string | null,    // if set, only members of this factionId can vote
}
```

- Votes land in `activeVote.votes.set(login, choice)` — O(1), no I/O.
- `POST /api/vote/:login` validates the login, checks `factionOnly` gate, sets the map entry.
- Response includes a coarse tally (snapped to nearest 5%) to prevent last-second pile-ons.

### Tally and Effect Application

When the vote closes (via `superviseInterval("vote.close", fn, 5_000)` checking `Date.now() >= activeVote.closeAt`):

1. Compute winning option by max votes in `activeVote.votes`.
2. Apply `VOTE_EFFECTS[winner.effect](worldState)` under `guard("vote.apply", fn)`.
3. `store.pushFeed({ kind: "vote_result", ... })` and broadcast.
4. Persist any world state mutations to `data/world-state.json` via `store.flush()`.
5. Clear `activeVote = null`.

### Tie-Breaking

Ties are broken by the option with the *lower alphabetical id* — deterministic, not random, so the outcome is auditable.

### Anti-Manipulation

- One vote per login per vote window (Map deduplication).
- `factionOnly` votes require `character.factionId === activeVote.factionOnly`.
- Votes cannot be changed once cast (immutable Map.set — first write wins).
- Coarse tally display (±5 percentage points) prevents last-second cascades.

---

## Cooperative Events (Crowd Events at Scale)

### Surge Events (Ambient, Chat-Volume Driven)

The existing `firePulse` machinery already responds to concurrent chatters and chat volume. Extension: three new surge types triggered when the pulse score hits a threshold:

| Surge | Trigger | Effect |
|-------|---------|--------|
| `faction_siege` | score > 45 + active faction war | Randomly-selected zone has all enemies swapped to a faction's enemy pool for 10 minutes |
| `world_boss` | score > 60 | Spawns `hollow_sigma` (tier-5 boss) via existing `startRaid(boss_id)` — the most powerful boss, normally event-only |
| `loot_rain_legendary` | score > 50 | `drops.spawnSessionDrops({ intensity: 3, itemLevel: 20 })` with `rarityBias = 3` |

These are added to the `firePulse` function by extending the `resolvedFlavor` switch from three options to six. Existing `SESSION_FLAVORS` array extended, `SPAWNABLE_BOSSES` set already includes `hollow_sigma`.

### Collective Challenges (Timed, Opt-In)

A new `collectiveChallenge` object in server state tracks crowd-participation goals:

```
collectiveChallenge = {
  goal: "deal 50000 total raid damage",
  metric: "raid_damage",
  target: 50000,
  progress: 0,
  rewardFn: "all_chatters_xp_burst",
  closeAt: timestamp,
}
```

Progress increments on each `fireRaidSwing` call (which already tracks damage). When `progress >= target`, `endCollectiveChallenge()` broadcasts reward. Reward functions are in the `VOTE_EFFECTS` registry (reused).

**Streamer opens via**: `POST /api/collective/start` (HMAC-signed) body `{ goal, metric, target, rewardFn, durationMs }`.

### World Events (Narrative, Storyteller-Driven)

The existing `rollEvent(storytellerId, character, run, rng)` in `shared/storyteller.js` fires per-character per-tick. Extension: a **world-level storyteller** fires shared events every 30 minutes of stream time, independent of individual characters. These are NOT per-character RNG (which would require run context) — they use a world RNG seeded from `Date.now()` in the world state file (one-time seed stored in `worldState.rngSeed`).

World events affect all players simultaneously:
- `world_plague` → all active characters get `infect(run, character, "flu")` on next tick
- `divine_favor` → global XP multiplier 1.5x for 15 minutes (stored in `worldState.activeBuffs`)
- `elder_invasion` → all faction members get notified of a territory threat; triggers a forced faction_siege surge

These are driven by a new `superviseInterval("world.storyteller", fn, 30 * 60_000)` that calls `rollWorldEvent(worldState, rng)` from a new `server/world-events.js` module.

---

## Anti-Spam and Scale Design

### Chat-Elixir Coalesce (Existing)

`Chat.Mmo.Bridge` already rate-limits to one ping per 8 seconds per login (`@cooldown_ms 8_000`), accumulating message counts into `lines: N`. This means at 1000 concurrent chatters, the MMO receives at most ~125 pings/second — well within Node's single-threaded I/O budget.

### Per-Command Server-Side Cooldowns

`server/commands.js` maintains an in-memory `Map<login, { cmd: timestamp }>` of last-fired-at timestamps per command. Commands with meaningful state mutations have minimum intervals:

| Command | Min Interval |
|---------|-------------|
| `!join` | once per session (checked against `character.lastSeen`) |
| `!fight` | driven by raid-state engagement; no extra limit |
| `!gather` | 60s window deduplication |
| `!craft` | 30s |
| `!trade-offer` | 60s |
| `!faction join/leave` | 24h (prevents faction-hopping for bonuses) |
| `!vote` | once per vote window |
| `!raid` (leader) | 10m |
| `!raid-join` | once per raid |
| `!duel` challenge | 60s |
| `!cheer` | once per duel |
| `!prestige` | 30s |
| `!sigma` | 15s |

Cooldown state is in-memory only — it resets on server restart, which is acceptable (restart is infrequent and cooldowns are for abuse prevention, not hard game rules).

### Coalescing Identical Commands

If 500 chatters all type `!gather wood` simultaneously, the bridge coalesces them into ~63 pings/second (500 chatters / 8s cooldown). The server dedupes at the `activeGather.contributors` Set — `O(1)` Set.has check, single Map.set update. No per-chatter database write during the window. Total work: 500 Set insertions over 60 seconds, one JSON write at window end.

### Validation

All command endpoints extend the existing `validate.js` pattern:

- `login` validated against `/^[a-z0-9_]{1,32}$/` (identical to existing endpoints)
- `cmd` enum validated against `VALID_COMMANDS` Set
- `args` length-capped and `scrub()`ed for control/zero-width chars (reuses `scrub()` from `validate.js`)
- Resource IDs validated against `AGENT_RESOURCES` keys from `shared/agent-world.js`
- Recipe IDs validated against `CRAFT_RECIPES` keys
- Faction IDs validated against `FACTION_IDS` from `shared/factions.js`
- Vote choices validated against `activeVote.options.map(o => o.id)`

### Broadcast Budget

The most expensive broadcast scenario is a surge event landing while 1000 chatters are active. `rt.broadcast` sends one WebSocket frame to all connected browser clients (the overlay + any open game tabs). Frame sizes are bounded by the existing `maxPayload` cap on the WS server. Surge events produce at most 3 broadcast frames (feed, sessionEvent, dropSpawn) — identical to the existing agent-session path, which already handles this.

---

## Data Model

### New Account-Level Fields

These fields survive permadeath. They belong on `character` (the account object), not on `character.run`.

| Field | Type | Location | Note |
|-------|------|----------|------|
| `character.factionId` | `string \| null` | Account | Which of the 4 factions the chatter belongs to. `null` = unaffiliated. |
| `character.factionJoinedAt` | `number \| null` | Account | Unix ms timestamp — enforces 24h leave cooldown. |
| `character.factionContribution` | `number` | Account | Cumulative contribution points to their faction (never resets). |
| `character.tradeHistory` | `TradeRecord[]` | Account | Last 20 completed trades (capped). Narrative replay. |
| `character.raidLeads` | `number` | Account | Lifetime successful raid leads — social prestige metric. |
| `character.votesParticipated` | `number` | Account | Lifetime vote participations — engagement metric. |

**Validation additions to `server/validate.js`**:
- `vFactionId(x)` — `vEnum(x, FACTION_IDS.concat([null]))`
- `vTradeHistory(x)` — `vArr(x, 20, vTradeRecord)` where `vTradeRecord` validates `{from, to, itemName, goldAmount, at}`
- `character.factionId` added to `vCharacter()` — bounded `null | factionId string`

### New World-Level State (server/store.js extension)

A new persistent document `data/world-state.json` stores state shared across all players:

```json
{
  "rngSeed": 12345678,
  "factionScores": {
    "void_order": 0,
    "crimson_pact": 0,
    "iron_conclave": 0,
    "shadow_web": 0
  },
  "factionMemberCounts": {
    "void_order": 0,
    "crimson_pact": 0,
    "iron_conclave": 0,
    "shadow_web": 0
  },
  "resourcePool": {
    "wood": 0,
    "ore": 0,
    "herbs": 0,
    "crystal": 0
  },
  "activeBuffs": [
    { "kind": "xp_mul", "value": 1.5, "expiresAt": 0 }
  ],
  "activeGather": null,
  "currentVote": null,
  "weeklyFactionWinner": null,
  "weeklyResetAt": 0,
  "worldEventHistory": []
}
```

`store.js` gains:
- `getWorldState()` — returns the in-memory world state
- `putWorldState(ws)` — updates in-memory, marks dirty
- `initStore()` extended to load `world-state.json`
- `flush()` already debounce-writes all dirty documents — no change needed there

### New Run-Level Fields

These fields live on `character.run` (erased on permadeath):

| Field | Type | Location | Note |
|-------|------|----------|------|
| `run.gatherContributions` | `Record<resource, boolean>` | Run | Tracks which gather windows this run has contributed to (for display). |

No new run fields are needed for the core command set — command state is transient (in-memory during execution) or account-level.

---

## New Shared Modules

### `shared/factions.js` (Deterministic)

```js
export const FACTION_IDS = ["void_order", "crimson_pact", "iron_conclave", "shadow_web"];

export const FACTION_DEFS = {
  void_order: { name: "Void Order", cap: 500, bonuses: {...} },
  crimson_pact: { name: "Crimson Pact", cap: 500, bonuses: {...} },
  iron_conclave: { name: "Iron Conclave", cap: 500, bonuses: {...} },
  shadow_web: { name: "Shadow Web", cap: 500, bonuses: {...} },
};

export const CRAFT_RECIPES = {
  iron_sword: { inputs: { ore: 3 }, goldCost: 50, outputSlot: "weapon", rarityBias: 1 },
  health_charm: { inputs: { herbs: 5 }, goldCost: 30, outputSlot: "charm", rarityBias: 0 },
  void_ring: { inputs: { crystal: 4 }, goldCost: 120, outputSlot: "ring", rarityBias: 3, factionRequired: "void_order" },
  // ... 8-12 total recipes
};

// Deterministic (no RNG calls). Returns stat modifier deltas added by derive().
// factionId may be null (returns all-zero object).
export function factionMods(factionId) { ... }

// Returns current faction member count from worldState.
export function factionSize(factionId, worldState) { ... }

// Whether the faction has capacity for a new member.
export function factionHasRoom(factionId, worldState) { ... }
```

**Deterministic**: `factionMods()` is a pure lookup — no RNG. Safe in `shared/` dual-runtime context. Does not use `Math.random()`.

### `server/commands.js` (Server-Only)

```js
// Per-login command cooldown tracker. In-memory, resets on restart.
const cmdCooldowns = new Map(); // login -> { cmd: lastFiredAt }

// Returns true if the command is within its cooldown window.
export function isOnCooldown(login, cmd) { ... }

// Record a command fire.
export function recordCommand(login, cmd) { ... }

// Main dispatch: called from POST /api/chat-ping handler after base ping work.
// Returns { handled, result } where result is the command outcome for response.
export function dispatchCommand(login, cmd, args, { store, rt, guard, worldState }) { ... }
```

### `server/world-events.js` (Server-Only)

```js
// Rolls a world-level storyteller event from the worldState RNG.
// NOT the same as rollEvent() in shared/storyteller.js (which is per-character, seeded).
// This one uses worldState.rngSeed + a counter for a simple LCG.
export function rollWorldEvent(worldState, hour) { ... }

// Apply effect of a world event to world state + broadcast frames.
// Returns array of rt.broadcast() payloads to send.
export function applyWorldEvent(event, worldState, store, rt) { ... }

export const WORLD_EVENT_KINDS = [
  "world_plague", "divine_favor", "elder_invasion",
  "resource_bonanza", "faction_challenge", "merchant_caravan"
];
```

**Not deterministic in the `shared/` sense** — world events use server-side `Date.now()`-seeded state, not the per-character mulberry32 stream. This is correct: world events are global state, not per-run, and do not need to match offline sim.

---

## New HTTP Endpoints / Chat Commands

### Convention

- All command endpoints follow `POST /api/cmd/<command>/:login`
- All are wrapped in `guard("POST /api/cmd/<command>", handler)` from `server/supervisor.js`
- All validate `login` against `/^[a-z0-9_]{1,32}$/`
- All call `resolveTwitchSigma(login)` first (mints if new)
- All update `character.lastSeen = Date.now()` and `character.twitchLogin = login`

### Endpoint Table

| Verb | Kind | Path | Body | Effect |
|------|------|------|------|--------|
| POST | http | `/api/cmd/join/:login` | `{}` | Announces sigma to feed; no mechanical change. |
| POST | http | `/api/cmd/gather/:login` | `{ resource: string }` | Adds login to active gather window for named resource. Dedupes per window. |
| POST | http | `/api/cmd/craft/:login` | `{ recipe_id: string }` | Deducts world resources + gold; creates item via `rollDrop`; adds to inventory. |
| POST | http | `/api/cmd/trade-offer/:login` | `{ item_index: number, asking_gold: number }` | Creates expiring trade offer in `pendingTrades`. |
| POST | http | `/api/cmd/trade-accept/:login` | `{ from_login: string }` | Atomically executes trade if offer valid and buyer has gold. |
| POST | http | `/api/cmd/faction/:login` | `{ action: "join"\|"leave"\|"info", faction_id?: string }` | Joins/leaves faction (24h cooldown on leave). Checks capacity cap. |
| POST | http | `/api/vote/:login` | `{ choice: string }` | Records vote in active vote window. One per window per login. |
| POST | http | `/api/vote/open` | HMAC-signed `{ kind, options, windowMs }` | Opens a vote window. |
| POST | http | `/api/vote/close` | HMAC-signed `{}` | Closes active vote and applies winning effect. |
| POST | http | `/api/cmd/raid/:login` | `{ boss_id: string }` | Prestige-gated: starts a 30s raid-forming countdown. |
| POST | http | `/api/cmd/raid-join/:login` | `{}` | Enlists in the forming raid during countdown. |
| POST | http | `/api/collective/start` | HMAC-signed `{ goal, metric, target, rewardFn, durationMs }` | Opens a collective challenge. |
| GET  | http | `/api/world-state` | — | Returns public world state snapshot (faction scores, resource pool, active buffs). |
| GET  | http | `/api/factions` | — | Returns all faction defs + current member counts. |

### Chat-to-Endpoint Mapping (chat-elixir bridge)

The bridge's `handle_info` in `lib/chat/mmo/bridge.ex` parses `!command` from message text and includes `{ cmd, args }` in the POST body. The MMO server dispatches in `server/commands.js`. The Twitch bot (`lib/chat/bots/twitch.ex`) posts formatted replies for read commands.

| Chat command | Dispatched to | Bot reply? |
|---|---|---|
| `!join` | `/api/cmd/join/:login` | Yes — sigma teaser |
| `!sigma [login]` | `GET /api/sigma/:login` | Yes — formatted status |
| `!loot` | `GET /api/sigma/:login` | Yes — top items |
| `!status` | `GET /api/sigma/:login` | Yes — diseases/injuries/mood |
| `!skills` | `GET /api/sigma/:login` | Yes — skill levels |
| `!fight` | `/api/raid/fight/:login` | No — overlay shows it |
| `!run` | `/api/raid/run/:login` | No |
| `!gather <resource>` | `/api/cmd/gather/:login` | No — feed shows aggregate |
| `!craft <recipe>` | `/api/cmd/craft/:login` | Yes — crafted item name |
| `!trade offer <idx> <gold>` | `/api/cmd/trade-offer/:login` | Yes — offer posted |
| `!trade accept <login>` | `/api/cmd/trade-accept/:login` | Yes — trade completed |
| `!faction join <id>` | `/api/cmd/faction/:login` | Yes — faction joined |
| `!faction leave` | `/api/cmd/faction/:login` | Yes — faction left |
| `!faction info` | `/api/cmd/faction/:login` | Yes — faction stats |
| `!vote <choice>` | `/api/vote/:login` | No — overlay shows live tally |
| `!raid <boss_id>` | `/api/cmd/raid/:login` | Yes — countdown started |
| `!join-raid` | `/api/cmd/raid-join/:login` | No — overlay shows raider list |
| `!cheer <login>` | Inline with duel state | No — overlay shows cheer count |
| `!prestige` | `GET /api/sigma/:login` | Yes — prestige score + next milestone |
| `!upgrade` | `/api/upgrade-weapon/:login` | Yes — existing behavior |

---

## Balance Numbers

All balance numbers are tied to existing constants where possible.

### Faction Mods (Added to `derive(run, character)`)

The faction modifier is additive with trait/skill mods, not multiplicative. Keeps the faction bonus meaningful but not game-breaking.

| Faction | stat delta |
|---------|-----------|
| `void_order` | `atkAdd += int * 0.12; overloadAdd += 0.08` |
| `crimson_pact` | `atkAdd += str * 0.10; onKillHeal = maxHp * 0.02` |
| `iron_conclave` | `defAdd += resolve * 0.15; hpMul *= 1.05` |
| `shadow_web` | `critAdd += 0.18; dodgeAdd += 0.10` |

These are applied in `derive(run, character)` after `traitMods()` and before `diseaseMods()`, following the existing layering order in `shared/stats.js`.

### Crafting Costs

Tied to `POTION_COST = 25` and existing `upgradeCost(plus)` as anchors:

| Recipe | Resources | Gold | Expected Output Rarity |
|--------|-----------|------|----------------------|
| `iron_sword` | ore ×3 | 50 | Common–Uncommon |
| `health_charm` | herbs ×5 | 30 | Common |
| `lucky_ring` | crystal ×2 | 80 | Uncommon–Rare |
| `void_ring` | crystal ×4 | 120 | Rare–Epic (faction-locked) |
| `battle_relic` | ore ×5, herbs ×2 | 200 | Epic–Legendary (requires lvl 15+) |

### Trade Limits

- Min `asking_gold`: 1
- Max `asking_gold`: `DUEL_MAX_WAGER = 250_000` (reused from existing duel cap)
- Max offer lifetime: 120s
- Max pending offers per login: 1 (simplest anti-abuse)

### Voting Windows

| Vote kind | Window | Min voters for effect |
|-----------|--------|----------------------|
| Zone modifier | 90s | 5 |
| Boss select | 60s | 10 |
| Mercy | 45s | 3 |
| Faction decree | 120s | faction_size * 0.3 |

### Gather Windows

- Duration: 60s
- Max contributors: 200
- Resource output: unique contributor count (1 per login)
- Cooldown between windows: 5 minutes per resource type
- Resource pool cap: 1000 per resource (prevents world-state bloat)

### Raid Lead Requirement

`RAID_LEAD_PRESTIGE_REQ = 500` prestige — reachable by a dedicated player after ~15–20 runs (median), creates meaningful aspiration without being unobtainable.

---

## Streamer / OBS Integration

All OBS integration is **additive only** per the hard invariant in `CLAUDE.md`. The existing `server/obs-setup.js` creates an isolated `"SIGMA ABYSS"` scene.

### Overlay Additions

New overlay elements broadcast via `rt.broadcast` and consumed by the existing browser-source overlay:

| Frame type | Payload | Display |
|---|---|---|
| `voteOpen` | `{ kind, options, closeAt, tally }` | Vote countdown + live bar chart |
| `voteTally` | `{ tally, leading }` | Updates every 5s during window |
| `voteResult` | `{ winner, effect, tally }` | Celebration banner 8s |
| `factionWar` | `{ leader, scores }` | Faction score HUD sidebar |
| `gatherOpen` | `{ resource, closeAt, contributors }` | Progress bar |
| `gatherComplete` | `{ resource, units, contributors }` | Celebration splash |
| `collectiveProgress` | `{ goal, progress, target }` | Shared progress bar |
| `collectiveComplete` | `{ goal, reward }` | Victory banner |
| `tradeComplete` | `{ from, to, itemName, goldAmount }` | Ticker text |
| `raidForming` | `{ boss_id, leader, raiders, countdown }` | Raid assembly HUD |

These are purely additive — they do not modify any existing frame types or the live OBS scene. The existing `obs-setup.js` scene includes a browser source pointed at `/overlay/arena`. New overlay elements are rendered in the same browser source's HTML by extending `client/js/ui.js`.

---

## Scaling Notes for Thousands of Chatters

### Throughput Model

At 2000 concurrent chatters with the bridge's 8s coalesce:
- **Ping rate**: ~250 POST /api/chat-ping/second
- **Per-ping work**: Map lookup (O(1)), Set.has (O(1)), possible broadcast (~1ms)
- **Node single-thread budget**: Comfortable at this rate — the existing server already handles this

### Aggregate Command Rate

If 10% of chatters send a command in any given minute, at 2000 chatters that's 200 commands/minute = ~3.3 commands/second. Each command endpoint does a single `store.getPlayer()` + `store.putPlayer()` (in-memory Map operations, O(1)) + at most one `store.pushFeed()`. Disk writes are debounced by `STORE_FLUSH_MS` (existing). No per-command disk I/O in the hot path.

### Gather Deduplication

`activeGather.contributors = new Set()` — at 2000 chatters all typing `!gather` simultaneously, the Set deduplication completes in microseconds (200 effective contributors × 2000 attempted = 2000 Set.has + 200 Set.add operations).

### Vote Scale

At 2000 voters, `activeVote.votes = new Map()` with 2000 entries. Memory cost: ~150KB (string keys + string values). Tally computation on close: `Map.values()` → single pass O(n). No issue at this scale.

### Faction Score Updates

Faction scores update on raid kill, craft completion, and vote participation. Each is an `O(1)` increment to `worldState.factionScores[factionId]`. The world state flushes to disk on the same `store.flush()` debounce cycle as player data.

### Broadcast Fan-out

The bottleneck for large chat events is `rt.broadcast()` which sends to all connected WebSocket clients. Browser overlay clients are typically 1–5 (OBS + streamer monitors). The relay pattern (few WS subscribers, many HTTP chatters) means broadcast is never a bottleneck at any realistic chat size.

---

## Cross-Agent Dependencies

| Key | Agent | Dependency |
|-----|-------|-----------|
| `systems` | Agent 1 (Lead Systems) | Faction system definitions (FACTION_DEFS), crafting recipe balance, world resource economy balance. The systems doc governs how factions integrate with the overall progression loop. |
| `economy` | Agent 2 (Economy) | Trade pricing, gold sink rates for crafting and faction projects, faction contribution scoring weights. This doc assumes economy balance numbers come from Agent 2. |
| `narrative` | Agent 3 (Narrative) | World event text, faction lore, vote option copy. World event kinds (`WORLD_EVENT_KINDS`) need narrative content. Mercy vote flavor text. |
| `retention` | Agent 4 (Retention) | Daily/weekly vote schedule, collective challenge cadence, faction war reset timing. This doc specifies the mechanics; retention doc governs the scheduling. |
| `simulation` | Agent 6 (Simulation) | World state evolution between stream sessions (resource decay, faction influence drift). Agent 6 owns the offline world tick; this doc's world-state.json is the input/output surface. |
| `npc` | Agent 7 (AI NPC) | Faction NPCs (faction quartermasters for trading, raid recruiters, vote-criers). The NPC doc will own NPC dialogue and schedules; this doc provides the faction hooks they can read. |

---

## Open Conflicts to Resolve

1. **!craft vs run/account split**: Crafted items land in `character.run.inventory` (erased on death). Some recipes should arguably produce account-level cosmetics instead. Need Agent 1 and Agent 2 to define which recipe outputs are run-items vs. account-cosmetics.

2. **Faction mods in `derive()`**: Adding `factionMods()` to `shared/stats.js`'s `derive()` function adds a call with the character's account-level `factionId`. The `derive(run, character)` signature already takes `character` — but `factionId` is on `character`, not on `run`. This is clean architecturally, but needs Agent 6 to confirm the offline simulation path handles the account-level field correctly (offline sim passes the same `character` object, so it should work, but needs verification).

3. **Voting and faction wars — streamer control**: Who triggers votes — the streamer manually, a cron schedule, or automatic game conditions? This doc provides the HMAC-signed `POST /api/vote/open` endpoint for manual control. Agent 4 (Retention) should decide if votes fire on a schedule.

4. **`!fight hard` interaction with existing danger system**: The elite-force mechanic needs a clean implementation that doesn't corrupt the existing `run.danger` state for the persistent character. Safest approach: the server-side `!fight hard` spawns a separate server-authoritative encounter (not touching `run.danger`) — but this conflicts with the "server is truth" invariant for character state. Needs Agent 1 resolution.

5. **Trade of run-inventory items after death**: If a trade offer is open and the offeror dies before the trade executes, the item no longer exists. Need a cleanup pass in `resolveDeath()` that cancels any pending trade offers for the deceased login.

6. **Faction cap enforcement at scale**: `FACTION_CAP = 500` is a hard cut. At scale, this creates a perverse incentive to join factions early and never leave. Should cap be soft (diminishing returns) or hard? Needs Agent 2 (Economy) ruling on whether faction seat scarcity is a feature or a pain point.

---

## Success Criteria

1. `!gather`, `!craft`, `!trade`, `!faction`, `!vote` all dispatched and persisted within 200ms of the bridge POST arriving at the MMO server, measured via `Date.now()` bookending the handler.

2. At 500 simulated concurrent chatters (using the smoke.js harness extended with command load), the event loop lag stays below 20ms (measured via `process.hrtime()`).

3. A vote window with 200 participants produces exactly one result broadcast with the correct winning option and the correct aggregate tally.

4. A gather window with 300 attempted chatters (200 cap) produces exactly 200 units in the resource pool.

5. A trade executed between two chatters correctly transfers the item from `character.run.inventory[idx]` of the seller and debits `asking_gold` from the buyer's `character.gold`.

6. `factionMods(factionId)` returns all-zero for `factionId = null` (unaffiliated chatters get no bonus, no penalty).

7. A chatter who joins a faction, dies (permadeath), and respawns still has `character.factionId` set (account-level field survives `resolveDeath()`).

8. The OBS overlay receives `voteOpen`, `voteTally`, and `voteResult` frames in sequence for a complete vote cycle, with no modification to the existing arena or raid frame types.

9. A chatter who crafts an item while their inventory is at `INVENTORY_MAX = 40` receives `{ ok: false, error: "inventory_full" }` and no resources are deducted.

10. `!faction leave` issued within 24 hours of `!faction join` returns `{ ok: false, error: "leave_cooldown", remainingMs: N }` and does not modify `character.factionId`.
