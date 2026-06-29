// SIGMA ABYSS — economy constants (master design §3.1, [A2]).
//
// Kept out of constants.js so the economy balance surface is one file you
// can tune without touching the core sim (02-economy.md §14 cheat sheet).
// Pure ESM, dual-runtime — no Node built-ins, no RNG.

// Anti-inflation: total gold across all players before the auto-brake.
export const ECONOMY_GOLD_CAP = 50_000_000;
// Treasury surplus that triggers a prosperity loot-shower event.
export const ECONOMY_TREASURY_PROSPERITY_THRESHOLD = 1_000_000;
// Treasury-mode (brake active) rates.
export const ECONOMY_TREASURY_MODE_TAX_RATE = 0.12;
export const ECONOMY_TREASURY_MODE_FEE_MUL = 1.5;
// Treasury mode releases when circulation falls this far below the cap.
export const ECONOMY_TREASURY_MODE_RELEASE_FRAC = 0.8;

export const MARKET_LISTING_MAX_BASE = 1; // base simultaneous listings; up to 3 via shards
export const MARKET_BUY_ORDER_MAX = 5;
export const MARKET_HISTORY_RING_SIZE = 1000; // sale prices kept per slot:rarity bucket
export const MARKET_SCAN_CAP = 500; // buy-order match scan ceiling (perf bound)
export const MARKET_RATE_WINDOW_MS = 60_000;
export const MARKET_RATE_MAX = 10; // market actions per login per window
