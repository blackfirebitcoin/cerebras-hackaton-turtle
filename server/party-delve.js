// Party dungeon delve orchestration (demo P5). Mirrors live-delve.js's discipline:
// executed INLINE on a player-driven request, server-authoritative, bounded, NEVER
// in the 3s world tick and NEVER triggered by the NPC/Director planner — so the tick
// budget, idle-quiescence, and no-combat-authority-leak rails stay intact. Model
// calls (boss-drop enrichment) stay strictly off the resolution path (cache-primary).

import { INVENTORY_MAX } from "../shared/constants.js";
import { resolvePartyEncounter } from "../shared/party-combat.js";
import { buildPartyCombatants, ensureDemoRun } from "./party-build.js";
import { buildDungeonEnemies, rollPartyLoot } from "./party-dungeon.js";

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

  const party = s.parties?.[token] || { leaderToken: token, members: [], status: "forming" };
  ensureDemoRun(character);

  const combatants = buildPartyCombatants(party, character, (id) => s.overworldNpcs?.[id]);
  const seed = seedOf(`${token}:${tileId}:${s.tick || 0}`);
  const { enemies, level, depth } = buildDungeonEnemies(tile, combatants.length, seed);
  const result = resolvePartyEncounter({ party: combatants, enemies, seed });
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

  // Record the outcome on the party (player-driven → persists with the world).
  if (s.parties?.[token]) {
    s.parties[token].lastDelve = {
      outcome: result.outcome,
      rounds: result.rounds,
      tile: tile.name,
      kills: result.kills.length,
      drops: loot.drops.map((d) => ({ to: d.memberName, item: d.item?.name || "loot", rarity: d.item?.rarity, fromBoss: d.fromBoss })),
      at: s.tick || 0,
    };
    s.parties[token].status = result.outcome === "victory" ? "done" : "forming";
  }
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
