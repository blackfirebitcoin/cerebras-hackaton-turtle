// SIGMA ABYSS — market math + currency rules (master design §0.6 / §3.1, [A2]).
//
// PURE and RNG-FREE: fees, taxes, durations, currency conversions, and the
// validation predicates the server + client both need. No RNG lives here —
// reroll/listing-ID randomness is SERVER-ONLY (server/market.js) so it can
// never leak into the deterministic sim path (master §4.2). Dual-runtime
// ESM: no Node built-ins, no DOM.

import { RARITY_RANK } from "./constants.js";
import { MARKET_LISTING_MAX_BASE } from "./economy-constants.js";

// ── Currency conversion tables ────────────────────────────────────────
// Prestige Shards: minted on permadeath + boss kills, non-transferable.
export const SHARD_PER_PRESTIGE = 0.5;
export const SHARD_PER_BOSS_KILL = 2;

// Rune Dust: salvage product, the crafting/reroll sink currency.
export const RUNE_DUST_PER_RARITY = {
  common: 1,
  uncommon: 3,
  rare: 8,
  epic: 20,
  legendary: 55,
  mythic: 150,
  oneofone: 500,
};
export const REROLL_DUST_COST = {
  common: 2,
  uncommon: 6,
  rare: 18,
  epic: 50,
  legendary: 140,
  mythic: 400,
  // oneofone is intentionally absent → non-rerollable (lore stamp only).
};

// ── Market fees + durations (the gold sinks) ──────────────────────────
export const LISTING_FEE = {
  common: 15,
  uncommon: 35,
  rare: 80,
  epic: 300,
  legendary: 1500,
  mythic: 8000,
  oneofone: 20000,
};
export const TRANSACTION_TAX_RATE = 0.08; // seller pays, → world treasury
export const LISTING_DURATION_MS = {
  directSale: 48 * 3600_000,
  auction: 24 * 3600_000,
  buyOrder: 72 * 3600_000,
};

// Vault + slot + lore-stamp shard costs.
export const VAULT_BASE_CAPACITY = 20;
export const VAULT_MAX_CAPACITY = 40;
export const VAULT_EXPAND_SHARDS = 100;
export const SECOND_SLOT_SHARDS = 50;
export const THIRD_SLOT_SHARDS = 200;
export const LORE_STAMP_SHARDS = 15;
export const LORE_FLAVOR_MAX = 60;

export function listingFee(rarity, feeMul = 1) {
  return Math.round((LISTING_FEE[rarity] || 15) * feeMul);
}

export function transactionTax(salePrice, rate = TRANSACTION_TAX_RATE) {
  return Math.floor(Math.max(0, salePrice) * rate);
}

export function runeDustForRarity(rarity) {
  return RUNE_DUST_PER_RARITY[rarity] || 0;
}

export function rerollDustCost(rarity) {
  return REROLL_DUST_COST[rarity]; // undefined for oneofone (non-rerollable)
}

// Effective free balance = gold not locked in buy-order escrow.
export function freeGold(character) {
  return Math.max(0, (character.gold | 0) - (character.goldEscrowed | 0));
}

// Can the character list `item` for `fee`? Checks gold + slot count.
export function canList(character, item, fee, activeListingCount) {
  if (!item) return { ok: false, error: "no_item" };
  if (freeGold(character) < fee) return { ok: false, error: "insufficient_gold", fee };
  const slots = character.marketSlots || MARKET_LISTING_MAX_BASE;
  if (activeListingCount >= slots) return { ok: false, error: "no_listing_slots", slots };
  return { ok: true };
}

export function canBid(character, amount, previousOwnBid = 0) {
  const delta = amount - previousOwnBid;
  if (delta <= 0) return { ok: false, error: "bid_not_higher" };
  if (freeGold(character) < delta) return { ok: false, error: "insufficient_gold" };
  return { ok: true, delta };
}

export function canReroll(character, item) {
  if (!item) return { ok: false, error: "no_item" };
  const cost = rerollDustCost(item.rarity);
  if (cost === undefined) return { ok: false, error: "non_rerollable" };
  if ((character.runeDust | 0) < cost) return { ok: false, error: "insufficient_dust", cost };
  return { ok: true, cost };
}

// Buy-order filter predicate: does `item` satisfy `order.filter`?
export function matchesBuyOrder(order, item) {
  if (!order || !item || !order.filter) return false;
  const f = order.filter;
  if (f.slot && item.slot !== f.slot) return false;
  if (f.rarity && (RARITY_RANK[item.rarity] || 0) < (RARITY_RANK[f.rarity] || 0)) return false;
  if (f.minPower && (item.power | 0) < f.minPower) return false;
  if (f.effect && item.effect !== f.effect) return false;
  return true;
}

// The market UI's value signal: gold per point of item power.
export function goldPerPower(price, item) {
  const p = item?.power ? item.power : 0;
  if (p <= 0) return price; // unpowered item — price is the whole signal
  return Math.round((price / p) * 100) / 100;
}

// Fresh empty market document (server seeds data/market.json from this).
export function freshMarket() {
  return { schema: 1, listings: {}, buyOrders: {} };
}
