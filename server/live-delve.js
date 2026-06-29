// SIGMA ABYSS — live delve: REAL progression from chat.
//
// The fix for "hollow spectacle". A chat line now advances the chatter's
// PERSISTED run by real delveTick()s — the SAME tick the browser client and
// the offline simulator use — so a chat-only viewer (no browser open) really
// fights, loots, levels, and dies. Server-authoritative; nothing here is
// reflex, so the 6–30s stream delay is irrelevant (chatting is the heartbeat).
//
// This mirrors simulateOffline()'s loop body but is driven by chat lines and
// hard-bounded per ping. After the encounters it runs a small AUTO-PILOT
// (spend stat points, equip better loot) so a chat-only sigma actually grows
// instead of leveling forever in starter bare fists.
//
// DETERMINISM + DESYNC (critical): delveTick draws only from the run's own
// seeded rng (run.rngState) and saves it back — pure arithmetic, no timers, no
// Math.random in shared/. It is called INLINE from the chat-ping HTTP handler
// (no new interval — PSU power safety). The caller MUST gate this on the sigma
// having NO active browser WebSocket (rt.isTokenOnline === false): a connected
// browser owns + saves its own run, and advancing the same run.rngState from
// both sides would silently fork the RNG stream. chat-ping keeps `lastSeen`
// fresh on every line, so a browser that later reconnects just continues the
// stream (its offline sim sees ~no elapsed time) — a continuation, not a fork.

import { GEAR_SLOTS, INVENTORY_MAX, STAT_MAX } from "../shared/constants.js";
import { sellValue } from "../shared/loot.js";
import {
  autoEquipBest,
  bankAtTown,
  delveTick,
  deployToZone,
  resolveDeath,
  retreatToTown,
} from "../shared/progression.js";
import { recommendedZone, zoneById } from "../shared/zones.js";

// Encounters advanced per chat-ping. Small so a chatty user can't monopolise
// CPU or rocket past everyone — chatting is a steady drip, not a fast-forward.
const MAX_TICKS_PER_PING = Number(process.env.LIVE_DELVE_MAX_TICKS) || 2;
// Auto-pilot pumps survival + damage first so the sigma reads as "getting
// tougher", then rounds out. Greedy-lowest keeps the build balanced.
const PUMP_STATS = ["vit", "str", "agi"];

// Spend any banked stat points into the pump stats, keeping them balanced
// (each point goes to the currently-lowest pump stat). Bounded by statPoints.
function autoSpend(run) {
  let spent = 0;
  while (run.statPoints > 0) {
    let lo = PUMP_STATS[0];
    for (const k of PUMP_STATS) if ((run.stats[k] || 0) < (run.stats[lo] || 0)) lo = k;
    if ((run.stats[lo] || 0) >= STAT_MAX) break; // capped — stop burning points
    run.stats[lo] = (run.stats[lo] || 0) + 1;
    run.statPoints -= 1;
    spent += 1;
  }
  return spent;
}

// Auto-equip the best of the haul is shared/progression.autoEquipBest() now, so
// the live autopilot and the offline simulator equip by one identical rule.

// Advance `character`'s run by up to `n` real encounters (bounded). Returns an
// events summary the chat-ping handler turns into overlay feedback + a
// rate-limited chat callout. Returns null when there's nothing to advance
// (no run). Pure progression.js reuse — no rng outside the run's own stream.
export function liveDelve(character, n = 1) {
  const run = character?.run;
  if (!run?.rngState) return null;
  // Honor a deliberate REST posture — the player chose the safe idle path
  // (shelter in town, run frozen). Mirrors simulateOffline's posture gate;
  // chatting won't drag a resting sigma back into the abyss against their will.
  if (character.posture === "rest") return null;

  const ticks = Math.max(1, Math.min(MAX_TICKS_PER_PING, n | 0));
  const ev = {
    ticks: 0,
    xpGained: 0,
    goldGained: 0,
    kills: 0,
    killed: [],
    loot: [],
    leveled: false,
    levelsGained: 0,
    newLevel: run.level || 1,
    boss: false,
    retreats: 0,
    death: null,
    equipped: [],
    level: run.level || 1,
    depth: run.depth || 0,
    zone: run.zone || "town",
  };
  const goldBefore = character.gold | 0;

  for (let i = 0; i < ticks; i += 1) {
    // In town/safe → deploy to the best zone this sigma has earned so a
    // chat-only viewer actually delves (mirrors simulateOffline's redeploy).
    if (zoneById(run.zone)?.safe) {
      deployToZone(character, recommendedZone(character).id);
    }
    const out = delveTick(character);
    ev.ticks += 1;
    if (out.type === "idle") break; // couldn't enter a zone — nothing to do

    if (out.result) {
      ev.xpGained += out.result.xpGained || 0;
      ev.kills += out.result.kills || 0;
      for (const k of out.result.killed || []) ev.killed.push({ name: k.name, kind: k.kind });
    }
    if (out.xpRes?.leveled) {
      ev.leveled = true;
      ev.levelsGained += out.xpRes.levelsGained || 0;
      ev.newLevel = out.xpRes.newLevel;
    }
    for (const it of out.loot || []) {
      ev.loot.push({ name: it.name, rarity: it.rarity, power: it.power || 0 });
    }

    if (out.type === "death") {
      // Mirror the browser's death handling EXACTLY — resolveDeath mints a
      // fresh run, the account keeps prestige/gold/cosmetics. Skipping this
      // would leave the run in a corrupt hp<=0 state.
      const dr = resolveDeath(character, out);
      ev.death = {
        deathBy: out.deathBy,
        prestigeGained: dr.prestigeGained,
        summary: dr.summary,
        feedEntry: dr.feedEntry,
      };
      break; // fresh run minted; stop advancing this ping
    }
    if (out.type === "boss_clear") ev.boss = true;
    if (out.type === "retreat" || out.type === "boss_clear") {
      // Bank the haul (sells the bag → gold + prestige), heal, redeploy —
      // the idle loop's "secure your run, go again". Auto-equip the best of the
      // haul FIRST: bankAtTown sells the whole bag, so a drop from this delve
      // (a boss legendary that hasn't auto-equipped yet) would otherwise be
      // vendored to gold before the post-loop autoEquip below ever sees it.
      ev.retreats += 1;
      for (const e of autoEquipBest(run)) ev.equipped.push(e);
      retreatToTown(character);
      bankAtTown(character);
      deployToZone(character, recommendedZone(character).id);
    }
    // 'continue' → next tick.
  }

  // Auto-pilot — ONLY on a surviving run. After a death, resolveDeath already
  // replaced character.run with a fresh (empty) run; the local `run` ref still
  // points at the discarded dead run, so skip the autopilot entirely (the
  // fresh run has no stat points or loot to act on anyway).
  if (!ev.death) {
    autoSpend(run);
    // Accumulate — a mid-loop retreat above may already have equipped haul.
    for (const e of autoEquipBest(run)) ev.equipped.push(e);
  }

  ev.goldGained = (character.gold | 0) - goldBefore;
  ev.level = run.level || 1;
  ev.newLevel = run.level || ev.newLevel;
  ev.depth = run.depth || 0;
  ev.zone = run.zone || "town";
  return ev;
}

// An equippable item is one that declares a gear slot. Mirrors the
// `.slot` gate autoEquip() / drops use to decide what can be worn.
function equippable(it) {
  return !!it && typeof it === "object" && GEAR_SLOTS.includes(it.slot);
}

// Map the run to the manual-equip wire shape: the FULL inventory projected
// down to the few fields the loadout UI needs, keeping each item's array
// `index` so a follow-up equip can address it by position. Only equippable
// items (those with a real `.slot`) are surfaced — bare reagents/junk that
// happen to sit in the bag can't be worn, so they're not offered. Pure.
export function loadoutInventory(run) {
  const inv = Array.isArray(run?.inventory) ? run.inventory : [];
  const out = [];
  for (let i = 0; i < inv.length; i += 1) {
    const it = inv[i];
    if (!equippable(it)) continue;
    out.push({
      index: i,
      name: String(it.name || "Item").slice(0, 60),
      rarity: String(it.rarity || "common"),
      power: Number(it.power) || 0,
      slot: it.slot,
      family: it.family || null,
    });
  }
  return out;
}

// Manual equip: move run.inventory[index] into run.gear[slot] and return the
// previously-worn piece to the bag. Reuses autoEquip()'s swap shape (splice
// out → set gear → return the displaced item) but is caller-driven and
// strictly validated: the slot must be real, the index must point at an
// equippable item, and that item's own slot must match (a weapon can only go
// in the weapon slot). The starter Bare Fists (power 0) is NOT returned to
// the bag — it's a presence placeholder, not loot. If the bag is full when a
// real displaced piece needs a home, it's vendored to gold like drops.js
// does rather than exceeding INVENTORY_MAX. Pure (no rng, no persistence);
// the caller persists + re-derives. Returns {ok} or {ok:false,error}.
export function equipFromInventory(run, slot, index) {
  if (!run || typeof run !== "object") return { ok: false, error: "no_run" };
  if (!GEAR_SLOTS.includes(slot)) return { ok: false, error: "invalid_slot" };
  if (!Array.isArray(run.inventory)) run.inventory = [];
  if (!run.gear) run.gear = { weapon: null, armor: null, ring: null, relic: null, charm: null };
  if (!Number.isInteger(index) || index < 0 || index >= run.inventory.length) {
    return { ok: false, error: "invalid_index" };
  }
  const item = run.inventory[index];
  if (!equippable(item)) return { ok: false, error: "not_equippable" };
  if (item.slot !== slot) return { ok: false, error: "slot_mismatch" };

  const incoming = run.inventory.splice(index, 1)[0];
  const old = run.gear[slot];
  run.gear[slot] = incoming;

  // Return the displaced piece to the bag — but only a REAL item (the
  // starter Bare Fists / any power-0 placeholder is discarded, matching
  // autoEquip()). When the bag is full, vendor it to gold instead of
  // overflowing the cap.
  let vendoredGold = 0;
  if (old && typeof old === "object" && (old.power || 0) > 0 && !old.starter) {
    if (run.inventory.length < INVENTORY_MAX) {
      run.inventory.push(old);
    } else {
      vendoredGold = sellValue(old);
    }
  }
  return { ok: true, equipped: incoming, displaced: old || null, vendoredGold };
}
