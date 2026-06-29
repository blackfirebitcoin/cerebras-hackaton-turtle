#!/usr/bin/env node
// PR8 read-only operator/agent tool — Sigmacraft OVERWORLD edition.
//
// Prints a Sigmacraft snapshot derived from the persisted world.json using the
// SAME shared projection the server/SSE path uses (projectSigmacraftSnapshot over
// the 140-tile overworld map + overworldNpcs population), so the CLI can never
// drift from the live shape. Server-less: it reads the file directly, so an
// operator can inspect a paused or crashed world without booting the runtime.
//
// Pure read: it never mutates state, never calls Gemma, and never touches the
// tick path. (It will heal an absent map/population IN MEMORY ONLY via
// seedSigmacraftOverworld so a pre-overworld world.json is still inspectable; the
// file is never written back.)
//
// Scope note: the map + population ROSTER are persisted, so they always show here.
// NPC PLANS (the off-tick planner's output) are ambient/in-memory only and are
// NOT persisted (idle-quiescence guard), so the planner/latestPlans sections read
// from whatever the file happens to hold — usually empty for a live-flushed world.
// For live NPC dynamics, hit the running server's GET /api/sigmacraft/snapshot
// (exposed as `sigmashake-mmo sigmacraft` / the mmo_sigmacraft MCP tool).
//
// Usage:
//   node tools/sigmacraft-snapshot.js [world|map|npc <idOrName>|snapshot] [flags]
//   MMO_DATA_DIR=.tmp/dev-data node tools/sigmacraft-snapshot.js world
//
// Subcommands:
//   world     (default) world-level summary: realm, tick, population, tile-type
//             distribution, planner health (plans pending/consumed), recent events,
//             a sample of the latest NPC plans. --json for the machine shape.
//   map       the static tile graph: dimensions, town, type counts, busiest tiles.
//             --type <t> filters the listing; --tile <id> shows one tile in full.
//   npc <x>   one NPC's identity + latest plan, matched by id or (case-insensitive)
//             name substring, read from overworldNpcs + npcAgents.
//   snapshot  the per-observer projection (place, windowed worldMap, occupants,
//             validActions, recentEvents). --token <t> views as that actor; with
//             no token it stands the observer in the town tile.
//
// Flags: --data-dir <dir>  --json  --token <t>  --type <t>  --tile <id>  --limit <n>

import { readFile } from "node:fs/promises";
import path from "node:path";

import { projectSigmacraftSnapshot, seedSigmacraftOverworld } from "../shared/sigmacraft.js";

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function dataDir() {
  return arg("--data-dir") || process.env.MMO_DATA_DIR || path.join(process.cwd(), "data");
}
const wantsJson = () => process.argv.includes("--json");
const limit = () => Math.max(1, Number(arg("--limit")) || 8);

async function loadSigmacraft(dir) {
  const file = path.join(dir, "world.json");
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`could not read ${file} (set --data-dir or MMO_DATA_DIR)`);
  }
  const parsed = JSON.parse(raw);
  const sigmacraft = parsed.sigmacraft;
  if (!sigmacraft || typeof sigmacraft !== "object") {
    throw new Error(`no sigmacraft world state found in ${file}`);
  }
  // Heal map/population IN MEMORY ONLY so a pre-overworld file is still inspectable.
  seedSigmacraftOverworld(sigmacraft, sigmacraft.realmId || "sigmacraft_alpha");
  return { world: parsed, sigmacraft };
}

function tileTypeCounts(map) {
  const counts = {};
  for (const tile of Object.values(map?.tiles || {})) {
    counts[tile.type] = (counts[tile.type] || 0) + 1;
  }
  return counts;
}
function npcCountsByTile(overworldNpcs) {
  const counts = {};
  for (const npc of Object.values(overworldNpcs || {})) {
    if (npc?.tileId) counts[npc.tileId] = (counts[npc.tileId] || 0) + 1;
  }
  return counts;
}
function plannerHealth(npcAgents) {
  const agents = Object.values(npcAgents || {});
  let withPlan = 0;
  let pending = 0;
  let consumed = 0;
  const sources = {};
  for (const a of agents) {
    if (!a?.plan) continue;
    withPlan += 1;
    if (a.plan.consumed) consumed += 1;
    else pending += 1;
    const s = a.plan.source || "?";
    sources[s] = (sources[s] || 0) + 1;
  }
  return { tracked: agents.length, withPlan, pending, consumed, sources };
}
function latestPlans(sigmacraft, n) {
  return Object.entries(sigmacraft.npcAgents || {})
    .filter(([, a]) => a?.plan)
    .sort((a, b) => (b[1].plan.plannedAtTick || 0) - (a[1].plan.plannedAtTick || 0))
    .slice(0, n)
    .map(([id, a]) => ({
      id,
      name: sigmacraft.overworldNpcs?.[id]?.name || id,
      currentGoal: a.plan.currentGoal || null,
      dialogueLine: a.plan.dialogueLine || null,
      step: a.plan.step || null,
      source: a.plan.source || null,
      consumed: !!a.plan.consumed,
      plannedAtTick: a.plan.plannedAtTick ?? null,
    }));
}

function worldSummary(world, sigmacraft) {
  const map = sigmacraft.map;
  const types = tileTypeCounts(map);
  return {
    realmId: sigmacraft.realmId,
    worldTick: sigmacraft.tick || 0,
    objective: sigmacraft.objective
      ? { questId: sigmacraft.objective.questId, title: sigmacraft.objective.title }
      : null,
    map: {
      width: map?.width || null,
      height: map?.height || null,
      townTileId: map?.townTileId || null,
      tileCount: Object.keys(map?.tiles || {}).length,
      typeCounts: types,
    },
    population: { totalNpcs: Object.keys(sigmacraft.overworldNpcs || {}).length },
    planner: plannerHealth(sigmacraft.npcAgents),
    latestNpcPlans: latestPlans(sigmacraft, 5),
    recentEvents: (sigmacraft.recentEvents || []).slice(-8).map((e) => ({ tick: e.tick, text: e.text })),
  };
}

function printWorld(world, sigmacraft) {
  const s = worldSummary(world, sigmacraft);
  if (wantsJson()) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const lines = [];
  lines.push(`Realm ${s.realmId} — world tick ${s.worldTick}`);
  if (s.objective) lines.push(`Objective: ${s.objective.title}`);
  lines.push(
    `Map: ${s.map.tileCount} tiles (${s.map.width}x${s.map.height}), town=${s.map.townTileId}`,
  );
  const types = Object.entries(s.map.typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}:${c}`)
    .join(" ");
  lines.push(`  types: ${types}`);
  lines.push(`Population: ${s.population.totalNpcs} NPCs`);
  const src = Object.entries(s.planner.sources)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  lines.push(
    `Planner: ${s.planner.withPlan}/${s.planner.tracked} have plans • ` +
      `${s.planner.pending} pending • ${s.planner.consumed} consumed${src ? ` • ${src}` : ""}`,
  );
  lines.push("Latest plans:");
  for (const p of s.latestNpcPlans) {
    lines.push(`  ${p.name} (${p.source || "?"}${p.consumed ? ", consumed" : ""}): ${p.currentGoal || "—"}`);
  }
  lines.push("Recent events:");
  for (const e of s.recentEvents.slice(-5)) lines.push(`  [t${e.tick}] ${e.text}`);
  console.log(lines.join("\n"));
}

function printMap(sigmacraft) {
  const map = sigmacraft.map;
  const tiles = map?.tiles || {};
  const counts = npcCountsByTile(sigmacraft.overworldNpcs);
  const one = arg("--tile");
  if (one) {
    const tile = tiles[one];
    if (!tile) {
      console.error(`no tile "${one}"`);
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        {
          id: tile.id,
          name: tile.name,
          type: tile.type,
          danger: tile.danger,
          region: tile.region,
          x: tile.x,
          y: tile.y,
          npcCount: counts[tile.id] || 0,
          exits: (tile.exits || []).map((id) => ({ id, name: tiles[id]?.name || id, type: tiles[id]?.type })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const typeFilter = arg("--type");
  let list = Object.values(tiles);
  if (typeFilter) list = list.filter((t) => t.type === typeFilter);
  if (wantsJson()) {
    console.log(
      JSON.stringify(
        {
          width: map.width,
          height: map.height,
          townTileId: map.townTileId,
          tileCount: Object.keys(tiles).length,
          typeCounts: tileTypeCounts(map),
          tiles: list.map((t) => ({ id: t.id, type: t.type, npcCount: counts[t.id] || 0, exits: t.exits })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const lines = [];
  lines.push(`Map ${map.width}x${map.height} — ${Object.keys(tiles).length} tiles, town=${map.townTileId}`);
  lines.push(
    `Types: ${Object.entries(tileTypeCounts(map))
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}:${c}`)
      .join(" ")}`,
  );
  const busiest = list
    .map((t) => ({ ...t, npcCount: counts[t.id] || 0 }))
    .sort((a, b) => b.npcCount - a.npcCount)
    .slice(0, limit());
  lines.push(typeFilter ? `Tiles (type=${typeFilter}, top ${limit()} by population):` : `Busiest tiles (top ${limit()}):`);
  for (const t of busiest) {
    lines.push(`  ${t.id} [${t.type}] pop ${t.npcCount} • exits: ${(t.exits || []).join(", ") || "—"}`);
  }
  console.log(lines.join("\n"));
}

function findNpc(sigmacraft, query) {
  const npcs = Object.values(sigmacraft.overworldNpcs || {});
  const q = String(query || "").toLowerCase();
  return (
    npcs.find((npc) => npc.id === query) ||
    npcs.find((npc) => String(npc.name || "").toLowerCase() === q) ||
    npcs.find((npc) => String(npc.name || "").toLowerCase().includes(q))
  );
}
function printNpc(sigmacraft, query) {
  if (!query) {
    console.error("`npc` needs an <idOrName> argument");
    process.exitCode = 1;
    return;
  }
  const npc = findNpc(sigmacraft, query);
  if (!npc) {
    console.error(`no NPC matched "${query}"`);
    process.exitCode = 1;
    return;
  }
  const agent = sigmacraft.npcAgents?.[npc.id];
  const tile = sigmacraft.map?.tiles?.[npc.tileId];
  console.log(
    JSON.stringify(
      {
        id: npc.id,
        name: npc.name,
        archetype: npc.archetypeLabel || npc.archetype || "unknown",
        faction: npc.faction || "",
        persona: npc.persona || "",
        mood: npc.moodValue ?? null,
        place: tile ? { id: tile.id, name: tile.name, type: tile.type } : { id: npc.tileId },
        goals: npc.goals || [],
        plan: agent?.plan
          ? {
              currentGoal: agent.plan.currentGoal,
              dialogueLine: agent.plan.dialogueLine,
              step: agent.plan.step,
              source: agent.plan.source,
              consumed: !!agent.plan.consumed,
              plannedAtTick: agent.plan.plannedAtTick ?? null,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

function printSnapshot(world, sigmacraft) {
  const token = arg("--token") || null;
  const snapshot = projectSigmacraftSnapshot(world, null, { token });
  console.log(JSON.stringify(snapshot, null, 2));
}

async function main() {
  const dir = dataDir();
  const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "world";
  const { world, sigmacraft } = await loadSigmacraft(dir);

  switch (command) {
    case "world":
      printWorld(world, sigmacraft);
      return;
    case "map":
      printMap(sigmacraft);
      return;
    case "npc":
      printNpc(sigmacraft, process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : arg("--name"));
      return;
    case "snapshot":
      printSnapshot(world, sigmacraft);
      return;
    default:
      console.error(`unknown command "${command}" (use: world | map | npc <idOrName> | snapshot)`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
