// Playtest party-run orchestration. This is intentionally request-driven: the
// player clicks "begin party finding", then the server builds a demo party,
// walks it to a dungeon, and resolves bounded combat waves. It never runs from
// the 3s world tick and never gives NPC/Director agents authority over player
// loot, XP, death, or economy.

import { INVENTORY_MAX } from "../shared/constants.js";
import { resolvePartyEncounter } from "../shared/party-combat.js";
import {
  MAX_SIGMACRAFT_RECENT_EVENTS,
  PARTY_MAX_MEMBERS,
  nextHopToward,
  stableIndex,
} from "../shared/sigmacraft.js";
import { buildPartyCombatants, ensureDemoRun } from "./party-build.js";
import { buildDungeonEnemies, rollPartyLoot } from "./party-dungeon.js";
import { DELVE_COOLDOWN_TICKS } from "./party-delve.js";
import { DEMO_PARTY_DEADLINE_MS, demoThroughputStatus } from "./sigmacraft-demo-throughput.js";

const JOIN_BASE = Object.freeze({
  adventurer: 76,
  guard: 70,
  scout: 68,
  mystic: 64,
  crafter: 56,
  merchant: 48,
  bandit: 42,
});

const JOIN_LINES = Object.freeze({
  adventurer: ["wants a clean story to tell at the next tavern table", "smiles at the danger rating"],
  guard: ["checks the road signs, then nods", "joins because the route needs a shield"],
  scout: ["already knows half the trail", "likes that the party has a clear destination"],
  mystic: ["heard the dungeon muttering in a dream", "says the omen points that way"],
  crafter: ["wants first pick of useful salvage", "packs tools in case old locks need persuading"],
  merchant: ["calculates the risk, then hires themselves as quartermaster", "joins once the escort looks real"],
  bandit: ["claims this is community service", "likes the odds better with witnesses"],
});

function seedOf(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function appendEvent(s, text) {
  if (!s) return;
  if (!Array.isArray(s.recentEvents)) s.recentEvents = [];
  s.recentEvents.push({ tick: s.tick || 0, text });
  const overflow = s.recentEvents.length - MAX_SIGMACRAFT_RECENT_EVENTS;
  if (overflow > 0) s.recentEvents.splice(0, overflow);
}

function tileView(tile) {
  return tile
    ? {
        id: tile.id,
        name: tile.name,
        type: tile.type,
        terrain: tile.terrain || null,
        danger: tile.danger,
        region: tile.region,
        description: tile.description,
      }
    : null;
}

function releaseExistingParty(s, token) {
  for (const npc of Object.values(s.overworldNpcs || {})) {
    if (npc.partyLock === token) npc.partyLock = null;
  }
  if (s.parties) delete s.parties[token];
}

function pickDemoDungeon(s, token) {
  const tiles = s?.map?.tiles || {};
  s.delveCooldowns = s.delveCooldowns || {};
  const cooldowns = s.delveCooldowns[token] || {};
  const nowTick = s.tick || 0;
  const choices = Object.values(tiles)
    .filter((t) => t.type === "dungeon")
    .filter((t) => !Number.isFinite(cooldowns[t.id]) || nowTick - cooldowns[t.id] >= DELVE_COOLDOWN_TICKS)
    .sort((a, b) => (b.danger || 0) - (a.danger || 0) || a.name.localeCompare(b.name));
  return choices.find((t) => t.id === "basilisk_badlands") || choices[0] || null;
}

function travelPath(s, startId, targetId) {
  const tiles = s?.map?.tiles || {};
  const path = [];
  let here = startId;
  for (let guard = 0; guard < 64 && tiles[here]; guard += 1) {
    path.push(tileView(tiles[here]));
    if (here === targetId) break;
    const next = nextHopToward(here, targetId, tiles);
    if (!next || next === here) break;
    here = next;
  }
  return path;
}

function joinReason(npc, target, seed) {
  const lines = JOIN_LINES[npc.archetype] || JOIN_LINES.adventurer;
  return lines[stableIndex(`${npc.id}:${target.id}:${seed}:line`, lines.length)];
}

function joinDecision(npc, startTile, target, seed, rank) {
  const base = JOIN_BASE[npc.archetype] ?? 52;
  const local = npc.tileId === startTile.id ? 10 : 0;
  const mood = Math.round(((npc.moodValue ?? 50) - 50) / 4);
  const danger = Math.max(0, (target.danger || 1) - 2) * 3;
  const hesitation = stableIndex(`${npc.id}:${target.id}:${seed}:hesitation`, 45);
  const score = base + local + mood + danger - hesitation - Math.min(10, Math.floor(rank / 6));
  return {
    npcId: npc.id,
    name: npc.name,
    archetype: npc.archetype,
    faction: npc.faction || null,
    persona: npc.persona || null,
    accepted: score >= 52,
    score,
    reason: joinReason(npc, target, seed),
  };
}

function buildPartyByInvitation(s, token, startTile, target, seed) {
  const candidates = Object.values(s.overworldNpcs || {})
    .filter((npc) => npc && (!npc.partyLock || npc.partyLock === token))
    .sort((a, b) => {
      const localA = a.tileId === startTile.id ? 1 : 0;
      const localB = b.tileId === startTile.id ? 1 : 0;
      const baseA = JOIN_BASE[a.archetype] ?? 52;
      const baseB = JOIN_BASE[b.archetype] ?? 52;
      return localB - localA || baseB - baseA || a.id.localeCompare(b.id);
    });
  const decisions = [];
  const accepted = [];
  for (let i = 0; i < candidates.length && decisions.length < 24; i += 1) {
    const npc = candidates[i];
    const decision = joinDecision(npc, startTile, target, seed, i);
    decisions.push(decision);
    if (decision.accepted && accepted.length < PARTY_MAX_MEMBERS) accepted.push(decision);
    if (accepted.length >= PARTY_MAX_MEMBERS && decisions.length >= 8) break;
  }

  // A demo slice needs a full party. If the first wave of volunteers is too
  // cautious, the strongest may still opt in after seeing the roster form.
  if (accepted.length < PARTY_MAX_MEMBERS) {
    for (const decision of decisions.slice().sort((a, b) => b.score - a.score)) {
      if (accepted.length >= PARTY_MAX_MEMBERS) break;
      if (accepted.some((d) => d.npcId === decision.npcId)) continue;
      decision.accepted = true;
      decision.reason = "joins once the table has enough brave faces";
      accepted.push(decision);
    }
  }

  const party = {
    leaderToken: token,
    status: "forming",
    targetTileId: target.id,
    createdTick: s.tick || 0,
    demo: true,
    members: [],
  };
  for (const decision of accepted.slice(0, PARTY_MAX_MEMBERS)) {
    const npc = s.overworldNpcs[decision.npcId];
    if (!npc) continue;
    npc.partyLock = token;
    npc.tileId = startTile.id;
    party.members.push({
      npcId: npc.id,
      name: npc.name,
      archetype: npc.archetype,
      faction: npc.faction || null,
      persona: npc.persona || null,
    });
  }
  s.parties[token] = party;
  return { party, joinDecisions: decisions };
}

function splitWaves(enemies) {
  const normals = enemies.filter((e) => !e.isBoss);
  const bosses = enemies.filter((e) => e.isBoss);
  const waves = [];
  if (bosses.length) {
    waves.push(normals.slice(0, 2));
    waves.push(normals.slice(2, 4));
    waves.push([...normals.slice(4), ...bosses]);
  } else {
    const size = Math.max(1, Math.ceil(normals.length / 2));
    for (let i = 0; i < normals.length; i += size) waves.push(normals.slice(i, i + size));
  }
  return waves.filter((wave) => wave.length);
}

function decoratedEnemies(states, builtById) {
  return (states || []).map((state) => {
    const built = builtById.get(state.id) || {};
    return {
      ...state,
      isBoss: !!built.isBoss,
      bossId: built.bossId || null,
      baseEnemyId: built.baseEnemyId || null,
      lpc: built.lpc || null,
      maxHp: built.sheet?.maxHp || null,
    };
  });
}

function partyView(states, byId) {
  return (states || []).map((state) => {
    const src = byId.get(state.id) || {};
    const maxHp = src.sheet?.maxHp || state.maxHp || null;
    return {
      id: state.id,
      name: state.name,
      isPlayer: !!state.isPlayer,
      hp: Math.max(0, Math.round(state.hp || 0)),
      maxHp,
      alive: state.alive !== false && (state.hp || 0) > 0,
      fled: !!state.fled,
      kills: state.kills || 0,
    };
  });
}

function enemyStartView(states) {
  return (states || []).map((e) => ({
    id: e.id,
    name: e.name,
    hp: Math.max(0, Math.round(e.hp ?? e.sheet?.maxHp ?? 1)),
    maxHp: e.sheet?.maxHp || e.maxHp || null,
    alive: (e.hp ?? e.sheet?.maxHp ?? 1) > 0,
    isBoss: !!e.isBoss,
    bossId: e.bossId || null,
    baseEnemyId: e.baseEnemyId || null,
    lpc: e.lpc || null,
  }));
}

function resolveWaveRun({ combatants, waves, seed }) {
  const builtById = new Map(waves.flat().map((e) => [e.id, e]));
  const partyLedger = new Map(
    combatants.map((c) => [
      c.id,
      { id: c.id, name: c.name, isPlayer: !!c.isPlayer, hp: c.hp, alive: c.hp > 0, fled: false, kills: 0, sheet: c.sheet },
    ]),
  );
  let currentParty = combatants.map((c) => ({ ...c }));
  const waveResults = [];
  const allKills = [];
  const allEnemies = [];
  const allLog = [];
  let rounds = 0;
  let outcome = "victory";

  for (let i = 0; i < waves.length; i += 1) {
    const wave = waves[i];
    const hasBoss = wave.some((e) => e.isBoss);
    if (hasBoss) {
      currentParty = currentParty.map((c) => ({ ...c, hp: Math.max(c.hp || 1, Math.ceil(c.sheet.maxHp * 0.7)) }));
    }
    const partyById = new Map(currentParty.map((c) => [c.id, c]));
    const startParty = partyView(
      currentParty.map((c) => ({ ...c, alive: c.hp > 0, fled: !!c.fled, kills: c.kills || 0 })),
      partyById,
    );
    const startEnemies = enemyStartView(wave);
    const result = resolvePartyEncounter({
      party: currentParty,
      enemies: wave.map((e) => ({ ...e })),
      seed: (seed + i * 7919) >>> 0,
      maxRounds: hasBoss ? 64 : 36,
    });
    rounds += result.rounds;
    for (const p of result.party || []) {
      const ledger = partyLedger.get(p.id);
      if (!ledger) continue;
      ledger.hp = Math.round(p.hp);
      ledger.alive = !!p.alive;
      ledger.fled = !!p.fled;
      ledger.kills += p.kills || 0;
    }
    const enemies = decoratedEnemies(result.enemies, builtById);
    waveResults.push({
      wave: i + 1,
      title: hasBoss ? "Boss Wave" : `Wave ${i + 1}`,
      outcome: result.outcome,
      rounds: result.rounds,
      boss: hasBoss,
      startParty,
      startEnemies,
      party: partyView(result.party, partyById),
      enemies,
      log: result.log.map((e) => ({ ...e, wave: i + 1 })),
    });
    allKills.push(...result.kills);
    allEnemies.push(...enemies);
    allLog.push(...result.log.map((e) => ({ ...e, wave: i + 1 })));
    if (result.outcome !== "victory") {
      outcome = result.outcome;
      break;
    }

    currentParty = currentParty
      .map((c) => {
        const state = partyLedger.get(c.id);
        if (!state?.alive || state.fled) return null;
        const recovery = i < waves.length - 1 ? Math.ceil(c.sheet.maxHp * 0.28) : 0;
        const hp = Math.min(c.sheet.maxHp, Math.max(1, state.hp + recovery));
        state.hp = hp;
        return { ...c, hp };
      })
      .filter(Boolean);
    if (!currentParty.length && i < waves.length - 1) {
      outcome = "defeat";
      break;
    }
  }

  const party = [...partyLedger.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isPlayer: p.isPlayer,
    hp: Math.max(0, p.hp),
    maxHp: p.sheet?.maxHp || null,
    alive: !!p.alive,
    fled: !!p.fled,
    kills: p.kills || 0,
  }));
  const bossDead = allEnemies.some((e) => e.isBoss && !e.alive);
  return { outcome, rounds, party, enemies: allEnemies, kills: allKills, log: allLog, waves: waveResults, bossDead };
}

function carryPlayerResult(character, result) {
  const playerResult = result.party.find((p) => p.isPlayer);
  if (!character?.run || !playerResult) return;
  character.run.hp = playerResult.alive ? Math.max(1, Math.round(playerResult.hp)) : 0;
  if (!playerResult.alive) character.run.alive = false;
}

function keepPlayerLoot(character, combatants, loot) {
  const playerId = combatants.find((c) => c.isPlayer)?.id;
  return keepPlayerLootForId(character, playerId, loot);
}

function keepPlayerLootForId(character, playerId, loot) {
  const inv = character?.run?.inventory;
  let kept = 0;
  if (!Array.isArray(inv)) return kept;
  for (const d of loot.drops || []) {
    if (d.memberId === playerId && inv.length < INVENTORY_MAX) {
      inv.push(d.item);
      kept += 1;
    }
  }
  return kept;
}

function hardenDemoLeader(combatants) {
  return combatants.map((c) => {
    if (!c.isPlayer) return c;
    const sheet = {
      ...c.sheet,
      defense: (c.sheet.defense || 0) + 80,
      dodge: Math.max(c.sheet.dodge || 0, 0.35),
    };
    return { ...c, sheet, hp: Math.max(c.hp || 1, sheet.maxHp) };
  });
}

function joinDialogue(decision, target, seed) {
  const lines = {
    adventurer: [`I'm in. ${target.name} sounds like a song waiting to happen.`, "Keep a place by the door. I will bring steel."],
    guard: ["If this road needs a shield, I will stand there.", `I know the route to ${target.region}. Stay behind me.`],
    scout: ["I can guide us there without losing daylight.", "I saw fresh tracks. We should move before they cool."],
    mystic: ["The omen bends toward that place. I will come.", "I heard the old stones whisper your name."],
    crafter: ["If there is salvage in there, I want to see it first.", "I packed tools. Old doors hate me."],
    merchant: ["Fine. I will count supplies and danger both.", "A terrible idea, which means the margin may be excellent."],
    bandit: ["Call it charity. I will watch the shadows.", "I know ambush country. Better I am with you than ahead of you."],
  };
  const list = lines[decision.archetype] || lines.adventurer;
  return list[stableIndex(`${decision.npcId}:${target.id}:${seed}:dialogue`, list.length)];
}

function declineDialogue(decision, target, seed) {
  const lines = [
    `Not ${target.name}. Not today.`,
    "I have a debt, a bad knee, and no desire to meet a boss.",
    "Ask me again when the road is less hungry.",
  ];
  return lines[stableIndex(`${decision.npcId}:${target.id}:${seed}:decline`, lines.length)];
}

function publicLoot(loot) {
  return (loot?.drops || []).map((d) => ({
    to: d.memberName,
    memberId: d.memberId,
    isPlayer: d.isPlayer,
    fromBoss: d.fromBoss,
    item: { name: d.item?.name, rarity: d.item?.rarity, slot: d.item?.slot, effect: d.item?.effect },
  }));
}

function publicRun(staged) {
  return {
    ok: true,
    runId: staged.runId,
    mode: "demo_party_run",
    status: staged.status || "staged",
    outcome: staged.result.outcome,
    rounds: staged.result.rounds,
    bossDead: staged.result.bossDead,
    startTile: staged.startTile,
    targetTile: staged.targetTile,
    travelPath: staged.travelPath,
    joinDecisions: staged.joinDecisions,
    roster: staged.roster,
    party: staged.result.party,
    enemies: staged.result.enemies,
    waves: staged.result.waves,
    log: staged.result.log,
    level: staged.level,
    tile: staged.targetTile?.name,
    loot: publicLoot(staged.loot),
    plannerDemo: staged.plannerDemo || null,
    timeline: { partyFindMs: DEMO_PARTY_DEADLINE_MS, travelStepMs: 1350, resultHoldMs: 15000 },
  };
}

// Begin the party-finding demo. It stages the full party, travel plan, combat, and
// loot but leaves the player in town until commitPartyDemo() is called.
export function runPartyDemo({ world, store, token, character, bossDrops = null }) {
  const s = world?.sigmacraft;
  if (!s?.map?.tiles) return { ok: false, error: "no overworld" };
  if (!character?.isPlaytest) return { ok: false, error: "party run is a playtest-only demo surface" };
  ensureDemoRun(character);
  if (character?.run && character.run.alive === false) {
    return { ok: false, error: "your hero has fallen — mint a new playtest run to begin again" };
  }
  s.parties = s.parties || {};
  s.actorPlaces = s.actorPlaces || {};
  s.overworldNpcs = s.overworldNpcs || {};
  s.delveCooldowns = s.delveCooldowns || {};
  s.demoRuns = s.demoRuns && typeof s.demoRuns === "object" ? s.demoRuns : {};

  releaseExistingParty(s, token);
  const startTile = s.map.tiles[s.map.townTileId] || Object.values(s.map.tiles).find((t) => t.type === "town");
  const target = pickDemoDungeon(s, token);
  if (!startTile || !target) return { ok: false, error: "no available dungeon for the demo run" };
  const seed = seedOf(`${token}:${target.id}:${s.tick || 0}:party-demo`);
  s.actorPlaces[token] = startTile.id;
  const plannerDemo = demoThroughputStatus(s);

  const { party, joinDecisions } = buildPartyByInvitation(s, token, startTile, target, seed);
  if (party.members.length < PARTY_MAX_MEMBERS) return { ok: false, error: "not enough available NPCs answered the tavern board" };

  const path = travelPath(s, startTile.id, target.id);
  if (!path.length || path[path.length - 1]?.id !== target.id) {
    return { ok: false, error: "the party could not find a route to the dungeon" };
  }
  party.status = "forming";
  const combatants = hardenDemoLeader(buildPartyCombatants(party, character, (id) => s.overworldNpcs?.[id]));
  const built = buildDungeonEnemies(target, combatants.length, seed);
  const waves = splitWaves(built.enemies);
  const result = resolveWaveRun({ combatants, waves, seed });

  const loot = rollPartyLoot({
    result,
    builtEnemies: built.enemies,
    party: combatants,
    level: built.level,
    depth: built.depth,
    seed,
    bossDrops,
  });

  const accepted = joinDecisions.filter((d) => d.accepted);
  const joins = accepted.slice(0, PARTY_MAX_MEMBERS).map((decision, index) => ({
    ...decision,
    joinAtMs: Math.round(plannerDemo.partyJoinMs[index] ?? 6000 + index * 7000),
    dialogue: joinDialogue(decision, target, seed),
  }));
  const decoratedDecisions = joinDecisions.map((d) => {
    const joined = joins.find((j) => j.npcId === d.npcId);
    return joined || { ...d, accepted: false, dialogue: declineDialogue(d, target, seed), joinAtMs: null };
  });
  const staged = {
    runId: `demo_${seed.toString(36)}_${String(s.tick || 0)}`,
    status: "staged",
    createdTick: s.tick || 0,
    startTile: tileView(startTile),
    targetTile: tileView(target),
    travelPath: path,
    joinDecisions: decoratedDecisions,
    roster: [
      { id: combatants[0]?.id || token, name: character.name || "Playtester", archetype: "player", isPlayer: true },
      ...party.members.map((m) => ({ id: m.npcId, name: m.name, archetype: m.archetype, faction: m.faction || null, persona: m.persona || null })),
    ],
    result,
    loot,
    plannerDemo,
    level: built.level,
    depth: built.depth,
    partyMemberIds: party.members.map((m) => m.npcId),
    playerId: combatants.find((c) => c.isPlayer)?.id || token,
  };
  s.demoRuns[token] = staged;
  party.lastDelve = null;

  const acceptedNames = party.members.map((m) => m.name).join(", ");
  appendEvent(s, `${character.name || "A playtester"} posts a party notice at ${startTile.name}.`);
  appendEvent(s, `${acceptedNames} gather at the tavern table.`);

  return publicRun(staged);
}

export function commitPartyDemo({ world, store, token, character, runId = null }) {
  const s = world?.sigmacraft;
  const staged = s?.demoRuns?.[token];
  if (!staged) return { ok: false, error: "no staged party run" };
  if (runId && staged.runId !== runId) return { ok: false, error: "staged party run id mismatch" };
  if (!character?.isPlaytest) return { ok: false, error: "party run is a playtest-only demo surface" };
  const party = s.parties?.[token];
  if (!party) return { ok: false, error: "party record vanished" };
  const target = s.map?.tiles?.[staged.targetTile?.id];
  if (!target) return { ok: false, error: "target dungeon vanished" };

  for (const step of staged.travelPath || []) {
    s.actorPlaces[token] = step.id;
    for (const npcId of staged.partyMemberIds || []) {
      const npc = s.overworldNpcs?.[npcId];
      if (npc) npc.tileId = step.id;
    }
  }

  carryPlayerResult(character, staged.result);
  const kept = keepPlayerLootForId(character, staged.playerId, staged.loot);
  if (staged.result.outcome === "victory") {
    const cooldowns = s.delveCooldowns[token] || (s.delveCooldowns[token] = {});
    const nowTick = s.tick || 0;
    for (const tid of Object.keys(cooldowns)) {
      if (nowTick - cooldowns[tid] >= DELVE_COOLDOWN_TICKS) delete cooldowns[tid];
    }
    cooldowns[target.id] = nowTick;
  }

  party.status = staged.result.outcome === "victory" ? "done" : "forming";
  party.lastDelve = {
    outcome: staged.result.outcome,
    rounds: staged.result.rounds,
    tile: target.name,
    kills: staged.result.kills.length,
    waves: staged.result.waves.length,
    bossDead: staged.result.bossDead,
    drops: staged.loot.drops.map((d) => ({
      to: d.memberName,
      item: d.item?.name || "loot",
      rarity: d.item?.rarity,
      fromBoss: d.fromBoss,
    })),
    at: s.tick || 0,
  };

  appendEvent(s, `The party travels ${(staged.travelPath || []).length - 1} roads to ${target.name}.`);
  appendEvent(s, `The party ${staged.result.outcome} in ${target.name}; boss ${staged.result.bossDead ? "slain" : "still standing"}.`);
  store?.pushFeed?.({
    kind: "narrative",
    name: "Party Finder",
    detail: `Automated party run ${staged.result.outcome} at ${target.name} (${staged.result.waves.length} waves, ${kept} loot to the leader).`,
  });

  const out = publicRun({ ...staged, status: "committed" });
  delete s.demoRuns[token];
  return out;
}
