# 02 — Economy Design: SIGMA ABYSS Player-Driven Economy

**Agent:** Economy Designer (Agent 2)
**Date:** 2026-05-30
**Status:** Implementation-ready design draft

---

## Overview

SIGMA ABYSS currently has a solo acquisition loop: characters earn gold through
`character.gold += goldGained` in `shared/progression.js:delveTick()`, sell
inventory via `bankAtTown()`, and spend gold on potions (`POTION_COST = 25`) and
weapon upgrades (`shared/weapons.js:upgradeCost(plus)`). There is no player-to-player
transfer, no price discovery, and no structural gold sink beyond those two spends.

This document designs a complete player-driven economy that:

1. Extends the existing constants and sim without replacing any existing logic.
2. Runs entirely through Twitch chat commands — the PRIMARY input per Invariant 8.
3. Keeps all new persistent state on the ACCOUNT side of the run/account split
   (Invariant 4), so permadeath never wipes economic standing.
4. Uses the existing deterministic RNG pattern for any sim-side rolls, and keeps
   all new `shared/` modules pure ESM dual-runtime (Invariant 1).
5. Scales to thousands of chatters with O(1) per-message work.

### Inspirations mapped to design pillars

| Inspiration | Economy Expression |
|---|---|
| RuneScape — trading economy, collection goals, social prestige | Player market, rarity collecting, prestige-tier trade fees |
| Fear & Hunger — scarcity, high-risk decisions | Volatile resource nodes, listing expiry, blind-box auctions |
| RimWorld — emergent stories, faction wars | Faction-controlled markets, trade wars, price manipulation |
| Dwarf Fortress — deep simulation, emergent history | Order-book price history, bubble events, lore-stamped items |

---

## 1. Currency Systems

### 1.1 Gold (existing, extended)

`character.gold` (account-level, survives permadeath) is the universal medium of
exchange. The existing sources:

- `REST_GOLD_PER_HOUR = 60` (constants.js) — safe idle trickle
- `result.goldGained * econ.goldMul` per encounter in `delveTick()` — combat drops
- `sellValue(item)` via `bankAtTown()` — NPC vendor sell
- `ORACLE_REWARD_DEFAULT.gold = 25` — oracle bazaar inference work

Gold is the ONLY currency used for player-to-player trades and market listings.
It is intentionally unified to avoid fragmenting liquidity.

### 1.2 Prestige Shards (new, account-side)

A non-transferable secondary currency earned exclusively through permadeath and
milestone combat. Prestige Shards (`character.shards`) unlock cosmetic market
slots and premium listing tiers. They cannot be traded between players, preventing
whale extraction of the prestige economy.

Sources:
- `resolveDeath()` mints `Math.floor(prestigeGained * SHARD_PER_PRESTIGE)` shards
  alongside prestige points. At `SHARD_PER_PRESTIGE = 0.5`, a run worth 20 prestige
  yields 10 shards.
- Boss kills in shared raids: `SHARD_PER_BOSS_KILL = 2` (paid by server on `endRaid()`).

Sinks:
- Unlocking a second simultaneous market listing slot: 50 shards (one-time permanent).
- Unlocking a third slot: 200 shards.
- Applying a permanent "Lore Stamp" to a listed item (see §4.3): 15 shards.

### 1.3 Rune Dust (new, account-side)

A crafting reagent earned by salvaging items (see §3.1 below). Rune Dust cannot
be earned through combat drops or rest — it is purely a sink product of the loot
loop, creating a reason to engage with loot beyond the NPC vendor path.

| Rarity salvaged | Rune Dust gained |
|---|---|
| common | 1 |
| uncommon | 3 |
| rare | 8 |
| epic | 20 |
| legendary | 55 |
| mythic | 150 |
| oneofone | 500 |

These ratios follow `RARITY_RANK` values (constants.js) at approximately
`RARITY_RANK[rarity] ^ 2 * 6` — scarcity is preserved.

Sinks:
- Affix reroll (see §3.2): costs Rune Dust scaled to item rarity.
- Market listing fee upgrade (see §4.1): 10 Rune Dust per listing bonus tier.

---

## 2. Resource Generation: Balance Numbers

### 2.1 Existing gold income calibration

Using existing constants:

- `upgradeCost(plus)` = `60 * 1.55^plus` (weapons.js). Full +0→+10 ladder:
  60 + 93 + 144 + 223 + 346 + 536 + 831 + 1287 + 1994 + 3091 = **~8,605 gold total**
- `POTION_COST = 25`, `POTION_MAX = 20` → full restock = 500 gold
- `REST_GOLD_PER_HOUR = 60` → 8h rest = 480 gold (barely one potion restock)
- An active delver at zone 3 (tier 3, `lootBias ≈ 1.5`) at level 40 generates
  roughly 8–20 gold per encounter * ~1380 encounters/hour (2600ms tick) ≈
  **11,000–27,600 gold/hour** in raw combat income before NPC sells.
- `sellValue(item)` for a level-40 rare = `(40 + 2*9)*(1+2*0.55)` ≈ **182 gold**.
  A full 40-slot inventory of mixed rares/epics at L40 ≈ **4,000–8,000 gold** banked.

**Key conclusion:** Active high-zone delvers generate 10–30k gold/hour. The
weapon upgrade total-ladder sink of 8,605 gold is consumed in under one hour.
The economy desperately needs new sinks to prevent runaway inflation.

### 2.2 New income ceilings by playstyle

| Playstyle | Gold/hour (rough) | Primary sources |
|---|---|---|
| Casual rester | ~60 | REST_GOLD_PER_HOUR |
| Casual delver (zone 1-2) | 500–2,000 | combat + NPC sell |
| Active mid-game (zone 3-4) | 5,000–15,000 | combat + NPC sell + market sales |
| Endgame grinder (zone 5) | 15,000–40,000 | combat + market arbitrage + crafting |
| Oracle bot (agents) | ~600 | ORACLE_REWARD_DEFAULT.gold * actions |

Market income (selling to players) should be the primary incentive at
endgame — crafted and stamped items must command 2–10x NPC sell price to
make trading worthwhile.

---

## 3. Item Rarity Economics + Crafting

### 3.1 Salvage System

New chat command `!salvage` / `!salvage all` destroys an inventory item (or all
items below the player's configured keep-threshold) and returns Rune Dust.

This creates a meaningful choice: NPC sell (gold, immediate) vs. salvage (Rune Dust,
deferred value via crafting). At endgame where gold is abundant, Rune Dust becomes
the scarcity currency.

The salvage action is processed by a new endpoint `POST /api/salvage/:login` (see §6).

### 3.2 Affix Reroll (Rune Crafting)

New chat command `!reroll <slot>` consumes Rune Dust and randomizes one affix on
the equipped item in the given gear slot. The new affix is drawn from the existing
`AFFIX_POOL` (loot.js) using the character's `run.rngState` — fully deterministic,
compatible with offline sim.

Reroll cost scales with rarity (to protect rare item value):

| Rarity | Rune Dust cost per reroll |
|---|---|
| common | 2 |
| uncommon | 6 |
| rare | 18 |
| epic | 50 |
| legendary | 140 |
| mythic | 400 |
| oneofone | non-rerollable (lore stamp only) |

**Design intent:** Rerolling a legendary costs 140 dust ≈ 2.5 salvaged legendaries.
This ratio ensures players must hunt for many items before optimizing one, which is
RuneScape's crafting/grinding loop applied to loot.

Rerolls are tracked in `item.rerolls` (new field, account-side on equipped gear)
for lore purposes. Items with high reroll counts display a "Forged" suffix in the
HUD (social prestige signal).

### 3.3 Rarity Tier Economics

The existing `RARITY_WEIGHT` (constants.js) defines relative drop rates:

```
common: 1000, uncommon: 420, rare: 160, epic: 46,
legendary: 11, mythic: 2, oneofone: 0.06
```

Implied relative scarcity (common = 1x baseline):
- common: 1x | uncommon: 2.4x | rare: 6.25x | epic: 21.7x
- legendary: 90.9x | mythic: 500x | oneofone: 16,667x

**Market price targets** (to make player trading profitable over NPC selling):
- common: 5–20 gold (near NPC sell; rarely worth listing)
- uncommon: 30–80 gold
- rare: 100–400 gold
- epic: 500–2,000 gold
- legendary: 3,000–15,000 gold (2–5h of casual income)
- mythic: 20,000–100,000 gold (high-stakes, rare transactions)
- oneofone: Floor auction only — starting bid enforced at 50,000 gold

The listing fee structure (§4.1) is designed so that listing a common item is
net-negative after fees (preventing spam), while legendary+ listings are highly
profitable over NPC vendoring.

### 3.4 Item Power as Price Signal

The existing `itemPower(item)` function (loot.js) provides a single comparable
number. The market display shows item power alongside price, so buyers can evaluate
deals without complex tooltip reading. The ratio `listedPrice / itemPower(item)` is
the "gold-per-power" signal shown in the market UI.

---

## 4. Market Architecture (Auction House / Order Book)

### 4.1 Market Overview

The SIGMA ABYSS Market is a **persistent listing board** with:
- Direct-price listings (sell at X gold — first buyer wins)
- Blind-box auctions (24h duration, highest offer wins)
- Buy orders (offer X gold for any item matching a filter)

All market state lives in `data/market.json` (new store document) managed by
`server/store.js` extensions (see §7). The market is NOT simulated inside
`delveTick()` — it is a server-side async system, so it does not need to be
deterministic and can call Node built-ins freely.

### 4.2 Listing Fees (Gold Sinks)

Listing fees are the primary gold sink. They are charged on listing creation
(non-refundable even if the item does not sell), which discourages listing spam.

**Fee structure:**

| Rarity | Listing fee (gold) | Rationale |
|---|---|---|
| common | 15 | Below common NPC sell; only list if expecting player premium |
| uncommon | 35 | ~15% of target player price |
| rare | 80 | ~15% of target player price |
| epic | 300 | ~15–20% of target player price |
| legendary | 1,500 | ~10–15% of target player price; meaningful sink |
| mythic | 8,000 | ~8–10%; rare event, large absolute sink |
| oneofone | 20,000 | Floor; ensures only committed sellers list |

**Transaction tax:** On successful sale, the seller pays an additional 8% tax
on the final transaction price, deposited into the World Treasury (see §5.4).
This is the primary ongoing inflation brake — every trade removes gold from
circulation.

**Unsold fee:** If a listing expires unsold, the item is returned to the seller's
vault but NO refund of the listing fee is issued. This ensures only confident
sellers list, preventing market clutter.

### 4.3 Lore Stamps

For an additional 15 Prestige Shards (non-gold cost, so it doesn't drive
inflation), a seller can attach a permanent Lore Stamp to a listing before it goes
live. A Lore Stamp records:

- Seller's character name and current title
- The item's `rerolls` count and highest zone where it dropped
- A custom 60-character flavor line (chat-input, scrubbed by `validate.js:scrub()`)

Lore Stamps make items traceable (RuneScape provenance + Dwarf Fortress artifact
history). Items with stamps display a special icon in the market and command a
social premium in player-negotiated trades. The stamp data is stored on the item
itself (`item.loreStamp = { seller, title, rerolls, depthZone, flavor, stampedAt }`)
and persists on the item across all future transfers.

### 4.4 Buy Orders

A buy order is an offer to purchase any item matching a filter at a given gold
price. The buyer locks the gold upfront (escrowed into `character.goldEscrowed`).

Buy order filter fields:
- `slot`: one of `GEAR_SLOTS` (constants.js)
- `rarity`: minimum rarity rank
- `minPower`: minimum `itemPower()` value
- `effect`: optional specific EFFECT_ID (loot.js)

When a seller lists an item that matches an open buy order, the server auto-matches
(immediate sale, no auction duration). Auto-match pays the buy order price to the
seller, releases the buyer's escrow, and delivers the item to the buyer's vault.

Buy orders are the "demand signal" that creates emergent price discovery. A cluster
of buy orders for "legendary ring" at 8,000 gold tells the market that players
value legendary rings at that floor.

### 4.5 Chat Command Interface

All market interactions happen through Twitch chat via new HTTP endpoints. The
commands are designed for low-friction mobile use (short, memorable):

| Chat command | Effect |
|---|---|
| `!list <slot> <price>` | List equipped item in slot for direct sale |
| `!list <slot> auction` | List for 24h blind auction |
| `!buy <listingId> ` | Purchase a direct-price listing |
| `!bid <listingId> <amount>` | Place bid on auction |
| `!offer <slot> <minRarity> <price>` | Place a buy order |
| `!unlist <listingId>` | Cancel listing (no fee refund) |
| `!market` | DM summary of top 5 listings per rarity |
| `!mylistings` | Show seller's active listings |
| `!vault` | Show items in player vault (see §4.6) |
| `!price <slot> <rarity>` | Show recent sale prices for that category |
| `!salvage [all]` | Destroy item for Rune Dust |
| `!reroll <slot>` | Reroll one affix (costs Rune Dust) |

### 4.6 Player Vault

A player vault (`character.vault: Item[]`) is a persistent off-run item storage
that survives permadeath, analogous to a bank. Max capacity: 20 slots base,
expandable to 40 with 100 Prestige Shards (one-time unlock).

Items in the vault can be listed directly on the market without equipping. When an
item sells from the vault, gold flows to `character.gold` immediately.

The vault also receives items when:
- A buy order is auto-matched (buyer receives item into vault)
- A market auction completes (winner receives item into vault)

**New character field:** `character.vault = []` (account-side, survives permadeath).

### 4.7 Trade Ledger (Emergent Price History)

All completed transactions are recorded in `data/market-history.json` as a ring
buffer of the last 1000 trades per `slot+rarity` bucket. The `!price` command
queries this history to return:
- Last 5 sale prices (descending by recency)
- 7-day median price

This is the emergent price oracle that lets players price intelligently without
external spreadsheets. Over months, a rich price-history database forms — the
"Dwarf Fortress ledger" of the economy.

---

## 5. Gold/Resource Sinks: Inflation Prevention

### 5.1 Sink Inventory

The existing sinks are:
- Potions: up to `POTION_COST * POTION_MAX = 25 * 20 = 500 gold` per run
- Weapon upgrades: `upgradeCost(0)` through `upgradeCost(9)` = ~8,605 gold total

These are insufficient for a multi-year economy. New sinks introduced:

| Sink | Gold removed per event | Volume estimate |
|---|---|---|
| Market listing fee (common) | 15 | High volume, low unit |
| Market listing fee (epic) | 300 | Medium volume |
| Market listing fee (legendary) | 1,500 | Low volume, significant |
| Market listing fee (mythic) | 8,000 | Very rare |
| Market transaction tax (8% of sale price) | Variable — e.g., 800 on 10k sale | Per transaction |
| Affix reroll (legendary) | 140 Rune Dust (not gold) | Medium |
| Vault expansion (prestige shards, not gold) | — | One-time |
| Lore Stamp (prestige shards, not gold) | — | Moderate |
| Future: Faction war pledge | Large (hundreds–thousands) | Event-driven |
| Future: Town reconstruction event (agents/sim) | Very large (tens of thousands) | World event |

### 5.2 Transaction Tax as Velocity Damper

The 8% transaction tax is the most powerful ongoing sink because it fires on every
player-to-player trade. In a mature economy with 1,000 daily trades averaging
3,000 gold each:

```
1,000 trades * 3,000 gold * 0.08 = 240,000 gold/day removed from circulation
```

Against a generation rate of (say) 200 active players at 5,000 gold/hour for 2h/day:
```
200 players * 5,000 gold/hr * 2 hr = 2,000,000 gold/day generated
```

At this scale the tax removes ~12% of daily generation, which is insufficient
alone. The listing fees and world events (§5.3) must carry more load at scale.

### 5.3 World Events as Mega-Sinks (Cross-Agent Dependency: simulation)

Coordinating with Agent 6 (simulation), major world events should create
large-scale gold sinks:

- **Town Reconstruction:** After a catastrophic raid boss kills 50+ players,
  the town enters a "damaged" state. Players can donate gold to an NPC reconstruction
  fund. Collective donations above a threshold restore the town and grant all donors
  a cosmetic reward. This can remove 500k–5M gold in a single event.
- **Faction War Funding:** Players pledge gold to their faction's war effort (see §5.5
  and cross-dependency on Agent 3 / narrative). Pledged gold is spent even if the
  faction loses — it is consumed, not refunded.
- **Bounty Board:** Players can post gold bounties on specific raid bosses
  (`!bounty <bossId> <amount>`). The bounty gold is escrowed; when the boss is
  slain in a raid, the gold is split among top contributors. This re-circulates
  gold but does NOT destroy it — the net effect is wealth redistribution, not
  a sink. Bounties are included as a social mechanic but must be counted separately
  from sinks.

### 5.4 World Treasury

All listing fees and transaction taxes flow into a `world.treasury` counter
(world-level persistent state, not per-character). The treasury funds:
- Periodic "prosperity events": when treasury > 1,000,000 gold, a world event fires
  that spawns bonus loot showers and XP bursts, conceptually "spending" the surplus
  back into the world. This is gold VELOCITY redirection, not destruction — treasury
  gold flows back as drop rewards, keeping the sink conceptually real while returning
  player engagement value.
- Faction war prizes (see §5.5): top-faction players receive a gold disbursement
  funded by treasury, so the Treasury is the clearing mechanism.

### 5.5 Listing Expiry Cadence

All market listings expire after configurable durations:
- Direct-price listings: 48h
- Auction listings: 24h
- Buy orders: 72h

Expired listings return items to the seller's vault. The listing fee is NOT refunded.
This cadence prevents the market from becoming a permanent "stash" and forces
continuous engagement.

### 5.6 Anti-Inflation Monitoring

A server-side gauge tracks `world.goldInCirculation` — updated on every gold
credit/debit to any character. The gauge is stored in `data/world.json` and
reported in `/healthz`. If gold-in-circulation exceeds a configurable ceiling
`ECONOMY_GOLD_CAP` (suggested: 50,000,000 gold total across all players), the
server activates "Treasury Mode":
- Listing fees increase by 50% (multiplier applied server-side)
- Transaction tax increases from 8% to 12%
- The feed broadcasts a world event: "The Abyss strains under the weight of wealth"
- Treasury Mode deactivates when gold drops 20% below the cap

This is the automatic inflation brake that persists for years without manual tuning.

---

## 6. New shared/ Modules

### 6.1 `shared/market.js` (non-deterministic; pure validation + math helpers)

This module contains validation helpers and price math usable in both client
(display) and server (validation). No RNG, no Node built-ins.

```js
// Proposed exports:
export const LISTING_FEE = { common: 15, uncommon: 35, rare: 80, epic: 300, legendary: 1500, mythic: 8000, oneofone: 20000 };
export const TRANSACTION_TAX_RATE = 0.08;
export const LISTING_DURATION_MS = { directSale: 48 * 3600_000, auction: 24 * 3600_000, buyOrder: 72 * 3600_000 };
export const VAULT_BASE_CAPACITY = 20;
export const VAULT_MAX_CAPACITY = 40;
export const VAULT_EXPAND_SHARDS = 100;
export const SECOND_SLOT_SHARDS = 50;
export const THIRD_SLOT_SHARDS = 200;
export const LORE_STAMP_SHARDS = 15;
export const SHARD_PER_PRESTIGE = 0.5;
export const SHARD_PER_BOSS_KILL = 2;
export function listingFee(rarity) { ... }
export function transactionTax(salePrice) { ... }
export function canList(character, item) { ... } // checks gold, slot count, item in inventory/vault
export function canBid(character, amount) { ... } // checks escrowed + free gold
export function matchesBuyOrder(order, item) { ... } // filter predicate
export function goldPerPower(price, item) { ... } // price signal for market display
export const RUNE_DUST_PER_RARITY = { common: 1, uncommon: 3, rare: 8, epic: 20, legendary: 55, mythic: 150, oneofone: 500 };
export const REROLL_DUST_COST = { common: 2, uncommon: 6, rare: 18, epic: 50, legendary: 140, mythic: 400 };
export function canReroll(character, item) { ... }
```

This module is DETERMINISM-EXEMPT: it performs no RNG rolls. Reroll RNG happens
server-side using a fresh `makeRng(Date.now() ^ character.seed)` — NOT using the
run's `rngState` since rerolls are an account-side action that must not interfere
with offline sim determinism.

### 6.2 `shared/economy-constants.js` (new constants, dual-runtime)

Rather than polluting `shared/constants.js`, new economy constants live here.
Both modules remain pure ESM with `.js` imports.

```js
export const ECONOMY_GOLD_CAP = 50_000_000;
export const ECONOMY_TREASURY_PROSPERITY_THRESHOLD = 1_000_000;
export const ECONOMY_TREASURY_MODE_TAX_RATE = 0.12;
export const ECONOMY_TREASURY_MODE_FEE_MUL = 1.5;
export const MARKET_LISTING_MAX_BASE = 1; // slots; expandable to 3 with shards
export const MARKET_BUY_ORDER_MAX = 5;
export const MARKET_HISTORY_RING_SIZE = 1000;
```

---

## 7. Data Model

All new persistent state respects the RUN/ACCOUNT/WORLD split (Invariant 4).

### 7.1 Character (account-side additions)

All fields below survive permadeath. They are added to the character object and
validated in `server/validate.js:vCharacter()`.

```js
character.gold              // existing — universal currency
character.prestige          // existing — non-transferable status
character.shards            // NEW: non-transferable Prestige Shards (integer >= 0)
character.runeDust          // NEW: crafting reagent (integer >= 0)
character.vault             // NEW: Item[] — off-run persistent storage, max 20 base
character.vaultCapacity     // NEW: 20 or 40 (after shard unlock)
character.marketSlots       // NEW: 1, 2, or 3 (after shard unlocks)
character.goldEscrowed      // NEW: gold locked in active buy orders (integer >= 0)
character.activeListings    // NEW: listingId[] — IDs of character's active market listings
character.activeBuyOrders   // NEW: orderId[] — IDs of character's active buy orders
character.economyStats      // NEW: { totalSold, totalBought, totalListingFees, totalTaxPaid, totalSalvaged }
```

**Note on `character.activeListings`:** This is an index for fast O(1) lookup.
The canonical listing data lives in `data/market.json`, not the character record.

### 7.2 Run-side additions (destroyed on permadeath)

None required. All economic actions (listing, buying, salvaging) are account-side
operations. The only run interaction is that `!salvage` removes an item from
`run.inventory` — which is run-side and therefore intentionally lost on death.
Items in the vault are safe.

### 7.3 World State (`data/world.json`, new document)

Managed via new `store.js` exports: `getWorld()`, `putWorld()`.

```js
{
  treasury: 0,                      // accumulated listing fees + taxes
  goldInCirculation: 0,             // sum of all character.gold
  treasuryMode: false,              // auto-inflation brake flag
  prosperityEventFiredAt: 0,        // last treasury-prosperity drain timestamp
  factionWarFund: { A: 0, B: 0 },  // placeholder for Agent 3 faction war
  bounties: [],                     // active boss bounties
  history: {                        // price history ring buffer
    "weapon:rare": [...],
    "ring:legendary": [...]
  }
}
```

### 7.4 Market Document (`data/market.json`, new document)

Managed via new `store.js` exports: `getMarket()`, `putMarket()`.

```js
{
  listings: {                         // keyed by listingId (uuid-like)
    "lst_abc123": {
      id: "lst_abc123",
      seller: "twitchlogin",
      item: { ...Item },              // full item snapshot at list time
      kind: "directSale" | "auction",
      price: 5000,                    // asking price or auction start
      bids: [],                       // [{ bidder, amount, at }] for auctions
      createdAt: 1234567890,
      expiresAt: 1234567890,
      loreStamp: null | { ... }       // optional stamp
    }
  },
  buyOrders: {
    "ord_xyz789": {
      id: "ord_xyz789",
      buyer: "twitchlogin",
      filter: { slot, rarity, minPower, effect },
      price: 8000,
      createdAt: 1234567890,
      expiresAt: 1234567890
    }
  }
}
```

Listings and orders are indexed in memory for fast matching on item list. The
server maintains an in-memory `Map<listingId, listing>` rebuilt from disk on
startup — no separate DB needed given current scale.

---

## 8. New HTTP Endpoints / Chat Commands

All endpoints are called by `chat-elixir` (`Chat.Mmo.Bridge`) which forwards
Twitch chat commands. The MMO server is the source of truth (Invariant 8).

Each endpoint is wrapped in `guard()` (supervisor.js) for fault isolation and must
complete in < 50ms to avoid blocking chat throughput at thousands of chatters.

### 8.1 Market Listing

**Verb:** POST
**Kind:** http
**Path:** `/api/market/list/:login`
**Body:** `{ slot: string, kind: "directSale"|"auction", price: number }`
**Effect:**
1. `store.getPlayer(token)` → resolve character
2. Find item in `run.inventory` or `character.vault` for the given slot (highest
   power item in that slot, or caller specifies index via `itemIndex` param)
3. `canList(character, item)` — checks gold ≥ fee, slot count ≤ marketSlots
4. Deduct `listingFee(item.rarity)` from `character.gold`
5. Remove item from inventory/vault, create listing in market.json
6. Update `character.activeListings` and `world.goldInCirculation`
7. Push feed entry `{ kind: "market_list", seller, item.name, price }`
8. Return `{ ok, listingId, fee, goldRemaining }`

Chat trigger: `!list <slot> <price>` or `!list <slot> auction`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/market/buy/:login`
**Body:** `{ listingId: string }`
**Effect:**
1. Resolve buyer character
2. Lock listing (mark `listing.pendingBuy = true` to prevent race on concurrent
   claims — held for 200ms, then released)
3. Check `buyer.gold - buyer.goldEscrowed >= listing.price`
4. Compute `tax = transactionTax(listing.price)`
5. Deduct `listing.price + tax` from buyer; credit `listing.price * (1 - TAX_RATE)`
   to seller (net of tax); add `tax` to `world.treasury`
6. Deliver item to `buyer.vault`
7. Remove listing; update `seller.activeListings`; update world circulation
8. Push feed entry for legendary+ purchases
9. Return `{ ok, item, goldSpent, taxPaid }`

Chat trigger: `!buy <listingId>`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/market/bid/:login`
**Body:** `{ listingId: string, amount: number }`
**Effect:**
1. Validate auction has not expired
2. Check `amount > currentHighBid` and `buyer.gold - buyer.goldEscrowed >= amount`
3. Escrow the delta (`amount - previousBidByThisBuyer`) from buyer.gold into
   `buyer.goldEscrowed`; refund previous leader's escrow
4. Update `listing.bids` with new bid
5. Return `{ ok, newHigh: amount }`

Chat trigger: `!bid <listingId> <amount>`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/market/offer/:login`
**Body:** `{ slot: string, rarity: string, minPower: number, price: number, effect?: string }`
**Effect:**
1. Check `buyer.activeBuyOrders.length < MARKET_BUY_ORDER_MAX`
2. Check available gold >= price (escrow `price` from character.gold)
3. Create buy order in market.json; add to `character.activeBuyOrders`
4. Run buy-order-match scan against all current listings (O(n) listings scan,
   acceptable at current scale; cap scan at 500 listings)
5. If match found → auto-execute as immediate sale
6. Return `{ ok, orderId, matched: bool }`

Chat trigger: `!offer <slot> <rarity> <price>`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/market/unlist/:login`
**Body:** `{ listingId: string }`
**Effect:**
1. Verify `listing.seller === login`
2. Return item to vault (no fee refund)
3. Remove listing; update `character.activeListings`
4. Return `{ ok, item }`

Chat trigger: `!unlist <listingId>`

---

**Verb:** GET
**Kind:** http
**Path:** `/api/market`
**Body:** (query params) `slot?, rarity?, minPower?, sort?`
**Effect:** Returns paginated listing snapshot (max 20 per page). No auth required.

Chat trigger: `!market` (returns condensed top-5 summary per rarity via chat reply)

---

**Verb:** GET
**Kind:** http
**Path:** `/api/market/price/:slot/:rarity`
**Body:** none
**Effect:** Returns last-5 sale prices + 7-day median from world.history ring buffer.

Chat trigger: `!price <slot> <rarity>`

---

### 8.2 Salvage + Crafting

**Verb:** POST
**Kind:** http
**Path:** `/api/salvage/:login`
**Body:** `{ slot?: string, all?: boolean, keepRarity?: string }`
**Effect:**
1. Identify items to salvage (specific slot or all below `keepRarity`)
2. For each item: grant `RUNE_DUST_PER_RARITY[item.rarity]` to `character.runeDust`
3. Remove items from `run.inventory` (or vault if `fromVault: true`)
4. Update `character.economyStats.totalSalvaged`
5. Return `{ ok, dustGained, itemsDestroyed }`

Chat trigger: `!salvage` / `!salvage all`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/reroll/:login`
**Body:** `{ slot: string }`
**Effect:**
1. Find equipped item in `character.run.gear[slot]`
2. Check `character.runeDust >= REROLL_DUST_COST[item.rarity]`
3. Deduct dust; draw a new affix using `makeRng(Date.now() ^ character.seed)` (NOT
   the run RNG — account-side action)
4. Replace a random affix on the item; increment `item.rerolls`
5. Recalculate `item.power = itemPower(item)` and `item.value = sellValue(item)`
6. Persist; return `{ ok, newAffix, item }`

Chat trigger: `!reroll <slot>`

---

### 8.3 Vault

**Verb:** GET
**Kind:** http
**Path:** `/api/vault/:login`
**Effect:** Returns `character.vault` contents.

Chat trigger: `!vault`

---

**Verb:** POST
**Kind:** http
**Path:** `/api/vault/expand/:login`
**Body:** none
**Effect:**
1. Check `character.vaultCapacity < VAULT_MAX_CAPACITY`
2. Check `character.shards >= VAULT_EXPAND_SHARDS`
3. Deduct shards; set `character.vaultCapacity = VAULT_MAX_CAPACITY`
4. Return `{ ok, newCapacity }`

---

### 8.4 Economy Status Endpoints

**Verb:** GET
**Kind:** http
**Path:** `/api/economy`
**Effect:** Returns world economy snapshot: `{ treasury, goldInCirculation, treasuryMode, topListings, recentSales }`.

---

**Verb:** POST
**Kind:** http
**Path:** `/api/bounty/post/:login`
**Body:** `{ bossId: string, amount: number }`
**Effect:** Escrow amount from character.gold; add to world.bounties.

Chat trigger: `!bounty <bossId> <amount>`

---

### 8.5 Cron / Background Jobs

A `superviseInterval('market.sweep', fn, 60_000)` (every 60s) in `server.js`:
1. Expire listings past `expiresAt` → return items to seller vault, no fee refund
2. Finalize ended auctions → pay seller, deliver to winner vault, collect tax
3. Update `world.goldInCirculation` gauge
4. Check `world.goldInCirculation > ECONOMY_GOLD_CAP` → activate/deactivate treasury mode
5. Check `world.treasury > ECONOMY_TREASURY_PROSPERITY_THRESHOLD` → fire prosperity event

---

## 9. Scaling & Anti-Abuse

### 9.1 Per-Message Work

Chat pings arrive at O(thousands/minute) via `bridge.ex → POST /api/chat-ping/:login`.
Market commands arrive at lower frequency (intentional chat-command, not every message).
All market endpoints do:
- One `store.getPlayer()` → in-memory Map lookup (O(1))
- One `store.getMarket()` → in-memory object (O(1))
- Validation + mutation (O(1) per listing)
- One deferred `store.flush()` (debounced, `STORE_FLUSH_MS = 2500`)

This is well within the per-message budget. The buy-order match scan is O(listings)
but market commands are low-frequency (< 1/second per player); cap the scan at
500 and this is safe.

### 9.2 Concurrency: Listing Race

Two players simultaneously buying the same `directSale` listing (concurrent POST
requests) could double-spend. Prevention:

- Set `listing.pendingBuy = true` atomically at the top of the buy handler.
- If `pendingBuy` is already true, return `{ ok: false, error: "listing_claimed" }`.
- Since Node.js is single-threaded, there is no true concurrency race within a
  single process. The `pendingBuy` flag protects against requests that arrive in
  the same event loop turn but are queued sequentially.
- Clear `pendingBuy` after 200ms if the transaction was not completed (guard
  failure path).

### 9.3 Gold Escrow Integrity

Buy orders escrow gold. The escrow is tracked as `character.goldEscrowed`. Any
endpoint that checks available gold must use `character.gold - character.goldEscrowed`
as the effective free balance. The `canList()` and `canBid()` helpers in
`shared/market.js` enforce this. The validator in `validate.js` should clamp
`goldEscrowed` to `[0, character.gold]`.

### 9.4 Rate Limiting Market Commands

Market commands (list/buy/bid/offer) are rate-limited per login:
- Max 10 market actions per 60-second window
- Tracked in a `Map<login, { count, windowStart }>` in-memory rate limiter in
  the market endpoint handlers (not in validate.js, which is stateless)

This prevents bots from spamming buy orders to corner the market.

### 9.5 Price Manipulation Detection

Market history is public. Players who consistently list well above median and
no-one buys are providing free intel to the community. No server-side price cap
is imposed — price caps in MMO economies historically cause shortages and black
markets. Instead, the `!price` command provides transparent price history so the
community self-regulates.

### 9.6 Store Document Scaling

At 10,000 players with active listings, `data/market.json` could reach ~50MB
(each listing ~5KB). The current JSON-file store will degrade. This is a known
scaling boundary; the store.js interface is designed to be swappable (Invariant 7).
Migrating market.json to SQLite is a one-file change with no API changes.

Recommended migration trigger: market.json > 10MB or listing count > 2,000.

---

## 10. Integration Points with Existing Code

### 10.1 `delveTick()` additions

In `shared/progression.js:delveTick()`, after the gold credit line
(`character.gold += goldGained`), add a world circulation update:

```js
// New: update world gold tracking (server-side only; no-op in browser)
if (typeof updateWorldCirculation === 'function') {
  updateWorldCirculation(goldGained);
}
```

The `updateWorldCirculation` function is injected by the server (not in shared/,
to maintain dual-runtime purity). Client-side this function is undefined and the
check gates cleanly.

### 10.2 `resolveDeath()` additions

In `shared/progression.js:resolveDeath()`, after prestige minting, add shard minting:

```js
const shardsGained = Math.floor(prestigeGained * SHARD_PER_PRESTIGE);
character.shards = (character.shards || 0) + shardsGained;
```

This requires importing `SHARD_PER_PRESTIGE` from `shared/economy-constants.js`.

### 10.3 `bankAtTown()` additions

In `shared/progression.js:bankAtTown()`, items are sold to the NPC vendor at
`sellValue(item)`. After this, the server-side call also updates world circulation
(gold enters from "nowhere" — the NPC is the gold faucet). The server injects
a callback:

```js
// After bankAtTown(), in server route:
world.goldInCirculation += goldFromBank;
```

### 10.4 `validate.js` additions

New fields require validation:

```js
// Add to vCharacter():
character.shards = vInt(raw.shards, { min: 0, max: 1_000_000, def: 0 });
character.runeDust = vInt(raw.runeDust, { min: 0, max: 10_000_000, def: 0 });
character.vault = vArr(raw.vault, vItem, { maxLen: VAULT_MAX_CAPACITY, def: [] });
character.vaultCapacity = vEnum(raw.vaultCapacity, [20, 40], { def: 20 });
character.marketSlots = vEnum(raw.marketSlots, [1, 2, 3], { def: 1 });
character.goldEscrowed = vInt(raw.goldEscrowed, { min: 0, max: raw.gold || 0, def: 0 });
character.activeListings = vArr(raw.activeListings, vStr, { maxLen: 3, def: [] });
character.activeBuyOrders = vArr(raw.activeBuyOrders, vStr, { maxLen: 5, def: [] });
```

A new `vItem(raw)` validator mirrors the existing item schema validation.

### 10.5 `store.js` additions

New exports required:

```js
export function getMarket() { ... }        // returns in-memory market object
export function putMarket(market) { ... }  // queues flush
export function getWorld() { ... }         // returns world state
export function putWorld(world) { ... }    // queues flush
export function getMarketHistory() { ... } // ring buffer for !price
export function pushMarketHistory(slot, rarity, price) { ... }
```

The `initStore()` function should load `market.json` and `world.json` alongside
the existing `players.json` and `feed.json`.

### 10.6 `server.js` additions

New supervised background loop:

```js
superviseInterval('market.sweep', async () => {
  const market = store.getMarket();
  const world = store.getWorld();
  // ... expire listings, finalize auctions, check caps
  store.putMarket(market);
  store.putWorld(world);
}, 60_000);
```

New routes registered in the same `server.js` route-registration block:

```js
app.post('/api/market/list/:login',   guard('market.list',   handleMarketList));
app.post('/api/market/buy/:login',    guard('market.buy',    handleMarketBuy));
app.post('/api/market/bid/:login',    guard('market.bid',    handleMarketBid));
app.post('/api/market/offer/:login',  guard('market.offer',  handleMarketOffer));
app.post('/api/market/unlist/:login', guard('market.unlist', handleMarketUnlist));
app.get('/api/market',                guard('market.browse', handleMarketBrowse));
app.get('/api/market/price/:slot/:rarity', guard('market.price', handleMarketPrice));
app.post('/api/salvage/:login',       guard('salvage',       handleSalvage));
app.post('/api/reroll/:login',        guard('reroll',        handleReroll));
app.get('/api/vault/:login',          guard('vault',         handleVault));
app.post('/api/vault/expand/:login',  guard('vault.expand',  handleVaultExpand));
app.get('/api/economy',               guard('economy',       handleEconomy));
app.post('/api/bounty/post/:login',   guard('bounty.post',   handleBountyPost));
```

### 10.7 `FEED_KINDS` extension

Add new feed kinds to `shared/constants.js`:

```js
export const FEED_KINDS = [
  "death", "legendary", "ascend", "boss", "milestone",
  "market_sale",       // NEW: a legendary+ item sold player-to-player
  "market_auction",    // NEW: auction finalized at a notable price
  "market_bounty",     // NEW: boss bounty claimed
  "economy_event"      // NEW: treasury prosperity or treasury mode activated
];
```

---

## 11. Cross-Agent Dependencies

| Agent | Dependency | Detail |
|---|---|---|
| **Agent 1 (systems)** | Faction gating for markets | If factions control market districts, listing availability and fees may vary by faction. Economy provides the fee constants; systems provides the faction/reputation gate. |
| **Agent 3 (narrative)** | Faction war fund + lore stamps | Faction wars are the mega-sink event; narrative defines when wars start/end. Lore stamps create narrative provenance for items. |
| **Agent 4 (retention)** | Daily/weekly market challenges | Retention agent defines daily quest hooks ("sell one epic today" → bonus gold reward). Economy provides the endpoints; retention triggers the daily refresh. |
| **Agent 5 (twitch)** | Chat command parsing + reply formatting | Twitch interaction agent owns the chat command language and the reply format for `!market`, `!price`, `!vault`. Economy owns the server endpoints; twitch owns the chat UX. |
| **Agent 6 (simulation)** | World events as mega-sinks | Town reconstruction, world disasters that drain the treasury. Simulation agent drives the world-tick that triggers these events. |
| **Agent 7 (npc)** | NPC trader price floors | NPC vendor `sellValue(item)` is the price floor that prevents player market deflation below crafting cost. NPC agent may introduce specialized NPC traders with different buy/sell rates. |

---

## 12. Open Conflicts to Resolve

1. **Reroll RNG source:** Rerolling an equipped item must NOT consume the run's
   `rngState` (that would desync offline sim). This document proposes using a
   fresh non-seeded RNG (`Date.now() ^ character.seed`). However, this breaks the
   shared/ determinism invariant if `reroll` logic ever moves into `delveTick()`.
   Resolution needed: confirm reroll is permanently a server-side-only action
   (never called in offline sim path). **Verdict suggested: reroll lives in server
   route only, never in shared/.**

2. **Vault items and offline sim:** During offline sim, `run.inventory` can overflow
   and auto-sell items (existing behavior). Should overflow-sold items instead go
   to the vault? If yes, this modifies `delveTick()` behavior and requires vault
   state to be accessible in the shared/ sim. Given the dual-runtime constraint,
   vault access in shared/ requires careful design. **Suggested resolution: keep
   auto-sell behavior unchanged; vault is a manual action only (no sim interaction).**

3. **Buy order matching on listing creation:** The buy-order-match scan runs
   synchronously in the listing endpoint. At large listing scale (>500 orders),
   this could be slow. Agent 6 (simulation) may define async world-tick patterns
   that could host this scan. **Suggested resolution: cap scan at 500 orders for
   now; defer to async world-tick when order book grows.**

4. **Gold circulation accounting source-of-truth:** `world.goldInCirculation`
   must be perfectly consistent with the sum of all `character.gold` values.
   Starting from a non-zero player base means a bootstrap scan is needed. Keeping
   this in sync incrementally is fragile under crashes. **Suggested resolution:
   treat `world.goldInCirculation` as an approximate gauge (re-derived from a
   full player scan every 6h by a cron), not an authoritative balance.**

5. **Listing ID format:** Listings need a collision-resistant ID. The current
   store uses login-keyed records. Suggested: `lst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`.
   This uses `Math.random()` (server-side only, not in shared/) — acceptable per
   Invariant 1, but worth flagging as a design decision.

6. **Faction-controlled market districts (dependency on Agent 1/3):** If factions
   own market zones, economic design needs to know: Can players from different
   factions trade? Are fees faction-specific? This document assumes a universal
   market until faction design is resolved. **This is the largest open dependency.**

---

## 13. Success Criteria

1. A player who actively delves at zone 5 for 8 hours cannot accumulate more gold
   than their weekly spending capacity across potions, upgrades, listing fees, and
   rerolls (i.e., active play stays economically meaningful, not redundant).
2. A legendary item dropped by an endgame player commands a market price 5–20x its
   NPC sell value in steady-state (player premium justifies engaging with market).
3. Gold-in-circulation grows at < 5% per week after the first month of operation,
   measured by the `/api/economy` gauge.
4. Market listings for common items are net-negative after fees (prevents listing
   spam; sellers rationally NPC-sell commons).
5. The 8% transaction tax removes at least 200,000 gold/day from circulation when
   100+ players are active (healthy velocity).
6. Treasury Mode auto-activates and successfully depresses gold accumulation within
   72 hours of hitting `ECONOMY_GOLD_CAP`.
7. A new player can earn enough gold in their first 3 delve runs to afford one
   market purchase of a rare-tier item (accessibility gate — economy isn't
   exclusively endgame-locked).
8. The `!price` command returns meaningful historical data within 48 hours of a
   category's first sale.
9. Rune Dust is in net demand (more players want to reroll than have dust to spend)
   within the first week — confirms Rune Dust as a genuine scarcity currency.
10. All market endpoints respond in < 50ms at 1,000 concurrent active sessions
    (confirmed by `/healthz` latency tracking).

---

## 14. Balance Tuning Cheat Sheet

Quick-reference for post-launch adjustments (all constants in `shared/economy-constants.js`
or `shared/market.js` — no code changes required, only constant edits):

| Symptom | Adjustment |
|---|---|
| Too much gold in market, prices falling | Increase `LISTING_FEE[rarity]` for top tiers; decrease `ECONOMY_GOLD_CAP` |
| Market too thin, nothing for sale | Decrease listing fees; increase vault capacity |
| Rune Dust too scarce, crafting dead | Increase `RUNE_DUST_PER_RARITY` or decrease `REROLL_DUST_COST` |
| Commons flooding the market | Increase common/uncommon listing fee to above their NPC sell value |
| Legendaries never appearing | Increase `SHARD_PER_PRESTIGE` → more market slots → more listings |
| Buy order escrow draining player liquidity | Decrease `MARKET_BUY_ORDER_MAX` |
| Treasury mode firing too often | Increase `ECONOMY_GOLD_CAP` |
| Transaction tax feels punishing | Decrease `TRANSACTION_TAX_RATE` (floor: 0.05 to keep sink meaningful) |
