// Sigmacraft — the fantasy-MMO overworld layer for SIGMA ABYSS. Deterministic and
// dual-runtime (browser + node): no Node built-ins, no DOM, no Date, no
// Math.random. It GENERATES a tile overworld + NPC population (FNV-1a seeded,
// fully reproducible) and projects bounded read models; authoritative mutation
// lives in server/sigmacraft.js under the world tick.
//
// The overworld is an ADDITIVE namespace on world.sigmacraft (map + overworldNpcs
// + npcAgents). The SIGMA ABYSS combat layer (world.zones / world.npcs / the 60s
// schedule) is untouched; the 6 combat zones are merely anchored to landmark
// tiles via tile.zoneId (a projection link).

export const SIGMACRAFT_SCHEMA = "sigmacraft.world.v2";
export const SIGMACRAFT_REALM_ID = "sigmacraft_alpha";

export const SIGMACRAFT_INTENT_KINDS = Object.freeze(["move", "rest", "talk"]);

export const MAX_SIGMACRAFT_PENDING_INTENTS = 128;
export const MAX_SIGMACRAFT_TICK_INTENTS = 16;
export const MAX_SIGMACRAFT_RECENT_EVENTS = 40;

// NPC-agent proposal lane (PR7). Caps enforced at the validate.js boundary + on
// rolling memory. NPC_DIALOGUE_MAX matches the feed detail cap.
export const MAX_NPC_AGENT_GOALS = 2;
export const MAX_NPC_AGENT_INCIDENTS = 8;
export const NPC_GOAL_TEXT_MAX = 96;
export const NPC_DIALOGUE_MAX = 140;
export const NPC_SUMMARY_MAX = 160;
export const NPC_PLAN_REUSE_TICKS = 5;

// Overworld scale + per-tick bounds.
export const WORLD_MAP_WIDTH = 14;
export const WORLD_MAP_HEIGHT = 10; // 140 tiles
export const NPC_POPULATION_TARGET = 200;
export const MAX_NPC_EFFECTS_PER_TICK = 12; // bounded NPC effects applied per 3s tick
export const MAX_NPC_PROPOSALS_PER_CYCLE = 256; // vNpcProposals batch cap (>= population)
export const WORLD_MAP_WINDOW = 2; // Chebyshev radius of the windowed snapshot map
export const MAX_WORLDMAP_CELLS = 64;

// ── Agentic NPC planning (PR-C): two-layer plans ──────────────────────────────
// STRATEGIC layer (off-tick): an `agenda` = ordered objectives, each a real action
// at a real tile. TACTICAL layer (on-tick): one concrete primitive per tick, walked
// toward the current objective and performed when the NPC arrives. The full action
// vocabulary — every action has a tile precondition + a bounded effect on REAL npc
// state (tileId / supplies / moodValue), never player loot/XP/death/market.
export const NPC_ACTION_KINDS = Object.freeze(["move", "talk", "gather", "fight", "rest", "craft"]);
export const NPC_TERMINAL_ACTIONS = Object.freeze(["talk", "gather", "fight", "rest", "craft"]);
export const MAX_NPC_AGENDA_STEPS = 5; // strategic objectives per agenda
export const NPC_SUPPLY_CAP = 5; // gathered-supply tally ceiling (bounded npc state)
export const NPC_MOOD_MIN = 0;
export const NPC_MOOD_MAX = 100;
export const NPC_PATHFIND_NODE_CAP = 512; // BFS guard (140 tiles ⇒ never hit)

// Tile preconditions for each terminal action — the "grounding" rule. PURE.
export function tileSupportsAction(tile, kind) {
  if (!tile) return false;
  const type = tile.type;
  const danger = tile.danger || 0;
  switch (kind) {
    case "gather":
      return type === "wilds" || type === "dungeon" || type === "ruins";
    case "fight":
      return type === "dungeon" || danger >= 3;
    case "rest":
      return type === "town" || type === "city" || danger <= 1;
    case "craft":
      return type === "town" || type === "city";
    case "talk":
      return true; // talking is always available
    default:
      return false;
  }
}

// Deterministic BFS next-hop from `fromId` toward `toId` over the tile exits graph.
// Returns the first tile on a shortest path, or `fromId` when already there /
// unreachable. PURE (exits are ordered ⇒ stable), bounded by NPC_PATHFIND_NODE_CAP.
export function nextHopToward(fromId, toId, tiles) {
  if (!tiles || !tiles[fromId] || !tiles[toId] || fromId === toId) return fromId;
  const prev = { [fromId]: null };
  const queue = [fromId];
  let visited = 0;
  let found = false;
  while (queue.length && visited < NPC_PATHFIND_NODE_CAP) {
    const cur = queue.shift();
    visited += 1;
    if (cur === toId) { found = true; break; }
    for (const nb of tiles[cur]?.exits || []) {
      if (tiles[nb] && !(nb in prev)) {
        prev[nb] = cur;
        queue.push(nb);
      }
    }
  }
  if (!found) return fromId;
  let node = toId;
  while (prev[node] !== fromId && prev[node] != null) node = prev[node];
  return prev[node] === fromId ? node : fromId;
}

// THE CASCADE. Given an NPC's current tile + its strategic agenda objective, return
// the concrete tactical primitive for THIS tick and whether the objective is now
// complete (so the caller advances the cursor). PURE + total.
//   { kind: "move"|"gather"|"fight"|"rest"|"craft"|"talk"|"noop", targetId?, objectiveComplete }
export function deriveNextStep(npc, agenda, cursor, tiles) {
  const objective = Array.isArray(agenda) ? agenda[cursor] : null;
  if (!objective) return { kind: "noop", objectiveComplete: true };
  const here = npc?.tileId;
  const target = objective.targetTileId;
  // Travel phase: still walking toward the objective's tile.
  if (target && target !== here && tiles?.[target]) {
    const hop = nextHopToward(here, target, tiles);
    if (hop && hop !== here) return { kind: "move", targetId: hop, objectiveComplete: false };
    return { kind: "noop", objectiveComplete: true }; // unreachable ⇒ skip objective
  }
  // Arrived (or no target). A plain "move" objective is done on arrival.
  if (objective.kind === "move") return { kind: "noop", objectiveComplete: true };
  // Terminal action — perform it iff the current tile supports it, else degrade to talk.
  if (tileSupportsAction(tiles?.[here], objective.kind)) {
    return { kind: objective.kind, objectiveComplete: true };
  }
  return { kind: "talk", objectiveComplete: true };
}

// Director / game-master lane (PR9). ONE world-level brain proposes bounded public
// beats off-tick; the tick consumes them into the objective + feed. It owns no
// authority (no loot/XP/death/market) — only narrative + the public objective.
export const DIRECTOR_KINDS = Object.freeze(["quest_beat", "rumor", "danger", "summary"]);
export const MAX_DIRECTOR_QUEUE = 8; // validated proposals waiting for the tick
export const MAX_DIRECTOR_EFFECTS_PER_TICK = 2; // bounded director beats applied per 3s tick
export const MAX_DIRECTOR_PROPOSALS_PER_CYCLE = 16; // vDirectorProposals batch cap
export const DIRECTOR_BEAT_COOLDOWN_TICKS = 10; // min ticks between fresh proposals (pacing)
export const DIRECTOR_TITLE_MAX = 80;
export const DIRECTOR_TEXT_MAX = 200;
export const DIRECTOR_ID_MAX = 40;
export const TALK_ACTION_LIMIT = 8;

export const DEFAULT_SIGMACRAFT_OBJECTIVE = Object.freeze({
  questId: "ash_shrine",
  stageId: "ash_shrine_stage_1",
  title: "The Ash Shrine Has Gone Quiet",
  prompt: "Travel the Old Pilgrim Road and find why the shrine fell silent.",
});

// ── Deterministic generator (FNV-1a; ported from the standalone slice) ────────
// Exported so server-side off-tick planners (NPC, Director) seed the SAME way and
// stay reproducible/testable without re-implementing FNV. Pure: no Date/random.
export function stableIndex(seed, modulo) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % modulo;
}
export function choose(list, seed) {
  return list[stableIndex(seed, list.length)];
}

const LANDMARKS = Object.freeze({
  "4,4": { id: "millbridge", name: "Millbridge", description: "A trading village with a watchfire over the river crossing.", terrain: "village", region: "Riverlands", danger: 1 },
  "5,4": { id: "old_pilgrim_road", name: "Old Pilgrim Road", description: "A wind-cut road lined with shrine markers.", terrain: "road", region: "Pilgrim Road", danger: 2 },
  "6,4": { id: "ash_shrine", name: "Ash Shrine", description: "A soot-dark chapel where offerings still smolder.", terrain: "shrine", region: "Ashen Weald", danger: 3 },
  "2,2": { id: "storm_oak_lodge", name: "Storm-Oak Lodge", description: "A timber hall where crafters season storm-oak.", terrain: "forest", region: "Storm-Oak Woods", danger: 2 },
  "10,2": { id: "basilisk_badlands", name: "Basilisk Badlands", description: "White stones, old scales, and an empty sky.", terrain: "badlands", region: "Basilisk Badlands", danger: 5 },
  "11,7": { id: "moon_silver_mines", name: "Moon-Silver Mines", description: "Cold mine mouths under old lunar wards.", terrain: "mine", region: "Moon-Silver Range", danger: 4 },
  "1,8": { id: "bandit_mire", name: "Bandit Mire", description: "Reed blinds, false trails, and stolen banners.", terrain: "mire", region: "Low Mire", danger: 4 },
  "8,8": { id: "ember_forge", name: "Ember Forge", description: "A communal forge around a coal-red public anvil.", terrain: "forge", region: "Ember Hills", danger: 2 },
});

// Landmark tiles that anchor the 6 SIGMA ABYSS combat zones (projection link).
const LANDMARK_ZONE = Object.freeze({
  millbridge: "town",
  ember_forge: "goblin_warrens",
  storm_oak_lodge: "cursed_forest",
  old_pilgrim_road: "infernal_highway",
  moon_silver_mines: "demon_catacombs",
  basilisk_badlands: "abyss_ruins",
});

const TERRAIN_BY_BAND = Object.freeze([
  ["forest", "woods", "ridge", "badlands"],
  ["meadow", "road", "forest", "ruins"],
  ["river", "village", "road", "shrine"],
  ["mire", "hills", "forge", "mine"],
]);
const TERRAIN_DETAILS = Object.freeze({
  badlands: ["Badlands", "Sun-cracked ground with old monster tracks."],
  forest: ["Forest", "Pine-dark woods full of resin and watched paths."],
  forge: ["Forgeward", "Workyards, charcoal sheds, and crafting boards."],
  hills: ["Hills", "Wind-bent hills where old roads climb and vanish."],
  meadow: ["Meadow", "Open grassland broken by standing stones."],
  mine: ["Minehold", "Cold galleries and guarded ore carts."],
  mire: ["Mire", "Wet reeds, hidden plank roads, uncertain footing."],
  ridge: ["Ridge", "Knife-backed stone with a long view."],
  river: ["Riverbank", "Fords, fishers, waterwheels, trade barges."],
  road: ["Road", "Pilgrim stones, patrol cairns, dangerous crossings."],
  ruins: ["Ruins", "Collapsed lintels and rooms that remember banners."],
  shrine: ["Shrine", "Offerings, ash bowls, bells, and quiet vows."],
  village: ["Village", "Market sheds, watchfires, people with errands."],
  woods: ["Woods", "Low green canopy, logging camps, mushroom circles."],
});

// 7 display types the playtest map renders, derived from the 14 terrains.
function tileType(terrain, id) {
  if (terrain === "village") return id === "millbridge" ? "town" : "city";
  if (terrain === "forge" || terrain === "mine" || terrain === "badlands") return "dungeon";
  if (terrain === "ruins") return "ruins";
  if (terrain === "shrine") return "shrine";
  if (terrain === "road") return "road";
  return "wilds";
}

const NAME_PREFIXES = ["Ari","Bryn","Cael","Dara","Eld","Fenn","Garr","Hale","Ivo","Jora","Kest","Lysa","Marn","Nim","Oren","Perr","Quill","Rook","Sable","Tams","Ulric","Vara","Wren","Ysol","Zane"];
const NAME_SUFFIXES = ["Ash","Brook","Cairn","Dusk","Ember","Fell","Glen","Hart","Iron","Jun","Knot","Lark","Mire","Nail","Oak","Pike","Quarry","Rune","Stone","Thorn","Vale","Wick","Yew","Zinc"];

// Archetype counts sum to NPC_POPULATION_TARGET (200).
const NPC_ARCHETYPES = Object.freeze([
  { key: "adventurer", label: "Adventurer", count: 45, factions: ["Free Blades", "Roadwardens", "Lantern Company"], goals: ["find trouble before it finds the road", "earn renown in public quests", "escort weaker travelers"], personas: ["bold sellsword", "careful delver", "laughing spear carrier", "tired veteran"] },
  { key: "crafter", label: "Crafter", count: 38, factions: ["Ember Guild", "Storm-Oak Carpenters", "Moon-Silver Factors"], goals: ["secure rare materials", "finish a public work order", "keep tools and roads supplied"], personas: ["patient smith", "sharp-eyed tailor", "ore appraiser", "woodwright"] },
  { key: "bandit", label: "Bandit", count: 35, factions: ["Red Reed Gang", "Ash Knife Crew", "Broken Toll"], goals: ["ambush rich caravans", "avoid patrols", "control a dangerous shortcut"], personas: ["boastful raider", "quiet cutpurse", "deserter captain", "mire scout"] },
  { key: "merchant", label: "Merchant", count: 25, factions: ["Millbridge Factors", "Moon Cartel", "Pilgrim Peddlers"], goals: ["move goods safely", "find reliable guards", "buy low before the roads close"], personas: ["nervous caravaner", "silver-tongued trader", "supply clerk", "horse broker"] },
  { key: "guard", label: "Guard", count: 23, factions: ["Millbridge Watch", "Shrine Wardens", "Forge Bailiffs"], goals: ["hold the roads", "break bandit pressure", "protect public works"], personas: ["stern watchman", "road captain", "gate sergeant", "shrine sentinel"] },
  { key: "scout", label: "Scout", count: 20, factions: ["Lantern Company", "Mire Runners", "High Ridge Eyes"], goals: ["map danger", "report movement", "guide adventurers through harsh travel"], personas: ["soft-spoken pathfinder", "weather reader", "bird-call messenger", "mapmaker"] },
  { key: "mystic", label: "Mystic", count: 14, factions: ["Ash Choir", "Moon-Silver Oracles", "Mushroom Theologians"], goals: ["interpret omens", "calm old spirits", "trade riddles for protection"], personas: ["ash priest", "dream cartographer", "ritual keeper", "mushroom theologian"] },
]);

const coordKey = (x, y) => `${x},${y}`;
const generatedTileId = (x, y) => `wild_${String(x).padStart(2, "0")}_${String(y).padStart(2, "0")}`;
const tileIdAt = (x, y) => LANDMARKS[coordKey(x, y)]?.id || generatedTileId(x, y);

function terrainFor(x, y) {
  const bandY = Math.min(TERRAIN_BY_BAND.length - 1, Math.floor((y / WORLD_MAP_HEIGHT) * TERRAIN_BY_BAND.length));
  const band = TERRAIN_BY_BAND[bandY];
  return band[(x + y * 2) % band.length];
}
function regionFor(x, y, terrain) {
  if (y <= 2 && x <= 4) return "Storm-Oak Woods";
  if (x >= 9 && y <= 4) return "Basilisk Badlands";
  if (x >= 9 && y >= 6) return "Moon-Silver Range";
  if (x <= 3 && y >= 6) return "Low Mire";
  if (x >= 6 && y >= 7) return "Ember Hills";
  if (Math.abs(y - 4) <= 1) return "Pilgrim Road";
  return TERRAIN_DETAILS[terrain]?.[0] || "Sigmacraft Wilds";
}
function dangerFor(x, y, terrain) {
  const edge = x === 0 || y === 0 || x === WORLD_MAP_WIDTH - 1 || y === WORLD_MAP_HEIGHT - 1 ? 1 : 0;
  const base = { badlands: 4, mire: 3, mine: 3, ruins: 3, ridge: 2, forest: 2, woods: 2, hills: 2, road: 1, shrine: 1, forge: 1, village: 1, meadow: 1, river: 1 }[terrain] || 1;
  return Math.max(1, Math.min(5, base + edge));
}
function tileName(x, y, terrain) {
  const [terrainName] = TERRAIN_DETAILS[terrain] || ["Wilds"];
  const prefix = ["North", "East", "South", "West", "Old", "High", "Low"][(x * 3 + y) % 7];
  return `${prefix} ${terrainName} ${x + 1}-${y + 1}`;
}
function createTile(x, y) {
  const landmark = LANDMARKS[coordKey(x, y)];
  const terrain = landmark?.terrain || terrainFor(x, y);
  const detail = TERRAIN_DETAILS[terrain] || ["Wilds", "Unsettled Sigmacraft country."];
  const id = tileIdAt(x, y);
  const exits = [
    y > 0 ? tileIdAt(x, y - 1) : null,
    x < WORLD_MAP_WIDTH - 1 ? tileIdAt(x + 1, y) : null,
    y < WORLD_MAP_HEIGHT - 1 ? tileIdAt(x, y + 1) : null,
    x > 0 ? tileIdAt(x - 1, y) : null,
  ].filter(Boolean);
  const tile = {
    id,
    x,
    y,
    name: landmark?.name || tileName(x, y, terrain),
    description: landmark?.description || detail[1],
    terrain,
    type: tileType(terrain, id),
    region: landmark?.region || regionFor(x, y, terrain),
    danger: landmark?.danger || dangerFor(x, y, terrain),
    exits,
  };
  if (LANDMARK_ZONE[id]) tile.zoneId = LANDMARK_ZONE[id];
  return tile;
}

// Static, deterministic tile graph. `seed` is accepted for interface symmetry;
// the map design is fixed (landmarks at fixed coords), so output is identical.
export function generateOverworld(seed = SIGMACRAFT_REALM_ID) {
  const tiles = {};
  for (let y = 0; y < WORLD_MAP_HEIGHT; y += 1) {
    for (let x = 0; x < WORLD_MAP_WIDTH; x += 1) {
      const tile = createTile(x, y);
      tiles[tile.id] = tile;
    }
  }
  return JSON.parse(JSON.stringify({ width: WORLD_MAP_WIDTH, height: WORLD_MAP_HEIGHT, townTileId: "millbridge", tiles, seed: String(seed) }));
}

function npcDisplayName(globalIndex, archetypeKey, seed) {
  const prefix = choose(NAME_PREFIXES, `${seed}:${archetypeKey}:prefix:${globalIndex}`);
  const suffix = choose(NAME_SUFFIXES, `${seed}:${archetypeKey}:suffix:${globalIndex}`);
  return `${prefix}${suffix}`;
}
function npcTileId(globalIndex, archetype, tiles, seed) {
  const all = Object.values(tiles);
  const candidates = all.filter((t) => {
    if (archetype.key === "bandit") return t.danger >= 3;
    if (archetype.key === "crafter") return ["forge", "mine", "forest", "village"].includes(t.terrain);
    if (archetype.key === "merchant") return ["village", "road", "river", "forge"].includes(t.terrain);
    if (archetype.key === "guard") return ["village", "road", "shrine", "forge"].includes(t.terrain);
    if (archetype.key === "mystic") return ["shrine", "ruins", "woods", "mire"].includes(t.terrain);
    return true;
  });
  return choose(candidates.length ? candidates : all, `${seed}:${archetype.key}:place:${globalIndex}`).id;
}
function createNpcAgent(archetype, index, globalIndex, tiles, seed) {
  const id = `npc_${archetype.key}_${String(index).padStart(3, "0")}`;
  const name = npcDisplayName(globalIndex, archetype.key, seed);
  const faction = choose(archetype.factions, `${seed}:${id}:faction`);
  const persona = choose(archetype.personas, `${seed}:${id}:persona`);
  const goals = [choose(archetype.goals, `${seed}:${id}:goal:0`), choose(archetype.goals, `${seed}:${id}:goal:1:${globalIndex}`)];
  return {
    id,
    name,
    archetype: archetype.key,
    archetypeLabel: archetype.label,
    faction,
    persona,
    tileId: npcTileId(globalIndex, archetype, tiles, seed),
    moodValue: 50,
    supplies: 0, // gathered-material tally; gather++ / craft-- (bounded NPC_SUPPLY_CAP)
    plannerCadenceTicks: 4 + (globalIndex % 8),
    goals,
    memory: {
      goals: goals.map((text, i) => ({ text, urgency: i === 0 ? "medium" : "low" })),
      relationships: [],
      recentIncidents: [],
      summaryPointer: `${id}#rolling`,
    },
  };
}

// The 200-agent population, distributed across the tile map. Deterministic.
export function generatePopulation(seed = SIGMACRAFT_REALM_ID, tiles) {
  const npcs = {};
  let globalIndex = 0;
  for (const archetype of NPC_ARCHETYPES) {
    for (let index = 0; index < archetype.count; index += 1) {
      const npc = createNpcAgent(archetype, index, globalIndex, tiles, String(seed));
      npcs[npc.id] = npc;
      globalIndex += 1;
    }
  }
  return JSON.parse(JSON.stringify(npcs));
}

// Lightweight fresh shell — the heavy map/population are seeded separately so
// generation stays out of the snapshot hot path.
export function createSigmacraftState() {
  return {
    schema: SIGMACRAFT_SCHEMA,
    realmId: SIGMACRAFT_REALM_ID,
    tick: 0,
    pendingIntents: [],
    recentEvents: [],
    actorPlaces: {},
    objective: { ...DEFAULT_SIGMACRAFT_OBJECTIVE },
    vcsAccounts: {},
    npcAgents: {},
    npcCursor: 0,
    npcConsumeCursor: 0,
    map: null,
    overworldNpcs: {},
    // Director / game-master lane (PR9): validated proposals waiting for the tick
    // + compact game-master status. Ambient/regenerable — never persisted.
    directorQueue: [],
    gameMaster: { status: "idle", lastBeatTick: 0, lastBeatKind: null, beats: 0 },
  };
}

// Idempotent seed/heal: generate the overworld map + population only when absent.
// Doubles as the migration for pre-overworld worlds.
export function seedSigmacraftOverworld(sigmacraft, seed = SIGMACRAFT_REALM_ID) {
  if (!sigmacraft) return sigmacraft;
  if (!sigmacraft.map || !sigmacraft.map.tiles) sigmacraft.map = generateOverworld(String(seed));
  if (!sigmacraft.overworldNpcs || !Object.keys(sigmacraft.overworldNpcs).length) {
    sigmacraft.overworldNpcs = generatePopulation(String(seed), sigmacraft.map.tiles);
  }
  return sigmacraft;
}

// ── Projection ───────────────────────────────────────────────────────────────
// The tile an actor is standing in. Explicit token wins, then character, then town.
export function sigmacraftActorTileId(sigmacraft, character, token = null) {
  const key = token || character?.token || character?.id || null;
  const tracked = key ? sigmacraft?.actorPlaces?.[key] : null;
  return tracked || sigmacraft?.map?.townTileId || "millbridge";
}
// Back-compat alias (VCS/welcome still call this; it just needs a stable string).
export const sigmacraftActorZoneId = sigmacraftActorTileId;

function npcCountsByTile(overworldNpcs) {
  const counts = {};
  for (const npc of Object.values(overworldNpcs || {})) {
    if (npc?.tileId) counts[npc.tileId] = (counts[npc.tileId] || 0) + 1;
  }
  return counts;
}

// Windowed map read model: the current tile + its Chebyshev-radius neighborhood,
// bounded by MAX_WORLDMAP_CELLS, with live npcCount + reachability flags.
function projectWorldMap(sigmacraft, currentTileId, reachable) {
  const map = sigmacraft?.map;
  if (!map?.tiles) return { width: 0, height: 0, cells: [] };
  const counts = npcCountsByTile(sigmacraft.overworldNpcs);
  const cur = map.tiles[currentTileId];
  const cx = cur?.x ?? 0;
  const cy = cur?.y ?? 0;
  const cells = [];
  for (const tile of Object.values(map.tiles)) {
    if (Math.max(Math.abs(tile.x - cx), Math.abs(tile.y - cy)) > WORLD_MAP_WINDOW) continue;
    cells.push({
      id: tile.id,
      x: tile.x,
      y: tile.y,
      name: tile.name,
      type: tile.type,
      danger: tile.danger,
      npcCount: counts[tile.id] || 0,
      current: tile.id === currentTileId,
      exit: reachable.has(tile.id),
    });
    if (cells.length >= MAX_WORLDMAP_CELLS) break;
  }
  cells.sort((a, b) => a.y - b.y || a.x - b.x);
  return { width: map.width, height: map.height, window: WORLD_MAP_WINDOW, cells };
}

// Overworld NPCs + other player/agent actors standing in the current tile.
function projectOccupants(sigmacraft, currentTileId, selfToken) {
  const out = [];
  for (const npc of Object.values(sigmacraft?.overworldNpcs || {})) {
    if (npc.tileId !== currentTileId) continue;
    const plan = sigmacraft?.npcAgents?.[npc.id]?.plan || null;
    const objective = plan?.agenda && Array.isArray(plan.agenda) ? plan.agenda[plan.cursor || 0] : null;
    out.push({
      id: npc.id,
      kind: "npc",
      name: npc.name,
      archetype: npc.archetypeLabel || npc.archetype || null,
      faction: npc.faction || null,
      goal: plan?.goal || null, // strategic intent
      doing: objective?.kind || null, // current tactical action (the cascade)
      lastLine: plan?.dialogueLine || null,
      supplies: npc.supplies ?? 0,
      mood: npc.moodValue ?? 50,
    });
    if (out.length >= 16) break;
  }
  for (const [tok, tid] of Object.entries(sigmacraft?.actorPlaces || {})) {
    if (tid !== currentTileId || tok === selfToken) continue;
    out.push({ id: tok.slice(-4), kind: "player", name: `Wanderer ${tok.slice(-4)}` });
    if (out.length >= 24) break;
  }
  return out;
}

// Valid actions from the current tile: one move per exit + rest + talk (if locals).
export function sigmacraftValidActions(sigmacraft, currentTileId) {
  const tiles = sigmacraft?.map?.tiles || {};
  const here = tiles[currentTileId];
  const actions = [];
  for (const exitId of here?.exits || []) {
    const t = tiles[exitId];
    if (t) actions.push({ kind: "move", targetId: t.id, label: `Travel to ${t.name}` });
  }
  actions.push({ kind: "rest", label: "Rest" });
  const localNpc = Object.values(sigmacraft?.overworldNpcs || {}).some((n) => n.tileId === currentTileId);
  if (localNpc) actions.push({ kind: "talk", label: "Talk with the locals" });
  return actions.slice(0, 24);
}

// Cheap read model. Pure projection; `character` may be null.
export function projectSigmacraftSnapshot(world, character = null, opts = {}) {
  const sigmacraft = world?.sigmacraft || createSigmacraftState();
  const token = opts.token || character?.token || character?.id || null;
  const currentTileId = sigmacraftActorTileId(sigmacraft, character, token);
  const tiles = sigmacraft?.map?.tiles || {};
  const tile = tiles[currentTileId] || tiles[sigmacraft?.map?.townTileId] || null;
  const reachable = new Set((tile?.exits || []).filter((id) => tiles[id]));
  const pending = Array.isArray(sigmacraft.pendingIntents)
    ? sigmacraft.pendingIntents.find((intent) => intent.token === token) || null
    : null;
  const place = tile
    ? {
        id: tile.id,
        name: tile.name,
        type: tile.type,
        danger: tile.danger,
        region: tile.region,
        flavor: tile.description,
        safe: tile.danger <= 1 || tile.type === "town",
        zoneId: tile.zoneId || null,
      }
    : null;
  return {
    schema: "sigmacraft.snapshot.v2",
    realmId: sigmacraft.realmId || SIGMACRAFT_REALM_ID,
    worldTick: sigmacraft.tick || 0,
    actorId: token,
    place,
    worldMap: projectWorldMap(sigmacraft, currentTileId, reachable),
    occupants: projectOccupants(sigmacraft, currentTileId, token),
    objective: sigmacraft.objective || null,
    gameMaster: sigmacraft.gameMaster || null,
    validActions: sigmacraftValidActions(sigmacraft, currentTileId),
    pendingIntent: pending ? { kind: pending.kind, targetId: pending.targetId || null } : null,
    recentEvents: (sigmacraft.recentEvents || []).slice(-8),
  };
}
