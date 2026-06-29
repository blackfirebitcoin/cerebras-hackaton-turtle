# Agent 7 — AI NPC & World Designer
## SIGMA ABYSS: NPC Intelligence, Memory Architecture, and Living World

**Agent key:** `npc`  
**Output path:** `docs/design/07-npc.md`  
**Date:** 2026-05-30

---

## 1. Overview

SIGMA ABYSS is a Twitch-chat MMO rooted in emergent narrative: every system should generate stories, every failure should create opportunity, and the world should feel alive whether or not the streamer is watching. The existing codebase has deep per-character personality (`shared/traits.js`, `shared/mood.js`, `shared/storyteller.js`) and a working Agent Realm API for autonomous AI agents (`server/agent-realm.js`). What it lacks is the connective tissue that makes NPCs feel like inhabitants rather than catalogs — persistent identity, episodic memory, evolving relationships, faction allegiances, and procedural dialogue driven by those memories.

This document specifies the complete NPC intelligence layer. It extends the existing code without replacing it, obeys every hard invariant (dual-runtime `shared/`, deterministic RNG, run/account split, server trust boundary, `superviseInterval` for background loops, `store.js` for persistence), and is designed to scale to thousands of chatters pinging simultaneously.

### Design goals

1. **NPCs remember players.** An NPC that a player saved from a raid encounter greets them differently six sessions later. An NPC whose kin the player killed treats them with hostility that can be earned back — or cannot.
2. **Relationships evolve naturally.** Relationship scores drift with each meaningful interaction. Trust accrues slowly; betrayal lands hard. Factions inherit individual NPC dispositions and expose collective consequences.
3. **The world reacts to player actions.** Zone lore mutates as players do things: a boss killed permanently marks the zone, leaving a gravestone and a lore fragment. A region depopulated by raids becomes "haunted" — altered enemy pools, different event chances. Faction wars flare and cool based on aggregate player behavior.
4. **The Oracle Bazaar drives NPC dialogue cheaply.** NPCs that need "smart" responses post inference HITs to `server/oracle-bazaar.js`; viewer-run AI agents answer them and earn in-game rewards. This offloads inference onto player token budgets rather than the operator's.
5. **Twitch chat is the primary interface.** Every meaningful NPC interaction is triggerable by a chat command. Commands are cheap (< 1 ms server work per message); heavy work is async and coalesced.

---

## 2. Mechanics

Each mechanic is grounded in real existing exports and described as an extension.

### 2.1 NPC Personality — extending `shared/traits.js`

Every NPC rolls a personality from `TRAITS` using the same `rollTraits(seed)` function players use (`shared/traits.js:rollTraits`). NPC seeds are deterministic: `npcSeed = mixSeed(npcId_hash, WORLD_SEED)` using `shared/rng.js:mixSeed`. This means the same NPC always has the same personality across server restarts, and two players encounter the same "person."

NPCs additionally carry a **disposition bias** table: a mapping of trait IDs to disposition weights. A `bloodlust`-tagged NPC is suspicious of `stoic` players but respects `tough` ones. These are static lookup tables in the new `shared/npc-personalities.js` module — pure data, no RNG at read time.

NPC traits also modulate **dialogue tone** (see §2.5): a `sarcastic` NPC's Oracle HIT prompt includes tone instructions; a `paranoid` NPC's trust threshold is doubled.

### 2.2 NPC Memory Architecture

Memory is the central design lever. The system uses a **three-tier memory model** inspired by cognitive science and constrained by the server's JSON-file store:

**Tier 1 — Episodic Buffer (per-NPC, per-account)**  
Short-term events: the last 8 interactions this NPC has had with this player. Stored as a compact array of episode objects on the WORLD document (see §3). Each episode is ~80 bytes. At 500 active NPCs × 1000 active players × 8 episodes = 320 MB worst case; in practice the buffer is sparse (most NPC×player pairs have 0 episodes). Episodes older than 30 real-world days are pruned on NPC tick.

**Tier 2 — Relationship Ledger (per-NPC, per-account)**  
A single integer relationship score (`-100` to `+100`) plus a `flags` bitfield for irreversible events (betrayal, rescue, faction_kill). Initialized to the NPC faction's base disposition toward the player's accumulated faction standings. Updated by episode resolution. This is what NPCs actually "remember" — episodes are the evidence, the ledger is the conclusion. Stored on the WORLD document alongside episodes.

**Tier 3 — World Memory (global)**  
Persistent facts about the world that NPCs reference: which bosses have been killed and by whom, which zones are "haunted," which faction wars are active, lore fragments accumulated from player actions. Stored in a new `world.json` store file (§3.3). Read-only from NPC perspective; written only by server-side event handlers.

### 2.3 NPC Behavior Trees

Each NPC runs a simple three-state behavior tree evaluated on the NPC world tick (separate from `delveTick` — see §2.7):

```
IDLE → (trigger) → REACTIVE → (resolve) → IDLE
                ↓ (threshold met)
              GOAL-DRIVEN → (complete/fail) → IDLE
```

**IDLE:** NPC is at its "home" location in the zone or town. It posts ambient dialogue fragments to the feed every N world-ticks (rate: 1 per 10 minutes per NPC, globally coalesced to avoid feed spam). Ambient dialogue is picked from a static template pool in `shared/npc-defs.js` — no Oracle HIT needed.

**REACTIVE:** Triggered when a player interacts directly (chat command, kill, rescue event, trade). The NPC consults its relationship ledger and episode buffer, picks a response template, optionally posts an Oracle HIT for a "smart" elaboration, and updates the ledger. Response arrives in < 2 s for template-only responses, < 30 s when Oracle HIT is used (async, result posted to feed on resolution).

**GOAL-DRIVEN:** Triggered when the NPC's faction state or world memory reaches a threshold (e.g., faction reputation war declared, zone haunted, boss cleared). The NPC executes a multi-step behavior: patrol a route, recruit a player via chat command, drop a questline breadcrumb, or initiate a faction event. Goal-driven behavior runs under `superviseInterval` — no goal completes in a single tick.

### 2.4 Relationship System

Relationship scores decay toward faction-default at rate `RELATIONSHIP_DECAY_PER_DAY = 2` unless locked by a flag. Flags:

| Flag | Meaning | Lockout |
|------|---------|---------|
| `rescue` | Player saved this NPC from a raid or boss | Prevents decay below +20 |
| `betrayal` | Player attacked this NPC or their faction | Prevents recovery above -40 |
| `faction_kill` | Player killed this NPC's faction member | -15 one-time, recoverable |
| `legendary_gift` | Player gave this NPC a legendary+ item | +30 one-time, permanent floor |
| `oath_sworn` | Player completed NPC's quest chain | Unlocks special dialogue tier |

Relationship → disposition band mapping (used for dialogue selection and quest gating):

| Score | Band | Effect |
|-------|------|--------|
| 75–100 | `ally` | Full quest access, trade discounts, escort buffs |
| 40–74 | `friendly` | Standard quest access, mild discount |
| 5–39 | `neutral` | Default behavior |
| -20–4 | `suspicious` | Prices raised, quest hints withheld |
| -50 to -21 | `hostile` | Refuses service, may call for faction backup |
| < -50 | `nemesis` | Attacks on sight (rare; boss-tier NPCs only) |

Relationship updates are capped to prevent abuse: max delta per calendar day per NPC×player pair is `±30`. This means a player cannot flip a nemesis to ally in a single session.

### 2.5 Procedural Dialogue

Dialogue uses a **three-layer pipeline**:

**Layer 1 — Template selection.** Static templates keyed by `(dispositionBand, interactionKind, personalityTrait)` triplet. Templates are defined in `shared/npc-defs.js` as plain objects — ~200 templates covering greeting/rejection/quest-offer/quest-complete/ambient/crisis. Template variables `{playerName}`, `{npcName}`, `{zone}`, `{faction}`, `{killCount}`, `{relationshipBand}` are substituted server-side. No Oracle HIT needed. Latency: < 1 ms.

**Layer 2 — Oracle elaboration.** For high-stakes interactions (first meeting after a major world event, quest resolution, relationship tier change), the server posts an Oracle HIT via `attachOracleBazaar`'s internal path. The HIT prompt is the filled template plus world-memory context (zone state, faction war status, NPC backstory summary). The elaboration is a free-form extension of the template — the template is always shown immediately; the Oracle elaboration appends when it resolves. Latency: async, posted to feed.

**Layer 3 — Player-driven Oracle questions.** Via chat command `!ask <npc> <question>`, players can pose arbitrary questions to an NPC. The server posts an Oracle HIT with the NPC's personality bias, relationship context, and world memory as the system prompt. Answers cost the player a small gold fee (anti-spam). Answers are public feed events — everyone watching sees the exchange. This is the "Oracle Bazaar drives NPC dialogue" mechanic in practice.

### 2.6 Faction System

Five factions inhabit SIGMA ABYSS, each with a zone affinity, a disposition matrix toward other factions, and a pool of named NPCs:

| Faction ID | Name | Zone affinity | Rivals |
|------------|------|---------------|--------|
| `ironhollow` | Ironhollow Guild | `town` | `void_order` |
| `crimson_pact` | Crimson Pact | `goblin_warrens`, `infernal_highway` | `ironhollow` |
| `bone_court` | Bone Court | `cursed_forest`, `demon_catacombs` | `crimson_pact` |
| `void_order` | Void Order | `abyss_ruins` | all |
| `wanderers` | The Wanderers | all zones | none (neutral) |

**Faction reputation** is an ACCOUNT-level field (`character.factionRep`, a map of factionId → integer -100..+100). It survives permadeath (same side of the run/account line as `prestige`, `gold`, `titles`). It is initialized to `{ ironhollow: 10, crimson_pact: 0, bone_court: 0, void_order: 0, wanderers: 5 }` at character creation.

Faction rep changes from:
- Killing enemies tagged with a faction (`enemies.js:ENEMIES` will gain a `faction` field — see §3)
- Completing NPC questlines
- Raid outcomes (if a faction NPC was the raid target vs. a faction NPC was saved)
- Aggregate chat-ping patterns (mob type killed most in a zone, tracked per-account)

Faction rep gates:
- Zone-specific NPC greetings (neutral → suspicious when `factionRep[zone_faction] < -20`)
- Shop prices (each 10 rep above/below neutral = ±5% price delta)
- Exclusive quest chains (req: `factionRep[faction] >= 50`)
- Enemy spawn bias (when `factionRep[faction] < -40`, that faction adds elites to zone encounters more frequently — feed parameter `bias` in `loot.js:rollDrop` extended to `encounterBias` in `delveTick`)

Faction wars are triggered when the global aggregate of all players' combined faction kills crosses a threshold (`FACTION_WAR_THRESHOLD = 500 aggregate kills`). A war is a world-memory event that: raises encounter danger in the contested zone, changes ambient NPC dialogue, and spawns special faction boss events via `startRaid()`.

### 2.7 NPC World Tick

The NPC world tick is a separate loop from `delveTick`. It runs server-side only, under `superviseInterval`, every `NPC_WORLD_TICK_MS = 60_000` (1 minute). It is NOT in `shared/` — it reads from `store.js` and posts to `store.pushFeed`. It is not deterministic in the offline-sim sense (it runs on wall clock, not a deterministic RNG stream tied to a run). This is correct: NPC world state is WORLD-level, not run-level.

Each NPC world tick:
1. For each active NPC (those with at least one episode in the last 7 days OR in a faction war):
   a. Advance relationship decay for all player relationships.
   b. Check goal-driven state machine transitions.
   c. Roll ambient dialogue (1-in-N chance, controlled by `NPC_AMBIENT_CHANCE_PER_TICK = 0.05`).
2. Check faction war thresholds.
3. Prune expired episodes (> 30 days).
4. Flush dirty NPC records to `world.json` via `store.js`.

The tick processes at most `NPC_TICK_BUDGET = 50` NPCs per minute (anti-abuse budget). NPCs are prioritized by recency of interaction. Total world tick wall time target: < 50 ms.

### 2.8 Zone World Reactions

When meaningful events happen in a zone, the world-memory document mutates and zone behavior adapts:

| Event | World mutation | Zone effect |
|-------|---------------|-------------|
| Boss killed for first time | `worldMem.bossKills[bossId] = { killerLogin, at }` | Zone gets lore fragment in ambient NPC dialogue |
| Boss killed 10+ times total | `worldMem.bossStatus[bossId] = 'weakened'` | Boss HP reduced 20%, but drops upgrade |
| Zone's enemy pool depleted (1000+ kills in 24h) | `worldMem.zoneStatus[zoneId] = 'haunted'` | Ambient enemy pool shifts toward elites, `storyteller.js` event rates increase |
| Faction war declared | `worldMem.factionWars[key] = { factions, startedAt }` | Encounter `bias` raised, faction NPCs comment on war |
| Player reaches `ally` with a faction | Feed event `npc_ally`, NPC escorts player once | Escort mechanic: next zone encounter NPC "joins" as a spectator fighter |

---

## 3. Data Model

### 3.1 Run vs. Account vs. World Split

The hard invariant: permadeath erases the RUN. New NPC fields respect this split exactly.

**Run-level fields (erased on death, in `character.run`):**  
None. NPC relationships survive permadeath. If you saved Mira from a raid in run 3, she remembers in run 4. This is the design intent: relationships are account-level prestige, not run-level gear.

**Account-level fields (survive permadeath, on `character`):**

```js
// New fields on the character object (survive resolveDeath)
character.factionRep = {
  // factionId -> integer -100..+100
  ironhollow: 10,
  crimson_pact: 0,
  bone_court: 0,
  void_order: 0,
  wanderers: 5,
};

character.npcRelationships = {
  // npcId -> { score: int -100..+100, flags: string[], lastSeenAt: epochMs }
  // Sparse — only NPCs with non-neutral relationships stored.
  // Max 200 entries per character (oldest pruned when full).
};

character.questLog = {
  // npcId -> { questId, phase, startedAt, completedAt? }
  // Active and recently completed quests.
  // Max 20 active, 50 completed (oldest pruned).
};
```

**Validator additions (server/validate.js):**  
`vFactionRep(raw)` clamps each value to `[-100, 100]`, validates keys against `FACTION_IDS`.  
`vNpcRelationships(raw)` validates each entry's `score` bounds, `flags` against `NPC_RELATIONSHIP_FLAGS`, limits array to 200 entries.  
`vQuestLog(raw)` validates `questId` against `QUEST_IDS`, `phase` as non-negative int.

### 3.2 NPC Document (in `world.json`)

NPC definitions live in `shared/npc-defs.js` (static, dual-runtime). NPC *state* lives in `world.json` (server-only). The separation means the browser can render NPC portraits and static bios from the shared module, but relationship state is server-authoritative.

```js
// NPC state entry in world.json npcs map (npcId -> npcState)
{
  id: "mira",                    // matches NPC_DEFS entry
  faction: "ironhollow",
  homeZone: "town",
  seed: 0xdeadbeef,              // deterministic personality seed
  traitIds: ["stoic", "kind"],   // rolled from seed via rollTraits
  goalState: "idle",             // "idle" | "reactive" | "goal_driven"
  goalData: null,                // goal-specific payload
  episodesBy: {
    // playerLogin -> Episode[] (max 8, newest first)
    "streamer_username": [
      { kind: "rescued", at: 1748000000000, delta: 25, zoneId: "goblin_warrens" },
      { kind: "greeted", at: 1747900000000, delta: 2, zoneId: "town" },
    ]
  },
  ambientCooldownUntil: 0,       // epoch ms — prevents dialogue spam
  lastTickAt: 0,                 // epoch ms of last NPC world tick
}
```

### 3.3 World Document (world.json)

New store file at `data/world.json`, managed via two new store exports: `getWorldMem()` and `putWorldMem(partial)`.

```js
// world.json top-level shape
{
  schema: 1,
  seed: 0xabcdef12,              // global world seed (set at first boot, never changes)
  bossKills: {
    // bossId -> { killerLogin, at, totalKills }
  },
  bossStatus: {
    // bossId -> "normal" | "weakened" | "empowered"
  },
  zoneStatus: {
    // zoneId -> "normal" | "haunted" | "contested"
  },
  factionWars: {
    // "factionA_vs_factionB" -> { factions: [factionA, factionB], startedAt, endedAt? }
  },
  factionKillTotals: {
    // factionId -> int (aggregate kills by all players)
  },
  loreFragments: [
    // { zoneId, text, triggeredBy, at } — max 100, oldest pruned
  ],
  npcs: {
    // npcId -> NPC state (see §3.2)
  },
  lastNpcTickAt: 0,
}
```

### 3.4 Enemy Faction Tagging (shared/enemies.js extension)

Each entry in `ENEMIES` (`shared/enemies.js`) will gain an optional `faction` field. This is additive and backward-compatible (undefined = neutral).

```js
// Example extension to existing ENEMIES entries
goblin:       { ..., faction: "crimson_pact" },
goblin_thief: { ..., faction: "crimson_pact" },
goblin_king:  { ..., faction: "crimson_pact" },   // boss
skeleton:     { ..., faction: "bone_court" },
bone_colossus:{ ..., faction: "bone_court" },
hollow_druid: { ..., faction: "bone_court" },      // boss
abyss_crawler:{ ..., faction: "void_order" },
sigma_wraith: { ..., faction: "void_order" },
hollow_sigma: { ..., faction: "void_order" },      // boss
// bandits, imps, wolves, boars, trolls → neutral (no faction field)
```

The `faction` field is consumed by `delveTick` post-encounter: when a faction enemy is killed, `character.factionRep[enemy.faction]` decreases by `FACTION_REP_PER_KILL` and the rival faction gains `FACTION_REP_RIVAL_GAIN`. Values are clamped to `[-100, +100]` before persist.

### 3.5 New Constants (shared/constants.js additions)

```js
// ── NPC & Faction system ──────────────────────────────────────────────
export const FACTION_IDS = ["ironhollow", "crimson_pact", "bone_court", "void_order", "wanderers"];
export const FACTION_REP_MIN = -100;
export const FACTION_REP_MAX = 100;
export const FACTION_REP_PER_KILL = -3;        // faction rep lost per enemy kill
export const FACTION_REP_RIVAL_GAIN = 1;       // rival faction rep gained per enemy kill
export const FACTION_WAR_THRESHOLD = 500;      // aggregate kills to trigger faction war
export const FACTION_WAR_DURATION_MS = 4 * 3600 * 1000;  // 4h
export const RELATIONSHIP_DECAY_PER_DAY = 2;   // score drifts toward faction baseline
export const RELATIONSHIP_MAX_DELTA_PER_DAY = 30;
export const RELATIONSHIP_EPISODE_MAX = 8;     // per NPC-player pair
export const RELATIONSHIP_NPC_MAX = 200;       // per character (oldest pruned)
export const NPC_WORLD_TICK_MS = 60_000;       // 1 minute NPC world tick
export const NPC_TICK_BUDGET = 50;             // max NPCs processed per world tick
export const NPC_AMBIENT_CHANCE_PER_TICK = 0.05;
export const NPC_RELATIONSHIP_FLAGS = ["rescue", "betrayal", "faction_kill", "legendary_gift", "oath_sworn"];
export const NPC_DISPOSITION_BANDS = ["ally", "friendly", "neutral", "suspicious", "hostile", "nemesis"];
export const QUEST_PHASE_MAX = 10;
export const QUEST_LOG_ACTIVE_MAX = 20;
export const QUEST_LOG_COMPLETED_MAX = 50;
export const WORLD_LORE_MAX = 100;
export const WORLD_BOSS_KILL_WEAKENED_THRESHOLD = 10;
export const WORLD_ZONE_HAUNTED_KILLS_24H = 1000;
```

---

## 4. New Shared Modules

### 4.1 `shared/npc-defs.js` — NPC catalogue and template library

**Deterministic: YES** (pure data + deterministic personality rolls; no live RNG reads outside `rollNpcTraits`)

```js
// Exports:
export const NPC_DEFS           // object: npcId -> NPC definition
export const NPC_IDS            // string[]
export const FACTION_DEFS       // object: factionId -> faction definition
export const QUEST_DEFS         // object: questId -> quest definition
export const QUEST_IDS          // string[]
export const DIALOGUE_TEMPLATES // object: templateKey -> string template
export function npcById(id)     // NPC_DEFS[id] or null
export function factionById(id) // FACTION_DEFS[id] or null
export function questById(id)   // QUEST_DEFS[id] or null
export function rollNpcTraits(npcId, worldSeed)  // deterministic rollTraits via mixSeed(hash(npcId), worldSeed)
export function dispositionBand(score)           // score -> band string
export function selectTemplate(band, interactionKind, traitIds)  // picks best-fit template
export function fillTemplate(template, vars)     // substitutes {vars} in template string
export function baseDisposition(factionRep, npcFaction)  // int: faction rep -> base relationship score
```

NPC definitions (initial set — ~20 named NPCs, 4–5 per faction):

```js
// Example entries
export const NPC_DEFS = {
  mira: {
    id: "mira", name: "Mira Ashveil", faction: "ironhollow",
    homeZone: "town", title: "Quartermaster",
    blurb: "Keeps Ironhollow's supply lines running. Trusts no one she hasn't bled beside.",
    portraitKey: "f_merchant_1",  // LPC sprite key
    questIds: ["mira_supply_run", "mira_vault_key"],
    traitWeight: ["stoic", "resourceful"],  // biased trait pool for rollNpcTraits
  },
  kael: {
    id: "kael", name: "Kael the Unbowed", faction: "crimson_pact",
    homeZone: "goblin_warrens", title: "Blood-Warden",
    blurb: "Leads raiding parties from the Warrens. Respects strength; despises mercy.",
    portraitKey: "m_warrior_2",
    questIds: ["kael_blood_toll", "kael_pact_trial"],
    traitWeight: ["bloodlust", "tough"],
  },
  // ... ~18 more
};
```

Quest definitions (initial set — 2 per NPC = ~40 quests):

```js
export const QUEST_DEFS = {
  mira_supply_run: {
    id: "mira_supply_run", npcId: "mira", faction: "ironhollow",
    name: "The Supply Run",
    phases: [
      { phase: 0, desc: "Kill 5 goblin enemies in Goblin Warrens", trigger: "kill_faction_n", args: { faction: "crimson_pact", zone: "goblin_warrens", count: 5 } },
      { phase: 1, desc: "Return to Mira in Ironhollow", trigger: "npc_greet", args: { npcId: "mira" } },
    ],
    reward: { gold: 150, factionRep: { ironhollow: 10 }, relationshipDelta: 15, itemTier: "uncommon" },
    reqRelationship: 10,  // min relationship score to unlock
    reqFactionRep: { ironhollow: 0 },
  },
  // ...
};
```

### 4.2 `shared/npc-memory.js` — memory utilities

**Deterministic: YES** (pure data transformation; no RNG)

```js
// Exports:
export function makeEpisode(kind, delta, zoneId)             // create an episode object
export function addEpisode(episodeArr, episode)              // prepend, cap at RELATIONSHIP_EPISODE_MAX
export function applyDecay(score, daysSinceInteraction, flags)  // relationship decay formula
export function applyDelta(score, delta, flags, character)      // clamp delta by daily cap, apply flags
export function getRelationship(character, npcId)             // { score, flags, lastSeenAt } or neutral default
export function setRelationship(character, npcId, rel)        // mutates character.npcRelationships, prunes if > max
export function questPhase(character, questId)                // current phase (0 = not started) or -1 = completed
export function advanceQuest(character, questId)              // increment phase, mark completed if past last
export function checkQuestTrigger(character, trigger, args)   // boolean: does this character event advance the quest?
```

### 4.3 `shared/faction-engine.js` — faction reputation math

**Deterministic: YES** (pure math on inputs; no RNG)

```js
// Exports:
export const FACTION_DEFS   // (re-exported from npc-defs for convenience)
export function applyKillRep(character, enemyFaction)        // mutates character.factionRep
export function factionDisposition(character, factionId)     // "ally"|"friendly"|"neutral"|"suspicious"|"hostile"
export function priceMultiplier(character, factionId)        // float: 0.7..1.3 based on rep
export function encounterBias(character, zoneId)             // int: loot.js rollDrop bias extension
export function factionRepDelta(current, delta)              // clamped new value
export function aggregateKillsForWar(worldMem, factionId)   // int: total kills across all players
export function checkWarThreshold(worldMem)                  // returns newly triggered war keys or []
```

---

## 5. New HTTP Endpoints and Chat Commands

All write endpoints are called by `chat-elixir`'s bridge. Per-message work is bounded to < 2 ms (sync) or deferred async.

### 5.1 NPC Interaction

**`POST /api/npc/greet/:login`**  
Body: `{ npcId: string }`  
Effect: Records a `greeted` episode for `(npcId, login)`. Looks up relationship, picks dialogue template, optionally posts Oracle HIT for elaboration. Returns `{ npcId, npcName, dialogueLine, oracleHitId? }`. The `oracleHitId`, if present, is polled by the client; when it resolves, the elaboration is broadcast as a feed event.  
Per-message work: < 2 ms synchronous (template path). Oracle HIT posting is async (< 5 ms).

**`POST /api/npc/ask/:login`**  
Body: `{ npcId: string, question: string }`  
Effect: Deducts a gold fee (50g; anti-spam) from player's character. Posts Oracle HIT with NPC personality and world-memory context. Returns `{ ok, hitId, goldDeducted }`. Answer is broadcast as `npc_answer` feed event when resolved.  
Chat command: `!ask <npcName> <question>`

**`POST /api/npc/quest/:login`**  
Body: `{ npcId: string, action: "start" | "status" | "complete" }`  
Effect: On `start`, checks relationship + faction rep gate, adds quest to `character.questLog`. On `status`, returns current phase + progress. On `complete`, validates current phase trigger completion, applies reward, advances relationship.  
Chat command: `!quest <npcName>` (cycles through start→status→complete)

### 5.2 Faction Commands

**`POST /api/faction/rep/:login`**  
Body: `{ factionId?: string }` (optional; returns all if absent)  
Effect: Read-only. Returns `character.factionRep` (all factions) or a specific faction's rep + disposition band.  
Chat command: `!rep` (shows all faction standings as a feed event visible to the chatter)

**`POST /api/faction/pledge/:login`**  
Body: `{ factionId: string }`  
Effect: Sets `character.pledgedFaction` (new account field) if `factionRep[factionId] >= 40`. Unlocks faction-specific titles and encounter buffs. Can only be changed once per 7 days.  
Chat command: `!pledge <factionName>`

### 5.3 World State Query

**`GET /api/world/state`**  
No auth required. Returns a public summary of world memory: active faction wars, zone statuses, top boss-kill leaderboard, recent lore fragments. Consumed by the browser overlay and OBS browser source.

**`GET /api/world/npc/:npcId`**  
No auth. Returns public NPC info: name, faction, homeZone, traitIds, title, blurb, current goalState (as a vague label: "idle"/"busy"/"quest_active"), and whether they're currently giving quests.

### 5.4 Internal: NPC Dialogue Webhook

**`POST /api/npc/oracle-result/:hitId`** (internal; HMAC-signed)  
Body: `{ hitId, result, npcId, playerLogin }`  
Effect: When an Oracle HIT resolves, the NPC dialogue result is posted as a `npc_dialogue` feed event. This is called by the Oracle Bazaar's `finalize()` path when a HIT tagged `npc_dialogue` completes — a small extension to the existing `oracle-bazaar.js` finalization hook.

### 5.5 Faction Kill Credit (existing endpoint extension)

**`POST /api/chat-ping/:login`** — existing endpoint  
Extension: After the existing arena/raid logic, read `enemyFaction` from the encounter result (or the current raid's boss faction) and call `applyKillRep(character, enemyFaction)` from `shared/faction-engine.js`. Increment `worldMem.factionKillTotals[enemyFaction]`. Check war thresholds. This is a < 1 ms additive operation.

**`POST /api/raid/fight/:login`** — existing endpoint  
Extension: Same faction-rep credit logic, applied per raid swing.

---

## 6. Scaling and Anti-Abuse

### 6.1 Per-message work budget

The system is designed so that every Twitch chat message (`/api/chat-ping/:login`) costs < 2 ms of synchronous server work. Faction rep update and episode append are both O(1) in-memory operations. The NPC world tick is a separate supervised loop — it never runs on the hot path.

### 6.2 Oracle HIT rate limiting

`!ask <npcName>` posts one Oracle HIT per invocation. Anti-abuse controls:
- Gold cost (50g per ask, character must have it)
- Per-login rate limit: max 1 `npc/ask` per login per 30 seconds (in-memory Map, not persisted)
- Global Oracle HIT cap: `ORACLE_OPEN_MAX` already enforced in `oracle-bazaar.js`
- HIT TTL: `NPC_ORACLE_TTL_MS = 120_000` (2 minutes; short so the board doesn't clog)

### 6.3 NPC world tick budget

The NPC world tick processes at most `NPC_TICK_BUDGET = 50` NPCs per minute and runs under `superviseInterval` so a throwing iteration never kills the loop. The 50-NPC budget assumes ~5 ms per NPC (relationship decay + goal check + optional ambient dialogue post). At 50 NPCs/min, the full NPC catalog of 20 named NPCs processes every < 1 minute; episodic buffer pruning runs weekly in a separate low-priority tick.

### 6.4 World document size control

`world.json` is bounded by:
- `WORLD_LORE_MAX = 100` lore fragments (oldest pruned)
- `RELATIONSHIP_NPC_MAX = 200` NPC relationships per character (oldest pruned)
- `RELATIONSHIP_EPISODE_MAX = 8` episodes per NPC×player pair
- Faction kill totals are integers, not arrays

Estimated world.json size at maturity: < 2 MB (20 NPCs × 1000 active players × 8 episodes × 80 bytes + static data). This fits comfortably in the JSON-file store.

### 6.5 Feed spam prevention

NPC ambient dialogue is gated by `ambientCooldownUntil` per NPC and a global feed rate of max 1 NPC ambient post per 2 minutes across all NPCs. `store.pushFeed` already caps at `FEED_MAX = 60`. New NPC feed event kinds are additive to `FEED_KINDS` in `shared/constants.js`.

### 6.6 Sybil resistance for `!ask`

Since Oracle HIT answers come from viewer-run AI agents, a single viewer could try to skew NPC responses by running many agents. The existing Oracle Bazaar already requires `redundancy >= 1` (default) and deduplicates by agent token. For `!ask` HITs, `redundancy = 3` is set so at least 3 distinct agents must agree on the answer before it posts. Majority-vote aggregation is already implemented in `oracle-bazaar.js:finalize()`.

---

## 7. Balance Numbers

All numbers reference existing constants where possible.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `FACTION_REP_PER_KILL` | -3 | At `DANGER_BOSS_AT = 0.9`, ~30 kills to reach hostile (−90/−3). Meaningful grind, not accidental. |
| `FACTION_REP_RIVAL_GAIN` | +1 | 1/3 of the loss — prevents faction-hopping by alternate-killing |
| `RELATIONSHIP_DECAY_PER_DAY` | 2 | 50-point ally → neutral in 25 days without interaction. Keeps relationships requiring maintenance. |
| `RELATIONSHIP_MAX_DELTA_PER_DAY` | 30 | Prevents single-session flip from nemesis to ally |
| `NPC_ASK_GOLD_COST` | 50g | ~2× `POTION_COST (25g)`. Meaningful but not punishing |
| `NPC_ASK_COOLDOWN_S` | 30 | Prevents chat spam |
| `NPC_ORACLE_REDUNDANCY` | 3 | Requires 3 agent answers for NPC dialogue quality |
| `NPC_ORACLE_TTL_MS` | 120_000 (2 min) | Keeps HIT board from clogging |
| `FACTION_WAR_THRESHOLD` | 500 kills | With 1000 daily chatters killing 5+ enemies each, a war triggers in < 1 day of focused play |
| `FACTION_WAR_DURATION_MS` | 4 hours | Long enough to feel consequential; short enough to resolve before next stream |
| `WORLD_ZONE_HAUNTED_KILLS_24H` | 1000 | ~200 active players killing 5 enemies each in a zone in 24h — achievable on a busy stream |
| `WORLD_BOSS_KILL_WEAKENED_THRESHOLD` | 10 | Requires real community coordination to weaken a boss |
| Quest reward gold | 100–500g | Tied to `REST_GOLD_PER_HOUR = 60` — 2–8h equivalent of idle income |
| Pledge rep threshold | 40 | Requires sustained positive play with a faction, not incidental kills |

---

## 8. Integration with Existing Code

### 8.1 delveTick extension

In `shared/progression.js:delveTick`, after the post-encounter block (line ~413 where `addMoodThought` is called), add:

```js
// Faction reputation update (new — account-level, survives permadeath)
if (result.kills?.length && character.factionRep) {
  for (const kill of result.kills) {
    const def = enemyDef(kill.id);  // enemies.js:enemyDef
    if (def?.faction) {
      applyKillRep(character, def.faction);  // faction-engine.js
    }
  }
}
```

This is safe to add to `shared/` because `faction-engine.js` is pure ESM with no Node built-ins. The browser sim and the server sim both update faction rep identically.

### 8.2 resolveDeath extension

In `shared/progression.js:resolveDeath`, faction rep and NPC relationships are NOT reset — they live on the account side of the split and are passed through `resolveDeath` unchanged, exactly like `prestige`, `gold`, and `titles`.

### 8.3 freshCharacter extension

In `shared/progression.js:freshCharacter`, initialize new account-level fields:

```js
character.factionRep = { ironhollow: 10, crimson_pact: 0, bone_court: 0, void_order: 0, wanderers: 5 };
character.npcRelationships = {};
character.questLog = { active: {}, completed: [] };
character.pledgedFaction = null;
character.pledgedFactionChangedAt = 0;
```

### 8.4 vCharacter extension

In `server/validate.js:vCharacter`, add:

```js
out.factionRep = vFactionRep(raw.factionRep);
out.npcRelationships = vNpcRelationships(raw.npcRelationships);
out.questLog = vQuestLog(raw.questLog);
out.pledgedFaction = vEnum(raw.pledgedFaction, [...FACTION_IDS, null], null);
out.pledgedFactionChangedAt = vInt(raw.pledgedFactionChangedAt, 0, 1e13, 0);
```

### 8.5 store.js extension

Add two new document slots to `server/store.js`:

```js
// New exports
export function getWorldMem()               // returns in-memory world doc
export function putWorldMem(partial)        // merges partial, marks dirty
export function getNpcState(npcId)          // returns npc state from worldMem.npcs
export function putNpcState(npcId, state)   // merges npc state, marks dirty
// New file: data/world.json (atomic write, same pattern as players.json)
```

### 8.6 server.js supervisor loop addition

```js
// NPC world tick — runs every NPC_WORLD_TICK_MS under supervision
superviseInterval("npc.worldTick", async () => {
  await tickNpcWorld({ store, rt, guard });
}, NPC_WORLD_TICK_MS);
```

`tickNpcWorld` is implemented in `server/npc-world.js` (new server-only file, not in `shared/`).

### 8.7 Feed event kinds addition

Add to `FEED_KINDS` in `shared/constants.js`:

```js
export const FEED_KINDS = [
  "death", "legendary", "ascend", "boss", "milestone",
  // New NPC kinds:
  "npc_greet", "npc_dialogue", "npc_quest_start", "npc_quest_complete",
  "npc_answer", "npc_ally", "faction_war_start", "faction_war_end",
  "zone_haunted", "lore_fragment",
];
```

### 8.8 Oracle Bazaar finalization hook

In `server/oracle-bazaar.js:finalize(task)`, after the existing aggregation, add:

```js
// If the HIT has a npcDialogue tag, route the result to the NPC dialogue handler
if (task.tags?.npc_dialogue) {
  const { npcId, playerLogin } = task.tags;
  await handleNpcOracleResult({ npcId, playerLogin, result: task.result, rt, store });
}
```

`task.tags` is a new optional field on Oracle HITs (added to `sanitizeReward` validator and HIT schema in `oracle-bazaar.js`).

---

## 9. New Server Module: `server/npc-world.js`

This is the only significant new server-side file. It is NOT in `shared/` because it reads from `store.js` and posts to `rt.broadcast` — it has server-only dependencies.

```js
// Exports:
export async function tickNpcWorld({ store, rt, guard })     // main world tick — called by superviseInterval
export async function handleNpcInteract({ login, npcId, kind, store, rt })  // greet/ask/quest dispatch
export async function handleNpcOracleResult({ npcId, playerLogin, result, rt, store })
export function buildNpcOraclePrompt(npcDef, npcState, character, question, worldMem)  // assembles HIT prompt
```

The tick function:
1. Loads `worldMem` from `store.getWorldMem()`
2. Iterates up to `NPC_TICK_BUDGET` active NPCs
3. For each: applies relationship decay to all episode-bearing players, advances goal state machine, rolls ambient dialogue
4. Checks faction war thresholds via `faction-engine.js:checkWarThreshold(worldMem)`
5. Prunes old episodes and lore fragments
6. Calls `store.putWorldMem(partial)` for dirty state

---

## 10. Cross-Agent Dependencies

| Dependency | Key | Why |
|------------|-----|-----|
| Lead Systems Designer | `systems` | Faction rep must integrate cleanly with the encounter generation system (`delveTick`). Specifically, `encounterBias` from faction reputation needs to hook into the `buildEncounter` logic. Coordinate on the exact bias parameter API so faction hostility raises elite spawn rates without duplicating the danger/loot-bias system. |
| Economy Designer | `economy` | Quest rewards (gold, items) need to be balanced against the gold economy. The `NPC_ASK_GOLD_COST = 50g` gold sink should be reviewed against the prestige/gold mint rates from `bankAtTown`. Faction trade discounts (`priceMultiplier`) need to hook into any future player-to-NPC trading surface. |
| Narrative Systems Designer | `narrative` | Quest chains and lore fragments are the implementation of narrative arcs. The `QUEST_DEFS` structure in `shared/npc-defs.js` needs to align with the narrative designer's quest/arc schema. Lore fragment generation policy (what events produce lore, how they're written) is co-owned. |
| Simulation Architect | `simulation` | The NPC world tick (`NPC_WORLD_TICK_MS = 60_000`) must be coordinated with whatever global world-sim tick the Simulation Architect defines. If the sim architect defines a faster global tick, the NPC tick should be a sub-harmonic. Faction war state and zone status mutations must not race with each other. |
| Twitch MMO Interaction Designer | `twitch` | Chat commands (`!ask`, `!quest`, `!rep`, `!pledge`) are new verb endpoints. The interaction designer owns the chat command UX (how commands are parsed, what feedback chatters get). Coordinate on command naming, rate limits visible to chatters, and how NPC dialogue is surfaced in the OBS chat overlay. |
| Retention Designer | `retention` | Quest log and NPC relationship progression are long-term retention hooks. The retention designer should review quest reward cadence (how often a player gets a "good thing" from NPC interaction) and the relationship decay rate to ensure NPCs don't go stale during normal stream gaps. |

---

## 11. Open Conflicts

1. **Shared/ faction-engine in the browser.** `shared/faction-engine.js` will be imported by the browser client (for UI display of faction rep). Confirm with the Simulation Architect that dual-runtime faction math is acceptable — specifically that `applyKillRep` is called symmetrically by the server after validating the encounter result, not trusted from the client. The client should compute faction rep for *display* only; the server is authoritative.

2. **FEED_KINDS enum expansion.** Adding 9 new feed event kinds to `FEED_KINDS` in `shared/constants.js` changes a constant shared across all agents. The Systems Designer should sign off on the enum expansion so it doesn't conflict with other agents' feed event additions.

3. **Oracle HIT tag field.** The `tags` field on Oracle HITs is a new addition to the `oracle-bazaar.js` HIT schema. The existing schema has no tags field. This needs to be validated in `oracle-bazaar.js`'s HIT intake sanitizer. Confirm no other agent is also extending the HIT schema simultaneously.

4. **World doc size at scale.** The JSON-file store works well for the current scale. If the player base grows to 10k+ active accounts, `npcRelationships` across all characters may pressure the store. The Systems Architect should review whether `world.json` and the per-character NPC relationship data should migrate to SQLite at the same time as any planned players.json migration.

5. **`pledgedFaction` mechanic.** The pledge mechanic gives faction-pledged players encounter buffs. The exact buff values (atk bonus against rival faction enemies, discount magnitude) are TBD and should be aligned with the Systems Designer's encounter balance work.

6. **Faction war enemy spawn bias implementation.** `encounterBias` from `faction-engine.js` extends the `bias` parameter in `loot.js:rollDrop`. But elite spawn rates are controlled by `DANGER_ELITE_AT` in `constants.js` and the `buildEncounter` logic in `delveTick`. There are two places this could be implemented — either as a modified danger value during encounters in a war zone, or as a modified enemy pool. The Systems Designer should resolve which hook point is cleaner.

---

## 12. Success Criteria

- [ ] Named NPCs greet players by name with relationship-appropriate dialogue within 2 seconds of `!quest <npcName>` or visiting their home zone.
- [ ] Relationship scores persist across permadeath: a player with `ally` relationship to Mira sees ally-tier dialogue on their second run.
- [ ] Faction rep changes visibly after 5 kills of faction-tagged enemies (`!rep` shows updated standing).
- [ ] Oracle HIT for `!ask` resolves within 5 minutes during a stream session with at least 2 active agent workers.
- [ ] Faction war triggers on the feed when `factionKillTotals` crosses `FACTION_WAR_THRESHOLD` and broadcasts to all connected clients.
- [ ] Zone `haunted` status changes the encounter feel (observable via more elite spawns) after `WORLD_ZONE_HAUNTED_KILLS_24H = 1000` kills in 24h.
- [ ] NPC world tick completes within 50 ms wall time at 20 active NPCs and 500 active players.
- [ ] `world.json` stays below 5 MB at 1000 active players with 20 NPCs.
- [ ] `validate.js` validators coerce all new character fields correctly — a character saved without `factionRep` gets defaults on next load, not a validation rejection.
- [ ] `shared/npc-defs.js` and `shared/faction-engine.js` import cleanly in both Node (server smoke test) and browser (ESM, no Node built-ins, .js extensions).
- [ ] A player who triggers `oath_sworn` flag on an NPC sees that flag persist through 3+ permadeath cycles.
- [ ] The `!pledge <factionName>` command is gated at `factionRep >= 40` and correctly denies pledges below threshold.
- [ ] Feed spam is bounded: no more than 1 NPC ambient dialogue event per 2 minutes globally.
- [ ] Quest reward gold (`100–500g`) is deliverable without breaking character schema validation (bounds on `character.gold`).
