# SIGMA ABYSS — Master Game Design Document (Synthesis)

> **Lead Architect synthesis** of the 7-agent design team. This is the single
> authoritative reconciliation. Where the per-agent docs (`01-systems.md` …
> `07-npc.md`) conflict, **this document wins** and the per-agent docs are read
> as detail/rationale only. Cross-references are inline: `[A1]`…`[A7]`.

**Status:** Buildable plan. No code is written by this doc — it defines the
unified data model, the deduplicated `shared/` module surface, the consolidated
API, and the emergent-story interlock. Build order is in `IMPLEMENTATION-PLAN.md`.

---

## 0. The single biggest conflict, resolved up front

Five of the seven agents independently designed a `shared/factions.js` — with
**five different faction ID sets, two different reputation scales, and three
different zone mappings.** This is the central reconciliation. The canon below
is binding; all agent docs are remapped onto it.

### 0.1 Canonical factions (5)

The five factions map 1:1 onto the **five existing danger zones**
(`shared/zones.js`: `goblin_warrens, cursed_forest, infernal_highway,
demon_catacombs, abyss_ruins`), per [A1] which is the only design anchored to the
real zone geography. Other agents' placeholder IDs are aliased here.

| Canon ID | Name | Home zone (real) | Archetype | Rival | Allied | Color |
|---|---|---|---|---|---|---|
| `iron_veil` | Iron Veil | `goblin_warrens` | Defense / wardens | `crimson_pact` | `void_order` | `#4aa3ff` |
| `crimson_pact` | Crimson Pact | `cursed_forest` | Blood-oath offense | `iron_veil` | `ember_court` | `#ff4d6d` |
| `void_order` | Void Order | `infernal_highway` | Sorcery / scholars | `ember_court` | `iron_veil` | `#b86bff` |
| `ember_court` | Ember Court | `demon_catacombs` | Merchant-kings / economy | `void_order` | `crimson_pact` | `#ffe44d` |
| `abyssal_convergence` | Abyssal Convergence | `abyss_ruins` | Nihilist / chaos (500-prestige gate to join) | all | none | `#5bd16a` |

**Alias table** (so the per-agent docs remain readable without rewrites):

| Doc | Their ID → | Canon ID |
|---|---|---|
| [A3] | `ironveil`, `voidcult`, `merchants`, `healers_guild`, `honor_guard` | `iron_veil`, `void_order`/`abyssal_convergence`, `ember_court`, `iron_veil`, `crimson_pact` (see §0.4) |
| [A5] | `void_order`, `crimson_pact`, `iron_conclave`, `shadow_web` | `void_order`, `crimson_pact`, `iron_veil`, `abyssal_convergence` |
| [A6] | `ironhollow_guard`, `void_order`, `crimson_pact`, `bone_syndicate`, `wanderers` | `iron_veil`, `void_order`, `crimson_pact`, `ember_court`, `abyssal_convergence` |
| [A7] | `ironhollow`, `crimson_pact`, `bone_court`, `void_order`, `wanderers` | `iron_veil`, `crimson_pact`, `ember_court`, `void_order`, `abyssal_convergence` |

[A3]'s `healers_guild` / `honor_guard` are folded into faction *roles*, not new
factions: Iron Veil is the healer/warden faction (owns scar cleansing), and
honor/dueling is a cross-faction event flavor, not an allegiance.

### 0.2 Canonical reputation model — **two-axis, both account-side**

The docs split between a single scalar 0–1000 ([A1], [A6]) and a per-faction map
−100..+100 ([A3], [A5]-contribution, [A7]). We keep **both**, because they serve
different jobs and reconcile cleanly:

- **`character.faction`** — the *one* faction you have **joined** (`!join`),
  account-side, `string | null`. Survives permadeath. This is your allegiance.
- **`character.factionRep`** — a **map** `{ [factionId]: int }` of standing with
  **every** faction. Range **0..1000** for your *joined* faction (the [A1]/[A6]
  rank ladder), and the same map also holds **±-signed standing** with others
  driven by faction-tagged kills ([A7]). To unify the scales we store all values
  in the **0..1000** domain and define a **neutral baseline of 500**: values
  above 500 = friendly, below 500 = hostile. `factionRep[joinedFaction]` starts
  at 0 on join and climbs to 1000 (the rank ladder reads it as `rep` directly;
  see `factionRank()`); standing with **non-joined** factions starts at the 500
  neutral baseline and drifts. This makes [A1]'s rank ladder and [A7]'s
  kill-rep deltas share one field without two clamping regimes.

> Implementation simplification adopted: the rank ladder (`factionRank(rep)`)
> reads `factionRep[character.faction]` directly on the **0..1000** scale. The
> kill-driven hostility/affinity from [A7] writes to the **other** keys around
> the 500 baseline. A single `vFactionRep()` validator clamps every value to
> `[0, 1000]`. No field has a negative domain — this avoids the [A3]/[A7]
> `−100..+100` vs [A1]/[A6] `0..1000` split entirely.

### 0.3 Canonical reputation rank ladder (joined faction, [A1])

| `factionRep[faction]` | Rank | Label | Perk |
|---|---|---|---|
| 0–49 | 0 | Outsider | zone access, no perk |
| 50–149 | 1 | Initiate | +5% gold in home zone, faction vendor |
| 150–299 | 2 | Member | faction crafting recipes, guild bank read |
| 300–499 | 3 | Champion | faction weapon arts, guild bank write, **scar cleanse (Iron Veil)** |
| 500–749 | 4 | Vanguard | +15% XP home zone, hourly faction elite |
| 750–999 | 5 | Warlord | +25% loot bias home zone, faction title |
| 1000 | 6 | Sovereign | one-of-one faction drop eligibility |

### 0.4 Canonical world-tick cadence — **ONE loop, 60s**

[A3] wants `world.tick` @30s; [A1]/[A2]/[A4]/[A6]/[A7] want 60s. **Canon: a
single `world.tick` at `WORLD_TICK_MS = 60_000`** under `superviseInterval`
([invariant 6]). There is exactly **one** world tick function, `worldTick(rt)` in
`server/world-tick.js`, which calls sub-advancers in a fixed order (factions →
zones → NPC schedules → market sweep → crisis/world-event state machine →
retention sweeps). 30s crisis responsiveness ([A3]) is preserved by giving the
crisis state machine a 60s `brewing` window (was 60s anyway) and resolving on the
next 60s tick — the 30s figure was about *announce latency*, which the WS
`worldPulse` broadcast covers within one tick. This honors the PSU power-safety
rule: one cheap (<50ms, ~500-entity) loop, not five overlapping timers.

### 0.5 Canonical world store documents — **TWO files, not five**

The agents proposed `data/world.json` (×4, incompatible shapes),
`data/world-state.json` ([A5]), `data/market.json` ([A2]/[A6]), `data/graves.json`
([A1]), `data/global-challenge.json` / `data/world-event.json` /
`data/monuments.json` / `data/hall-of-fame.json` ([A4]). Canon consolidates to:

- **`data/world.json`** — the single shared-world document. One top-level object
  with namespaced sections: `factions`, `zones`, `npcs`, `crisis`, `eventQueue`,
  `retention` (global challenge + world event + hall of fame + monuments ring),
  `economy` (treasury, circulation gauge, price-history ring), `graves`, `epoch`,
  `worldSeed`. Flushed on the existing debounce. High-frequency-write subsections
  (`graves`, `economy.priceHistory`) are kept as bounded ring buffers so the
  atomic write stays small.
- **`data/market.json`** — listings + buy orders **only**. Split out per
  [A2 §9.6]/[A6 conflict 6] because at 200×5KB listings the world.json atomic
  write would get slow. Everything else stays in `world.json`.

All access goes through `server/store.js` exports (invariant 7). Monuments,
hall-of-fame, global-challenge, and world-event live as **sections of
`world.json`**, not separate files — they are low-volume and bounded.

### 0.6 Canonical `shared/factions.js` — merge of 5 designs

ONE module. Superset of all five export lists, deduped:

```
FACTIONS, FACTION_IDS, FACTION_MAX_REP (1000), FACTION_REP_NEUTRAL (500),
FACTION_JOIN_COOLDOWN_MS, FACTION_DEFECTOR_MS,
factionById(id), factionRank(rep), factionRankLabel(rank), factionRankTitle(factionId, rep),
isRival(a, b), rivalMod(a, b),
factionCombatMods(factionId, factionRep, zoneId),   // [A1] derive() stacking, pure
factionZoneMod(factionId, worldZone),               // [A6] conquest bonus, pure
factionArts(factionId, rank),                        // [A1] weapon arts
factionRepGainForKill(zoneId, factionId, killKind),  // [A1]+[A7] kill rep
factionDisposition(factionRep, factionId),           // [A7] band label
priceMultiplier(factionRep, factionId),              // [A7] vendor pricing
pickFactionRaider(worldSeed, zoneTick, candidates)   // [A6] deterministic territory sim
```

[A5]'s `CRAFT_RECIPES` are **moved out** to `shared/crafting.js` ([A1]) — crafting
is one system, owned by one module. [A7]'s `applyKillRep` / `encounterBias` /
`checkWarThreshold` move to `shared/faction-engine.js` (kept separate because it
mutates `character.factionRep` as a side-effecting helper, whereas `factions.js`
stays a pure catalog + pure math). [A6]'s `FACTION_JOIN_COST_PRESTIGE` is
**dropped** — joining is free; defecting carries the penalty (resolving [A6
conflict 2]).

---

## 1. World Concept

**SIGMA ABYSS** is a browser-based retro auto-battler **persistent-Twitch-chat
MMO**. Pokémon-overworld look, Solo Leveling power-curve, Diablo loot, roguelike
permadeath, RimWorld personality sim, and Fear & Hunger permanent stakes. Every
Twitch chatter is a *sigma* delving the Abyss. The existing single-player vertical
slice (deterministic `delveTick` auto-battler, 7-stat loot, prestige-on-death,
shared feed + leaderboard) is **kept intact**; this design layers a **living
shared world** on top of it without breaking offline determinism.

The pivot from "everyone plays their own isolated sigma" to "everyone inhabits one
persistent Abyss" rests on five pillars, one per agent cluster:

1. **Allegiance** (factions + reputation) — [A1], [A6], [A7].
2. **A player-driven economy** (market, salvage, vault, crafting) — [A2], [A1].
3. **A world that evolves while you're gone** (world tick, zone pressure, faction
   territory, NPC schedules) — [A6], [A7].
4. **Emergent narrative** (world crises, trait×world collisions, procedural
   quests, NPC memory) — [A3], [A7].
5. **Habit + mastery loops** (daily/weekly/season/epoch, achievements,
   collections) — [A4].

All five surface through **Twitch chat commands** ([A5], invariant 8) and an
**additive OBS overlay** (invariant 9).

### 1.1 The emergent-story thesis

The whole point is that the five pillars **collide**, not run in parallel. A
worked example threaded through the systems:

> A `void_convergence` **world crisis** [A3] fires under the world tick because 12
> sigmas are online. Danger climbs 40% for everyone (`run._worldEffect`, [A3]).
> A `bloodlust` sigma in Iron Veil [A1] gets the trait×crisis mood-spike [A3 §2.4].
> While the crisis rages, Void Order's autonomous **faction raider** [A6] presses
> `infernal_highway` and *conquers* it — flipping `factionZoneMod` so Iron Veil
> members now fight at −0.1 there [A6]. A player dies to the surge carrying a
> faction-bound legendary; a **grave** spawns [A1] and the **NPC** Kael remembers
> the death [A7], shifting his disposition. The death also banks toward the
> sigma's **daily objective** [A4] and mints **prestige shards** [A2]. The
> legendary the dying run held auto-**enshrines to the museum** [A4]. The
> **narrative trigger** `death_in_crisis` [A3] writes one emergent feed line. The
> faction war moves the **season leaderboard** [A4]. Every subsystem fed every
> other subsystem from a single event.

---

## 2. Unified Data Model (RUN / ACCOUNT / WORLD)

Invariant 4 is sacred: permadeath erases **RUN**; **ACCOUNT** survives; **WORLD**
is server-owned and shared. Every new persistent field below was audited against
that line. Anything that must outlive death is on the ACCOUNT or WORLD side.

### 2.1 RUN — `character.run.*` (erased on permadeath, mostly `_`-prefixed ephemerals)

All run-side additions are **transient, server-injected, never persisted**, and
**stripped by `validate.js:vRun`** (so a malicious client cannot forge them).
Critically, **none touch `run.rngState`** — they are applied after RNG draws
using the existing storyteller-effect block (`progression.js` ~L481-504), so they
cannot desync offline sim (invariant 2).

| Field | Source | Note |
|---|---|---|
| `run._worldEffect` | [A3] | active crisis personalEffect (danger/loot/xp/disease deltas) |
| `run._pendingWorldEvents` | [A6] | per-zone world events injected at save-read, consumed once |
| `run._factionZoneMod` | [A6] | precomputed faction conquest combat mod for the deploy zone |
| `run._factionDebtEncounterFired` | [A1] | one-shot Debt Collector spawn flag |
| `run._questProgress` | [A3] | within-run quest scratch (boss kills, breaks survived) |
| `run._crisisContributed` | [A3] | did this run contribute to the active crisis |
| `run._dailyKillProgress`, `run._dailyDepthHighWater` | [A4] | banked to account on death/bank |
| `run.gatherContributions` | [A5] | display-only set of gather windows joined this run |

### 2.2 ACCOUNT — `character.*` (survives permadeath)

Validated in `server/validate.js:vCharacter` or **silently dropped** (invariant 5).
Grouped by owning agent; conflicts resolved.

**Factions / reputation (canon §0.2):**
| Field | Type | Validator |
|---|---|---|
| `faction` | `string \| null` | `vEnum(FACTION_IDS, null)` |
| `factionRep` | `{ [factionId]: int 0..1000 }` | `vFactionRep()` |
| `factionRank` | `int 0..6` (cached, recomputed) | `vInt(0,6)` |
| `factionJoinedAt` | `number` (ms) | `vNum` |
| `factionDefectorUntil` | `number` (ms) | `vNum` |
| `factionDebt` | `{ [zoneId]: int 0..20 }` | `vObj`+`vInt` |
| `factionContribution` | `int` ([A5] weekly war) | `vInt(0,1e9)` |
| `pledgedFaction` / `pledgedFactionChangedAt` | `string\|null` / `number` ([A7]) | `vEnum`/`vNum` |

> **`pledgedFaction` vs `faction`:** these collapse into ONE concept. `faction`
> (from `!join`) IS the pledge. [A7]'s `pledgedFaction` + its 7-day cooldown is
> merged into `faction` + `factionJoinedAt` + the 7-day `FACTION_JOIN_COOLDOWN_MS`.
> There is no separate pledge. [A7]'s `pledge rep>=40` gate is dropped in favor of
> [A1]'s open join (rep starts at 0 on join). Drop `pledgedFaction`/`pledgedFactionChangedAt`.

**Progression / skills (Account):**
| Field | Type | Agent |
|---|---|---|
| `skillTalents` | `{ [skillId]: [t1\|null, t2\|null, t3\|null] }` | [A1] |
| `scars` | `Array<{stat, amount:-2, gainedAt}>` (max 5) | [A1] |

**Economy (Account, [A2]):**
| Field | Type |
|---|---|
| `shards` (Prestige Shards, non-transferable) | `int 0..1e6` |
| `runeDust` | `int 0..1e7` |
| `vault` / `vaultCapacity` | `Item[]≤40` / `20\|40` |
| `marketSlots` | `1\|2\|3` |
| `goldEscrowed` | `int 0..gold` |
| `activeListings` / `activeBuyOrders` | `listingId[]≤3` / `orderId[]≤5` |
| `economyStats` | `{totalSold,totalBought,totalListingFees,totalTaxPaid,totalSalvaged}` |

**Narrative / quests (Account) — ONE quest system, see §3.4:**
| Field | Type | Agent |
|---|---|---|
| `quests` | unified quest-instance array (≤20) | [A3]+[A7] merged |
| `questXp` / `questLevel` | `int` / `int 0..50` | [A3] |
| `narrativeFlags` | `{ [flag]: bool }` (≤50) | [A3] |
| `npcRelationships` | `{ [npcId]: {score:-100..100, flags[], lastSeenAt} }` (≤200) | [A7] |

> [A3]'s `character.factionRep` as a **per-faction object** and [A7]'s identical
> field are the **same field** — defined once in §0.2. [A3]'s `npcOpinions` and
> [A7]'s `npcRelationships` are the **same field** — canon uses `npcRelationships`
> ([A7] owns the schema; [A3]'s `npcOpinions` stub is dropped). [A3]'s
> `character.quests` and [A7]'s `character.questLog` are **merged** into one
> `character.quests` array (§3.4).

**Retention (Account, [A4]):**
`dailyObjectives`, `weeklyBounties`, `achievements{earned,progress,score}`,
`season{...}`, `pastSeasons`, `bestiary{kills,firstKilledAt}`, `museum[≤20]`,
`activeTitle`, `cosmeticLoadout`, `rivals[≤3]`, `streakPrestigeMul`,
`legacyPrestigeMul`.

**Item-level new fields (on items in inventory/vault/gear/listings):**
| Field | Agent | Validator |
|---|---|---|
| `bound` (`'unbound'\|'account'\|'faction'`) | [A1] | `vEnum`, default `'unbound'` |
| `setId` (`string\|null`) | [A1] | `vEnum(SET_IDS,null)` |
| `rerolls` (`int≥0`) | [A2] | `vInt` |
| `loreStamp` (`{seller,title,rerolls,depthZone,flavor,stampedAt}\|null`) | [A2] | `vLoreStamp` |
| `reagent` flag / `code` (crafting reagent items) | [A1] | `vItem` extension |

### 2.3 WORLD — `data/world.json` (+ `data/market.json`), server-owned

One document, namespaced (canon §0.5). Shape:

```jsonc
{
  "schema": 1,
  "worldSeed": 0,            // set at first boot, never changes (det. faction/event rolls)
  "epoch": 0,               // incrementing world-tick counter
  "factions": {             // [A1]+[A6]
    "iron_veil": { "treasury": 0, "memberCount": 0, "sovereignty": null,
                   "weeklyKills": 0, "weeklyGoldDonated": 0,
                   "strength": 1.0, "activePlayers": 0,
                   "zoneScores": { "goblin_warrens": 0.5 } }
    /* ...5 factions */
  },
  "zones": {                // [A6]+[A7]
    "goblin_warrens": { "pressure": 0.3, "conquestOwner": null, "conquestSince": 0,
                        "contestantFactions": ["iron_veil","crimson_pact"],
                        "killsThisHour": 0, "deathsThisHour": 0, "lastPlayerAt": 0,
                        "status": "normal",      // normal|haunted|contested
                        "resourceNodes": {} }
    /* ...5 danger zones */
  },
  "npcs": { /* [A7] npcId -> {seed, traitIds, goalState, schedulePhase, zoneId,
                              moodValue, episodesBy{login:[ep≤8]}, memoryLog,
                              goods, questActive, ambientCooldownUntil} */ },
  "crisis": {               // [A3] — the ONE active world crisis
    "activeCrisis": null,   // {id, phase, startedAt, endsAt, contributions{}, total,
                            //  voteMap, outcome, worldEffectApplied}
    "cooldowns": {}, "history": [/* ≤20 */],
    "townLocked": false, "townHealLockUntil": 0
  },
  "eventQueue": [ /* [A6] per-zone world events, cap 10/zone */ ],
  "economy": {              // [A2]
    "treasury": 0, "goldInCirculation": 0, "treasuryMode": false,
    "bounties": [], "priceHistory": { "weapon:rare": [/* ring ≤1000 */] }
  },
  "retention": {            // [A4]
    "globalChallenge": null, "worldEvent": null,
    "monuments": [/* ring ≤500 */], "hallOfFame": [],
    "factionWar": null      // [A1] operator faction war: {factionA,factionB,expiresAt}
  },
  "graves": [ /* [A1] {id, login, zoneId, items[], expiresAt} */ ],
  "lastTickAt": 0
}
```

> **Faction territory ([A6] `factions.zoneScores`/`conquestOwner`) vs operator
> faction war ([A1] `retention.factionWar`) coexist:** autonomous territory sim is
> the always-on background; the operator war is a 30-min hype overlay that doubles
> duel rep — different mechanics, different keys, no conflict.
>
> **`world.factionRep` ([A3] world-level standings) is dropped** as redundant —
> faction standing visible to all is derived from `factions[].zoneScores` and
> `treasury`; per-player standing lives on the account (§0.2).

---

## 3. Reconciled `shared/` Module Surface (deduped)

Invariants 1+2: every `shared/` module is pure ESM, `.js` import extensions, no
Node built-ins, no DOM, and either **deterministic** (RNG only via `makeRng`) or
explicitly **RNG-free pure math**. The agents proposed ~16 modules with overlaps;
canon is **11 new shared modules + 4 extensions to existing files**.

### 3.1 New shared modules (11)

| Module | Owner | Det? | Merged-from / notes |
|---|---|---|---|
| `shared/factions.js` | [A1] base | yes | **Merge of [A1][A5][A6]** (canon §0.6). Catalog + pure math + deterministic `pickFactionRaider`. |
| `shared/faction-engine.js` | [A7] | yes (RNG-free) | Side-effecting rep helpers: `applyKillRep`, `encounterBias`, `checkWarThreshold`, `aggregateKillsForWar`. Imports `factions.js`. |
| `shared/skill-talents.js` | [A1] | yes | Talent trees; `talentMods()` stacked in `derive()`. |
| `shared/crafting.js` | [A1] | yes | **Absorbs [A5] `CRAFT_RECIPES`.** Reagent + recipe + `executeCraft(run,char,id,rng)`. |
| `shared/item-sets.js` | [A1] | yes | Faction item sets; `setModsForBonuses(equippedSetBonuses(gear))` in `derive()`. |
| `shared/market.js` | [A2] | RNG-free pure math | Fees/tax/durations/`canList`/`matchesBuyOrder`/`goldPerPower`. **No RNG** (reroll RNG is server-side, §4.2). |
| `shared/economy-constants.js` | [A2] | yes | Caps, treasury thresholds, ring sizes. |
| `shared/narrative-triggers.js` | [A3] | yes when given run rng | Emergent feed text; `resolveTrigger`/`fireTrigger`. |
| `shared/quests.js` | [A3]+[A7] | gen=det, advance=server | **UNIFIED quest module** (§3.4): trait/backstory/storyteller/world-event/NPC-gated templates. |
| `shared/npc-defs.js` | [A7] | yes | NPC catalog + schedules + dialogue templates + `rollNpcTraits`. **Absorbs [A6] `npc-defs.js`.** |
| `shared/npc-memory.js` | [A7] | yes (RNG-free) | Episode/relationship/decay math. |

### 3.2 Extensions to existing shared files (4)

| File | Extension | Agent | Determinism guard |
|---|---|---|---|
| `shared/constants.js` | `FEED_KINDS` superset (§5.3), new balance constants, `WORLD_TICK_MS` etc. | all | additive only — `vEnum` accepts any array member |
| `shared/storyteller.js` | `WORLD_EVENTS` catalog + `rollWorldEvent` (**server-only, non-det**) + optional `worldBias` field on the 3 storytellers | [A3] | `rollWorldEvent` is explicitly server-side; never called from `delveTick` |
| `shared/traits.js` | `traitWorldMods(traitIds, worldEffect)` (pure) + `'cursed'` trait | [A3]/[A1] | pure function, stacked in `derive()` |
| `shared/loot.js` | `rollDrop` reagent extension, `EFFECTS.cursed`, `bound`/`setId`/`rerolls` on `makeItem` output | [A1]/[A2] | reagent roll uses the passed run rng → deterministic |
| `shared/zones.js` | `zone.factionId` mapping (read-only) | [A1] | static data |
| `shared/enemies.js` | optional `faction` field on archetypes (undefined = neutral) | [A7] | static data |

> **`shared/world-events.js`** ([A6]) is **merged into `shared/storyteller.js`**.
> Both define "world events"; [A3] put the catalog in `storyteller.js`, [A6] in a
> new module. Canon: world-event **catalog + effect application** lives in
> `storyteller.js` (next to the per-run events it parallels); the **server-only
> tick orchestration** lives in `server/world-tick.js` (§4.1). [A6]'s
> `applyWorldEvent(worldEvent,character,run)` becomes an export of
> `storyteller.js` and is invoked from the existing `delveTick` storyteller-effect
> block, so there is exactly **one** effect-application path.

### 3.3 New SERVER-only modules (not `shared/`)

| Module | Owner | Purpose |
|---|---|---|
| `server/world-tick.js` | [A6] | THE single 60s `worldTick(rt)` (canon §0.4). Calls all advancers + crisis SM + retention sweeps. |
| `server/commands.js` | [A5] | `dispatchCommand(login,cmd,args,ctx)`, per-login cooldown map, `VOTE_EFFECTS` registry. |
| `server/market.js` | [A2]/[A6] | listing/buy/bid/offer/expire + price index. Server-side RNG for listing IDs + reroll. |
| `server/retention.js` | [A4] | `creditRetentionEvent`, `ensureFreshObjectives`, `creditGlobalChallenge`, `creditBestiary`, `buildMonumentEntry`, `autoMuseumEnshrined`. |
| `server/npc-world.js` | [A7] | `handleNpcInteract`, `handleNpcOracleResult`, `buildNpcOraclePrompt`. **NPC ticking folded into `world-tick.js`** (canon §0.4 — no separate `npc.worldTick` loop). |

### 3.4 The unified quest system (resolving [A3]×[A7])

[A3] (`shared/quests.js`, trait/backstory/storyteller/world-gated) and [A7]
(NPC-questline `QUEST_DEFS` in `npc-defs.js`, `questLog` field) both designed
quests. Canon merges them:

- **One module:** `shared/quests.js` owns `QUEST_TEMPLATES` (the union of [A3]'s
  trait/backstory/world templates **and** [A7]'s NPC questlines). [A7]'s
  `QUEST_DEFS` are imported into `quests.js` as the `npc`-category templates;
  `npc-defs.js` keeps only the *reference list* (`npcDef.questIds`).
- **One account field:** `character.quests` — array of quest instances (≤20).
  [A7]'s `questLog{active,completed}` shape is adopted internally but exposed as
  the flat `quests` array [A3] uses. `questXp`/`questLevel` ([A3]) stay.
- **Gating union:** a template may require any of `traitRequired`,
  `backstoryRequired`, `storytellerRequired`, `worldEventRequired` ([A3]) **or**
  `npcId` + `reqRelationship` + `reqFactionRep` ([A7]).
- **Advancement:** server-side only, piggybacking existing action endpoints
  ([A3 §2.3.3]); NPC `checkQuestTrigger` ([A7]) becomes a trigger-kind handled by
  the same `advanceQuestObjective`.

---

## 4. How the world ticks (server-authoritative loop)

### 4.1 The single `worldTick(rt)` — fixed sub-advancer order

Runs under `superviseInterval('world.tick', …, WORLD_TICK_MS=60_000)` (invariant
6). Wall-clock, non-deterministic at the loop level; deterministic per-entity via
`mixSeed(worldSeed, epoch)` for auditability ([A6]). Order:

1. `epoch++`.
2. **Factions** ([A6]): for each contested zone, `pickFactionRaider`, advance
   `zoneScores`, flip `conquestOwner` at 1.0 → push `faction_conquest` feed.
3. **Zones** ([A6]/[A7]): pressure growth/decay from batched `notifyZoneEvent`
   buffer; eruption at ≥0.95 → `zone_eruption` + `startRaid`; haunted at 1000
   kills/24h.
4. **NPC schedules + decay + ambient** ([A7]): `epochHour = epoch % 24`; advance
   ≤`NPC_TICK_BUDGET` NPCs; relationship decay; gated ambient dialogue.
5. **Crisis state machine** ([A3]): `brewing→active→resolving→concluded`;
   launch if ≥3 online + no cooldown + roll; apply `worldEffect`; set
   `crisis.activeCrisis.pendingPersonalEffect` for client injection.
6. **World-event queue** ([A6]): generate per-zone events; they are injected into
   `run._pendingWorldEvents` at each player's **save-read** (not here).
7. **Market sweep** ([A2]): expire listings, finalize auctions, collect tax,
   update circulation gauge, toggle treasury mode, fire prosperity event. (Market
   lives in `data/market.json` but is swept by the same loop.)
8. **Retention sweeps** ([A4]): global-challenge flush (every tick), world-event
   rotation, season-ladder cache invalidation, daily/weekly freshness.
9. `store.putWorldState(w)`; `rt.broadcast({t:'worldPulse', …})`.

> [A4]'s four separate `superviseInterval`s (`worldEvent.tick`,
> `globalChallenge.flush`, `seasonLadder.refresh`, `objectives.sweep`) and [A7]'s
> `npc.worldTick` and [A2]'s `market.sweep` and [A3]'s `world.tick` are **all
> folded into this one loop's sub-steps** to respect PSU power safety (one timer,
> bounded work). Exception: `globalChallenge.flush` keeps its own 5s
> `superviseInterval` because it batches kill contributions at sub-tick latency —
> that loop does only an in-memory counter→`world.json` write and is allowed.

### 4.2 Determinism firewall (invariant 2) — the load-bearing rule

- `delveTick` / `simulateOffline` parity is preserved because **every** new
  effect (crisis, world-event, faction mods) is applied through the existing
  post-RNG storyteller-effect block, never touching `run.rngState`.
- **Reroll RNG** ([A2]) uses a server-side `makeRng(Date.now() ^ character.seed)`
  in `server/market.js` and is **never** importable into `shared/` — confirmed
  excluded from the sim path (resolves [A2 conflict 1]).
- **Crafting RNG** ([A1]) is deterministic: `executeCraft(run,char,id,rng)` takes
  the run's `makeRng`, advances state, server saves `run.rngState` back. Crafting
  *is* allowed in `shared/` because it threads the run RNG correctly.
- `simulateOffline` receives crisis bonuses **only if** the server injected them
  before the offline batch — by design, offline players "sleep through" most
  crises ([A3 conflict 6]). This is a deliberate live-play incentive.
- CI guard: `grep -r "Math.random" shared/` must return **zero** (invariant 2,
  [A6 success #10]).

---

## 5. Consolidated API surface

All new endpoints follow the existing pattern: `guard(where, handler)` wrapping,
`validate.js` on every input, `store.getPlayer→mutate→putPlayer`, `rt.broadcast`
for social. All chat verbs are **new HTTP endpoints the chat-elixir
`Chat.Mmo.Bridge` forwards to** (invariant 8) — the MMO is the source of truth.

### 5.1 Chat-elixir bridge change (single, minimal — [A5])

`lib/chat/mmo/bridge.ex` parses `!cmd args` from the message text and adds
`{cmd, args}` to the existing `POST /api/chat-ping/:login` body. The MMO dispatches
in `server/commands.js` **after** base ping work. This is the **only** chat-elixir
change. Read commands (`!sigma`, `!rep`, `!daily`…) are formatted by the Twitch
bot from GET responses.

### 5.2 Endpoint families (deduped — resolves duplicate paths across docs)

Several agents defined the same path differently. Canon paths:

| Family | Canon endpoints | Source / dedupe note |
|---|---|---|
| **Faction** | `POST /api/faction/join/:login`, `/leave/:login`, `GET /api/faction/:id`, `POST /api/faction/donate/:login`, `POST /api/faction/war` (HMAC), `POST /api/faction/rep-event` (HMAC), `GET /api/faction/rep/:login`, `POST /api/faction/pledge/:login`→**dropped** (pledge==join) | [A1]+[A5] `/api/cmd/faction`→ canon uses `/api/faction/*`; [A6] `/api/cmd/faction-join`→ alias to `/api/faction/join`. ONE join path. |
| **Crafting** | `GET /api/recipes/:login`, `POST /api/craft/:login` | [A1]; [A5] `/api/cmd/craft`→ alias. ONE craft path. |
| **Talents** | `GET /api/talents/:login`, `POST /api/talent/unlock/:login`, `POST /api/talent/respec/:login` | [A1] |
| **Market** | `POST /api/market/{list,buy,bid,offer,unlist,post}/:login`, `GET /api/market`, `GET /api/market/summary`, `GET /api/market/price/:slot/:rarity` | [A2]+[A6] merged; `/post` ([A6]) == `/list` ([A2]) — keep both as aliases, `list` canonical. |
| **Salvage/reroll/vault** | `POST /api/salvage/:login`, `POST /api/reroll/:login`, `GET /api/vault/:login`, `POST /api/vault/expand/:login` | [A2] |
| **Economy/bounty** | `GET /api/economy`, `POST /api/bounty/post/:login` | [A2] |
| **Graves** | `GET /api/graves`, `POST /api/grave/loot/:graveId`, `POST /api/scars/cleanse/:login` | [A1] |
| **World/crisis** | `GET /api/world`, `POST /api/world/contribute`, `POST /api/world/vote`, `GET /api/world/zones`, `GET /api/world/factions`, `GET /api/world/events`, `GET /api/world/npc/:id`, `POST /api/world/npc/:id/interact/:login` | [A3]+[A6]+[A7]; ONE `GET /api/world` snapshot merges [A1]+[A3]+[A6] shapes. |
| **NPC** | `POST /api/npc/greet/:login`, `POST /api/npc/ask/:login`, `POST /api/npc/quest/:login`, `POST /api/npc/oracle-result/:hitId` (HMAC) | [A7] |
| **Quests** | `GET /api/sigma/:login/quests` | [A3] |
| **Retention** | `GET /api/daily/:login`, `POST /api/daily-chest/:login`, `GET /api/weekly/:login`, `POST /api/bounty-board/spend`, `GET\|POST /api/achievements[...]`, `GET /api/season[...]`, `POST /api/season/claim/:login`, `GET /api/leaderboard?tab=`, `GET /api/bestiary/:login`, `GET /api/museum/:login`, `POST /api/museum/enshrine`, `POST /api/equip-title`, `GET /api/monuments`, `GET /api/hall-of-fame`, `GET /api/global-challenge`, `POST /api/global-challenge/claim`, `GET /api/world-event`, `POST /api/community-event` (HMAC), `POST /api/prestige-spend` | [A4] |
| **Voting/raid-lead/collective** | `POST /api/vote/:login`, `/api/vote/open` (HMAC), `/api/vote/close` (HMAC), `POST /api/cmd/raid/:login`, `/api/cmd/raid-join/:login`, `POST /api/collective/start` (HMAC), `POST /api/cmd/gather/:login`, trade pair `POST /api/cmd/trade-{offer,accept}/:login` | [A5] |

> **`GET /api/leaderboard?tab=` ([A4]) vs existing `GET /api/leaderboard`:** the
> existing endpoint gains an optional `tab` query (`prestige`(default)|`season`|
> `streak`|`achievement`). Backward compatible.
>
> **`GET /api/world` ([A1]/[A3]/[A6]) collision:** ONE handler returns a merged
> public snapshot `{factions, zones, crisis, activeFactionWar, activeRepEvents,
> worldEvent, graveCount}`. Cached 2–10s.

### 5.3 `FEED_KINDS` union (resolves [A2]/[A3]/[A4]/[A6]/[A7] all editing it)

Single additive superset appended to the existing
`["death","legendary","ascend","boss","milestone"]`:

```
faction_join, faction_war_start, faction_war_end, faction_conquest,
market_list, market_sale, market_auction, market_bounty, economy_event,
narrative, npc_greet, npc_dialogue, npc_answer, npc_quest_start,
npc_quest_complete, npc_ally, npc_memory, zone_eruption, zone_haunted,
lore_fragment, world_event, achievement, oneofone_found, grave_looted,
scar_cleansed, gather_complete, vote_result, rep_event_start
```

`vFeedEvent` uses `vEnum` so any member validates. Overlay renders unknown kinds
generically (already true) — additive, non-breaking.

### 5.4 The `!fight` verb collision (resolves [A3 conflict 1] / [A5 conflict])

`!fight` today drives raid swings. [A3] also wants it as a crisis `contributeVerb`.
**Canon ([A5] arbitrates):** a single `!fight` does **both** — the
`/api/chat-ping` dispatcher fires the raid swing **and** (if a crisis with
`contributeVerb==='fight'` is active) records one throttled crisis contribution.
No new verb; one message advances both systems. Crisis-only verbs (`!pray`,
`!gather`, `!escort`, `!rally`, `!vote`) remain distinct.

---

## 6. Resolved cross-cutting conflicts (master list)

| # | Conflict | Resolution |
|---|---|---|
| C1 | **5 incompatible faction sets** | Canon §0.1 — 5 factions on the 5 real zones; alias table maps every doc. |
| C2 | **Rep scale 0–1000 vs ±100** | Canon §0.2 — single 0..1000 field, neutral=500; joined faction uses 0..1000 ladder. |
| C3 | **World tick 30s vs 60s; 6+ separate loops** | Canon §0.4/§4.1 — ONE 60s `world.tick` with ordered sub-advancers (PSU safety). |
| C4 | **`data/world.json` ×4 incompatible + many side files** | Canon §0.5/§2.3 — ONE namespaced `world.json` + split `market.json`. |
| C5 | **`shared/factions.js` ×5; `world-events.js`/`npc-defs.js` dupes** | Canon §0.6/§3.1/§3.2 — single merged modules; world-events into `storyteller.js`; one `npc-defs.js`. |
| C6 | **Quests ×2 ([A3] vs [A7])** | Canon §3.4 — unified `shared/quests.js`, single `character.quests`. |
| C7 | **`character.factionRep`/`npcOpinions` defined twice** | Canon §2.2 — single `factionRep` (§0.2), single `npcRelationships` ([A7]); `npcOpinions` dropped. |
| C8 | **Faction join cost (5 prestige [A6]) vs free [A1]** | Free join, defector penalty on switch ([A1]); drop `FACTION_JOIN_COST_PRESTIGE`. |
| C9 | **`pledgedFaction` vs `faction`** | Same concept; keep `faction`+`factionJoinedAt`, drop pledge fields. |
| C10 | **`!fight` raid vs crisis** | Both fire from one message (§5.4). |
| C11 | **Duplicate endpoints (`/api/cmd/faction-join` vs `/api/faction/join`, `/market/post` vs `/list`, `GET /api/world` ×3)** | Canon §5.2 — one path each, others are aliases. |
| C12 | **`FEED_KINDS` edited by 5 agents** | Single union §5.3. |
| C13 | **Reroll/listing-ID `Math.random` vs determinism** | Server-side only, never in `shared/` (§4.2). |
| C14 | **Reagent/craft RNG vs offline sim** | Crafting threads run RNG (det.); reroll is server-only (§4.2). |
| C15 | **Item binding ([A1]) vs market trade ([A2])** | `bound==='unbound'` is the default for common→rare drops (so the market has liquidity); `account`/`faction` for crafted/legendary/boss drops. [A2] owns unbound *rate*; [A1] owns *rules*. |
| C16 | **Market price floor `sellValue*0.5` vs economy balance** | Ratified: floor `sellValue*0.5`, ceiling `itemPower*3` ([A6]), economy constants in `economy-constants.js` ([A2]). |
| C17 | **Scar application order in `freshRun`** | Scars apply **before** `backstoryProfile` deltas; clamp to `STAT_MIN=1` ([A1 conflict 4]). |
| C18 | **World-event delivery: server-inject vs WS** | Server-inject into `run._pendingWorldEvents` (offline-safe); WS only carries the `worldPulse` summary ([A6 conflict 4]). |
| C19 | **Museum auto-enshrine hook in `resolveDeath`** | `server/retention.js:autoMuseumEnshrined` called by the server wrapper around `resolveDeath`, before run reset — keeps `resolveDeath` pure ([A4 conflict 6]). |
| C20 | **Faction war elite-spawn hook ([A7]: danger vs pool)** | Via `encounterBias` feeding `buildEncounter` enemy-pool selection, NOT by mutating `run.danger` ([A7 conflict 6]/[A5 conflict 4]). |
| C21 | **Premium season pass payment** | Out of repo scope; `premiumUnlocked` hardwired `false` in the free build ([A4 conflict 1]). |
| C22 | **Trade of run-inventory item after death** | `resolveDeath` server wrapper cancels pending trade offers + clears the deceased login's listings of run items ([A5 conflict 5]). |
| C23 | **Faction cap hard 500 ([A5])** | Dropped — territory/treasury scale by `zoneScores`, not a hard seat cap; avoids early-joiner lockout. |
| C24 | **Gold circulation accounting drift** | Treat `economy.goldInCirculation` as an approximate gauge, re-derived by a 6h full-player scan ([A2 conflict 4]). |

---

## 7. Invariant compliance summary

| Invariant | How the synthesis honors it |
|---|---|
| 1 — `shared/` dual-runtime, pure ESM | All 11 new shared modules are pure ESM, `.js` imports, no node built-ins/DOM. Server-only logic (`world-tick`, `commands`, `market`, `retention`, `npc-world`) lives in `server/`. |
| 2 — determinism | Determinism firewall §4.2; reroll/listing-ID RNG server-only; all world effects applied post-RNG; CI `grep Math.random shared/` == 0. |
| 3 — `delveTick` is THE tick | World tick is a *separate* server loop; it never moves a character between zones; per-tick world effects are injected as data and consumed once. |
| 4 — RUN/ACCOUNT split | §2 audit: every persistent field is ACCOUNT or WORLD; run-side additions are `_`-prefixed ephemerals stripped by `vRun`. |
| 5 — server trust boundary | Every new field has a `validate.js` validator (§2.2); `vRun` strips `_pendingWorldEvents`/`_worldEffect`/`_factionZoneMod`. |
| 6 — supervisor | ONE `world.tick` + the allowed 5s `globalChallenge.flush` under `superviseInterval`; PSU-safe single bounded loop. |
| 7 — store.js | All new collections via `store.js` exports; two documents only (`world.json`, `market.json`). |
| 8 — Twitch primary input | All verbs are HTTP endpoints chat-elixir forwards; one minimal bridge change; O(1)/coalesced per-message work. |
| 9 — OBS additive | New overlay frames (`voteOpen`, `worldPulse`, `gatherComplete`, `factionWar`…) are additive; isolated scene untouched. |

---

## 8. Cross-references

- World concept & emergent thesis → §1, §1.1
- Data model (RUN/ACCOUNT/WORLD) → §2; per-agent detail in `01`–`07`.
- Shared module reconciliation → §3; canon `factions.js` → §0.6.
- World tick → §4; per-agent detail in `06-simulation.md` (sim), `03-narrative.md`
  (crisis SM), `07-npc.md` (NPC tick), `04-retention.md` (sweeps).
- API → §5; per-agent endpoint tables in each doc.
- Conflict ledger → §6.

Build sequencing, milestones, the Milestone-1 vertical slice, per-task file
targets, determinism/invariant risk flags → **`IMPLEMENTATION-PLAN.md`**.
