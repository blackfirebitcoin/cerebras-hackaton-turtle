// Dungeon encounter + loot for a party delve (demo P4). Reuses the real systems:
// makeEnemy (the tuned roster), makeRng (seeded), rollDrop (the loot table), and the
// Gemma-capable boss-drop forge. Enemies are adapted into the party-combat resolver's
// combatant shape. Server-side (uses makeRng/Date-stamped item ids); the resolver
// itself stays pure.

import { makeEnemy } from "../shared/enemies.js";
import { rollDrop } from "../shared/loot.js";
import { makeRng } from "../shared/rng.js";

const NORMALS = ["goblin", "skeleton", "imp", "wolf", "boar", "bandit", "abyss_crawler", "corrupted_knight"];
// Boss ids are RAID_BOSS_DROPS keys → a boss kill yields a REAL raid drop (+ optional
// Gemma enrichment via the boss-drop forge).
const BOSSES = ["goblin_king", "hollow_druid", "chrome_centurion", "catacomb_tyrant"];
const ENEMY_SHEET_EXTRA = { critChance: 0.05, critMult: 1.5, dodge: 0.03, overload: 0 };

function enemyToCombatant(e, idx, bossId = null) {
  return {
    id: `${e.id}_${idx}`,
    name: e.name,
    isPlayer: false,
    isBoss: e.kind === "boss",
    bossId,
    enemyKind: e.kind,
    lootBonus: e.lootBonus || 0,
    sheet: { maxHp: e.maxHp, attack: e.attack, defense: e.defense, speed: e.speed || 8, ...ENEMY_SHEET_EXTRA },
    hp: e.maxHp,
  };
}

// Deterministic enemy pack for a dungeon tile, SCALED by party size (the base
// buildEncounter ignores party size → a 4-man party would stomp a single-fighter
// pack; here count grows with the party). A dangerous dungeon is capped by a boss.
export function buildDungeonEnemies(tile, partySize = 1, seed = 1) {
  const rng = makeRng((seed >>> 0) || 1);
  const danger = Math.max(1, tile?.danger || 1);
  // Gentle scaling tuned for a winnable demo: a level-8 party beats a low/mid
  // dungeon comfortably; danger climbs the threat. A mythic BOSS only caps the
  // deepest tier (danger>=5) so mid-danger delves end in victory + loot.
  const level = 2 + danger;
  const depth = Math.floor(danger / 2);
  const count = Math.max(2, Math.min(6, partySize + Math.floor(danger / 2)));
  const enemies = [];
  for (let i = 0; i < count; i++) {
    enemies.push(enemyToCombatant(makeEnemy(rng.pick(NORMALS), level, depth, rng), i));
  }
  if (danger >= 5) {
    const bossId = rng.pick(BOSSES);
    enemies.push(enemyToCombatant(makeEnemy(bossId, level + 1, depth + 1, rng), count, bossId));
  }
  return { enemies, level, depth, danger };
}

// After a VICTORY, roll one drop per killed enemy and assign it to the member that
// landed the kill. Boss kills route through bossDrops.forgeOrCached (sync, off the
// resolution path; warms Gemma enrichment for next time). `builtEnemies` is the
// buildDungeonEnemies output (carries bossId, which the resolver result drops).
export function rollPartyLoot({ result, builtEnemies, party, level, depth, seed, bossDrops = null }) {
  if (!result || result.outcome !== "victory") return { drops: [] };
  const rng = makeRng(((seed >>> 0) ^ 0x9e3779b9) >>> 0);
  const memberById = new Map(party.map((c) => [c.id, c]));
  const bossById = new Map((builtEnemies || []).map((e) => [e.id, e.bossId]));
  const drops = [];
  for (const kill of result.kills || []) {
    const member = memberById.get(kill.by) || party[0];
    if (!member) continue;
    const bossId = bossById.get(kill.enemyId) || null;
    let item = null;
    if (bossId && bossDrops) {
      try {
        item = bossDrops.forgeOrCached(bossId, level);
        bossDrops.warm?.(bossId, level, { killerLevel: level });
      } catch {
        item = null; // forge threw → fall through to the normal drop, never hang the request
      }
    }
    if (!item) item = rollDrop({ rng, level, depth, bias: bossId ? 3 : 1 });
    if (item) drops.push({ memberId: member.id, memberName: member.name, isPlayer: !!member.isPlayer, fromBoss: !!bossId, item });
  }
  return { drops };
}
