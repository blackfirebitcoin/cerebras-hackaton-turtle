// SIGMA ABYSS — the single persistent-world tick (master design §0.4 / §4.1).
//
// The whole living world advances on ONE supervised 60s loop — never a
// second timer — to honour the PSU power-safety rule (one cheap, bounded
// loop, not a fleet of co-spiking intervals). Later milestones add
// sub-advancers (faction territory, zone pressure, NPC schedules, market
// sweep, crisis state machine, retention sweeps) IN FIXED ORDER inside
// `worldTick`. Milestone 1 ships the spine: bump the epoch, recompute
// per-faction membership from the live player set, fold the drained zone
// events into per-zone counters, and stamp the tick.
//
// `worldTick(world, players, ctx)` is deliberately a PURE function of its
// arguments (no store, no rt, no Date.now) so the smoke test can drive it
// headlessly. `startWorldTick` is the thin server wiring that reads the
// world + players out of the store, calls `worldTick`, writes the world
// back, and broadcasts a `worldPulse` for the overlay.

import { PLAYER_ACTIVE_MS, WORLD_TICK_MS } from "../shared/constants.js";
import { createSigmacraftState, seedSigmacraftOverworld } from "../shared/sigmacraft.js";
import { FACTION_IDS, FACTIONS, factionZoneMod, pickFactionRaider } from "../shared/factions.js";
import { NPC_IDS, NPCS, npcSchedulePhase } from "../shared/npc-defs.js";
import { rollCrisis, rollWorldEvent } from "../shared/storyteller.js";
import { DANGER_ZONE_IDS, zoneById } from "../shared/zones.js";

const CRISIS_COOLDOWN_MS = 10 * 60_000;
const CRISIS_DURATION_MS = 5 * 60_000;

export const WORLD_SCHEMA = 1;

// A stable default world seed (master §2.3: set once at first boot, never
// changes). Folded with the epoch via mixSeed for deterministic, auditable
// per-tick faction-territory rolls.
const DEFAULT_WORLD_SEED = 0x51_6d_41_00; // "SmA\0" — Sigma Abyss world

// Build the initial shared-world document. Five factions on the five real
// danger zones; one zone record per danger zone. Shape follows master §2.3
// (namespaced sections) with M1 fields populated and later-milestone
// sections present-but-empty so the doc never needs a destructive reshape.
export function freshWorld(seed = DEFAULT_WORLD_SEED) {
  const factions = {};
  for (const id of FACTION_IDS) {
    const f = FACTIONS[id];
    factions[id] = {
      treasury: 0,
      memberCount: 0,
      activePlayers: 0,
      sovereignty: null,
      weeklyKills: 0,
      weeklyGoldDonated: 0,
      strength: 1.0,
      zoneScores: { [f.homeZone]: 0.5 },
    };
  }
  const npcs = {};
  for (const id of NPC_IDS) {
    npcs[id] = {
      id,
      factionId: NPCS[id].factionId,
      zoneId: NPCS[id].homeZone,
      schedulePhase: NPCS[id].schedule[0],
      moodValue: 50,
      lastDialogueAt: 0,
    };
  }
  const zones = {};
  for (const zid of DANGER_ZONE_IDS) {
    // Which factions contest this zone: its owner faction plus that
    // owner's rival, so each zone starts as a believable two-way contest.
    const owner = FACTION_IDS.find((id) => FACTIONS[id].homeZone === zid) || null;
    const ownerRival = owner ? FACTIONS[owner].rival : null;
    const contestants = [owner, ownerRival && ownerRival !== "all" ? ownerRival : null].filter(
      Boolean,
    );
    zones[zid] = {
      pressure: 0.3,
      conquestOwner: null,
      conquestSince: 0,
      contestantFactions: contestants,
      killsThisHour: 0,
      deathsThisHour: 0,
      lastPlayerAt: 0,
      status: "normal", // normal | haunted | contested
      resourceNodes: {},
    };
  }
  return {
    schema: WORLD_SCHEMA,
    worldSeed: seed >>> 0,
    epoch: 0,
    factions,
    zones,
    npcs,
    crisis: {
      activeCrisis: null,
      cooldowns: {},
      history: [],
      townLocked: false,
      townHealLockUntil: 0,
    },
    eventQueue: [],
    economy: {
      treasury: 0,
      goldInCirculation: 0,
      treasuryMode: false,
      bounties: [],
      priceHistory: {},
    },
    retention: {
      globalChallenge: null,
      worldEvent: null,
      monuments: [],
      hallOfFame: [],
      factionWar: null,
    },
    graves: [],
    lastTickAt: 0,
    // Sigmacraft fantasy overworld layer (integrate-this). The 140-tile map +
    // 200-agent population are generated deterministically from the world seed.
    sigmacraft: seedSigmacraftOverworld(createSigmacraftState(), String(seed)),
  };
}

// THE tick. Pure: mutates `world` in place from its arguments and returns a
// small summary (used by the broadcast + the smoke assertions). Must stay
// cheap and bounded — O(players + zoneEvents) with no heavy compute.
export function worldTick(world, players = [], ctx = {}) {
  if (!world || typeof world !== "object") return { epoch: 0, memberCounts: {} };
  const now = Number.isFinite(ctx.now) ? ctx.now : 0;
  const zoneEvents = Array.isArray(ctx.zoneEvents) ? ctx.zoneEvents : [];

  world.epoch = (world.epoch | 0) + 1;

  // 1) Factions: recompute live membership + active-player counts from the
  //    current player set. Cheap single pass.
  const memberCounts = {};
  const activeCounts = {};
  for (const id of FACTION_IDS) {
    memberCounts[id] = 0;
    activeCounts[id] = 0;
  }
  for (const c of players) {
    const fid = c?.faction;
    if (fid && memberCounts[fid] !== undefined) {
      memberCounts[fid] += 1;
      if (now - (c.lastSeen || 0) < PLAYER_ACTIVE_MS) activeCounts[fid] += 1;
    }
  }
  for (const id of FACTION_IDS) {
    if (!world.factions[id]) continue;
    world.factions[id].memberCount = memberCounts[id];
    world.factions[id].activePlayers = activeCounts[id];
  }

  // 2) Zones: fold the drained zone-event buffer into per-zone counters and
  //    this-tick heat (drives pressure).
  const tickHeat = {};
  for (const ev of zoneEvents) {
    const z = world.zones[ev.zoneId];
    if (!z) continue;
    const n = Number.isFinite(ev.n) ? ev.n : 1;
    if (ev.kind === "death") {
      z.deathsThisHour += n;
      tickHeat[ev.zoneId] = (tickHeat[ev.zoneId] || 0) + n * 0.02;
    } else {
      z.killsThisHour += n;
      tickHeat[ev.zoneId] = (tickHeat[ev.zoneId] || 0) + n * 0.002;
    }
    z.lastPlayerAt = now;
  }

  // 3) Zone pressure (master §M4): rises with this-tick heat, decays slowly.
  //    Contested at ≥0.95, calms below 0.6. Hourly counters reset each ~hour.
  const hourly = world.epoch % 60 === 0;
  for (const zid of DANGER_ZONE_IDS) {
    const z = world.zones[zid];
    if (!z) continue;
    z.pressure = Math.max(0, Math.min(1, z.pressure * 0.98 + (tickHeat[zid] || 0)));
    if (z.pressure >= 0.95 && z.status === "normal") z.status = "contested";
    else if (z.pressure < 0.6 && z.status === "contested") z.status = "normal";
    if (hourly) {
      z.killsThisHour = 0;
      z.deathsThisHour = 0;
    }
  }

  // 4) Faction territory conquest (master §4.1 step 2): each contested zone,
  //    a DETERMINISTIC raider faction (mixSeed(worldSeed, epoch)) presses its
  //    zoneScore; crossing 1.0 flips conquestOwner → a faction_conquest feed.
  const conquests = [];
  DANGER_ZONE_IDS.forEach((zid, zi) => {
    const z = world.zones[zid];
    if (!z || !Array.isArray(z.contestantFactions) || z.contestantFactions.length === 0) return;
    const raider = pickFactionRaider(
      world.worldSeed >>> 0,
      ((world.epoch << 4) ^ zi) >>> 0,
      z.contestantFactions,
    );
    const f = raider && world.factions[raider];
    if (!f) return;
    f.zoneScores = f.zoneScores || {};
    const press = 0.05 + (f.activePlayers || 0) * 0.02; // more active boots → faster
    f.zoneScores[zid] = Math.min(1, (f.zoneScores[zid] || 0) + press);
    if (z.conquestOwner && z.conquestOwner !== raider) {
      const owner = world.factions[z.conquestOwner];
      if (owner?.zoneScores)
        owner.zoneScores[zid] = Math.max(0, (owner.zoneScores[zid] || 0) - press * 0.5);
    }
    if (f.zoneScores[zid] >= 1 && z.conquestOwner !== raider) {
      z.conquestOwner = raider;
      z.conquestSince = now;
      conquests.push({ zoneId: zid, faction: raider });
    }
  });

  // 5) World-event queue (master §4.1 step 6): each zone may spawn one event
  //    (deterministic per worldSeed+epoch+zone). Injected into players' runs at
  //    save-read (injectWorldState), not here. Bounded + TTL-expired.
  if (!Array.isArray(world.eventQueue)) world.eventQueue = [];
  for (const zid of DANGER_ZONE_IDS) {
    const we = rollWorldEvent(world.worldSeed >>> 0, zid, world.epoch >>> 0);
    if (we)
      world.eventQueue.push({
        zoneId: zid,
        event: we,
        createdAt: now,
        ttl: now + WORLD_EVENT_TTL_MS,
      });
  }
  world.eventQueue = world.eventQueue.filter((e) => e.ttl > now);
  const cap = DANGER_ZONE_IDS.length * 10;
  if (world.eventQueue.length > cap) world.eventQueue = world.eventQueue.slice(-cap);

  // 6a) NPC schedules ([A7] — master §M6, ticked INSIDE this loop, no separate
  //     timer). Advance each NPC's schedule phase by the world hour-of-day.
  if (!world.npcs || typeof world.npcs !== "object") world.npcs = {};
  const epochHour = world.epoch % 24;
  for (const id of NPC_IDS) {
    if (!world.npcs[id]) {
      world.npcs[id] = {
        id,
        factionId: NPCS[id].factionId,
        zoneId: NPCS[id].homeZone,
        schedulePhase: "resting",
        moodValue: 50,
        lastDialogueAt: 0,
      };
    }
    world.npcs[id].schedulePhase = npcSchedulePhase(id, epochHour);
  }

  // 6b) World crisis state machine ([A3] — master §M5). Drives one collective
  //     crisis at a time through brewing→active→resolving→concluded.
  let onlineActive = 0;
  for (const id of FACTION_IDS) onlineActive += activeCounts[id];
  // Players with no faction also count as online — add a floor from the player
  // list (a crisis shouldn't require everyone be in a faction).
  if (onlineActive < players.length)
    onlineActive = players.filter((p) => now - (p?.lastSeen || 0) < PLAYER_ACTIVE_MS).length;
  const crisis = advanceCrisis(world, onlineActive, now);

  world.lastTickAt = now;
  return { epoch: world.epoch, memberCounts, activeCounts, conquests, crisis };
}

// The crisis state machine. Returns an event tag for the broadcast/feed.
export function advanceCrisis(world, onlineActive, now) {
  if (!world.crisis || typeof world.crisis !== "object") {
    world.crisis = { activeCrisis: null, cooldownUntil: 0, history: [] };
  }
  const cr = world.crisis;
  const ac = cr.activeCrisis;
  if (ac) {
    if (ac.phase === "brewing") {
      ac.phase = "active";
      ac.activatedAt = now;
      return { kind: "active", id: ac.id };
    }
    if (ac.phase === "active") {
      if (ac.total >= ac.target)
        ac.phase = "resolving"; // collectively beaten
      else if (now >= ac.endsAt) ac.phase = "resolving"; // timed out
      ac.outcome = ac.total >= ac.target ? "won" : ac.phase === "resolving" ? "timeout" : null;
      return { kind: "active", id: ac.id, total: ac.total, target: ac.target };
    }
    if (ac.phase === "resolving") {
      const concluded = { id: ac.id, name: ac.name, outcome: ac.outcome, total: ac.total, at: now };
      cr.history = [concluded, ...(cr.history || [])].slice(0, 20);
      cr.cooldownUntil = now + CRISIS_COOLDOWN_MS;
      cr.activeCrisis = null;
      return { kind: "concluded", ...concluded };
    }
    return null;
  }
  // No active crisis — maybe launch one (needs a crowd + cooldown elapsed).
  if (onlineActive >= 3 && now >= (cr.cooldownUntil || 0)) {
    const rolled = rollCrisis(world.worldSeed >>> 0, world.epoch >>> 0);
    if (rolled) {
      cr.activeCrisis = {
        ...rolled,
        phase: "brewing",
        startedAt: now,
        endsAt: now + CRISIS_DURATION_MS,
        contributions: {},
        total: 0,
        outcome: null,
      };
      return { kind: "launched", id: rolled.id, name: rolled.name };
    }
  }
  return null;
}

// A chatter contributes to the active crisis (via the matching verb). Returns
// the running total / target so the bot can report progress.
export function contributeToCrisis(world, login, amount = 1) {
  const ac = world?.crisis?.activeCrisis;
  if (!ac || ac.phase !== "active") return { ok: false, error: "no_active_crisis" };
  ac.contributions[login] = (ac.contributions[login] || 0) + amount;
  ac.total += amount;
  return { ok: true, total: ac.total, target: ac.target, crisis: ac.name, verb: ac.contributeVerb };
}

const WORLD_EVENT_TTL_MS = 30 * 60_000;

// Save-read injection (master §4.2, [A6]). When the server processes a player
// (chat-ping/save), copy the unexpired world events for their current zone onto
// run._pendingWorldEvents (deduped via character.lastWorldEventAt → each player
// sees each zone event once) and precompute run._factionZoneMod (conquest
// combat bonus). Both run fields are `_`-prefixed transients vRun strips on
// save — the client applies them once in delveTick and cannot forge them.
export function injectWorldState(character, world) {
  if (!character?.run || !world) return;
  const zid = character.run.zone;
  // Conquest combat mod for this player's faction in this zone (data, not store).
  character.run._factionZoneMod = factionZoneMod(
    character.faction || null,
    world.zones?.[zid] || null,
  );
  const pending = [];
  // Active crisis: its personalEffect rides EVERY injection (persistent while
  // active) — not watermark-deduped, so the surge keeps biting each delve.
  const ac = world.crisis?.activeCrisis;
  if (ac && ac.phase === "active") {
    pending.push({ id: ac.id, name: ac.name, effect: ac.personalEffect, crisis: true });
  }
  // Per-zone world events: deduped via the watermark so each lands once.
  if (Array.isArray(world.eventQueue) && !world.zones?.[zid]?.safe) {
    const since = character.lastWorldEventAt || 0;
    const fresh = world.eventQueue.filter((e) => e.zoneId === zid && e.createdAt > since);
    if (fresh.length) {
      for (const e of fresh) pending.push(e.event);
      character.lastWorldEventAt = world.lastTickAt || since;
    }
  }
  if (pending.length) character.run._pendingWorldEvents = pending;
}

// Server wiring: mount the one supervised world loop. Returns the stop fn.
// `extraAdvancers` is the extension seam: each milestone adds its sweep here
// (market, crisis, NPC, retention) so they all ride this ONE 60s timer
// rather than spawning their own — the PSU power-safety rule (master §0.4).
// Each advancer is `(ctx) => void` with ctx = {store, world, players, rt, now};
// a throw in one is contained (it's wrapped) and never stops the tick.
// `fastAdvancers` run on EVERY base tick (≈3s) for the Sigmacraft layer; the
// legacy core tick + `extraAdvancers` (market, storyteller, …) run once every
// `legacyEvery` base ticks, preserving their original 60s cadence under a single
// timer. `legacyEvery = 1` (default) reproduces the classic every-tick behaviour.
export function startWorldTick({
  store,
  rt,
  superviseInterval,
  intervalMs = WORLD_TICK_MS,
  extraAdvancers = [],
  fastAdvancers = [],
  legacyEvery = 1,
}) {
  let n = 0;
  return superviseInterval(
    "world.tick",
    () => {
      const w = store.getWorldState();
      if (!w) return;
      n += 1;
      const now = Date.now();
      // Tick-overrun/drift telemetry (integrate-this §"three-second tick
      // budget"): if a base tick exceeds its interval, log it so an operator
      // can see the world loop falling behind.
      const checkBudget = () => {
        const elapsed = Date.now() - now;
        if (elapsed > intervalMs) {
          console.warn(`[world.tick] overran budget: ${elapsed}ms > ${intervalMs}ms (tick ${n})`);
        }
      };

      // Fast lane — Sigmacraft and other sub-3s advancers, every base tick.
      // An advancer returns true iff it mutated world state; we only persist on
      // real changes so idle base ticks don't rewrite world.json (≈20x write
      // amplification avoided at the 3s cadence).
      let fastDirty = false;
      for (const advance of fastAdvancers) {
        try {
          if (advance({ store, world: w, rt, now })) fastDirty = true;
        } catch (err) {
          console.error(`[world.tick] fast sub-advancer fault: ${err?.message || err}`);
        }
      }

      // Legacy lane runs every `legacyEvery` base ticks (≈60s). Outside that
      // window we persist only when the fast lane actually mutated state.
      if (n % legacyEvery !== 0) {
        if (fastDirty) store.putWorldState(w);
        checkBudget();
        return;
      }

      const players = store
        .allPlayers()
        .map((p) => p.character)
        .filter(Boolean);
      const zoneEvents = store.drainZoneEvents();
      const summary = worldTick(w, players, { zoneEvents, now });
      store.putWorldState(w);
      // Narrative feed for crisis + conquest transitions (master §M5).
      if (summary.crisis?.kind === "launched") {
        store.pushFeed?.({
          kind: "narrative",
          detail: `A crisis stirs — ${summary.crisis.name}. Chat must answer.`,
        });
      } else if (summary.crisis?.kind === "concluded") {
        store.pushFeed?.({
          kind: "narrative",
          detail: `${summary.crisis.name} ${summary.crisis.outcome === "won" ? "was beaten back by the crowd" : "ran its course"}.`,
        });
      }
      for (const c of summary.conquests || []) {
        store.pushFeed?.({
          kind: "faction_conquest",
          detail: `${c.faction} seized control of ${c.zoneId}.`,
          faction: c.faction,
          zoneId: c.zoneId,
        });
      }
      for (const advance of extraAdvancers) {
        try {
          advance({ store, world: w, players, rt, now });
        } catch (err) {
          console.error(`[world.tick] sub-advancer fault: ${err?.message || err}`);
        }
      }
      if (rt && typeof rt.broadcast === "function") {
        rt.broadcast({
          t: "worldPulse",
          epoch: summary.epoch,
          factions: publicFactions(w),
          at: Date.now(),
        });
      }
      checkBudget();
    },
    intervalMs,
  );
}

// A compact, public-safe faction snapshot for the overlay + GET /api/world.
export function publicFactions(world) {
  const out = {};
  if (!world?.factions) return out;
  for (const id of FACTION_IDS) {
    const f = world.factions[id];
    const def = FACTIONS[id];
    if (!f || !def) continue;
    out[id] = {
      id,
      name: def.name,
      color: def.color,
      homeZone: def.homeZone,
      homeZoneName: zoneById(def.homeZone).name,
      memberCount: f.memberCount | 0,
      activePlayers: f.activePlayers | 0,
      treasury: f.treasury | 0,
    };
  }
  return out;
}
