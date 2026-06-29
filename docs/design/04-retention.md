# SIGMA ABYSS — Retention & Behavioral Design
## Agent 4: Retention & Behavioral Designer
**Doc path:** `docs/design/04-retention.md`
**Depends on:** Agent 1 (systems), Agent 2 (economy), Agent 3 (narrative), Agent 5 (twitch), Agent 6 (simulation)

---

## 1. Overview

Retention in SIGMA ABYSS is built on one axiom: **permadeath is not a punishment — it is the engine**. Every run ends in a story. Every story is banked into the account. The account accumulates prestige, titles, cosmetics, lifetime records, and social standing that outlast every death forever. This document designs the systems that convert that axiom into daily habits, multi-month progressions, seasonal obsessions, and community-scale events.

The existing foundation (`shared/progression.js:resolveDeath`, `shared/progression.js:checkUnlocks`, `shared/progression.js:freshCharacter`) already survives permadeath correctly. The RUN/ACCOUNT split (`CLAUDE.md` invariant 4) is sacred: anything designed here that must outlive death lives on the ACCOUNT. Run-side engagement hooks (quest timers, streak counters, objective progress mid-run) are cheap ephemeral state that resets naturally on death — that is by design.

### Design targets

| Metric | Target | Rationale |
|---|---|---|
| D1 return rate | ≥40% | Chat-based MMOs live or die on daily habit |
| D7 return rate | ≥20% | Weekly seasonal objectives create the pull |
| Session length | 15–45 min active per visit | Twitch watch time aligns here |
| Multi-month goal ownership | ≥1 per active player | Every player needs a north star |
| Chat messages triggering MMO engagement | ≥30% of chatters per stream | Bridge prestige gains to Twitch visibility |

---

## 2. Retention Architecture: The Four Loops

Every retention system maps to one of four time-scale loops. Shorter loops gate into longer ones.

```
MICRO   (~2-3 min)   delveTick → encounter → loot/XP/kill → mood
DAILY   (~24h)       Daily Objectives → Streak → Daily Chest
WEEKLY  (~7d)        Weekly Bounties → Seasonal ladder climb
EPOCH   (months)     Season pass → Collection → Prestige legacy
```

The micro loop already exists and is excellent. This document designs the other three.

---

## 3. Daily Objectives System

### 3.1 Concept

Every UTC day, each character (account-side) receives **3 Daily Objectives** drawn from a weighted pool. Objectives are simple enough to complete in one streaming session but not trivially skippable. Completing all 3 grants a **Daily Chest** (gold, prestige, a chance at a seasonal cosmetic token). A **Daily Streak** counter tracks consecutive days and unlocks escalating bonus rewards.

Objectives survive the day's permadeaths: if your run dies after killing 4 goblins toward a "kill 10 goblins" objective, the 4 kills are banked on the account and carry forward to the next run.

### 3.2 Objective Pool

Objectives draw from categories. The daily selection weights toward the player's natural play pattern (e.g., a Loot Goblin build character gets more loot objectives):

| Category | Example objectives | Chat visibility |
|---|---|---|
| Combat | Kill 10 normal enemies; Slay 2 elites; Land a killing blow on a boss | "X slew their daily elite" |
| Depth | Reach depth 12 in a single run; Survive 5 consecutive encounters | "X descended into the deep" |
| Loot | Find an Epic+ item; Sell 500g worth of gear; Find a Legendary item | "X found their daily Legendary" |
| Survival | Complete 3 encounters below 25% HP and survive; Survive a Mental Break | "X survived a mental break" |
| Skill | Gain 2 skill levels in a single run; Reach melee skill 10 | "X trained their melee to 10" |
| Community | Participate in a shared raid; Land 5 !fight swings in a raid | "X joined the raid" |
| Streak bonus | Survive 3 full runs without dying (rare, high-reward) | "X is on a deathless streak" |

### 3.3 Data model (ACCOUNT-side)

New fields on the character object (survive permadeath):

```js
character.dailyObjectives = {
  date: "2026-05-30",           // ISO date string (UTC), rerolls when stale
  objectives: [
    {
      id: "obj_kill_10_normal",
      category: "combat",
      label: "Kill 10 normal enemies",
      target: 10,
      progress: 0,              // increments across deaths
      completed: false,
    },
    // … (always 3)
  ],
  streakDays: 14,               // consecutive days with all 3 completed
  streakBestEver: 22,
  lastCompletedDate: "2026-05-29",
  chestClaimed: false,          // reset each day
};
```

**Validation**: `server/validate.js:vCharacter` must validate `dailyObjectives` with a `vDailyObjectives()` helper (date string format, array length 1-5, progress ≥ 0, streakDays ≥ 0).

### 3.4 Objective progress hooks

Progress is credited server-side through existing integration points:

- **Kill progress**: `delveTick` returns `result.kills` per tick. Server route `POST /api/chat-ping/:login` already calls `gainXp` and character save — add `tickObjectives(character, 'kills', result.kills)` after the delveTick call.
- **Depth progress**: `run.depth` after each tick. Check `run.depth >= target` for depth objectives.
- **Loot progress**: loot array returned from `delveTick`. Check rarity via `RARITY_RANK[item.rarity]`.
- **Skill progress**: `skillEvents` returned from `delveTick`. Credit skill-level objectives from those events.
- **Raid progress**: `fireRaidSwing` in `server/server.js` — add an objective credit call there.

Progress must be credited inside the server (trust boundary); the client receives updates via the WS `save` response.

### 3.5 Daily Chest rewards

When `chestClaimed === false` and all 3 objectives are `completed === true`:

```
POST /api/daily-chest/:login
→ grants: gold (100–400 based on streakDays bonus), prestige (+2–5),
          chance of seasonal token (see §6), optional cosmetic fragment
→ sets chestClaimed = true
→ broadcasts feed event { kind: 'milestone', text: 'X claimed their daily chest (🔥 14-day streak)' }
```

### 3.6 Streak bonuses

| Streak (consecutive days) | Bonus |
|---|---|
| 3 | +25% daily chest gold |
| 7 | Unlock a streak-exclusive chat title ("Creature of Habit") |
| 14 | +1 guaranteed Rare item in daily chest |
| 30 | Unlock cosmetic "Flame Halo" aura |
| 60 | Unlock title "The Faithful" + permanent +2% prestige on every death |
| 100 | Unlock cosmetic "Century" sigil — rare prestige cosmetic |

Streak titles unlock via `checkUnlocks(character)` pattern. The `+2% prestige` at streak 60 is stored as `character.streakPrestigeMul` (account-side multiplier, folded into `resolveDeath` prestige calc via `traitEconomy`-style expansion).

---

## 4. Weekly Bounties

### 4.1 Concept

Each Monday UTC, every character receives **5 Weekly Bounties** — harder than daily objectives, requiring focused effort across multiple sessions. Completing a bounty grants **Bounty Marks** (a weekly-scoped currency) that can be spent at the **Bounty Board** for cosmetics, seasonal tokens, and prestige boosts. Marks expire at the end of the week to prevent hoarding.

### 4.2 Bounty pool examples

| Tier | Example bounty | Marks reward |
|---|---|---|
| Easy (2) | Kill 50 enemies across all runs this week | 1 mark |
| Medium (2) | Survive a boss fight; reach depth 20 in a single run | 2 marks |
| Hard (1) | Die with 50+ kills in a single run; find 3 Legendary items this week | 4 marks |

Weekly bounties always include at least one community bounty (raid participation) and one loot/economy bounty (sell 2000g this week). This ensures players benefit from the economy designer's systems.

### 4.3 Data model (ACCOUNT-side)

```js
character.weeklyBounties = {
  weekStart: "2026-05-25",      // ISO date of Monday (UTC), rerolls when stale
  bounties: [
    {
      id: "bnty_kill_50",
      tier: "easy",
      label: "Kill 50 enemies across all runs",
      target: 50,
      progress: 0,
      completed: false,
      marksReward: 1,
    },
    // … (always 5)
  ],
  marksEarned: 0,               // marks earned but not yet spent this week
  marksSpent: 0,
  marksExpireAt: 1748649600000, // UTC ms for next Monday 00:00
};
```

### 4.4 Bounty Board

A new HTTP endpoint allows spending marks:

```
POST /api/bounty-board/spend
Body: { login, itemId }
Items:
  - "mark_prestige_5"   (3 marks) → +5 prestige immediately
  - "mark_rare_drop"    (2 marks) → inject an Epic item into next run's first loot roll
  - "mark_season_token" (5 marks) → +1 seasonal token (see §6)
  - "mark_cosmetic_*"   (varies)  → week-exclusive cosmetics
```

---

## 5. Achievement System

### 5.1 Architecture

Achievements live on `character.achievements` (account-side). They are **permanent unlocks** — once earned, they never go away, not even across seasons. Achievement completion grants titles, cosmetics, and a global "achievement score" displayed on the leaderboard alongside prestige.

### 5.2 Achievement categories

**Bestiary Achievements** — track kills of specific enemy types. These form a "bestiary" collection (see §7).

| ID | Name | Condition | Reward |
|---|---|---|---|
| `kill_100_goblins` | Goblin Slayer | Kill 100 goblins lifetime | Title: "Bane of Goblins" |
| `kill_50_elites` | Elite Hunter | Kill 50 elite enemies lifetime | Cosmetic: "Hunter's Mark" sigil |
| `kill_10_bosses` | Boss Breaker | Kill 10 zone bosses lifetime | Title: "Bossbreaker" |
| `kill_hollow_sigma` | Mirror Match | Kill the Hollow Sigma boss | Cosmetic: "Sigma Killer" aura |
| `all_bosses_once` | Abyss Clear | Kill all 5 zone bosses at least once | Title: "Abyss Cleared" + cosmetic |

**Depth Achievements**

| ID | Name | Condition | Reward |
|---|---|---|---|
| `depth_20_first` | Deep Cut | Reach depth 20 for the first time | Title: "Delver" (accelerates existing milestone) |
| `depth_30_no_potion` | Iron Lungs | Reach depth 30 without using a potion | Title: "Ironlung" |
| `depth_30_five_times` | Abyss Regular | Reach depth 30 on 5 different runs | Cosmetic: "Depth Scar" |

**Loot Achievements**

| ID | Name | Condition | Reward |
|---|---|---|---|
| `find_legendary` | Golden Touch | Find your first Legendary item | Title: "Lucky" |
| `find_mythic` | Myth Seeker | Find a Mythic item | Cosmetic: "Mythic Aura" |
| `find_oneofone` | One in a World | Find a One-of-One item | Title: "The Unique" — globally announced in feed |
| `sell_10000g` | Gold Baron | Sell 10,000g lifetime (cumulative) | Title: "Gold Baron" |

**Survival Achievements**

| ID | Name | Condition | Reward |
|---|---|---|---|
| `survive_500_encounters` | Veteran | Survive 500 lifetime encounters | Title: "The Veteran" |
| `streak_10` | Deathless Decade | Win 10 runs in a row without permadeath | Cosmetic: "Streak Flames" |
| `run_after_permadeath` | Undaunted | Start a new run within 60 seconds of permadeath | Title: "Undaunted" |

**Prestige / Legacy Achievements**

| ID | Name | Condition | Reward |
|---|---|---|---|
| `prestige_100` | Century | Reach 100 prestige | Title: "Centurion" |
| `prestige_1000` | Millennium | Reach 1,000 prestige | Cosmetic: "Millennium Ring" |
| `runs_100` | Rebirth | Die and rise 100 times | Title: "The Immortal" |

**Community Achievements**

| ID | Name | Condition | Reward |
|---|---|---|---|
| `raid_10` | Raid Veteran | Participate in 10 shared raids | Title: "Raider" |
| `raid_killing_blow` | Final Strike | Land the killing blow on a raid boss | Title: "The Finisher" + extra loot |
| `season_1_complete` | Season Survivor | Complete Season 1's season pass | Cosmetic: Season 1 exclusive sigil |

### 5.3 Data model (ACCOUNT-side)

```js
character.achievements = {
  earned: ["kill_100_goblins", "find_legendary"],  // array of completed IDs
  progress: {
    kill_100_goblins: 100,   // keyed by achievement ID
    kill_hollow_sigma: 0,
    // ... sparse — only populate when player has started progress
  },
  score: 1450,               // sum of achievement point values
};
```

### 5.4 Achievement feed events

Completing an achievement broadcasts to the shared feed:

```js
// constants.js: FEED_KINDS must add 'achievement'
{ kind: 'achievement', name: 'X', achievement: 'Mirror Match', cosmetic: 'Sigma Killer' }
```

The One-of-One achievement gets a special global announcement (unique feed kind `'oneofone_found'`) that all connected browsers render as a full-screen flash.

---

## 6. Season Pass System

### 6.1 Concept

A season runs for approximately 12 weeks. Each season has a **theme** (narrative + visual), a **Season Pass** (free and paid tracks), and a **Season Leaderboard** (prestige earned this season only). Season themes are proposed in collaboration with Agent 3 (narrative) and Agent 1 (systems).

Season 1 proposed theme: **The Hollow Ascension** — Hollow Sigma has sent agents into the upper zones; the world is fracturing. Mechanical focus: boss clears and depth records.

### 6.2 Season Pass Track

The pass has **50 tiers**. Each tier requires **Season XP** (SXP), earned by completing daily objectives, weekly bounties, raids, and boss kills. Both free and premium tracks advance simultaneously; premium unlocks the premium-column reward per tier.

| Tier | Free reward | Premium reward |
|---|---|---|
| 1 | +10 gold | Seasonal avatar frame: "Hollow Edge" |
| 5 | +1 prestige | Seasonal title: "Hollow Hunter" |
| 10 | Cosmetic: Season badge | Cosmetic: "Void Crown" hat variant |
| 20 | +50 gold | Seasonal aura: "Fracture Light" |
| 30 | Title: "Hollow-Touched" | Cosmetic: "Shattered Eye" |
| 40 | +100 gold | Full seasonal cosmetic set unlock |
| 50 | Title: "Season Champion" | Exclusive seasonal One-of-One sigil |

**SXP sources:**
- Daily objective complete: +20 SXP per objective, +50 SXP for all-3 chest
- Weekly bounty complete: +80 SXP per bounty
- Boss kill (first kill per zone per day): +40 SXP
- Raid participation: +15 SXP
- Permadeath at depth 20+: +25 SXP (failure creates opportunity — Fear & Hunger principle)
- Prestige milestone first hit during season: +100 SXP

### 6.3 Season Leaderboard

Separate from the permanent leaderboard in `server/realtime.js:leaderboard()`. Season ladder ranks by:
1. Prestige earned THIS SEASON (stored in `character.seasonStats.prestigeThisSeason`)
2. Tiebreaker: deepest run depth this season
3. Tiebreaker: boss kills this season

Displayed via `GET /api/leaderboard?season=current`.

### 6.4 Data model (ACCOUNT-side)

```js
character.season = {
  id: "season_1",               // enum, validated against known season IDs
  sxp: 840,                     // season XP earned
  tier: 12,                     // current pass tier (sxp / SXP_PER_TIER)
  premiumUnlocked: false,       // whether they have paid-track access
  rewardsClaimed: [1, 2, 3],    // tier numbers of rewards already taken
  seasonStats: {
    prestigeThisSeason: 45,
    bossKillsThisSeason: 3,
    deepestRunThisSeason: 22,
    raidsThisSeason: 7,
  },
};
```

### 6.5 Season transitions

At the end of a season:
- `character.season` is archived to `character.pastSeasons[season_id]` (account-side, permanent record)
- A new season object is initialized on first login after the new season starts
- Season leaderboard is frozen as `data/season-1-final.json` (stored via `store.js` pattern)
- Top 3 seasonal ladder finishers earn a permanent title: "Season 1 Champion #1/2/3"

---

## 7. Collection Systems

### 7.1 Bestiary

The bestiary tracks every enemy type killed by the account. It creates a "Pokédex"-style completionist goal: fill out every entry. Enemy definitions already exist in `shared/enemies.js:ENEMIES` and `shared/enemies.js:ENEMY_IDS`.

```js
character.bestiary = {
  kills: {
    goblin: 450,
    goblin_thief: 123,
    hollow_sigma: 1,
    // ... keyed by enemy ID from ENEMIES
  },
  firstKilledAt: {
    goblin: 1748649600000,   // ms timestamp
    hollow_sigma: 1749000000000,
  },
};
```

Bestiary milestones trigger achievements (§5.2). New kill counts are credited in the same post-delveTick hook that credits objectives.

**Chat surface**: `!bestiary <login>` → returns a summary string: "X has encountered 14/20 enemy types. Missing: abyss_hunter, bone_colossus..."

### 7.2 Title Collection

Titles are already tracked in `character.titles[]`. The collection goal is to display ALL earned titles in a "title wall" on the character sheet and allow players to equip any one as their active display title. This requires:

```js
character.activeTitle = "Voidlord";   // account-side, from character.titles[]
```

Displayed on the leaderboard (`server/realtime.js:leaderboard()` already returns `title: c.titles?.[c.titles.length - 1]` — this changes to `title: c.activeTitle || c.titles?.[c.titles.length - 1]`).

**Chat surface**: `!title <login>` → "X's title: Voidlord (also holds: Survivor, Delver, Abyss-Touched)"

### 7.3 Cosmetic Collection

`character.cosmeticsUnlocked[]` already exists. Extend it with a **cosmetic showcase** — an ordered list of which cosmetics the player has equipped to their character, displayed in the overlay's featured-rotation slot.

```js
character.cosmeticLoadout = {
  hat_style: "wizard",           // must be in character.cosmetics or unlocked
  hair_style: "ponytail",
  aura: "aura_diamond",          // from cosmeticsUnlocked
  sigil: "season_1_champion",    // seasonal cosmetic
  frame: "hollow_edge",          // pass cosmetic
};
```

### 7.4 Legendary Item Museum

Any Legendary, Mythic, or One-of-One item the player has ever found can be permanently enshrined in a "museum" on the account. The run inventory is ephemeral (dies with the run), but the account can hold up to **20 museum slots** for display purposes (no stat benefit — purely prestige and collection).

```js
character.museum = [
  {
    item: { /* full item object snapshot */ },
    enshrineAt: 1748649600000,
    runKills: 34,   // kills when found — part of the story
    deathBy: "bone_colossus",  // if the run died with this item
  },
  // up to 20
];
```

**Enshrine flow**: At `resolveDeath` time, the server checks the run's inventory for Legendary+ items and offers them to the museum (auto-enshrine the highest power one if museum is not full). The player can also manually enshrine via `POST /api/museum/enshrine`.

**Chat surface**: `!museum <login>` → "X's museum: [Worldender Ruin Edge (Mythic), The Last Sigma Shroud (Legendary), ...]"

---

## 8. Prestige Loops

### 8.1 Current prestige loop (existing)

`shared/progression.js:resolveDeath` already calculates prestige from `(level * 0.6 + depth * 0.9 + zone.tier * 4 + kills * 0.12) * econ.prestigeMul`. The existing MILESTONES array in `progression.js` gates 6 prestige unlock tiers. This document extends the prestige loop without changing the formula.

### 8.2 Prestige Tiers beyond 500

Extend `MILESTONES` (in `shared/progression.js`) with additional tiers above the current max (500 = "The Permadeath"):

| Prestige | Title | Cosmetic |
|---|---|---|
| 500 | The Permadeath | aura_mythic (existing) |
| 1000 | Abyss Eternal | aura_void (new) |
| 2000 | Sigma Prime | aura_prime (new) + permanent +5% prestige per death |
| 5000 | The Unending | cosmetic: animated particle wings |
| 10000 | Omega Sigma | title only — publicly announced in feed on achievement |

The `+5% prestige` at 2000 is stored as `character.legacyPrestigeMul` (account-side, folded into `resolveDeath`).

### 8.3 Prestige sinks

High prestige needs sinks to stay meaningful. Proposed prestige spends:

- **Respec token** (50 prestige): allows a full stat respec on the current run without a town visit. Available once per run.
- **Extra potion slot** (75 prestige): adds +1 to `POTION_MAX` for the current run only.
- **Enshrine voucher** (100 prestige): allows enshrining any item into the museum even if below Legendary.
- **Season XP boost** (30 prestige): +100 SXP immediately.

These are available via `POST /api/prestige-spend` (server-authoritative, validated against current prestige).

---

## 9. Community Challenges

### 9.1 Global Challenges

Every 3 days, the server generates a **Global Challenge** — a shared goal that ALL players contribute to. When the challenge is met, EVERYONE who participated receives a reward.

Example challenges:
- "The Abyss feeds: community kill 10,000 enemies this weekend"
- "Raid the Hollow Sigma 5 times before Sunday"
- "Community finds 50 Legendary items"

Progress is tracked via a new `data/global-challenge.json` file managed by `store.js`. Contributions are credited at the same hook points as objectives (kill events, loot events, raid events).

```js
// data/global-challenge.json (via store.js)
{
  id: "challenge_003",
  label: "Kill 10,000 enemies across all sigmas",
  metric: "kills",
  target: 10000,
  progress: 4567,
  startAt: 1748649600000,
  endAt: 1748908800000,      // 3 days
  rewardGold: 200,
  rewardPrestige: 10,
  rewardSXP: 50,
  participants: ["sig_abc123", "sig_def456"],  // token list
  claimed: [],               // tokens who've claimed reward
}
```

**Chat surface**: When a global challenge ticks to a round percentage (25%, 50%, 75%, 100%), the server broadcasts a feed event and chat-elixir announces it: "SIGMA ABYSS Community: 75% of the way to slaying 10,000 enemies! 🗡️"

### 9.2 Seasonal World Events

Every 2–3 weeks during a season, a **World Event** activates for 48 hours. World events are server-side overlays that modify the game state for all players:

| Event | Mechanic | Chat integration |
|---|---|---|
| **Goblin Invasion** | Goblin enemies spawn at 2x rate in all zones | "!fight" during raid spawns +1 goblin |
| **Blood Moon** | All encounters have +20% loot bias but +15% enemy damage | Raid boss HP ×1.5 but drops Mythic guaranteed |
| **The Fracture** | Zone 5 (abyss_ruins) is open to all regardless of highestLevel | Chat: "The Abyss is open — all may enter!" |
| **Sigma Surge** | XP from all sources ×1.5 for 24h | Broadcast hourly countdown |
| **Haunted Market** | Daily chest rewards ×2; streak bonuses doubled | Encourages log-in during event |

World events are implemented as a `worldEventModifiers` object in `data/world-event.json` that `delveTick` applies at the loot-bias and enemy-selection steps. The server broadcasts `{ t: 'worldEvent', event }` to all connected clients on event start/end.

### 9.3 Streamer-Triggered Community Events

The streamer (operator) can trigger special community events via the OBS/server interface:

```
POST /api/community-event  (HMAC-signed, internal only)
Body: { kind: 'double_prestige' | 'free_boss' | 'all_objectives_bonus', durationMs }
```

- `double_prestige`: for `durationMs`, all `resolveDeath` prestige calculations are doubled
- `free_boss`: spawns a bonus raid boss (calls existing `startRaid` flow)
- `all_objectives_bonus`: marks all active daily objectives as contributing double progress

This gives the streamer retention levers to deploy during low-energy parts of a stream.

---

## 10. Social Recognition Systems

### 10.1 Leaderboard Enhancements

The existing leaderboard (`server/realtime.js:leaderboard()`) sorts by prestige → level → kills. Extend it with:

1. **Achievement Score column** — `character.achievements.score` displayed alongside prestige.
2. **Season Rank column** — `character.season.seasonStats.prestigeThisSeason` for a separate seasonal sub-board.
3. **Streak column** — `character.dailyObjectives.streakDays` for the current streak leaderboard.

New endpoint: `GET /api/leaderboard?tab=season|streak|achievement|prestige` — the `tab` parameter selects which ranking to return.

### 10.2 Death Wall / Monument

Every permadeath already pushes a feed event. Extend this with a **permanent death monument** — a paginated list of notable deaths (depth 20+, boss kills, Legendary items lost) accessible via:

```
GET /api/monuments?page=0&limit=20
```

Each monument entry:

```js
{
  name: "SigmaGoblin",
  deathBy: "hollow_sigma",
  depth: 28,
  kills: 67,
  bestItem: { name: "Worldender Ruin Edge", rarity: "mythic" },
  prestige: 42,
  at: 1748649600000,
}
```

**Chat surface**: `!graves` → "Recent notable deaths: SigmaGoblin (depth 28, slain by hollow_sigma), ..."

### 10.3 Rivalry System

Two players who have killed each other's "featured" builds in raid contribute to a **Rivalry Score** — how often their paths cross. Rivalries are displayed on the character sheet and in the overlay:

```js
character.rivals = [
  { name: "SigmaVoid", encounters: 7, lastAt: 1748649600000 },
];
```

This is lightweight: the encounter is recorded when `fireRaidSwing` logs a kill against a featured character. No heavy compute per message.

### 10.4 Hall of Fame

At the end of each season, the top 10 on the season ladder are permanently recorded in `data/hall-of-fame.json`. Accessible via `GET /api/hall-of-fame`. Their names appear in the overlay's idle state as scrolling honorees.

---

## 11. New Shared Modules

### 11.1 `shared/objectives.js` (deterministic, dual-runtime)

Manages objective pool definitions and progress logic. Pure ESM, no Node built-ins.

```js
// Proposed exports:
export const DAILY_OBJECTIVE_POOL = [...]; // objective definitions with categories/weights
export const WEEKLY_BOUNTY_POOL = [...];   // bounty definitions with tier/marks
export function rollDailyObjectives(seed, dayIndex, character);
  // deterministic: seed + dayIndex → 3 objectives from pool, weighted by character's play history
  // returns: [{ id, category, label, target, marksReward }]
export function rollWeeklyBounties(seed, weekIndex, character);
  // returns: [{ id, tier, label, target, marksReward }] (always 5)
export function tickObjectives(character, event);
  // event = { type: 'kills'|'depth'|'loot'|'skill'|'raid', value, meta }
  // mutates character.dailyObjectives.objectives[].progress in place
  // returns: [{ id, completed, wasNew }] — list of newly completed objectives
export function tickWeeklyBounties(character, event);
  // same shape as tickObjectives but for weekly bounties
export function isDailyFresh(character, nowMs);
  // returns true if character.dailyObjectives.date is today (UTC)
export function rollFreshDaily(character, nowMs);
  // mutates character.dailyObjectives to today's fresh set (preserves streakDays)
export function rollFreshWeekly(character, nowMs);
  // mutates character.weeklyBounties to this week's set
export const SXP_PER_TIER = 200; // season XP per pass tier
export const SEASON_TIERS = 50;
```

Determinism guarantee: `rollDailyObjectives(seed, dayIndex, character)` uses `makeRng(mixSeed(seed, dayIndex))` so the same seed + day always produces the same objective set. This enables offline objective progress (simulateOffline can credit kills even while offline).

### 11.2 `shared/achievements.js` (deterministic, dual-runtime)

```js
export const ACHIEVEMENTS = { /* catalogue keyed by id */ };
export const ACHIEVEMENT_IDS = [...];
export function checkAchievements(character, event);
  // event = { type, value, meta } — same event bus as tickObjectives
  // returns: [{ id, title?, cosmetic? }] — newly earned achievements
export function achievementScore(earnedIds);
  // returns numeric score for leaderboard
export function achievementById(id);
```

Not deterministic in the RNG sense (no RNG draws), but pure functions — safe dual-runtime.

### 11.3 `shared/seasons.js` (pure, dual-runtime)

```js
export const SEASONS = [
  { id: "season_1", name: "The Hollow Ascension", startMs: 1748649600000, endMs: 1755302400000 },
  // future seasons added here
];
export function currentSeason(nowMs);           // returns SEASONS entry or null
export function isSeasonActive(seasonId, nowMs);
export function sxpForTier(tier);               // SXP required to reach this tier
export function tierForSxp(sxp);               // current tier from accumulated SXP
export function seasonRewards(tier, premium);  // returns reward descriptor for a given tier
```

---

## 12. New HTTP Endpoints

All new endpoints follow the same pattern as existing server routes: body validated via `server/validate.js`, character mutations via `store.getPlayer/putPlayer`, broadcasts via `rt.broadcast`.

### 12.1 Daily system

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/daily/:login` | — | Returns current daily objectives, streak, chest status |
| POST | `/api/daily-chest/:login` | `{}` | Claims daily chest if all 3 objectives complete; returns rewards; sets `chestClaimed=true` |
| POST | `/api/daily/refresh/:login` | `{}` | Admin/internal: force refresh objectives for today (server checks date internally) |

### 12.2 Weekly bounties

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/weekly/:login` | — | Returns current weekly bounties and mark balance |
| POST | `/api/bounty-board/spend` | `{ login, itemId }` | Spends marks from `weeklyBounties.marksEarned`; applies reward |

### 12.3 Achievements

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/achievements/:login` | — | Returns `character.achievements` + full catalogue |
| GET | `/api/achievements` | — | Returns global achievement catalogue (static, cached) |

### 12.4 Season

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/season` | — | Returns current season metadata, time remaining, SXP_PER_TIER |
| GET | `/api/season/pass/:login` | — | Returns player's season pass state, tier, rewards claimed |
| POST | `/api/season/claim/:login` | `{ tier }` | Claims a specific tier reward (validates tier is earned and not already claimed) |
| GET | `/api/leaderboard?tab=season` | — | Season-specific ladder |
| GET | `/api/leaderboard?tab=streak` | — | Streak-specific ladder |
| GET | `/api/leaderboard?tab=achievement` | — | Achievement score ladder |

### 12.5 Collection systems

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/bestiary/:login` | — | Returns `character.bestiary` + ENEMIES catalogue |
| GET | `/api/museum/:login` | — | Returns `character.museum` |
| POST | `/api/museum/enshrine` | `{ login, itemIndex }` | Enshrines item from current run inventory; validates item rarity |
| POST | `/api/equip-title` | `{ login, title }` | Sets `character.activeTitle`; validates title in `character.titles[]` |
| GET | `/api/monuments` | `?page=0&limit=20` | Paginated death monument list |
| GET | `/api/hall-of-fame` | — | All-time seasonal hall of fame |

### 12.6 Community events

| Verb | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/global-challenge` | — | Returns current global challenge and progress |
| GET | `/api/world-event` | — | Returns current world event (null if none) |
| POST | `/api/global-challenge/claim` | `{ login }` | Claims reward for completed global challenge |
| POST | `/api/community-event` | `{ kind, durationMs }` (HMAC-signed) | Operator-triggered community event |

### 12.7 Prestige sinks

| Verb | Path | Body | Effect |
|---|---|---|---|
| POST | `/api/prestige-spend` | `{ login, item }` | Spends prestige for a prestige-sink item; validates balance |

---

## 13. Chat Commands (chat-elixir → MMO)

All chat commands follow the existing pattern: `Chat.Mmo.Bridge` POSTs to a new MMO endpoint. The MMO is the source of truth; chat-elixir is a forwarder. Per-message work is O(1) and cheap — no heavy compute on each chat line.

| Chat command | Elixir route | MMO endpoint | Response (bot reply) |
|---|---|---|---|
| `!daily` | Bridge → MMO | `GET /api/daily/:login` | "Today: Kill 10 goblins (4/10), Reach depth 12 (0/12), Find Epic item (0/1). Streak: 7 days 🔥" |
| `!weekly` | Bridge → MMO | `GET /api/weekly/:login` | "Weekly bounties: 2/5 complete. Marks: 3. Next reset: Monday." |
| `!streak` | Bridge → MMO | `GET /api/daily/:login` | "X's current daily streak: 14 days" |
| `!bestiary` | Bridge → MMO | `GET /api/bestiary/:login` | "X's bestiary: 12/20 enemy types discovered. Missing: hollow_sigma, abyss_hunter..." |
| `!graves` | Bridge → MMO | `GET /api/monuments?limit=5` | "Recent notable deaths: SigmaVoid (depth 28, boss kill), ..." |
| `!title <name>` | Bridge → MMO | `POST /api/equip-title` | "X is now known as 'Voidlord'" |
| `!season` | Bridge → MMO | `GET /api/season` + `/api/season/pass/:login` | "Season 1: X is tier 12/50, 840 SXP. 6 weeks remaining." |
| `!museum` | Bridge → MMO | `GET /api/museum/:login` | "X's museum: Worldender Ruin Edge (Mythic), Vital Plate of the Edge (Epic)..." |
| `!challenge` | Bridge → MMO | `GET /api/global-challenge` | "Community kill: 7,234/10,000 enemies (72%). 18h remaining!" |

Each command must:
1. Coalesce identical commands from the same login within a 5-second window (prevent spam).
2. Return a chat-friendly string of ≤ 400 characters.
3. Never block the Bridge's main chat-ping loop.

---

## 14. Data Model Summary (RUN vs ACCOUNT split)

All new fields MUST obey the split invariant (CLAUDE.md §4): fields that must survive permadeath live on the ACCOUNT (character root), not the run.

### ACCOUNT-side (survive permadeath)

| Field | Type | Notes |
|---|---|---|
| `character.dailyObjectives` | Object | Full day state including progress, streak, chest claimed |
| `character.weeklyBounties` | Object | Full week state including marks balance |
| `character.achievements.earned` | Array[string] | Completed achievement IDs |
| `character.achievements.progress` | Object | Sparse progress counters by achievement ID |
| `character.achievements.score` | Number | Sum of achievement point values |
| `character.season` | Object | Season pass tier, SXP, seasonal stats, rewards claimed |
| `character.pastSeasons` | Object | Keyed by season ID — archived season state |
| `character.bestiary.kills` | Object | Keyed by enemy ID — lifetime kill counts |
| `character.bestiary.firstKilledAt` | Object | Keyed by enemy ID — timestamp of first kill |
| `character.museum` | Array | Up to 20 enshrined item snapshots |
| `character.activeTitle` | String | Currently equipped display title |
| `character.cosmeticLoadout` | Object | Currently equipped cosmetics per slot |
| `character.rivals` | Array | Top 3 rivals by encounter count |
| `character.streakPrestigeMul` | Number | Permanent prestige multiplier from 60-day streak |
| `character.legacyPrestigeMul` | Number | Permanent prestige multiplier from 2000-prestige tier |

### RUN-side (erased on permadeath — ephemeral engagement hooks)

| Field | Type | Notes |
|---|---|---|
| `run._dailyKillProgress` | Number | Temp kill count for this run's objective — banked to account on death/town |
| `run._dailyDepthHighWater` | Number | Max depth reached this run — banked to account on bank/town |

These run-side fields are purely a performance optimization (avoid reading the full objectives object on every tick). The server banks them to `character.dailyObjectives.objectives[].progress` at `bankAtTown` and `resolveDeath` time.

### WORLD-side (global, not per-player)

Managed by `store.js` as new top-level documents. Not on character objects.

| Store key / file | Content |
|---|---|
| `data/global-challenge.json` | Current global challenge state + participant list |
| `data/world-event.json` | Current world event modifiers (null if none active) |
| `data/season-current.json` | Current season metadata + global seasonal leaderboard |
| `data/hall-of-fame.json` | Permanent hall of fame records |
| `data/monuments.json` | Paginated death monument log (capped at 500 entries) |

---

## 15. Scaling & Anti-Abuse Notes

### Per-message work budget

The existing `POST /api/chat-ping/:login` is called on EVERY chat message from EVERY chatter. New retention hooks inserted here must be O(1) and allocation-light:

- `tickObjectives(character, event)` — single linear scan over 3 objectives. Acceptable.
- `tickWeeklyBounties(character, event)` — single linear scan over 5 bounties. Acceptable.
- `checkAchievements(character, event)` — scan against sparse `achievements.progress`. Cap at ~30 active achievement checks. Acceptable.
- `bestiary.kills[enemyId]++` — single hash write. Acceptable.

Do NOT call `checkAchievements` on every single chat ping. Only call it when a kill/loot/depth event actually occurred (i.e., when `delveTick` was called and returned non-idle results). The chat-ping route should batch-check objectives only when the character has a live delve tick firing.

### Global challenge updates

Global challenge progress is updated in a debounced batch, not per-message. The server accumulates kill contributions in memory for 5 seconds, then writes a single update to `data/global-challenge.json`. This follows the existing `STORE_FLUSH_MS` debounce pattern.

### Command coalescing

Chat commands like `!daily`, `!bestiary`, `!museum` can be called repeatedly by many chatters. The server must deduplicate: if the same `login` calls `GET /api/daily/:login` within 10 seconds, return a cached in-memory response. Use a `Map<login, { result, expireAt }>` with 10s TTL.

### Achievement unlock flood prevention

When a very active chatter unlocks multiple achievements in one session, cap the feed broadcast to 1 achievement announcement per login per 60 seconds. Queue extras and broadcast them sequentially.

### Season ladder

The season ladder is recomputed lazily — not on every save. It is computed on `GET /api/leaderboard?tab=season` from the in-memory player map (same as existing `leaderboard()`). With up to 400 concurrent connections (`WS_MAX_CONNECTIONS`) this is acceptable. At higher scale, cache the season ladder with a 30s TTL.

---

## 16. Balance Numbers

All numbers tied to existing constants:

| Mechanic | Value | Justification |
|---|---|---|
| Daily chest gold | 100–400 | Comparable to `REST_GOLD_PER_HOUR = 60` × 2–6h; keeps daily chest meaningful but not dominant |
| Daily streak prestige bonus at 60 days | +2% | Lifetime `econ.prestigeMul` (via `traitEconomy`) typically ~1.1–1.3; +2% is meaningful but small |
| Season pass tiers | 50 | Matches 12-week season: ~4–5 tiers per week sustainable |
| SXP per daily objective | 20 (each) + 50 (all-3) | 3×20 + 50 = 110 SXP/day → ~770/week → ~9,240/season = 46 tiers. Tier 50 requires bonus sources |
| SXP per tier | 200 | 50 tiers × 200 = 10,000 SXP; marginal players reach ~30 tiers naturally |
| Prestige respec token cost | 50 prestige | Roughly 3–5 deaths worth of prestige; expensive but reachable |
| Museum slots | 20 | Enough for a multi-month collector without trivializing the feature |
| Daily streak day for "Flame Halo" | 30 days | ~1 month of daily play; challenging but realistic for dedicated viewers |
| Bounty marks weekly cap | ~10 marks (5 bounties × avg 2 marks) | Enough for 2 shop purchases per week; prevents hoarding |

---

## 17. Cross-Agent Dependencies

| Dependency | Agent | What is needed | Why |
|---|---|---|---|
| World Events | Agent 6 (simulation) | `worldEventModifiers` structure that `delveTick` reads at loot-bias + enemy-selection steps; server broadcasts `worldEvent` frame | Retention events need sim-level hooks to modify enemy rates and loot |
| Season narrative themes | Agent 3 (narrative) | Season theme descriptions, world event flavor text, achievement names/lore | Retention systems need narrative dressing to feel like stories |
| Economy balance | Agent 2 (economy) | Daily chest gold amounts, bounty mark shop prices, prestige sink costs must not inflate or deflate the gold economy | Cross-contamination risk if we add too much gold via chests |
| Chat command routing | Agent 5 (twitch) | Chat-elixir `Chat.Mmo.Bridge` must forward `!daily`, `!weekly`, `!bestiary`, `!graves`, `!title`, `!season`, `!museum`, `!challenge`, `!streak` as new HTTP POSTs/GETs | All chat commands depend on chat-elixir acting as the thin forwarder |
| Leaderboard display | Agent 1 (systems) | Achievement score, season rank, and streak columns on the leaderboard need UI surface area in the overlay and client | The data model is defined here; the display lives in Agent 1's domain |
| NPC/world persistence | Agent 7 (npc) | World events and global challenges reference enemy types from `shared/enemies.js`; any new enemies added by Agent 7 must be added to the bestiary kill-tracking whitelist | New enemies not in `ENEMY_IDS` would be silently dropped from bestiary |

---

## 18. Open Conflicts to Resolve

1. **Premium season pass monetization**: Who controls the `premiumUnlocked` field and how is it set? Requires integration with Agent 2 (economy) and the broader Stripe/accounts system (outside this repo). Until resolved, treat `premiumUnlocked` as always-false in the free build.

2. **World event difficulty balance**: If `worldEventModifiers` increases enemy damage by 15%, low-level characters may die immediately. Need agreement with Agent 1 (systems) on whether world events are level-gated or apply universally. Current proposal: apply universally, matching Fear & Hunger's "the world is hard" philosophy.

3. **Global challenge participant list vs. privacy**: Storing participant tokens in `global-challenge.json` creates a mild privacy concern (linking multiple sessions to a recognizable name). Mitigation: store only a count, not token list, and use a bloom filter for dedup. Needs review.

4. **Season pass payment flow**: The document specifies a `premiumUnlocked` boolean but does not define how payment is processed. This must be resolved with the accounts/Stripe system outside this codebase before implementing the premium track.

5. **Rival system data freshness**: `character.rivals` is updated at raid time. If raids are rare, rivals become stale. May need a TTL on rival entries (clear if `lastAt` > 30 days). Needs agreement with Agent 5 (twitch).

6. **Museum enshrine at death**: The automatic enshrine-on-death flow (highest-power Legendary item enshrined automatically) requires `resolveDeath` to call `museumAutoEnshrined(character, run)`. This touches the core progression loop. Coordinate with Agent 1 (systems) on where exactly this hook sits relative to prestige minting and run reset.

7. **Objective determinism for simulateOffline**: `simulateOffline` runs `delveTick` in a loop and banks kills/loot. Objective progress for offline runs should be credited in bulk at the end of the offline simulation, not tick-by-tick. The `tickObjectives` call should NOT be inside the offline sim loop (performance). Need to define the offline batch-credit interface.

---

## 19. New `server/` Modules

### 19.1 `server/retention.js`

Houses server-side retention orchestration — not shared sim logic. Imports `shared/objectives.js` and `shared/achievements.js`:

```js
// Proposed exports:
export function ensureFreshObjectives(character, nowMs);
  // calls rollFreshDaily / rollFreshWeekly from shared/objectives.js
  // mutates character in-place; safe to call on every chat-ping (early exit if not stale)
export function creditRetentionEvent(character, event, nowMs);
  // event = { type: 'kills'|'depth'|'loot'|'skill'|'raid'|'boss_kill', value, meta }
  // calls tickObjectives, tickWeeklyBounties, checkAchievements
  // returns { objectivesCompleted, bountiesCompleted, achievementsEarned, feedEvents }
export function creditGlobalChallenge(store, event);
  // updates data/global-challenge.json progress (debounced)
export function creditBestiary(character, enemyId, count);
  // increments bestiary kill counts; checks bestiary achievements
export function buildMonumentEntry(character, deathInfo);
  // constructs a monument record from resolveDeath deathInfo
export function autoMuseumEnshrined(character, run);
  // called by resolveDeath; enshrines highest-power Legendary+ item if museum not full
```

`creditRetentionEvent` is the single call site inserted into the `delveTick` result handler in `server/server.js`. It keeps the server route clean and testable.

### 19.2 Supervisor loops for retention

New supervised intervals in `server/server.js`:

```js
// World event rotation: check if current world event expired; rotate to next if scheduled
superviseInterval('worldEvent.tick', worldEventTick, 60_000);

// Global challenge tick: flush batched contribution counts
superviseInterval('globalChallenge.flush', globalChallengFlush, 5_000);

// Season ladder cache: recompute if stale (lazy, 30s TTL)
superviseInterval('seasonLadder.refresh', seasonLadderRefresh, 30_000);

// Objective freshness sweep: for all online players, ensure daily/weekly objectives are fresh
superviseInterval('objectives.sweep', objectivesSweep, 300_000); // every 5 min
```

---

## 20. Success Criteria

Implementation is correct when ALL of the following pass:

1. **Daily objectives reset at UTC midnight** for every connected player. Streak increments by 1 when all 3 are completed before midnight; resets to 0 when a day is missed.

2. **Permadeath does not reset objective progress**. A player who kills 8/10 goblins then dies carries 8 kills into their next run.

3. **`shared/objectives.js` is dual-runtime**: imports successfully in both browser (via `/shared/objectives.js` static path) and Node (smoke test passes). No DOM or Node built-ins used.

4. **All new character fields pass `vCharacter()`** in `server/validate.js`. A character with all new fields serialized and deserialized produces the same result.

5. **Bestiary is complete**: all 20 ENEMY_IDS are trackable. `!bestiary` returns accurate counts for a player with known kill history.

6. **Season ladder is correctly isolated**: prestige earned before Season 1 start does not count toward the season ladder. Only `season.seasonStats.prestigeThisSeason` is ranked.

7. **Daily chest cannot be double-claimed**. A second `POST /api/daily-chest/:login` on the same day returns an error (chest already claimed).

8. **Global challenge progress is not lost on server restart**. It is persisted via `store.js` and reloaded on `initStore()`.

9. **Chat commands return within 100ms** (measured at the MMO server). No blocking IO in the command handler path.

10. **Achievement broadcasts are rate-limited**: at most 1 achievement feed event per login per 60 seconds, even if multiple achievements unlock simultaneously.

11. **The One-of-One find event** triggers a distinct `oneofone_found` feed kind and a full-client broadcast. A smoke test can simulate finding a `oneofone` item and verify the broadcast.

12. **Museum enshrine at permadeath** fires only when the dying run holds at least one Legendary+ item and the museum has an open slot. Runs dying with only common/uncommon/rare items do not modify the museum.
