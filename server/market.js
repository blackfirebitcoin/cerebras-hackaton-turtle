// SIGMA ABYSS — market engine (server-side, master design §3.3 / 02-economy.md).
//
// The auction-house / order-book mechanics. This is SERVER-ONLY: it may use
// Node built-ins and a server-side RNG (listing IDs, affix rerolls) that
// must NEVER leak into shared/ (master §4.2 determinism firewall). Each
// handler mutates the player(s) + market + world docs through `store`,
// pushes feed + broadcasts, and returns a small result object the HTTP
// endpoint echoes back. The 60s sweep is a sub-advancer of the ONE
// world.tick (not its own timer — PSU safety).

import crypto from "node:crypto";
import { RARITIES, RARITY_RANK } from "../shared/constants.js";
import {
  ECONOMY_GOLD_CAP,
  ECONOMY_TREASURY_MODE_FEE_MUL,
  ECONOMY_TREASURY_MODE_RELEASE_FRAC,
  ECONOMY_TREASURY_MODE_TAX_RATE,
  ECONOMY_TREASURY_PROSPERITY_THRESHOLD,
  MARKET_BUY_ORDER_MAX,
  MARKET_HISTORY_RING_SIZE,
  MARKET_RATE_MAX,
  MARKET_RATE_WINDOW_MS,
  MARKET_SCAN_CAP,
} from "../shared/economy-constants.js";
import { rerollOneAffix } from "../shared/loot.js";
import {
  canBid,
  canList,
  canReroll,
  freeGold,
  LISTING_DURATION_MS,
  listingFee,
  matchesBuyOrder,
  runeDustForRarity,
  TRANSACTION_TAX_RATE,
  transactionTax,
  VAULT_EXPAND_SHARDS,
  VAULT_MAX_CAPACITY,
} from "../shared/market.js";
import { makeRng } from "../shared/rng.js";

const KINDS = new Set(["directSale", "auction"]);

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

// ── Per-login market rate limiter (master §9.4) ───────────────────────
const rate = new Map(); // login -> { count, windowStart }
function rateLimited(login, now) {
  const r = rate.get(login);
  if (!r || now - r.windowStart > MARKET_RATE_WINDOW_MS) {
    rate.set(login, { count: 1, windowStart: now });
    return false;
  }
  if (r.count >= MARKET_RATE_MAX) return true;
  r.count += 1;
  return false;
}

// Effective fee/tax under treasury mode (the auto-inflation brake).
function feeMul(world) {
  return world?.economy?.treasuryMode ? ECONOMY_TREASURY_MODE_FEE_MUL : 1;
}
function taxRate(world) {
  return world?.economy?.treasuryMode ? ECONOMY_TREASURY_MODE_TAX_RATE : TRANSACTION_TAX_RATE;
}

function treasuryAdd(world, gold) {
  if (!world?.economy) return;
  world.economy.treasury = (world.economy.treasury | 0) + gold;
}

// Push a completed sale price into the bounded per-bucket history ring.
function pushHistory(world, slot, rarity, price, now) {
  if (!world?.economy) return;
  if (!world.economy.priceHistory) world.economy.priceHistory = {};
  const ph = world.economy.priceHistory;
  const key = `${slot}:${rarity}`;
  if (!ph[key]) ph[key] = [];
  const ring = ph[key];
  ring.push({ price, at: now });
  if (ring.length > MARKET_HISTORY_RING_SIZE) {
    ring.splice(0, ring.length - MARKET_HISTORY_RING_SIZE);
  }
}

// Highest-power item of `slot` from run.inventory, falling back to vault.
function findSellable(character, slot) {
  const run = character.run || {};
  const pools = [
    { src: "inventory", arr: Array.isArray(run.inventory) ? run.inventory : [] },
    { src: "vault", arr: Array.isArray(character.vault) ? character.vault : [] },
  ];
  let best = null;
  for (const { src, arr } of pools) {
    for (let i = 0; i < arr.length; i += 1) {
      const it = arr[i];
      if (!it || it.slot !== slot) continue;
      if (!best || (it.power | 0) > (best.item.power | 0)) best = { src, index: i, item: it };
    }
    if (best && src === "inventory") break; // prefer the live haul
  }
  return best;
}

function removeFrom(character, src, index) {
  const arr = src === "vault" ? character.vault : character.run.inventory;
  return arr.splice(index, 1)[0];
}

// Deliver an item into a vault; returns false if the vault is full.
function depositVault(character, item, { force = false } = {}) {
  if (!Array.isArray(character.vault)) character.vault = [];
  const cap = character.vaultCapacity || VAULT_MAX_CAPACITY;
  if (!force && character.vault.length >= cap) return false;
  character.vault.push(item);
  return true;
}

function sellerCharacter(store, login) {
  const tok = store.getTokenByTwitch(String(login).toLowerCase());
  if (!tok) return { token: null, character: null };
  return { token: tok, character: store.getPlayer(tok)?.character || null };
}

// ── List ──────────────────────────────────────────────────────────────
export function listItem(ctx) {
  const { login, token, character, store, world, market, now } = ctx;
  if (rateLimited(login, now)) return { ok: false, error: "rate_limited" };
  const slot = String(ctx.body?.slot || "");
  const kind = KINDS.has(ctx.body?.kind) ? ctx.body.kind : "directSale";
  const price = Math.max(1, Math.floor(Number(ctx.body?.price) || 0));
  const found = findSellable(character, slot);
  if (!found) return { ok: false, error: "no_item_in_slot", slot };
  const fee = listingFee(found.item.rarity, feeMul(world));
  const check = canList(character, found.item, fee, (character.activeListings || []).length);
  if (!check.ok) return { ok: false, ...check };

  character.gold -= fee;
  treasuryAdd(world, fee);
  character.economyStats = character.economyStats || {};
  character.economyStats.totalListingFees = (character.economyStats.totalListingFees | 0) + fee;
  const item = removeFrom(character, found.src, found.index);
  const lid = id("lst");
  const listing = {
    id: lid,
    seller: login,
    sellerToken: token,
    item,
    kind,
    price,
    bids: [],
    createdAt: now,
    expiresAt:
      now + (kind === "auction" ? LISTING_DURATION_MS.auction : LISTING_DURATION_MS.directSale),
    loreStamp: item.loreStamp || null,
  };
  market.listings[lid] = listing;
  character.activeListings = [...(character.activeListings || []), lid];

  store.putPlayer(token, character);
  store.putMarket(market);
  store.putWorldState(world);
  // Auto-match against open buy orders (immediate sale if someone wants it).
  const matched = kind === "directSale" ? tryMatchBuyOrders(ctx, listing) : null;
  store.pushFeed({
    kind: "market_list",
    login,
    name: character.name,
    detail: `listed ${item.name} (${item.rarity}) for ${price}g`,
    item: item.name,
    rarity: item.rarity,
    price,
  });
  return {
    ok: true,
    listingId: lid,
    fee,
    goldRemaining: character.gold,
    matched: !!matched,
    price,
    item: summarize(item),
  };
}

// ── Buy (direct sale) ──────────────────────────────────────────────────
export function buyListing(ctx) {
  const { login, token, character, store, world, market, now } = ctx;
  if (rateLimited(login, now)) return { ok: false, error: "rate_limited" };
  const lid = String(ctx.body?.listingId || "");
  const listing = market.listings[lid];
  if (!listing) return { ok: false, error: "no_such_listing" };
  if (listing.kind !== "directSale") return { ok: false, error: "is_auction" };
  if (listing.pendingBuy) return { ok: false, error: "listing_claimed" };
  if (listing.seller === login) return { ok: false, error: "own_listing" };
  const tax = transactionTax(listing.price, taxRate(world));
  if (freeGold(character) < listing.price + tax)
    return { ok: false, error: "insufficient_gold", need: listing.price + tax };
  if (!depositVault(character, listing.item)) return { ok: false, error: "vault_full" };
  listing.pendingBuy = true;

  character.gold -= listing.price + tax;
  character.economyStats = character.economyStats || {};
  character.economyStats.totalBought = (character.economyStats.totalBought | 0) + 1;
  character.economyStats.totalTaxPaid = (character.economyStats.totalTaxPaid | 0) + tax;
  treasuryAdd(world, tax);
  pushHistory(world, listing.item.slot, listing.item.rarity, listing.price, now);

  // Pay the seller (net of tax — tax already removed from buyer above goes
  // to treasury; seller receives the full listed price).
  const seller = sellerCharacter(store, listing.seller);
  if (seller.character) {
    seller.character.gold = (seller.character.gold | 0) + listing.price;
    seller.character.economyStats = seller.character.economyStats || {};
    seller.character.economyStats.totalSold = (seller.character.economyStats.totalSold | 0) + 1;
    seller.character.activeListings = (seller.character.activeListings || []).filter(
      (x) => x !== lid,
    );
    store.putPlayer(seller.token, seller.character);
  }
  delete market.listings[lid];
  store.putPlayer(token, character);
  store.putMarket(market);
  store.putWorldState(world);

  if (RARITY_RANK[listing.item.rarity] >= RARITY_RANK.legendary) {
    store.pushFeed({
      kind: "market_sale",
      login,
      name: character.name,
      detail: `bought ${listing.item.name} (${listing.item.rarity}) for ${listing.price}g`,
      rarity: listing.item.rarity,
      price: listing.price,
    });
  }
  return {
    ok: true,
    item: summarize(listing.item),
    goldSpent: listing.price + tax,
    taxPaid: tax,
    goldRemaining: character.gold,
  };
}

// ── Bid (auction) ───────────────────────────────────────────────────────
export function bidListing(ctx) {
  const { login, token, character, store, market, now } = ctx;
  if (rateLimited(login, now)) return { ok: false, error: "rate_limited" };
  const lid = String(ctx.body?.listingId || "");
  const amount = Math.max(1, Math.floor(Number(ctx.body?.amount) || 0));
  const listing = market.listings[lid];
  if (!listing) return { ok: false, error: "no_such_listing" };
  if (listing.kind !== "auction") return { ok: false, error: "not_auction" };
  if (now >= listing.expiresAt) return { ok: false, error: "auction_ended" };
  if (listing.seller === login) return { ok: false, error: "own_listing" };
  const highBid = listing.bids[listing.bids.length - 1] || null;
  const minNext = highBid ? highBid.amount + 1 : listing.price;
  if (amount < minNext) return { ok: false, error: "bid_too_low", minNext };
  const prevOwn = [...listing.bids].reverse().find((b) => b.bidder === login)?.amount || 0;
  const check = canBid(character, amount, prevOwn);
  if (!check.ok) return { ok: false, ...check };

  // Refund the previous leader's escrow (different bidder), escrow this bid.
  if (highBid && highBid.bidder !== login) {
    const prev = sellerCharacter(store, highBid.bidder);
    if (prev.character) {
      prev.character.goldEscrowed = Math.max(0, (prev.character.goldEscrowed | 0) - highBid.amount);
      store.putPlayer(prev.token, prev.character);
    }
  }
  // Net escrow change for this bidder: new amount minus their own prior escrow.
  character.goldEscrowed = Math.max(0, (character.goldEscrowed | 0) - prevOwn) + amount;
  listing.bids.push({ bidder: login, bidderToken: token, amount, at: now });

  store.putPlayer(token, character);
  store.putMarket(market);
  return { ok: true, newHigh: amount };
}

// ── Offer (buy order) ──────────────────────────────────────────────────
export function postOffer(ctx) {
  const { login, token, character, store, market, now } = ctx;
  if (rateLimited(login, now)) return { ok: false, error: "rate_limited" };
  if ((character.activeBuyOrders || []).length >= MARKET_BUY_ORDER_MAX)
    return { ok: false, error: "too_many_orders" };
  const slot = String(ctx.body?.slot || "");
  const rarity = RARITIES.includes(ctx.body?.rarity) ? ctx.body.rarity : "common";
  const minPower = Math.max(0, Math.floor(Number(ctx.body?.minPower) || 0));
  const effect = ctx.body?.effect ? String(ctx.body.effect) : null;
  const price = Math.max(1, Math.floor(Number(ctx.body?.price) || 0));
  if (freeGold(character) < price) return { ok: false, error: "insufficient_gold" };

  const oid = id("ord");
  const order = {
    id: oid,
    buyer: login,
    buyerToken: token,
    filter: { slot, rarity, minPower, effect },
    price,
    createdAt: now,
    expiresAt: now + LISTING_DURATION_MS.buyOrder,
  };
  character.goldEscrowed = (character.goldEscrowed | 0) + price;
  market.buyOrders[oid] = order;
  character.activeBuyOrders = [...(character.activeBuyOrders || []), oid];
  store.putPlayer(token, character);
  store.putMarket(market);

  // Scan current direct-sale listings for an immediate match (capped).
  let matched = null;
  let scanned = 0;
  for (const listing of Object.values(market.listings)) {
    if (++scanned > MARKET_SCAN_CAP) break;
    if (listing.kind !== "directSale" || listing.seller === login) continue;
    if (listing.price > price) continue;
    if (matchesBuyOrder(order, listing.item)) {
      matched = executeOrderMatch(ctx, order, listing);
      break;
    }
  }
  return { ok: true, orderId: oid, matched: !!matched };
}

// Fulfil a buy order against a matching listing (immediate sale).
function executeOrderMatch(ctx, order, listing) {
  const { store, world, market, now } = ctx;
  const buyer = sellerCharacter(store, order.buyer);
  const seller = sellerCharacter(store, listing.seller);
  if (!buyer.character) return null;
  if (!depositVault(buyer.character, listing.item)) return null;
  const tax = transactionTax(listing.price, taxRate(world));
  buyer.character.goldEscrowed = Math.max(0, (buyer.character.goldEscrowed | 0) - order.price);
  buyer.character.gold -= listing.price + tax;
  buyer.character.activeBuyOrders = (buyer.character.activeBuyOrders || []).filter(
    (x) => x !== order.id,
  );
  treasuryAdd(world, tax);
  pushHistory(world, listing.item.slot, listing.item.rarity, listing.price, now);
  if (seller.character) {
    seller.character.gold = (seller.character.gold | 0) + listing.price;
    seller.character.activeListings = (seller.character.activeListings || []).filter(
      (x) => x !== listing.id,
    );
    store.putPlayer(seller.token, seller.character);
  }
  delete market.listings[listing.id];
  delete market.buyOrders[order.id];
  store.putPlayer(buyer.token, buyer.character);
  store.putMarket(market);
  store.putWorldState(world);
  return { listingId: listing.id, price: listing.price };
}

// On listing creation, try to satisfy an existing buy order.
function tryMatchBuyOrders(ctx, listing) {
  const { market } = ctx;
  let scanned = 0;
  for (const order of Object.values(market.buyOrders)) {
    if (++scanned > MARKET_SCAN_CAP) break;
    if (order.buyer === listing.seller) continue;
    if (order.price < listing.price) continue;
    if (matchesBuyOrder(order, listing.item)) return executeOrderMatch(ctx, order, listing);
  }
  return null;
}

// ── Unlist ──────────────────────────────────────────────────────────────
export function unlist(ctx) {
  const { login, token, character, store, market } = ctx;
  const lid = String(ctx.body?.listingId || "");
  const listing = market.listings[lid];
  if (!listing) return { ok: false, error: "no_such_listing" };
  if (listing.seller !== login) return { ok: false, error: "not_seller" };
  if (listing.kind === "auction" && listing.bids.length) return { ok: false, error: "has_bids" };
  depositVault(character, listing.item, { force: true });
  delete market.listings[lid];
  character.activeListings = (character.activeListings || []).filter((x) => x !== lid);
  store.putPlayer(token, character);
  store.putMarket(market);
  return { ok: true, item: summarize(listing.item) };
}

// ── Salvage → Rune Dust ─────────────────────────────────────────────────
export function salvage(ctx) {
  const { token, character, store } = ctx;
  const run = character.run || {};
  const inv = Array.isArray(run.inventory) ? run.inventory : [];
  const all = !!ctx.body?.all;
  const slot = ctx.body?.slot ? String(ctx.body.slot) : null;
  const keepRank = ctx.body?.keepRarity ? RARITY_RANK[ctx.body.keepRarity] || 0 : 0;
  const keep = [];
  let dust = 0;
  let destroyed = 0;
  for (const it of inv) {
    const salvageThis = all
      ? (RARITY_RANK[it.rarity] || 0) <= keepRank || keepRank === 0
      : slot && it.slot === slot;
    if (salvageThis) {
      dust += runeDustForRarity(it.rarity);
      destroyed += 1;
    } else {
      keep.push(it);
    }
  }
  if (destroyed === 0) return { ok: false, error: "nothing_to_salvage" };
  run.inventory = keep;
  character.runeDust = (character.runeDust | 0) + dust;
  character.economyStats = character.economyStats || {};
  character.economyStats.totalSalvaged = (character.economyStats.totalSalvaged | 0) + destroyed;
  store.putPlayer(token, character);
  return { ok: true, dustGained: dust, itemsDestroyed: destroyed, runeDust: character.runeDust };
}

// ── Reroll one affix (server-only RNG) ─────────────────────────────────
export function reroll(ctx) {
  const { token, character, store, now } = ctx;
  const slot = String(ctx.body?.slot || "");
  const item = character.run?.gear?.[slot];
  if (!item) return { ok: false, error: "no_equipped_item", slot };
  const check = canReroll(character, item);
  if (!check.ok) return { ok: false, ...check };
  // Server-only RNG — never the run's rngState (account action, offline-safe).
  const rng = makeRng((now ^ (character.seed || 1)) >>> 0 || 1);
  const result = rerollOneAffix(item, rng);
  if (!result) return { ok: false, error: "reroll_failed" };
  character.runeDust -= check.cost;
  item.rerolls = (item.rerolls | 0) + 1;
  store.putPlayer(token, character);
  return {
    ok: true,
    cost: check.cost,
    rerolls: item.rerolls,
    affix: result.affix,
    power: item.power,
    runeDust: character.runeDust,
  };
}

// ── Vault expand ────────────────────────────────────────────────────────
export function vaultExpand(ctx) {
  const { token, character, store } = ctx;
  if ((character.vaultCapacity || 20) >= VAULT_MAX_CAPACITY)
    return { ok: false, error: "already_max" };
  if ((character.shards | 0) < VAULT_EXPAND_SHARDS)
    return { ok: false, error: "insufficient_shards", need: VAULT_EXPAND_SHARDS };
  character.shards -= VAULT_EXPAND_SHARDS;
  character.vaultCapacity = VAULT_MAX_CAPACITY;
  store.putPlayer(token, character);
  return { ok: true, vaultCapacity: character.vaultCapacity, shards: character.shards };
}

// ── Price history query (!price) ───────────────────────────────────────
export function priceQuery(world, slot, rarity) {
  const ring = world?.economy?.priceHistory?.[`${slot}:${rarity}`] || [];
  const recent = ring
    .slice(-5)
    .reverse()
    .map((e) => e.price);
  const weekAgo = ring.filter((e) => e.at); // (median over the whole bounded ring)
  const prices = weekAgo.map((e) => e.price).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  return { slot, rarity, recent, median, samples: ring.length };
}

// ── Browse snapshot (!market / GET /api/market) ────────────────────────
export function browse(market, { slot, rarity, limit = 20 } = {}) {
  const out = [];
  for (const l of Object.values(market.listings)) {
    if (slot && l.item.slot !== slot) continue;
    if (rarity && l.item.rarity !== rarity) continue;
    out.push({
      id: l.id,
      seller: l.seller,
      kind: l.kind,
      price: l.price,
      item: summarize(l.item),
      bids: l.bids.length,
      expiresAt: l.expiresAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function summarize(item) {
  if (!item) return null;
  return {
    name: item.name,
    slot: item.slot,
    rarity: item.rarity,
    power: item.power | 0,
    rerolls: item.rerolls | 0,
    effect: item.effect || null,
    loreStamp: item.loreStamp || null,
  };
}

// ── The 60s sweep — a sub-advancer of the ONE world.tick ───────────────
// Expires direct listings, finalizes ended auctions, re-derives the
// circulation gauge, toggles the treasury-mode brake, fires prosperity.
export function sweep({ store, now }) {
  const market = store.getMarket();
  const world = store.getWorldState();
  if (!market || !world) return { expired: 0, auctionsClosed: 0 };
  let expired = 0;
  let auctionsClosed = 0;

  for (const [lid, listing] of Object.entries(market.listings)) {
    if (now < listing.expiresAt) continue;
    if (listing.kind === "auction" && listing.bids.length) {
      // Finalize: highest bidder wins, escrow → payment, item → winner vault.
      const top = listing.bids[listing.bids.length - 1];
      const winner = sellerCharacter(store, top.bidder);
      const seller = sellerCharacter(store, listing.seller);
      const tax = transactionTax(top.amount, taxRate(world));
      if (winner.character) {
        winner.character.goldEscrowed = Math.max(
          0,
          (winner.character.goldEscrowed | 0) - top.amount,
        );
        winner.character.gold = Math.max(0, (winner.character.gold | 0) - tax); // bid already covered price via escrow→seller
        depositVault(winner.character, listing.item, { force: true });
        store.putPlayer(winner.token, winner.character);
      }
      if (seller.character) {
        seller.character.gold = (seller.character.gold | 0) + top.amount;
        seller.character.activeListings = (seller.character.activeListings || []).filter(
          (x) => x !== lid,
        );
        store.putPlayer(seller.token, seller.character);
      }
      treasuryAdd(world, tax);
      pushHistory(world, listing.item.slot, listing.item.rarity, top.amount, now);
      store.pushFeed({
        kind: "market_auction",
        login: top.bidder,
        detail: `won ${listing.item.name} (${listing.item.rarity}) at ${top.amount}g`,
        rarity: listing.item.rarity,
        price: top.amount,
      });
      auctionsClosed += 1;
    } else {
      // Unsold (or bid-less auction): return to seller vault, no fee refund.
      const seller = sellerCharacter(store, listing.seller);
      if (seller.character) {
        depositVault(seller.character, listing.item, { force: true });
        seller.character.activeListings = (seller.character.activeListings || []).filter(
          (x) => x !== lid,
        );
        store.putPlayer(seller.token, seller.character);
      }
      expired += 1;
    }
    delete market.listings[lid];
  }

  // Expire stale buy orders → refund escrow.
  for (const [oid, order] of Object.entries(market.buyOrders)) {
    if (now < order.expiresAt) continue;
    const buyer = sellerCharacter(store, order.buyer);
    if (buyer.character) {
      buyer.character.goldEscrowed = Math.max(0, (buyer.character.goldEscrowed | 0) - order.price);
      buyer.character.activeBuyOrders = (buyer.character.activeBuyOrders || []).filter(
        (x) => x !== oid,
      );
      store.putPlayer(buyer.token, buyer.character);
    }
    delete market.buyOrders[oid];
  }

  // Re-derive the circulation gauge (approximate; master conflict C24) and
  // toggle the treasury-mode brake.
  let circulation = 0;
  for (const rec of store.allPlayers()) circulation += rec.character?.gold | 0;
  world.economy.goldInCirculation = circulation;
  const wasMode = !!world.economy.treasuryMode;
  if (!wasMode && circulation > ECONOMY_GOLD_CAP) {
    world.economy.treasuryMode = true;
    store.pushFeed({
      kind: "economy_event",
      detail: "The Abyss strains under the weight of wealth — Treasury Mode engaged.",
    });
  } else if (wasMode && circulation < ECONOMY_GOLD_CAP * ECONOMY_TREASURY_MODE_RELEASE_FRAC) {
    world.economy.treasuryMode = false;
    store.pushFeed({ kind: "economy_event", detail: "The markets steady — Treasury Mode lifts." });
  }

  // Prosperity: when the treasury swells past the threshold, "spend" it back
  // into the world (the actual loot-shower is wired by the Twitch overlay in
  // M8; here we drain + announce so the sink stays a velocity redirect, not a
  // black hole). Master 02-economy §5.4.
  if ((world.economy.treasury | 0) > ECONOMY_TREASURY_PROSPERITY_THRESHOLD) {
    const spent = world.economy.treasury | 0;
    world.economy.treasury = 0;
    world.economy.prosperityEventFiredAt = now;
    store.pushFeed({
      kind: "economy_event",
      detail: `The Ember Court opens the vaults — ${spent}g of prosperity floods the Abyss.`,
      gold: spent,
    });
  }

  store.putMarket(market);
  store.putWorldState(world);
  return { expired, auctionsClosed, circulation, treasuryMode: world.economy.treasuryMode };
}
