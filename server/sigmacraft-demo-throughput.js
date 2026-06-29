// Hackathon demo lane: expose an operator-controlled planner throughput profile.
// When enabled by the operator, the NPC planner uses this as a real local
// scheduling budget: plan jobs queue, token throughput drains them, and overdue
// jobs surface as stale/frozen NPC planners in the playtest UI.

const PROFILES = Object.freeze({
  cerebras: {
    profile: "cerebras",
    label: "Gemma 4 on Cerebras",
    tokensPerSecond: 1800,
    simulated: false,
  },
  slow50: {
    profile: "slow50",
    label: "Model A",
    tokensPerSecond: 50,
    simulated: true,
  },
});

export const DEMO_PARTY_DEADLINE_MS = 30_000;
export const DEMO_PLAN_TOKENS = 360;
export const DEMO_WORLD_TICK_MS = 3_000;
export const DEMO_ACTIVE_NPCS = 200;
export const DEMO_PLANS_DEMANDED_PER_10S = 40;
export const DEMO_STRESS_WINDOW_MS = 30_000;
export const DEMO_READY_ID_CAP = 512;

function nowMs(now = Date.now()) {
  return Number.isFinite(now) ? now : Date.now();
}

function ensureDemoState(sigmacraft, now = Date.now()) {
  if (!sigmacraft.demoThroughput || typeof sigmacraft.demoThroughput !== "object") {
    sigmacraft.demoThroughput = { profile: "cerebras", setAt: nowMs(now), queueEnabled: false };
  }
  if (!PROFILES[sigmacraft.demoThroughput.profile]) sigmacraft.demoThroughput.profile = "cerebras";
  if (!Number.isFinite(sigmacraft.demoThroughput.setAt)) sigmacraft.demoThroughput.setAt = nowMs(now);
  if (!Array.isArray(sigmacraft.demoThroughput.queue)) sigmacraft.demoThroughput.queue = [];
  if (!Array.isArray(sigmacraft.demoThroughput.readyNpcIds)) sigmacraft.demoThroughput.readyNpcIds = [];
  if (!Array.isArray(sigmacraft.demoThroughput.staleNpcIds)) sigmacraft.demoThroughput.staleNpcIds = [];
  if (!Number.isFinite(sigmacraft.demoThroughput.lastAdvancedAt)) sigmacraft.demoThroughput.lastAdvancedAt = nowMs(now);
  if (!Number.isFinite(sigmacraft.demoThroughput.tokenCredit)) sigmacraft.demoThroughput.tokenCredit = 0;
  if (!Number.isFinite(sigmacraft.demoThroughput.requestedJobs)) sigmacraft.demoThroughput.requestedJobs = 0;
  if (!Number.isFinite(sigmacraft.demoThroughput.completedJobs)) sigmacraft.demoThroughput.completedJobs = 0;
  if (!Number.isFinite(sigmacraft.demoThroughput.missedDeadlines)) sigmacraft.demoThroughput.missedDeadlines = 0;
  return sigmacraft.demoThroughput;
}

export function setDemoThroughputProfile(sigmacraft, profile, now = Date.now()) {
  if (!sigmacraft || typeof sigmacraft !== "object") return null;
  const key = PROFILES[profile] ? profile : "cerebras";
  const at = nowMs(now);
  sigmacraft.demoThroughput = {
    profile: key,
    setAt: at,
    queueEnabled: true,
    queue: [],
    readyNpcIds: [],
    staleNpcIds: [],
    lastAdvancedAt: at - DEMO_STRESS_WINDOW_MS,
    tokenCredit: 0,
    requestedJobs: 0,
    completedJobs: 0,
    missedDeadlines: 0,
  };
  seedStressWindow(sigmacraft, at);
  return demoThroughputStatus(sigmacraft, now);
}

export function demoThroughputStatus(sigmacraft, now = Date.now()) {
  if (!sigmacraft || typeof sigmacraft !== "object") {
    const profile = PROFILES.cerebras;
    return buildStatus(profile, 0);
  }
  const state = ensureDemoState(sigmacraft, now);
  const profile = PROFILES[state.profile] || PROFILES.cerebras;
  advancePlannerQueue(sigmacraft, now);
  return buildStatus(profile, Math.max(0, nowMs(now) - state.setAt), state);
}

export function demoThroughputQueueEnabled(sigmacraft) {
  return !!sigmacraft?.demoThroughput?.queueEnabled;
}

export function requestDemoPlannerJobs(sigmacraft, npcIds = [], now = Date.now()) {
  if (!demoThroughputQueueEnabled(sigmacraft)) return 0;
  const state = ensureDemoState(sigmacraft, now);
  const queued = new Set(state.queue.map((j) => j.npcId));
  const ready = new Set(state.readyNpcIds);
  const at = nowMs(now);
  let added = 0;
  for (const npcId of npcIds) {
    if (!npcId || queued.has(npcId) || ready.has(npcId)) continue;
    state.queue.push({ npcId, requestedAt: at, deadlineAt: at + DEMO_PARTY_DEADLINE_MS, missed: false });
    queued.add(npcId);
    added += 1;
  }
  state.requestedJobs += added;
  advancePlannerQueue(sigmacraft, now);
  return added;
}

export function takeReadyDemoPlannerJobs(sigmacraft, candidateIds = [], limit = 1, now = Date.now()) {
  if (!demoThroughputQueueEnabled(sigmacraft)) return [];
  const state = ensureDemoState(sigmacraft, now);
  advancePlannerQueue(sigmacraft, now);
  const allowed = new Set(candidateIds);
  const ready = [];
  const keep = [];
  for (const npcId of state.readyNpcIds) {
    if (ready.length < limit && (!allowed.size || allowed.has(npcId))) ready.push(npcId);
    else keep.push(npcId);
  }
  state.readyNpcIds = keep;
  return ready;
}

function seedStressWindow(sigmacraft, now) {
  const state = ensureDemoState(sigmacraft, now);
  const ids = Object.keys(sigmacraft?.overworldNpcs || {}).sort();
  if (!ids.length) return;
  const at = nowMs(now);
  const demand = Math.min(ids.length, DEMO_PLANS_DEMANDED_PER_10S * 3);
  const requestedAt = at - DEMO_STRESS_WINDOW_MS - 1_000;
  state.queue = ids.slice(0, demand).map((npcId) => ({
    npcId,
    requestedAt,
    deadlineAt: requestedAt + DEMO_PARTY_DEADLINE_MS,
    missed: false,
  }));
  state.requestedJobs = state.queue.length;
}

function advancePlannerQueue(sigmacraft, now = Date.now()) {
  const state = ensureDemoState(sigmacraft, now);
  const profile = PROFILES[state.profile] || PROFILES.cerebras;
  const at = nowMs(now);
  const elapsedMs = Math.max(0, at - state.lastAdvancedAt);
  state.lastAdvancedAt = at;
  state.tokenCredit += (elapsedMs / 1000) * profile.tokensPerSecond;

  const capacity = Math.min(state.queue.length, Math.floor(state.tokenCredit / DEMO_PLAN_TOKENS));
  if (capacity > 0) {
    const completed = state.queue.splice(0, capacity);
    state.tokenCredit -= completed.length * DEMO_PLAN_TOKENS;
    state.completedJobs += completed.length;
    state.readyNpcIds.push(...completed.map((j) => j.npcId));
    if (state.readyNpcIds.length > DEMO_READY_ID_CAP) {
      state.readyNpcIds.splice(0, state.readyNpcIds.length - DEMO_READY_ID_CAP);
    }
  }

  let newMisses = 0;
  const stale = [];
  for (const job of state.queue) {
    if (job.deadlineAt <= at) {
      stale.push(job.npcId);
      if (!job.missed) {
        job.missed = true;
        newMisses += 1;
      }
    }
  }
  state.missedDeadlines += newMisses;
  state.staleNpcIds = stale;
}

function buildStatus(profile, elapsedMs, state = null) {
  const capacityPer10s = Math.max(1, Math.floor((profile.tokensPerSecond * 10) / DEMO_PLAN_TOKENS));
  const avgResponseMs = Math.round((DEMO_PLAN_TOKENS / profile.tokensPerSecond) * 1000 + (profile.simulated ? 500 : 180));
  const p95ResponseMs = Math.round(avgResponseMs * (profile.simulated ? 1.8 : 1.45));
  const windows = elapsedMs / 10_000;
  const overload = Math.max(0, DEMO_PLANS_DEMANDED_PER_10S - capacityPer10s);
  const wave = Math.abs(Math.sin(elapsedMs / 2200));
  const queueDepth = profile.simulated
    ? Math.min(DEMO_ACTIVE_NPCS, Math.round(72 + overload * windows * 1.2 + wave * 18))
    : Math.round(wave * 3);
  const staleNpcs = profile.simulated
    ? Math.min(DEMO_ACTIVE_NPCS, Math.round(48 + queueDepth * 0.72))
    : Math.round(wave * 4);
  const missedDeadlines = profile.simulated ? Math.floor((elapsedMs / DEMO_WORLD_TICK_MS) * 0.8) : 0;
  const partyJoinMs = profile.simulated
    ? [9_000, 18_500, 28_000, 37_500]
    : [6_000, 13_000, 20_000, 27_000];

  return {
    profile: profile.profile,
    label: profile.label,
    simulated: profile.simulated,
    tokensPerSecond: profile.tokensPerSecond,
    planTokens: DEMO_PLAN_TOKENS,
    worldTickMs: DEMO_WORLD_TICK_MS,
    activeNpcs: DEMO_ACTIVE_NPCS,
    demandPer10s: DEMO_PLANS_DEMANDED_PER_10S,
    capacityPer10s,
    queueDepth: state?.queueEnabled && state.requestedJobs > 0 ? state.queue.length : queueDepth,
    staleNpcs: state?.queueEnabled && state.requestedJobs > 0 ? state.staleNpcIds.length : staleNpcs,
    readyNpcs: state?.queueEnabled ? state.readyNpcIds.length : 0,
    requestedJobs: state?.queueEnabled ? state.requestedJobs : 0,
    completedJobs: state?.queueEnabled ? state.completedJobs : 0,
    missedDeadlines: state?.queueEnabled && state.requestedJobs > 0 ? state.missedDeadlines : missedDeadlines,
    avgResponseMs,
    p95ResponseMs,
    partyDeadlineMs: DEMO_PARTY_DEADLINE_MS,
    partyJoinMs,
    partyFinderStalls: profile.simulated,
    modeAgeMs: Math.round(elapsedMs),
  };
}
