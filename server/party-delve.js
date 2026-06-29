// Party dungeon delve orchestration (demo P5). Mirrors live-delve.js's discipline:
// executed INLINE on a player-driven request, server-authoritative, bounded, NEVER
// in the 3s world tick and NEVER triggered by the NPC/Director planner — so the tick
// budget, idle-quiescence, and no-combat-authority-leak rails stay intact. Model
// calls (boss-drop enrichment) stay strictly off the resolution path (cache-primary).

import { INVENTORY_MAX } from "../shared/constants.js";
import { resolvePartyEncounter } from "../shared/party-combat.js";
import { buildPartyCombatants, ensureDemoRun } from "./party-build.js";
import { buildDungeonEnemies, rollPartyLoot } from "./party-dungeon.js";

// A cleared dungeon's spoils don't respawn for this many world ticks (~3s each).
// The hard brake on the loot faucet, alongside HP cost + permadeath.
export const DELVE_COOLDOWN_TICKS = 120;

// FNV-1a → uint32, for a deterministic per-delve seed.
function seedOf(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Run one delve. Returns { ok, error? } or { ok:true, outcome, rounds, tile, party,
// enemies, log, loot, level }. Mutates: character.run.inventory (player loot) +
// party.lastDelve/status. The caller persists (putPlayer + putWorldState).
export function runPartyDelve({ world, store, token, character, bossDrops = null }) {
  const s = world?.sigmacraft;
  if (!s?.map) return { ok: false, error: "no overworld" };
  const tileId = s.actorPlaces?.[token] || s.map.townTileId;
  const tile = s.map.tiles?.[tileId];
  if (!tile) return { ok: false, error: "unknown tile" };
  if (tile.type !== "dungeon") return { ok: false, error: "not at a dungeon — travel to a dungeon tile first" };

  // Always materialize the leader's party record (even solo) so per-tile cooldowns
  // + delve history are tracked authoritatively.
  s.parties = s.parties || {};
  const party = s.parties[token] || (s.parties[token] = { leaderToken: token, members: [], status: "forming" });
  ensureDemoRun(character);
  if (character?.run && character.run.alive === false) {
    return { ok: false, error: "your hero has fallen — mint a new playtest run to delve again" };
  }
  // Per-tile cooldown: a freshly-cleared dungeon won't respawn loot for a while.
  // Keyed by tile ID for EVERY cleared dungeon (not just the last), so an A→B→A
  // rotation can't re-farm A. With HP cost + permadeath, the loot loop has real cost.
  party.clearedTiles = party.clearedTiles || {};
  const clearedAt = party.clearedTiles[tileId];
  if (Number.isFinite(clearedAt) && (s.tick || 0) - clearedAt < DELVE_COOLDOWN_TICKS) {
    return { ok: false, error: "this dungeon is freshly cleared — its spoils won't respawn yet" };
  }

  const combatants = buildPartyCombatants(party, character, (id) => s.overworldNpcs?.[id]);
  const seed = seedOf(`${token}:${tileId}:${s.tick || 0}`);
  const { enemies, level, depth } = buildDungeonEnemies(tile, combatants.length, seed);
  const result = resolvePartyEncounter({ party: combatants, enemies, seed });

  // Carry HP cost + permadeath back onto the leader's run — real stakes, and the
  // brake on the loot faucet: a wounded party must heal (rest at a safe tile) before
  // delving again, and a wipe ends the run (re-mint to play on).
  const playerResult = result.party.find((p) => p.isPlayer);
  if (character?.run && playerResult) {
    character.run.hp = playerResult.alive ? Math.max(1, Math.round(playerResult.hp)) : 0;
    if (!playerResult.alive) character.run.alive = false;
  }

  const loot = rollPartyLoot({ result, builtEnemies: enemies, party: combatants, level, depth, seed, bossDrops });

  // Attach the PLAYER's drops to their inventory (bounded). NPC drops are flavor in
  // the result (recruited NPCs have no persistent inventory in this demo).
  const playerId = combatants.find((c) => c.isPlayer)?.id;
  const inv = character?.run?.inventory;
  let kept = 0;
  if (Array.isArray(inv)) {
    for (const d of loot.drops) {
      if (d.memberId === playerId && inv.length < INVENTORY_MAX) {
        inv.push(d.item);
        kept += 1;
      }
    }
  }

  // Record the outcome on the party (player-driven → persists with the world). A
  // VICTORY puts this dungeon TILE on cooldown so it can't be re-farmed by rotation.
  party.lastDelve = {
    outcome: result.outcome,
    rounds: result.rounds,
    tile: tile.name,
    kills: result.kills.length,
    drops: loot.drops.map((d) => ({ to: d.memberName, item: d.item?.name || "loot", rarity: d.item?.rarity, fromBoss: d.fromBoss })),
    at: s.tick || 0,
  };
  if (result.outcome === "victory") party.clearedTiles[tileId] = s.tick || 0;
  party.status = result.outcome === "victory" ? "done" : "forming";
  store?.pushFeed?.({ kind: "narrative", name: "Dungeon", detail: `Party ${result.outcome} in ${tile.name} (${result.kills.length} slain, ${kept} loot to the leader).` });

  return {
    ok: true,
    outcome: result.outcome,
    rounds: result.rounds,
    tile: tile.name,
    level,
    party: result.party,
    enemies: result.enemies,
    log: result.log,
    loot: loot.drops.map((d) => ({ to: d.memberName, isPlayer: d.isPlayer, fromBoss: d.fromBoss, item: { name: d.item?.name, rarity: d.item?.rarity, slot: d.item?.slot, effect: d.item?.effect } })),
  };
}
