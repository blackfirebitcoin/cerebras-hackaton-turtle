// SIGMA ABYSS — chat voting (master design §M8 / 05-twitch.md, [A5]).
//
// The crowd steers the world. The operator opens a vote with a set of options;
// chatters cast one vote each (!vote <option>); on close the winning option's
// VOTE_EFFECT mutates the shared world. In-memory accumulator (one live vote at
// a time) + a small effect registry. Server-only.

import { WORLD_EVENTS } from "../shared/storyteller.js";

// Each effect mutates the world when its option wins. Pure-ish (world only).
export const VOTE_EFFECTS = {
  loot_surge: {
    id: "loot_surge",
    label: "Crack the vaults (loot surge)",
    apply(world, now) {
      const we = {
        id: "gold_rush",
        name: WORLD_EVENTS.gold_rush.name,
        effect: { ...WORLD_EVENTS.gold_rush.effect },
      };
      if (!Array.isArray(world.eventQueue)) world.eventQueue = [];
      for (const zid of Object.keys(world.zones || {})) {
        world.eventQueue.push({ zoneId: zid, event: we, createdAt: now, ttl: now + 30 * 60_000 });
      }
      return "A loot surge floods every zone.";
    },
  },
  calm: {
    id: "calm",
    label: "Beg for respite (calm the Abyss)",
    apply(world) {
      for (const z of Object.values(world.zones || {})) z.pressure = Math.max(0, z.pressure * 0.5);
      if (world.crisis?.activeCrisis?.phase === "active")
        world.crisis.activeCrisis.phase = "resolving";
      return "The Abyss exhales — pressure eases.";
    },
  },
  faction_war: {
    id: "faction_war",
    label: "Light the war beacon",
    apply(world, now) {
      world.retention = world.retention || {};
      world.retention.factionWar = {
        factionA: "iron_veil",
        factionB: "crimson_pact",
        expiresAt: now + 30 * 60_000,
      };
      return "Iron Veil and the Crimson Pact are at war for 30 minutes.";
    },
  },
};
export const VOTE_EFFECT_IDS = Object.keys(VOTE_EFFECTS);

// One live vote at a time (module state).
let current = null;

export function voteState() {
  return current;
}

// Open a vote. `options` is a list of VOTE_EFFECT ids (default: all). Operator-
// gated at the route layer (HMAC).
export function openVote({ options, durationMs = 60_000, now = 0 } = {}) {
  const ids = (Array.isArray(options) && options.length ? options : VOTE_EFFECT_IDS).filter(
    (id) => VOTE_EFFECTS[id],
  );
  if (!ids.length) return { ok: false, error: "no_valid_options" };
  current = {
    options: ids.map((id) => ({ id, label: VOTE_EFFECTS[id].label, votes: 0 })),
    voters: {},
    openedAt: now,
    endsAt: now + durationMs,
  };
  return { ok: true, vote: publicVote() };
}

export function castVote(login, optionId) {
  if (!current) return { ok: false, error: "no_open_vote" };
  if (current.voters[login]) return { ok: false, error: "already_voted" };
  const opt = current.options.find((o) => o.id === optionId);
  if (!opt) return { ok: false, error: "bad_option", options: current.options.map((o) => o.id) };
  opt.votes += 1;
  current.voters[login] = optionId;
  return { ok: true, option: optionId, votes: opt.votes };
}

// Close the vote, apply the winner's effect to `world`, return the outcome.
export function closeVote(world, now = 0) {
  if (!current) return { ok: false, error: "no_open_vote" };
  let winner = current.options[0];
  for (const o of current.options) if (o.votes > winner.votes) winner = o;
  const message = world ? VOTE_EFFECTS[winner.id].apply(world, now) : null;
  const result = {
    winner: winner.id,
    label: winner.label,
    votes: winner.votes,
    total: current.options.reduce((n, o) => n + o.votes, 0),
    message,
  };
  current = null;
  return { ok: true, result };
}

function publicVote() {
  if (!current) return null;
  return {
    options: current.options.map((o) => ({ id: o.id, label: o.label, votes: o.votes })),
    endsAt: current.endsAt,
    ballots: Object.keys(current.voters).length,
  };
}
