# SIGMA ABYSS — Narrative Systems Design (Agent 3)

**Role:** Narrative Systems Designer  
**Deliverable:** World-event engine, narrative trigger system, procedural quest architecture  
**Cross-dependencies:** systems (01), economy (02), retention (04), twitch (05), simulation (06), npc (07)

---

## 1. Overview

SIGMA ABYSS currently has a per-run storyteller (`shared/storyteller.js`: `rollEvent`, `tickEventChance`) that fires isolated micro-events into individual delves. These events are ephemeral: a `drop_pod` or `plague_carrier` fires, applies its effect descriptor, and vanishes. Nothing persists to the world; nothing connects one player's experience to another's; no event creates a sequel.

This document upgrades that per-run event picker into a **world-level crisis and narrative engine** operating on three interlocking layers:

1. **WORLD LAYER** — persistent crises that affect all players simultaneously, run under a supervised server loop, written to `data/world.json` via store.
2. **PERSONAL LAYER** — the existing `rollEvent` / `delveTick` pipeline, extended with trait-aware narrative triggers and quest hooks that chain run-level events into ongoing sagas.
3. **PROCEDURAL QUEST LAYER** — per-account quest chains generated from trait+backstory seeds, advanced by world events and combat outcomes, rewarding the account side of the run/account split.

All three layers are grounded in the existing export surfaces. New `shared/` modules are dual-runtime and deterministic where required. Trait interactions, mood thoughts, and backstory profiles are the primary personality inputs — no new character primitives are invented.

### Design Principles Expressed Here

- **Every action advances progression**: world events grant prestige, faction rep, quest XP.
- **Every system creates stories**: trait+world event collisions produce emergent text the feed broadcasts.
- **Failure creates opportunities**: a player killed mid-crisis leaves a "martyred" record that buffs survivors; a failed quest opens a harder variant.
- **Scarcity creates value**: world crises are time-gated; quests have expiry; legendary narrative items only drop during active events.
- **Social interaction is core**: crises require collective contribution; quests can be shared between players who share a faction (see systems doc).
- **Viewers can influence outcomes**: Twitch chat votes shift crisis outcomes; chat commands advance shared quests.
- **Emergent beats scripted**: events collide with traits and world state to produce unique text, never canned dialogue.
- **Risk creates excitement**: crises introduce permanent world-state changes; quests can fail with consequences.

---

## 2. Mechanics

### 2.1 World-Level Crisis Engine

**Existing hook:** `shared/storyteller.js:rollEvent(storytellerId, character, run, rng)` fires one per-run event per tick at `tickEventChance(storytellerId, run)` probability. The existing eleven events are personal (they apply to one run). We extend `storyteller.js` with a **world event catalogue** and a server-side world tick.

#### 2.1.1 Extended STORYTELLERS

The three existing storyteller personalities (`cassandra`, `phoebe`, `randy`) get a new optional field — `worldBias` — that weights which category of world crisis fires during their tenure on a given stream session.

```js
// storyteller.js addition (not a breaking change to existing shape)
cassandra.worldBias = { threat: 0.6, opportunity: 0.2, social: 0.2 };
phoebe.worldBias   = { threat: 0.2, opportunity: 0.5, social: 0.3 };
randy.worldBias    = { threat: 0.4, opportunity: 0.3, social: 0.3 };
```

The **active world storyteller** is the one most common among currently-online players: `server/server.js` counts `character.storyteller` across `store.allPlayers()` in the world tick and picks the plurality. If no players are online the world idles (no new crises fire).

#### 2.1.2 WORLD_EVENTS Catalogue (new export: `shared/storyteller.js`)

New named export `WORLD_EVENTS` — a flat object of event definitions. These are **not** fired by `delveTick`; they are fired by the world tick in `server.js` under `superviseInterval`. Each world event:

- Has a `duration` (in real seconds) during which it is `active`.
- Has a `phase`: `brewing` (announced, not yet affecting play), `active` (applying effects), `resolving` (wrapping up), `concluded`.
- Has a `contributeVerb` — the chat command (`!fight`, `!pray`, `!gather`, `!flee`) chatters use to contribute to resolution.
- Has `thresholds` — total contribution counts required for Good/Bad resolution branches.
- Has `worldEffect` — mutations applied to the world state on resolution.
- Has `personalEffect` — the modifier applied inside each player's `delveTick` while the event is `active` (same shape as existing effect descriptors in `rollEvent`).

```js
// Proposed export additions to shared/storyteller.js

export const WORLD_EVENTS = {
  // ── Threat crises ─────────────────────────────────────────────────
  void_convergence: {
    id: "void_convergence",
    name: "The Void Convergence",
    kind: "threat",
    blurb: "The abyss contracts. Every zone is louder, faster, more dangerous.",
    brewingText: "Cracks in the stone. Something stirs below.",
    activeText: "The Void Convergence is open. Danger climbs 40% faster for everyone.",
    resolveGood: "The convergence seals. The abyss exhales.",
    resolveBad: "The rift holds. A Hollow Sigma wakes early.",
    duration: 900, // 15 min real-time
    contributeVerb: "fight",
    thresholds: { good: 200, bad: 50 }, // total !fight pings needed for good outcome
    personalEffect: { dangerMul: 1.4, text: "The Void Convergence is open." },
    worldEffect: {
      good:  { spawnBoss: null, factionRepDelta: { ironveil: +5 } },
      bad:   { spawnBoss: "hollow_sigma", factionRepDelta: { voidcult: +8 } },
    },
    cooldownS: 3600, // min seconds before this can fire again
  },

  plague_wind: {
    id: "plague_wind",
    name: "Plague Wind",
    kind: "threat",
    blurb: "A black fog rolls through every zone. Disease rates spike.",
    brewingText: "Smoke where there is no fire.",
    activeText: "Plague Wind: ambient infection chance ×3 for all zones.",
    resolveGood: "The wind turns. The sick recover faster.",
    resolveBad: "The wind settles. Three random sigmas contract plague.",
    duration: 600,
    contributeVerb: "pray",
    thresholds: { good: 150, bad: 30 },
    personalEffect: { diseaseChanceAdd: 0.03, text: "Plague Wind howls." },
    worldEffect: {
      good:  { clearDiseasesPercent: 0.5, factionRepDelta: { healers_guild: +6 } },
      bad:   { infectRandomPlayers: { count: 3, disease: "plague" }, factionRepDelta: { voidcult: +5 } },
    },
    cooldownS: 2700,
  },

  iron_siege: {
    id: "iron_siege",
    name: "Iron Siege",
    kind: "threat",
    blurb: "Corrupted knights blockade Ironhollow. Town heals cost double.",
    brewingText: "Hammering at the gates.",
    activeText: "Iron Siege: town healing costs ×2 for all players.",
    resolveGood: "The siege breaks. A stash of siege-gear litters the road.",
    resolveBad: "Ironhollow falls briefly. No town healing for 5 minutes.",
    duration: 720,
    contributeVerb: "fight",
    thresholds: { good: 300, bad: 80 },
    personalEffect: { townHealCostMul: 2, text: "Iron Siege blocks the gates." },
    worldEffect: {
      good:  { spawnDrops: { kind: "item_shower", intensity: 2 }, factionRepDelta: { ironveil: +8 } },
      bad:   { townHealLockS: 300, factionRepDelta: { voidcult: +10 } },
    },
    cooldownS: 3600,
  },

  // ── Opportunity events ────────────────────────────────────────────
  loot_surge: {
    id: "loot_surge",
    name: "Loot Surge",
    kind: "opportunity",
    blurb: "Something broke open a hoard. Loot quality up 30% for 10 minutes.",
    brewingText: "A rumble from below. The vaults are cracking.",
    activeText: "Loot Surge: +30% loot rarity bias for all players.",
    resolveGood: "The surge peaks. Hauls spilled freely.",
    resolveBad: "The surge collapses. Loot quality returns to normal.",
    duration: 600,
    contributeVerb: "gather",
    thresholds: { good: 100, bad: 0 }, // no bad outcome needed
    personalEffect: { lootBiasAdd: 3, text: "A Loot Surge is on." },
    worldEffect: {
      good:  { factionRepDelta: { merchants: +4 } },
      bad:   {},
    },
    cooldownS: 1800,
  },

  xp_bloom: {
    id: "xp_bloom",
    name: "XP Bloom",
    kind: "opportunity",
    blurb: "The abyss remembers every kill. XP gains up 25% for 8 minutes.",
    brewingText: "The bones hum.",
    activeText: "XP Bloom: +25% XP for everyone delving.",
    resolveGood: "The bloom fades. The abyss grew quieter for a moment.",
    resolveBad: "The bloom fades.",
    duration: 480,
    contributeVerb: "delve",
    thresholds: { good: 80, bad: 0 },
    personalEffect: { xpMulAdd: 0.25, text: "XP Bloom is active." },
    worldEffect: { good: {}, bad: {} },
    cooldownS: 2400,
  },

  merchant_convoy: {
    id: "merchant_convoy",
    name: "Merchant Convoy",
    kind: "opportunity",
    blurb: "A convoy rolls through Ironhollow. Prices cut 20% for 12 minutes.",
    brewingText: "Wagon wheels on cobblestone.",
    activeText: "Merchant Convoy: potion cost -20%, upgrade cost -15%.",
    resolveGood: "The convoy departs. Good business.",
    resolveBad: "The convoy is raided. Normal prices resume.",
    duration: 720,
    contributeVerb: "escort",
    thresholds: { good: 120, bad: 40 },
    personalEffect: { potionCostMul: 0.8, upgradeCostMul: 0.85, text: "Merchant Convoy in town." },
    worldEffect: {
      good:  { factionRepDelta: { merchants: +8 } },
      bad:   { spawnBoss: "bandit_warlord", factionRepDelta: { voidcult: +3 } },
    },
    cooldownS: 3000,
  },

  // ── Social events ─────────────────────────────────────────────────
  faction_rally: {
    id: "faction_rally",
    name: "Faction Rally",
    kind: "social",
    blurb: "One faction calls its members together. Sigmas of that faction get a combat buff.",
    brewingText: "A flag raised over the warrens.",
    activeText: "Faction Rally: members of the rallied faction fight 15% harder.",
    resolveGood: "The rally disperses. The faction stands stronger.",
    resolveBad: "The rally falters. No bonus.",
    duration: 600,
    contributeVerb: "rally",
    thresholds: { good: 60, bad: 10 },
    personalEffect: { factionAtkBonus: 0.15, text: "A faction rallies around you." },
    worldEffect: {
      good:  { factionRepDelta: { rallyFaction: +10 } },
      bad:   { factionRepDelta: { rallyFaction: -3 } },
    },
    cooldownS: 2700,
  },

  elder_council: {
    id: "elder_council",
    name: "Elder Council",
    kind: "social",
    blurb: "A council convenes. Chat votes decide which faction gains permanent standing.",
    brewingText: "Letters to the old names.",
    activeText: "Elder Council: !vote <faction_name> to shift the balance.",
    resolveGood: "The council resolves. One faction gains lasting influence.",
    resolveBad: "The council dissolves without consensus.",
    duration: 600,
    contributeVerb: "vote",
    thresholds: { good: 50, bad: 0 },
    personalEffect: { text: "An Elder Council is convening." },
    worldEffect: {
      good:  { topVotedFactionRepBonus: +15, factionRepDelta: {} },
      bad:   {},
    },
    cooldownS: 7200,
  },

  dueling_season: {
    id: "dueling_season",
    name: "Dueling Season",
    kind: "social",
    blurb: "Grudge matches spike. Duel wagers pay out 30% more.",
    brewingText: "Gloves hit cobblestone.",
    activeText: "Dueling Season: duel wager payouts ×1.3.",
    resolveGood: "Season ends. The champion is remembered.",
    resolveBad: "Season ends.",
    duration: 1200,
    contributeVerb: "duel",
    thresholds: { good: 20, bad: 0 }, // 20 duels fought
    personalEffect: { duelPayoutMul: 1.3, text: "Dueling Season is on." },
    worldEffect: {
      good:  { factionRepDelta: { honor_guard: +10 } },
      bad:   {},
    },
    cooldownS: 5400,
  },
};

export const WORLD_EVENT_IDS = Object.keys(WORLD_EVENTS);
```

**New exports added to `shared/storyteller.js`** (all pure ESM, no Node built-ins):

```js
// Proposed new exports in shared/storyteller.js
export function worldEventById(id) { return WORLD_EVENTS[id] || null; }
export function rollWorldEvent(worldStorytellerId, worldState, rngFloat) { ... }
// rollWorldEvent picks a world event category via worldBias, then picks
// a specific event from that category. rngFloat is a pre-drawn float
// (from server's non-shared RNG — see 2.1.3). Returns the event def or null.
// Marks: not deterministic (server-side only, not called from delveTick).
```

#### 2.1.3 World State Document (`data/world.json`)

New JSON document managed by `store.js`. Because the world is global state (not per-player), it lives outside `players.json`.

```js
// New store.js exports
export function getWorldState()         { return world; }
export function putWorldState(w)        { world = w; worldDirty = true; }
export function initWorldState()        { ... } // loads data/world.json, self-heals
```

Shape of the world document:

```js
{
  v: 1,                          // schema version
  activeCrisis: null | {         // exactly one crisis active at a time
    id: "void_convergence",
    phase: "brewing"|"active"|"resolving"|"concluded",
    startedAt: 1717000000000,    // ms since epoch
    endsAt: 1717000900000,       // ms
    contributions: {             // login → count
      "xqc": 5,
      "pokimane": 3,
    },
    totalContributions: 8,
    voteMap: {},                 // for elder_council: faction → vote count
    outcome: null | "good" | "bad",
    worldEffectApplied: false,
  },
  crisisCooldowns: {             // eventId → nextAllowedAt (ms)
    "void_convergence": 1717003600000,
  },
  factionRep: {                  // world-level faction standing (visible to all)
    ironveil:    0,
    voidcult:    0,
    merchants:   0,
    healers_guild: 0,
    honor_guard: 0,
  },
  worldHistory: [                // last 20 concluded crises for lore display
    { id, name, outcome, concludedAt, topContributor }
  ],
  townLocked: false,             // iron_siege bad outcome
  townHealLockUntil: 0,          // ms
  lastCrisisAt: 0,               // ms
  pendingPersonalEffect: null,   // snapshot of the active crisis's personalEffect (read by delveTick)
}
```

#### 2.1.4 World Tick Loop (server-side, under `superviseInterval`)

In `server/server.js`, a new supervised interval fires every 30 seconds:

```js
// server.js addition
superviseInterval('world.tick', worldTick, 30_000);

function worldTick() {
  const w = store.getWorldState();
  const now = Date.now();

  if (w.activeCrisis) {
    advanceCrisis(w, now);
  } else {
    maybeLaunchCrisis(w, now);
  }
  store.putWorldState(w);
  // Broadcast updated world state to all connected clients
  rt.broadcast({ t: 'worldState', world: publicWorldState(w) });
}
```

`maybeLaunchCrisis` rolls a world event if:
- No cooldown is active for any world event.
- At least N players are online (configurable, default 3).
- A random roll fires (base chance 0.08 per 30s tick = roughly one crisis every ~6 minutes if enough players).

`advanceCrisis` runs the phase state machine:
- `brewing` → `active` after 60 seconds (announcement window).
- `active` → `resolving` when `endsAt` passes.
- `resolving` → `concluded` after applying `worldEffect` based on contribution vs. thresholds.

#### 2.1.5 delveTick Integration (personal effect injection)

The world crisis's `personalEffect` is injected into each player's `delveTick` via a server-read path. Because `delveTick` runs client-side for live players, the effect is communicated via the WS broadcast:

```js
// realtime.js: on world state broadcast, client caches pendingPersonalEffect
// game.js: before calling delveTick, merges pendingPersonalEffect into character.run._worldEffect
// delveTick (progression.js): reads run._worldEffect and applies modifiers
```

The modifier fields that `_worldEffect` supports are a strict subset of existing effect descriptor fields already handled by the storyteller block in `delveTick` (lines 481–504 of `progression.js`): `dangerDelta`, `lootBiasAdd`, `xpMulAdd`, `diseaseChanceAdd`, `potionCostMul`, `upgradeCostMul`, `text`. No new mutation paths are added to `delveTick` — the existing storyteller effect block already handles these. The only new field is `factionAtkBonus`, which is applied in `derive()` via the faction combat mod path (see Data Model, section 4).

**Validation:** `validate.js` gets a new `vWorldEffect(e)` validator that bounds all numeric fields to safe ranges before the client applies them.

---

### 2.2 Narrative Trigger System

The **narrative trigger** is the bridge between game events and emergent text. It generates one-line feed entries that read like story beats, not stat readouts. Triggers are deterministic (given the same inputs, same text) but produce varied output through template selection keyed to trait combinations.

#### 2.2.1 New Module: `shared/narrative-triggers.js`

Pure ESM, dual-runtime, **deterministic** (all RNG draws via a passed `rng` instance).

```js
// shared/narrative-triggers.js

// Trigger catalogue — maps a (triggerKind, trait[]) combo to a pool of text templates.
// Templates support {{name}}, {{zone}}, {{enemy}}, {{item}}, {{crisisName}} substitution.
export const TRIGGERS = {
  death_in_crisis: {
    // Called when a player dies while a world crisis is active
    templates: {
      default: [
        "{{name}} fell to {{enemy}} while the {{crisisName}} raged.",
        "{{name}} — taken by {{enemy}}. The {{crisisName}} claimed another.",
      ],
      bloodlust: [
        "{{name}} went down swinging at {{enemy}}, laughing. The {{crisisName}} howled back.",
      ],
      pessimist: [
        "{{name}} said it would end this way. {{enemy}} in the {{crisisName}}. They were right.",
      ],
      depressive: [
        "{{name}} barely resisted {{enemy}} during the {{crisisName}}. Some part of them didn't want to.",
      ],
    },
  },
  legendary_in_crisis: {
    templates: {
      default: [
        "{{name}} pulled a {{item}} from the chaos of the {{crisisName}}.",
        "The {{crisisName}} gave {{name}} something rare: {{item}}.",
      ],
      greedy: [
        "Of course {{name}} found {{item}} during the {{crisisName}}. Of course they did.",
      ],
      lucky: [
        "Fortune bent for {{name}} — {{item}} during the {{crisisName}}.",
      ],
    },
  },
  break_in_crisis: {
    templates: {
      default: [
        "{{name}} lost it mid-{{crisisName}}. {{breakName}} set in.",
      ],
      volatile: [
        "{{name}} snapped during the {{crisisName}}. {{breakName}} — and hit twice as hard.",
      ],
      ironWilled: [
        "The {{crisisName}} ground {{name}} down. Even iron bends. {{breakName}}.",
      ],
    },
  },
  quest_complete: {
    templates: {
      default: [
        "{{name}} finished '{{questName}}'. The abyss noticed.",
        "{{name}} closed the chapter on '{{questName}}'.",
      ],
      industrious: [
        "{{name}} ground through '{{questName}}' without a pause.",
      ],
      cannibal: [
        "{{name}} finished '{{questName}}'. Didn't ask how.",
      ],
    },
  },
  quest_fail: {
    templates: {
      default: [
        "'{{questName}}' slipped from {{name}}. The abyss forgets nothing.",
        "{{name}} let '{{questName}}' lapse. A harder version opens.",
      ],
      pessimist: [
        "{{name}} knew '{{questName}}' would fail. It did.",
      ],
    },
  },
  faction_shift: {
    templates: {
      default: [
        "{{factionName}} gains ground. The balance shifts.",
        "The {{crisisName}} leaves {{factionName}} stronger.",
      ],
    },
  },
};

export const TRIGGER_IDS = Object.keys(TRIGGERS);

// Resolve a trigger to one text line. `traitIds` selects the most-specific
// template pool. `vars` fills the {{placeholders}}.
export function resolveTrigger(triggerId, traitIds, vars, rng) {
  const def = TRIGGERS[triggerId];
  if (!def) return null;
  // Find most-specific matching trait template
  let pool = def.templates.default || [];
  for (const tid of (traitIds || [])) {
    if (def.templates[tid]?.length) {
      pool = def.templates[tid];
      break; // first trait match wins (traits are ordered by roll priority)
    }
  }
  if (!pool.length) return null;
  let text = rng.pick(pool);
  for (const [k, v] of Object.entries(vars || {})) {
    text = text.replaceAll(`{{${k}}}`, String(v));
  }
  return text;
}

// Called by delveTick's story block and server's crisis resolver.
// Deterministic when rng is the run's rng; non-deterministic when called
// from the server world tick (server uses its own crisis-scoped rng).
export function fireTrigger(triggerId, character, vars, rng) {
  return resolveTrigger(triggerId, character?.traits, vars, rng);
}
```

**Determinism note:** `fireTrigger` is deterministic when the passed `rng` is the run's `makeRng` instance (mulberry32, seeded from `run.rngSeed`). When called from the server world-tick it uses a non-seeded path (fine — server crisis text does not need offline determinism).

#### 2.2.2 Trigger Injection Points

| Event | Trigger ID | Where fired |
|---|---|---|
| Player dies during active world crisis | `death_in_crisis` | `resolveDeath()` in `progression.js` — checks `character.run._worldEffect?.text` for crisis presence |
| Legendary drop during active crisis | `legendary_in_crisis` | `delveTick` loot block (progression.js ~line 402), existing `legendaryDropped` flag |
| Mental break during active crisis | `break_in_crisis` | `maybeStartBreak` call in `delveTick`, after crisis check |
| Quest complete | `quest_complete` | `shared/quests.js` `resolveQuest()` |
| Quest fail | `quest_fail` | `shared/quests.js` `expireQuest()` |
| Crisis faction shift | `faction_shift` | `server.js` `advanceCrisis()` on conclusion |

Each trigger produces a `text` string that is pushed as a feed entry via `store.pushFeed({ kind: 'narrative', text, login, at })`. The `'narrative'` kind must be added to `FEED_KINDS` in `shared/constants.js` (currently `["death", "legendary", "ascend", "boss", "milestone"]`).

---

### 2.3 Procedural Quest Architecture

Quests are **per-account** (they survive permadeath — quests live on the account, not the run). They are generated procedurally from the character's `traits`, `backstory`, and `storyteller` personality. Quest objectives are anchored to things the player already does: kill counts, zone depths reached, boss victories, items banked. Quests never require a new action; they require the same actions with extra attention.

#### 2.3.1 New Module: `shared/quests.js`

Pure ESM, dual-runtime. Quest _generation_ is deterministic (seeded from character.seed + questIndex). Quest _advancement_ is non-deterministic (happens on server side via `POST /api/quest-event`).

```js
// shared/quests.js

// Quest template catalogue
export const QUEST_TEMPLATES = {
  // ── Trait-gated quests ────────────────────────────────────────────
  bloodthirst_trial: {
    id: "bloodthirst_trial",
    name: "The Bloodthirst Trial",
    traitRequired: ["bloodlust"],
    blurb: "Prove the lust. Kill 50 elites without retreating.",
    objectives: [
      { kind: "kill_elites", count: 50, label: "Kill 50 elites without retreating" }
    ],
    reward: { gold: 500, prestige: 8, title: "Bloodthirsty", questXp: 200 },
    expiryMs: 7 * 24 * 3600 * 1000, // 7 days
    failPenalty: { moodThought: "rival_thrived", goldLost: 0 },
    hardVariant: "bloodthirst_mastery", // opened on fail
  },
  stoic_endurance: {
    id: "stoic_endurance",
    name: "Stoic Endurance",
    traitRequired: ["stoic"],
    blurb: "No breaks. Survive 10 boss fights without a mental break.",
    objectives: [
      { kind: "boss_kills_no_break", count: 10, label: "Kill 10 bosses without a mental break" }
    ],
    reward: { gold: 400, prestige: 10, title: "Unbroken", questXp: 250 },
    expiryMs: 14 * 24 * 3600 * 1000,
    failPenalty: { moodThought: "rival_thrived" },
    hardVariant: "stoic_mastery",
  },
  cursed_run: {
    id: "cursed_run",
    name: "Cursed Fortune",
    traitRequired: ["cursed"],
    blurb: "The abyss watches. Reach depth 20 in the Abyss Ruins.",
    objectives: [
      { kind: "reach_depth", zoneId: "abyss_ruins", depth: 20, label: "Reach depth 20 in Abyss Ruins" }
    ],
    reward: { gold: 800, prestige: 15, cosmetic: "aura_cursed", questXp: 400 },
    expiryMs: 10 * 24 * 3600 * 1000,
    failPenalty: { moodThought: "rival_thrived", goldLost: 200 },
    hardVariant: "cursed_ascendancy",
  },
  // ── Backstory-gated quests ────────────────────────────────────────
  noble_heritage: {
    id: "noble_heritage",
    name: "Noble Heritage",
    backstoryRequired: { childhood: "noble_heir" },
    blurb: "The old name needs restoring. Earn 5000 gold in one run.",
    objectives: [
      { kind: "gold_in_run", amount: 5000, label: "Earn 5000 gold in a single run" }
    ],
    reward: { gold: 1000, prestige: 12, title: "Restored Heir", questXp: 300 },
    expiryMs: 30 * 24 * 3600 * 1000,
    failPenalty: {},
    hardVariant: null,
  },
  // ── World-event-gated quests ──────────────────────────────────────
  crisis_responder: {
    id: "crisis_responder",
    name: "Crisis Responder",
    worldEventRequired: "void_convergence",
    blurb: "Survive a Void Convergence. Stay in the abyss until it concludes.",
    objectives: [
      { kind: "survive_crisis", crisisId: "void_convergence", label: "Survive a Void Convergence" }
    ],
    reward: { gold: 300, prestige: 6, questXp: 150 },
    expiryMs: 2 * 3600 * 1000, // must complete within 2h of crisis starting
    failPenalty: {},
    hardVariant: null,
  },
  // ── Storyteller-flavoured quests ─────────────────────────────────
  cassandra_arc: {
    id: "cassandra_arc",
    name: "Cassandra's Burden",
    storytellerRequired: "cassandra",
    blurb: "The drumbeat climbs. Reach the boss 5 times across 5 different runs.",
    objectives: [
      { kind: "boss_reached_across_runs", count: 5, label: "Reach a zone boss in 5 separate runs" }
    ],
    reward: { gold: 600, prestige: 10, title: "Cassandra's Chosen", questXp: 280 },
    expiryMs: 21 * 24 * 3600 * 1000,
    failPenalty: {},
    hardVariant: null,
  },
  randy_chaos: {
    id: "randy_chaos",
    name: "Randy's Dice",
    storytellerRequired: "randy",
    blurb: "Chaos is a gift. Survive 3 mental breaks in one run without retreating.",
    objectives: [
      { kind: "breaks_survived_in_run", count: 3, label: "Survive 3 mental breaks without retreating" }
    ],
    reward: { gold: 500, prestige: 8, cosmetic: "aura_chaotic", questXp: 220 },
    expiryMs: 7 * 24 * 3600 * 1000,
    failPenalty: { moodThought: "rival_thrived" },
    hardVariant: "randy_mastery",
  },
  // ── Universal / social quests ─────────────────────────────────────
  first_ascent: {
    id: "first_ascent",
    name: "First Ascent",
    blurb: "Every sigma needs a first prestige. Die and earn 20 prestige in one run.",
    objectives: [
      { kind: "prestige_in_run", amount: 20, label: "Earn 20 prestige in a single run" }
    ],
    reward: { gold: 200, prestige: 5, title: "Ascendant", questXp: 100 },
    expiryMs: 30 * 24 * 3600 * 1000,
    failPenalty: {},
    hardVariant: null,
  },
  social_butterfly: {
    id: "social_butterfly",
    name: "Social Butterfly",
    blurb: "Talk is cheap. Fight alongside 10 other chatters in raid events.",
    objectives: [
      { kind: "raid_contributions", count: 10, label: "Contribute to 10 different raid events" }
    ],
    reward: { gold: 300, prestige: 7, questXp: 180 },
    expiryMs: 14 * 24 * 3600 * 1000,
    failPenalty: {},
    hardVariant: null,
  },
};

export const QUEST_TEMPLATE_IDS = Object.keys(QUEST_TEMPLATES);

// Generate a quest for a character. Deterministic from character.seed + questIndex.
// Returns a quest instance (not yet saved to the account).
export function generateQuest(character, questIndex) { ... }

// Which templates are eligible for this character?
export function eligibleTemplates(character) { ... }

// Advance a quest objective. Returns { advanced, completed, failed }.
// Not deterministic — called server-side after action events.
export function advanceQuestObjective(quest, character, event) { ... }

// Apply quest reward to character account fields (gold, prestige, titles, cosmeticsUnlocked).
export function resolveQuest(quest, character) { ... }

// Mark a quest as failed, apply penalty.
export function expireQuest(quest, character) { ... }

// Check all active quests for expiry.
export function sweepExpiredQuests(character) { ... }
```

#### 2.3.2 Quest Instance Shape (lives on `character` account, survives permadeath)

```js
// character.quests — new account-side field
character.quests = [
  {
    templateId: "bloodthirst_trial",
    name: "The Bloodthirst Trial",
    status: "active", // "active" | "completed" | "failed"
    startedAt: 1717000000000,
    expiresAt: 1717604800000,
    progress: { kill_elites: 32 }, // objective id → current count
    objectives: [ { kind: "kill_elites", count: 50, current: 32, done: false } ],
    reward: { gold: 500, prestige: 8, title: "Bloodthirsty", questXp: 200 },
    runBreakFlag: false, // set true if player retreated (fails no-retreat objectives)
  }
];
character.questXp = 0;      // account-level quest XP (separate from run XP)
character.questLevel = 0;   // 0-50, unlocks quest tiers
```

#### 2.3.3 Quest Event HTTP Endpoint

Quest advancement is driven by the server, not the client. The server calls `advanceQuestObjective` from existing pipeline hooks:

- Kill elites → `POST /api/chat-ping/:login` (after `fireRaidSwing` or `delveTick` result).
- Raid contributions → `POST /api/raid/fight/:login` handler.
- Boss reach → death/retreat resolution in `server.js`.
- Crisis survive → `advanceCrisis()` in the world tick.
- Gold/prestige in run → `bankAtTown` WS handler.

No new write endpoint is needed for advancement — advancement piggybacks on existing action endpoints. A new read endpoint is added:

```
GET /api/sigma/:login/quests  → { quests, questXp, questLevel }
```

---

### 2.4 Trait × World Event Collisions (Emergent Personality)

The richest emergent stories come from trait-world event intersections. Several trait combinations produce unique behaviour during specific world events. These are implemented as modifier overrides in `delveTick` when both `character.traits` and `run._worldEffect` are set.

| Trait | World Event | Emergent Effect |
|---|---|---|
| `bloodlust` | `void_convergence` | Mood spike on kill ×1.5 during convergence; narrative trigger fires |
| `sickly` | `plague_wind` | Disease chance ×4 instead of ×3; immediate `diseased` mood thought |
| `stoic` | `iron_siege` | Immune to siege's `townHealCostMul` (resolve holds) |
| `cannibal` | `loot_surge` | Heals on kill also restores 5% max HP as gold value |
| `pessimist` | any `threat` crisis | -8 mood on crisis start; narrative trigger generates doom text |
| `lucky` | `loot_surge` | Additional +2 loot bias on top of surge bonus |
| `pyromaniac` | `void_convergence` | `onHitProc` burn rate ×2 |
| `ironWilled` | any crisis | Break chance halved during crisis (resolve anchor) |
| `volatile` | any crisis | Break chance ×1.3; but `berserk` break gives crisis fight contribution credit |

These intersections are checked in a new helper `traitWorldMods(traitIds, worldEffect)` in `shared/traits.js`, returning a modifier overlay. It is called from `derive()` in `stats.js` alongside the existing `traitMods()` call.

---

### 2.5 NPC Relationship Stubs

The NPC designer (Agent 7) owns the full NPC system. This document reserves the narrative hooks:

- **`character.npcOpinions`** — account-side map from NPC id → opinion score (-100 to +100). Empty by default.
- **Narrative trigger `npc_opinion_shift`** — fired when a world event causes an NPC opinion to shift significantly (e.g., defending the `iron_siege` improves `ironveil_blacksmith` opinion).
- **Quest template field `npcRequired`** — a quest may require a minimum opinion with an NPC before it is eligible (e.g., "The Blacksmith's Request" requires `ironveil_blacksmith >= 20`).
- **Feed kind `npc_memory`** — NPC remarks about player actions broadcast to the feed.

These stubs are declared but unimplemented until Agent 7's NPC system is in place.

---

## 3. Data Model

### 3.1 New Account-Side Fields (survive permadeath)

All new account fields must be added to `server/validate.js:vCharacter()` with appropriate bounds or they are silently dropped.

| Field | Location | Type | Validator bounds | Notes |
|---|---|---|---|---|
| `character.quests` | account | `Array<QuestInstance>` (max 10) | `vArr(vQuest, 10)` | Max 10 concurrent quests; sweepExpired on login |
| `character.questXp` | account | `Number` | `vInt(0, 1_000_000)` | Quest-layer XP |
| `character.questLevel` | account | `Number` | `vInt(0, 50)` | Unlocks higher quest tiers |
| `character.factionRep` | account | `Object<string, Number>` | `vFactionRep()` each -1000..1000 | Per-faction reputation (personal) |
| `character.npcOpinions` | account | `Object<string, Number>` (max 20 keys) | `vNpcOpinions()` each -100..100 | NPC relationship stubs |
| `character.narrativeFlags` | account | `Object<string, Boolean>` (max 50 keys) | `vNarrativeFlags()` | One-shot story flag gates (e.g., "completed_bloodthirst_trial") |

### 3.2 New Run-Side Fields (cleared on permadeath)

| Field | Location | Type | Notes |
|---|---|---|---|
| `run._worldEffect` | run | `Object` or `null` | Current crisis personal effect; injected by server over WS, cleared on retreat/death |
| `run._questProgress` | run | `Object` | Scratch object for within-run objectives (boss kills, breaks survived); merged to `character.quests` on retreat/bank/death |
| `run._crisisContributed` | run | `Boolean` | True if player contributed to current crisis this run |

`run._worldEffect` uses the underscore prefix convention already established by `run._twitchEliteNext` in `progression.js` (line 230) — temporary server-injected flags that are not persisted to disk.

### 3.3 New World-Side Document (`data/world.json`)

Managed by `store.getWorldState()` / `store.putWorldState()`. Not per-player — one global document.

| Field | Type | Notes |
|---|---|---|
| `activeCrisis` | Object or null | See section 2.1.3 |
| `crisisCooldowns` | Object | eventId → ms |
| `factionRep` | Object | World-level faction standings |
| `worldHistory` | Array (max 20) | Concluded crisis log |
| `townLocked` | Boolean | Siege bad-outcome flag |
| `townHealLockUntil` | Number | ms timestamp |
| `lastCrisisAt` | Number | ms timestamp |
| `pendingPersonalEffect` | Object or null | Snapshot broadcast to clients |

### 3.4 Run/Account Split Audit

All new persistent state that must survive permadeath is on the **account** (`character.*` outside `character.run`). The run-side scratch fields (`_worldEffect`, `_questProgress`, `_crisisContributed`) are explicitly temporary and cleared by `resolveDeath` alongside the existing run wipe. The world document is neither run nor account — it is shared world state owned by the server.

---

## 4. New Shared Modules (Proposed Export Signatures)

### 4.1 `shared/narrative-triggers.js`

**Deterministic:** yes when called with a seeded `rng`; non-deterministic from server world tick.

```js
export const TRIGGERS;              // trigger catalogue
export const TRIGGER_IDS;           // string[]
export function resolveTrigger(triggerId, traitIds, vars, rng); // → string|null
export function fireTrigger(triggerId, character, vars, rng);   // → string|null
```

### 4.2 `shared/quests.js`

**Deterministic:** `generateQuest` and `eligibleTemplates` are deterministic (seeded from character.seed + questIndex). `advanceQuestObjective`, `resolveQuest`, `expireQuest`, `sweepExpiredQuests` are non-deterministic (server-side only).

```js
export const QUEST_TEMPLATES;                                       // template catalogue
export const QUEST_TEMPLATE_IDS;                                    // string[]
export function generateQuest(character, questIndex);               // → QuestInstance | null
export function eligibleTemplates(character);                        // → string[]
export function advanceQuestObjective(quest, character, event);     // → {advanced, completed, failed}
export function resolveQuest(quest, character);                     // mutates character, returns {gold, prestige, ...}
export function expireQuest(quest, character);                      // mutates character
export function sweepExpiredQuests(character);                      // mutates character, returns expired[]
export function questById(templateId);                              // → template def | null
export function questProgress(character, templateId);               // → current progress object
```

### 4.3 `shared/storyteller.js` Extensions (additive, no breaking changes)

**Deterministic:** `rollWorldEvent` is non-deterministic (server-only). All existing exports remain unchanged.

```js
// New exports added to existing file
export const WORLD_EVENTS;                                   // world event catalogue
export const WORLD_EVENT_IDS;                               // string[]
export function worldEventById(id);                         // → def | null
export function rollWorldEvent(worldStorytellerId, worldState, rngFloat); // → def | null (non-det)
```

### 4.4 `shared/traits.js` Extension (additive)

**Deterministic:** yes, pure function of trait list and world effect object.

```js
// New export added to existing file
export function traitWorldMods(traitIds, worldEffect); // → overlay modifier object | null
```

---

## 5. New HTTP Endpoints and Chat Commands

### 5.1 HTTP Endpoints

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/world` | — | Returns `publicWorldState(w)` — crisis state, faction rep, pending personal effect, world history. Cached 10s. |
| GET | `/api/sigma/:login/quests` | — | Returns `{ quests, questXp, questLevel }` for the login's character. |
| POST | `/api/world/contribute` | `{ login, verb }` | Records a contribution to the active crisis from a chat command. Rate-limited: one contribution per login per 30s per crisis. Returns `{ ok, totalContributions, phase }`. |
| POST | `/api/world/vote` | `{ login, faction }` | For `elder_council` crisis: records a vote. Rate-limited: one vote per login per crisis. Returns `{ ok, voteMap }`. |

`/api/world/contribute` and `/api/world/vote` are lightweight: they mutate `world.activeCrisis.contributions` (a Map by login) and `totalContributions` (a running sum), then call `store.putWorldState(w)`. The world tick handles threshold evaluation — contribute endpoints do not evaluate outcomes.

### 5.2 Chat Commands (forwarded by `chat-elixir`)

Chat commands are new routes on the MMO server called by `Chat.Mmo.Bridge` in `sigmashake-chat-elixir`. Each maps to a lightweight POST to the MMO server:

| Chat verb | HTTP path | Throttle | Effect |
|---|---|---|---|
| `!fight` | `POST /api/world/contribute` `{ verb: "fight" }` | 1/30s per login per crisis | Contributes to threat crisis resolution. Also triggers existing raid swing logic if a raid is active. |
| `!pray` | `POST /api/world/contribute` `{ verb: "pray" }` | 1/30s per login per crisis | Contributes to plague_wind resolution. |
| `!gather` | `POST /api/world/contribute` `{ verb: "gather" }` | 1/30s per login per crisis | Contributes to opportunity crisis. |
| `!escort` | `POST /api/world/contribute` `{ verb: "escort" }` | 1/30s per login per crisis | Contributes to merchant_convoy. |
| `!rally` | `POST /api/world/contribute` `{ verb: "rally" }` | 1/30s per login per crisis | Contributes to faction_rally. |
| `!vote <faction>` | `POST /api/world/vote` `{ faction }` | 1 per login per crisis | Records elder_council vote. Faction name fuzzy-matched server-side. |
| `!quest` | `GET /api/sigma/:login/quests` (read) | — | Bot replies with active quest summary. |
| `!world` | `GET /api/world` (read) | — | Bot replies with current crisis state. |

**Per-message work is O(1):** The contribute endpoint does a Map lookup + increment + putWorldState. No heavy computation per message. Rate limiting uses an in-memory `Map<login, lastContributeAt>` reset per crisis — no database round-trips.

**Scaling to thousands of chatters:** Contributions are coalesced to a counter, not per-login lists. The 30s throttle per chatter means 3,000 chatters typing `!fight` produces at most 3,000 distinct entries per 30s window = 100/s. At O(1) per entry, this is easily handled. The Map is cleared on crisis conclusion to prevent memory growth.

---

## 6. Scaling and Anti-Abuse

### 6.1 Chat Flood Protection

- **30-second contribution throttle per login per crisis** (in-memory Map): prevents a single chatter from spamming contributions.
- **Maximum crisis contribution count**: `MAX_CRISIS_CONTRIBUTIONS = 10_000` — hard cap on `totalContributions` to prevent threshold gaming from bots. Crisis resolves automatically at cap.
- **Bot filter**: `Chat.Mmo.Bridge` already calls `Garden.bot_login?` to filter known bots. `!fight` and `!pray` from bot logins are rejected before hitting the MMO server.
- **Faction vote dedup**: one vote per login per crisis, enforced by a `Set<login>` cleared per crisis.
- **Word sanitisation**: all chat inputs pass through `validate.js:scrub()` before any string storage. Faction names in `!vote` are matched against `FACTION_IDS` enum, not stored verbatim.

### 6.2 Crisis Timing and Frequency

- One crisis active at a time prevents stacking buffs/debuffs.
- `cooldownS` per event prevents the same crisis firing within its cooldown window.
- World tick fires every 30s: 120 ticks/hour maximum. Crisis launch chance 0.08/tick ≈ 1 crisis per 2 hours under sustained play.
- A minimum of 3 online players is required to launch a crisis. Empty-stream crises do not fire — protecting against phantom world events when the stream is offline.
- The `brewing` phase (60s) gives players advance notice and allows the overlay to announce before effects apply.

### 6.3 Quest Anti-Abuse

- Maximum 10 concurrent quests per character prevents quest farming.
- Quest objectives use server-side counters only — clients cannot self-report objective progress.
- `questXp` caps at 1,000,000 per `vInt` validator.
- `questLevel` caps at 50 — tier gate prevents immediate access to the hardest quest templates.
- Quest rewards are bounded: `gold` ≤ 2000, `prestige` ≤ 20 per quest, `title` is a validated string from a fixed allowlist.

### 6.4 World State Integrity

- `store.putWorldState` uses the same atomic JSON write pattern as `store.flush` (`writeJsonAtomic` — temp file + rename).
- World state is flushed to disk immediately on `putWorldState` (not debounced) because it represents shared game state that must survive a crash.
- `advanceCrisis` is wrapped in `guard()` to isolate faults — a bad world event cannot crash the server.
- `worldHistory` caps at 20 entries to bound document growth.

---

## 7. Balance Numbers

These are derived from and consistent with existing constants in `shared/constants.js`.

| Parameter | Value | Rationale |
|---|---|---|
| World crisis fire chance / 30s tick | 0.08 | ~1 crisis per ~6 min of active play; feels like RimWorld's storyteller cadence |
| Crisis brewing phase | 60s | One announce→react window; overlay can animate a warning |
| Crisis active duration | 480–1200s (8–20 min) | Scaled to complexity; threat crises shorter, social longer |
| Contribution threshold (good) | 50–300 | Scales with viewer count: 50 = solo-stream viable; 300 = hype train crowd |
| Contribution throttle | 30s per login | Prevents spam; a 100-viewer stream generates ~3/s contributions at peak |
| Quest expiry | 2h–30 days | Short for crisis quests (urgency); long for trait arc quests (patience) |
| Quest prestige reward | 5–15 | Benchmarked against `REST_PRESTIGE_PER_HOUR = 1.5` and death prestige calc |
| Quest gold reward | 200–1000 | Benchmarked against `REST_GOLD_PER_HOUR = 60` and `trader_caravan` (60–220g) |
| Crisis `lootBiasAdd` | 3 | Additive to zone `lootBias`; abyss_ruins is lootBias=4 so this is a 75% bonus |
| Crisis `xpMulAdd` | 0.25 | Additive to econ.xpMul; equivalent to ~1.25× kill XP |
| Crisis `dangerMul` | 1.4 | Stacks multiplicatively with zone.dangerMult (abyss_ruins 1.7 × 1.4 = 2.38 effective) |
| Faction rep per crisis | 3–15 | World-level rep; personal rep on account is separate and scales similarly |
| Max world factionRep | ±1000 | Symmetric; faction effects gate at rep thresholds (see systems doc) |
| townHealLockS bad outcome | 300 (5 min) | Painful but not run-ending; town is still reachable, just no heal |
| MAX_CRISIS_CONTRIBUTIONS | 10,000 | Upper bound; well above any realistic chat volume |

---

## 8. Cross-Agent Dependencies

| Dependency | Key | Document | What this doc needs from them |
|---|---|---|---|
| Systems Designer | `systems` | 01-systems.md | Faction system definition: faction IDs, reputation thresholds, faction-gated content. `factionRep` world state and `character.factionRep` personal state are declared here but must be anchored to the faction ID set in 01-systems. |
| Economy Designer | `economy` | 02-economy.md | Potion/upgrade cost multipliers during crises must not undercut the economy designer's baseline pricing. `potionCostMul`, `upgradeCostMul` effect fields in world events need validation against economy balance. |
| Retention Designer | `retention` | 04-retention.md | Quest `expiryMs` values and `questLevel` unlock gating should align with the retention designer's daily/weekly loop timings. Quest rewards (prestige amounts) must not compete with their milestone system. |
| Twitch Interaction Designer | `twitch` | 05-twitch.md | Chat command verbs (`!fight`, `!pray`, `!vote`, etc.) must not conflict with their command surface. The `!fight` verb is already used for raid engagement — the Twitch designer must arbitrate whether `!fight` goes to crisis contribution OR raid swing (or both) when both are active. |
| Simulation Architect | `simulation` | 06-simulation.md | The world tick loop (`superviseInterval('world.tick', worldTick, 30_000)`) must be coordinated with the simulation architect's server-side tick design to avoid tick contention. The `run._worldEffect` injection path via WS must be consistent with their simulation state model. |
| AI NPC Designer | `npc` | 07-npc.md | The NPC opinion stubs (`character.npcOpinions`, `npcRequired` quest field, `npc_memory` feed kind) declared here are placeholder interfaces waiting for the NPC system. The NPC designer owns the opinion scoring model; this doc only reserves the field names and hook points. |

---

## 9. Open Conflicts

1. **`!fight` verb collision**: `!fight` currently drives raid swings via `POST /api/raid/fight/:login`. If a world crisis (e.g., `void_convergence`) also uses `!fight` as its `contributeVerb`, the MMO server must dispatch the same message to both the raid system and the crisis contribution endpoint. The Twitch interaction designer (Agent 5) must decide whether a single `!fight` advances both or requires separate verbs. This must be resolved before the crisis contribution endpoint is shipped.

2. **Faction ID namespace**: This doc uses faction IDs (`ironveil`, `voidcult`, `merchants`, `healers_guild`, `honor_guard`) that are placeholders. The systems designer (Agent 1) must define the canonical faction ID set. All world events referencing faction IDs in `worldEffect.factionRepDelta` will need to update their keys once that list is final.

3. **World effect in delveTick — client vs server authority**: The `run._worldEffect` field is injected by the server but applied by the client in `delveTick`. This is a trust gap: a malicious client could ignore or modify `_worldEffect`. For the current "client-authoritative + server social layer" architecture this is acceptable (the personal crisis effect is a buff/debuff, not a security-critical value). If the simulation architect (Agent 6) moves `delveTick` server-side, this gap closes automatically. Until then, the client's self-reported crisis modifiers should not be trusted for leaderboard-affecting computations.

4. **Quest advancement server hook coverage**: Quest objectives of kind `kill_elites`, `boss_kills_no_break`, and `breaks_survived_in_run` require the server to observe the outcome of individual `delveTick` results. Currently `delveTick` is client-side; the server only receives summarised results via WS `save` frames. The simulation architect (Agent 6) must define how per-tick event outcomes are communicated to the server before these specific objective kinds can be reliably tracked. Fallback: these objectives use the existing death/retreat summaries from `simulateOffline` and `resolveDeath` which are server-observable.

5. **`FEED_KINDS` expansion**: Adding `'narrative'` and `'npc_memory'` to `FEED_KINDS` in `shared/constants.js` requires a coordinated change with the Twitch interaction designer (Agent 5) who owns the feed display layer, and the simulation architect (Agent 6) who owns server-side feed handling. A simple additive change to the `FEED_KINDS` array is non-breaking (validate.js uses `vEnum` which accepts any string in the array), but the overlay client must handle unknown kinds gracefully (it already does: unknown feed kinds render a generic entry).

6. **Crisis personal effect and offline simulation**: If a player is offline during a crisis, `simulateOffline` runs `delveTick` in a loop but has no access to `run._worldEffect` (which is server-injected). Offline runs during a crisis therefore do not receive crisis bonuses or penalties. This is correct by design — crises are a live play incentive — but must be documented in the UX ("Your sigma slept through the Void Convergence"). The retention designer (Agent 4) should be aware of this as a deliberate mechanic.

---

## 10. Success Criteria

1. **World crisis fires and concludes correctly**: Given N >= 3 online players, within 30 minutes of server uptime a world crisis moves from `null` → `brewing` → `active` → `resolving` → `concluded` with the correct outcome applied based on contribution count vs. thresholds. Verifiable via `GET /api/world`.

2. **Crisis personal effect reaches all live players**: During an active crisis, every player's `run._worldEffect` is set to the crisis's `personalEffect` within two world-tick cycles (60s) of the crisis going `active`. Verifiable by reading character state via `GET /api/sigma/:login`.

3. **Chat contribution throttle holds**: A single login sending `!fight` 100 times in 30 seconds produces exactly 1 contribution increment in `world.activeCrisis.totalContributions`. Verifiable with a smoke test against `POST /api/world/contribute`.

4. **Quest generation is deterministic**: `generateQuest(character, 0)` called twice with the same character (same `character.seed`) returns identical quest instances. Verifiable in `server/smoke.js`.

5. **Quest objectives advance on correct events**: A character with the `bloodthirst_trial` quest accumulates `kill_elites` progress when the server processes elite kills, not when the player self-reports. Verifiable via `GET /api/sigma/:login/quests` after confirmed server-side elite kill events.

6. **Narrative trigger text varies by trait**: Given a `death_in_crisis` trigger with `bloodlust` trait vs. `pessimist` trait, the feed text differs and matches the correct template pool. Verifiable with a unit test against `shared/narrative-triggers.js:resolveTrigger`.

7. **`traitWorldMods` is composable with `derive()`**: Calling `derive(run, character)` on a character with `bloodlust` trait during `void_convergence` produces a higher `attack` value than the same character without the crisis active. Verifiable via the existing smoke test harness.

8. **World state survives server restart**: `data/world.json` is written atomically on `putWorldState`. After a controlled server restart, `getWorldState()` returns the pre-restart crisis state, including `contributions` and `phase`. Verifiable by killing and restarting the server during an active crisis.

9. **Feed narrative entries render correctly**: A `kind: 'narrative'` entry in the feed displays as a text-only story beat (not a `null` render or error) in the overlay. Verifiable by inspecting the overlay's feed handler for unknown/new kinds.

10. **No determinism breakage**: `pnpm run smoke` (the existing headless sim smoke test) passes without modification after all `shared/` changes are merged. The smoke test's deterministic seed must produce identical run outcomes before and after the new module additions.

---

*Document version: 1.0 — SIGMA ABYSS Narrative Systems Design*  
*Agent 3 (Narrative Systems Designer)*  
*Cross-reference: docs/design/01-systems.md, 02-economy.md, 04-retention.md, 05-twitch.md, 06-simulation.md, 07-npc.md*
