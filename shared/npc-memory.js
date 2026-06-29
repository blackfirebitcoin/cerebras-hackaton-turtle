// SIGMA ABYSS — NPC memory + relationships (master design §3.1, [A7]).
//
// NPCs remember what players do. A relationship is a signed score (−100..+100)
// plus a bounded episode ring + flags, stored on character.npcRelationships
// (account-side, ≤200 NPCs). PURE + RNG-free math — deterministic, dual-runtime.

export const REL_MIN = -100;
export const REL_MAX = 100;
export const EPISODE_RING = 8;
export const REL_DECAY_PER_DAY = 4; // score drifts toward 0 when ignored

// Episode kinds → score weight. Greeting warms slowly; gifts + quest help warm
// fast; attacking the NPC's faction cools.
export const EPISODE_WEIGHT = {
  greet: 1,
  ask: 1,
  gift: 6,
  quest_help: 10,
  faction_kill: -8,
  betray: -20,
};

export function freshRelationship(now = 0) {
  return { score: 0, flags: [], lastSeenAt: now, episodes: [] };
}

function clampScore(n) {
  return Math.max(REL_MIN, Math.min(REL_MAX, n));
}

// Record an episode on a relationship object; mutates + returns it.
export function rememberEpisode(rel, kind, now = 0, extra = null) {
  const r = rel || freshRelationship(now);
  const w = EPISODE_WEIGHT[kind] ?? 0;
  r.score = clampScore((r.score || 0) + w);
  r.lastSeenAt = now;
  r.episodes = [{ kind, w, at: now, ...(extra ? { extra } : {}) }, ...(r.episodes || [])].slice(
    0,
    EPISODE_RING,
  );
  return r;
}

// Decay a relationship toward neutral based on elapsed time. RNG-free.
export function decayRelationship(rel, now = 0) {
  if (!rel) return rel;
  const days = Math.max(0, (now - (rel.lastSeenAt || now)) / (24 * 3600 * 1000));
  if (days < 1) return rel;
  const drift = Math.floor(days) * REL_DECAY_PER_DAY;
  if (rel.score > 0) rel.score = Math.max(0, rel.score - drift);
  else if (rel.score < 0) rel.score = Math.min(0, rel.score + drift);
  rel.lastSeenAt = now;
  return rel;
}

// Disposition band label from a relationship score.
export function dispositionLabel(score) {
  const s = score || 0;
  if (s >= 60) return "ally";
  if (s >= 20) return "friendly";
  if (s > -20) return "neutral";
  if (s > -60) return "wary";
  return "hostile";
}

// The dialogue bucket used by npc-defs (collapses wary→hostile-ish for lines).
export function dispositionBucket(score) {
  const d = dispositionLabel(score);
  if (d === "wary") return "hostile";
  return d;
}
