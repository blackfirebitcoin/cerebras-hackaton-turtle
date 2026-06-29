// SIGMA ABYSS — central balance + enum constants.
//
// Single source of truth. Imported by the client game logic, the
// deterministic sim (combat/progression), and server-side input
// validation. Stat-formula coefficients live in stats.js; this file is
// the cross-cutting numbers + enums everything agrees on.

// v2 → v3: Project Ascendant Inc6 — dual specialization. Adds an optional
// second build set (`setB`) + `activeSet` ("A"|"B") on the account and a
// parallel inactive-gear loadout (`run.gearB`). The migration is EXACT-IDENTITY:
// a v2 save loads as activeSet "A", setB null → Set A already IS its single
// loadout, so derive()/delveTick stay byte-identical. No save is rewritten on
// disk until the next save; vCharacter coerces the new fields to their defaults.
export const SCHEMA_VERSION = 3;

// Build-set identifiers (Project Ascendant Inc6 — dual specialization). A
// character carries one active combat profile at a time; "A" is the canonical
// single-loadout (every pre-Inc6 character) and "B" is an optional second set.
export const BUILD_SETS = ["A", "B"];

// ── Virtual render space (canvas is letterboxed to this) ──────────────
export const VW = 1920;
export const VH = 1080;

// ── The 7 stats ───────────────────────────────────────────────────────
export const STAT_KEYS = ["str", "agi", "vit", "luck", "int", "greed", "resolve"];
export const STAT_LABEL = {
  str: "Strength",
  agi: "Agility",
  vit: "Vitality",
  luck: "Luck",
  int: "Intellect",
  greed: "Greed",
  resolve: "Resolve",
};
export const STAT_BLURB = {
  str: "Raw attack power.",
  agi: "Attack speed + dodge chance.",
  vit: "Maximum HP.",
  luck: "Crit chance, rarer loot, hidden events.",
  int: "Crit damage + overload double-hits.",
  greed: "More loot & rarer drops — but danger rises faster.",
  resolve: "Damage reduction, slows danger, can cheat death.",
};
export const STAT_MIN = 1;
export const STAT_MAX = 999; // hard per-stat cap (validation bound)
export const START_STATS = { str: 5, agi: 5, vit: 5, luck: 5, int: 5, greed: 5, resolve: 5 };
export const STAT_POINTS_PER_LEVEL = 3;

// ── Levels / XP ───────────────────────────────────────────────────────
export const LEVEL_MAX = 200;
export const XP_BASE = 40;
export const XP_GROWTH = 1.16;

// ── Build presets (the "respec to a template" buttons) ────────────────
export const BUILD_PRESETS = {
  bruiser: { label: "Bruiser", weight: { str: 3, vit: 2, resolve: 1 } },
  glasscannon: { label: "Glass Cannon", weight: { str: 3, agi: 3 } },
  trickster: { label: "Trickster", weight: { agi: 3, luck: 3 } },
  goblin: { label: "Loot Goblin", weight: { greed: 4, luck: 2 } },
  warlock: { label: "Warlock", weight: { int: 3, luck: 2, resolve: 1 } },
  juggernaut: { label: "Juggernaut", weight: { vit: 3, resolve: 3 } },
};

// ── Rarity — 7 tiers ──────────────────────────────────────────────────
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "oneofone"];
export const RARITY_LABEL = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
  mythic: "Mythic",
  oneofone: "One-of-One",
};
export const RARITY_COLOR = {
  common: "#9aa4b2",
  uncommon: "#5bd16a",
  rare: "#4aa3ff",
  epic: "#b86bff",
  legendary: "#ff9d2e",
  mythic: "#ff4d6d",
  oneofone: "#ffe44d",
};
export const RARITY_RANK = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
  oneofone: 6,
};
export const RARITY_AFFIXES = {
  common: 1,
  uncommon: 2,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
  oneofone: 6,
};
// Base drop weights — luck / greed / zone tier bend the curve at roll time.
export const RARITY_WEIGHT = {
  common: 1000,
  uncommon: 420,
  rare: 160,
  epic: 46,
  legendary: 11,
  mythic: 2,
  oneofone: 0.06,
};

// ── Gear slots ────────────────────────────────────────────────────────
export const GEAR_SLOTS = ["weapon", "armor", "ring", "relic", "charm"];
export const GEAR_SLOT_LABEL = {
  weapon: "Weapon",
  armor: "Armor",
  ring: "Ring",
  relic: "Cursed Relic",
  charm: "Gamblin’ Charm",
};
export const INVENTORY_MAX = 40;

// ── Spirit Pool (Project Ascendant Inc1 — display foundation) ─────────
// Spirit is a display-only resource in Inc1. Inc2+ will introduce
// spiritCost skills that consume from this pool during delves.
// Formula: SPIRIT_BASE + int * SPIRIT_PER_INT (pure additive, no rng).
// All new-family weapons + skills are exact-identity (+0) until Inc2.
export const SPIRIT_BASE = 50;
export const SPIRIT_PER_INT = 1.5;

// ── Danger / attention system ─────────────────────────────────────────
export const DANGER_MAX = 1;
export const DANGER_ELITE_AT = 0.55; // elites start showing up
export const DANGER_BOSS_AT = 0.9; // the zone boss hunts you
export const DANGER_PER_TICK = 0.02; // base rise per delve tick
export const DANGER_PER_DEPTH = 0.05; // baseline danger added each "push deeper"
// Alpha-strike cap: no single enemy swing may take more than this fraction of
// the fighter's maxHp. Guarantees you survive ≥3 hits from full — so a sigma
// is never one-shot by an over-levelled elite/boss, which leaves a window for
// the auto-potion + post-hit flee to actually fire. A pure post-RNG clamp in
// combat.js (no rng draw) so offline↔live parity is unaffected.
export const MAX_HIT_FRAC = 0.33;

// ── Delve pacing ──────────────────────────────────────────────────────
export const DELVE_TICK_MS = 2600; // real-time ms between live encounters
export const OFFLINE_TICK_MS = 9000; // game-time ms per simulated offline tick
export const OFFLINE_CAP_MS = 12 * 3600 * 1000; // simulate at most 12h away
export const DEPTH_MAX = 30;

// ── Posture — what the sigma does while you are away ──────────────────
export const POSTURES = ["delve", "rest"];
export const REST_GOLD_PER_HOUR = 60; // safe idle trickle — ~2 potions/hr
export const REST_PRESTIGE_PER_HOUR = 1.5; // ~12 prestige for an 8h sleep, just past the Survivor title

// ── Economy ───────────────────────────────────────────────────────────
export const POTION_COST = 25;
export const POTION_MAX = 20;
export const POTION_HEAL_FRAC = 0.45;
export const NAME_MAX = 18;

// ── AI behaviour config — the auto-battler "brain" ────────────────────
export const AI_TARGET_PRIORITY = ["nearest", "lowest_hp", "highest_threat", "elites_last"];
export const AI_TARGET_LABEL = {
  nearest: "Nearest",
  lowest_hp: "Finish the weak",
  highest_threat: "Biggest threat",
  elites_last: "Trash first, elites last",
};
export const AI_DEFAULTS = {
  // Tuned so a new player on autopilot survives their FIRST session: flee and
  // potion bands are wide enough that one hard pack-tick can't skip both gates,
  // and retreatDepth 5 keeps trash packs at 2-3 (not 3-4 at depth 8) so the
  // sigma runs the intended "dive shallow, flee early, bank loot" loop instead
  // of marching to depth 8 into a 4-mob wall. Only NEW runs get these (freshRun
  // spreads AI_DEFAULTS; resolveDeath carries the prior run's tuned ai).
  fleeHpFrac: 0.32, // bail out of an encounter below this HP fraction
  potionHpFrac: 0.55, // quaff a potion below this HP fraction
  retreatDanger: 0.8, // walk back to town when danger exceeds this
  retreatDepth: 5, // ...or once this depth is reached
  targetPriority: "lowest_hp",
  greedMode: false, // hunt elites/bosses for loot instead of avoiding them
  avoidElites: true, // skip elite encounters when danger allows
};
export const AI_BOUNDS = {
  fleeHpFrac: [0, 0.9],
  potionHpFrac: [0, 0.95],
  retreatDanger: [0.25, 1],
  retreatDepth: [1, DEPTH_MAX],
};

// ── Feed — the shared social ticker ───────────────────────────────────
// Base kinds (the original single-player slice) plus the persistent-world
// MMO union (see docs/design/00-master-design.md §5.3). `vFeedEvent` uses
// `vEnum` against this list, and the overlay renders unknown kinds
// generically — so this array is additive-only and never breaks old feeds.
export const FEED_KINDS = [
  "death",
  "legendary",
  "ascend",
  "boss",
  "milestone",
  // Persistent-world MMO kinds (master design §5.3 union).
  "twitch_redemption",
  "faction_join",
  "faction_leave",
  "faction_war_start",
  "faction_war_end",
  "faction_conquest",
  "market_list",
  "market_sale",
  "market_auction",
  "market_bounty",
  "economy_event",
  "narrative",
  "npc_greet",
  "npc_dialogue",
  "npc_answer",
  "npc_quest_start",
  "npc_quest_complete",
  "npc_ally",
  "npc_memory",
  "zone_eruption",
  "zone_haunted",
  "lore_fragment",
  "world_event",
  "achievement",
  "oneofone_found",
  "grave_looted",
  "scar_cleansed",
  "gather_complete",
  "vote_result",
  "rep_event_start",
];
export const FEED_MAX = 60;

// ── WebSocket protocol + server limits (the "power gate" in spirit:
//    hard ceilings so a flood of players can't run the box over) ───────
export const WS_MSG_MAX_BYTES = 24 * 1024; // hard cap on inbound frame size
export const WS_RATE = { windowMs: 10_000, max: 40 }; // per-connection message budget
export const WS_MAX_CONNECTIONS = 400; // refuse new sockets past this
export const SAVE_MIN_INTERVAL_MS = 4000; // server ignores saves faster than this
export const PLAYER_ACTIVE_MS = 90_000; // "online" if seen within this window

// ── Net / runtime ─────────────────────────────────────────────────────
export const DEFAULT_PORT = 7777;
export const STORE_FLUSH_MS = 2500; // debounce window for disk persistence
export const STATS_BROADCAST_MS = 5000; // playercount + leaderboard push cadence

// ── Persistent shared world (master design §0.4) ──────────────────────
// ONE supervised world loop at 60s. Every world sub-system (faction
// territory, zone pressure, NPC schedules, market sweep, crisis SM,
// retention sweeps) is a sub-advancer of this single tick — never its own
// timer — to honour the PSU power-safety rule (one cheap bounded loop).
export const WORLD_TICK_MS = 60_000;

// ── Agent Realm — ArtifactsMMO-inspired API play (server-authoritative) ──
// AI agents register for a bearer token and drive a character through
// cooldown-gated actions. Every action returns a cooldown the agent must
// wait out before its next action — the core pacing + anti-abuse mechanic,
// exactly as in ArtifactsMMO. Unlike the browser sigma (client-authoritative,
// permadeath delve), the agent realm is fully server-authoritative.
export const AGENT_WORLD_W = 11;
export const AGENT_WORLD_H = 11;
export const AGENT_START = { x: 5, y: 5 }; // the town / spawn tile
export const AGENT_NAME_MAX = 24;
export const AGENT_TOKEN_PREFIX = "agt_";
export const AGENT_INVENTORY_MAX = 50;
export const AGENT_BASE_HP = 100;
export const AGENT_HP_PER_LEVEL = 12;
export const AGENT_SKILLS = ["mining", "woodcutting", "fishing", "alchemy", "oracle"];
// Cooldown seconds per action kind (move adds AGENT_COOLDOWN_PER_TILE per
// manhattan tile travelled). Tuneable; agents poll cooldown.expiration.
export const AGENT_COOLDOWN = { move: 4, fight: 8, gather: 6, rest: 3, craft: 9, oracle: 4 };
export const AGENT_COOLDOWN_PER_TILE = 3;
export const AGENT_COOLDOWN_MAX_S = 120; // never strand an agent longer than this

// ── Oracle Bazaar — "Mechanical Turk for AI agents" ──────────────────────
// Claude Code (or any internal agent) posts inference HITs (questions/contexts);
// the AI agents playing the realm earn gold + task coins + oracle XP by
// answering them. This offloads inference onto the workers' own token budgets —
// the whole point: save the operator's weekly token spend. Requester routes are
// HMAC-signed; worker routes are agent-bearer-authed and gated on standing on
// the oracle tile.
export const ORACLE_PROMPT_MAX = 8000;
export const ORACLE_CONTEXT_MAX = 24000;
export const ORACLE_ANSWER_MAX = 16000;
export const ORACLE_CHOICES_MAX = 12;
export const ORACLE_REDUNDANCY_DEFAULT = 1; // distinct answers needed to finalize
export const ORACLE_REDUNDANCY_MAX = 9;
export const ORACLE_TTL_MS_DEFAULT = 5 * 60_000;
export const ORACLE_TTL_MS_MAX = 60 * 60_000;
export const ORACLE_LEASE_MS = 90_000; // claim lease before a HIT re-opens to the pool
export const ORACLE_OPEN_MAX = 500; // hard cap on concurrent open HITs
export const ORACLE_DONE_KEEP = 200; // completed/expired HITs retained for polling
export const ORACLE_REWARD_DEFAULT = { gold: 25, coins: 1, xp: 12 };
export const ORACLE_TASK_KINDS = ["inference", "classify", "rank", "extract"];
