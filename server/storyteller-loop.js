// SIGMA ABYSS — the dynamic storyteller loop (the "AI-Dungeon" beat).
//
// Latency-proof crowd narrative. Every few world ticks the Abyss "stirs": a
// procedural story beat is narrated and the crowd gets ~50s to vote its course
// (!vote loot_surge | calm | faction_war). The winning choice mutates the
// shared world. Because the decision window (~50s) dwarfs the 6–30s stream
// delay, even a heavily-delayed viewer still gets their vote in — nobody is
// racing a reflex, they're steering a slow story. That is what makes a
// chat-driven game playable over a broadcast delay.
//
// This is a SUB-ADVANCER of the ONE 60s world tick — never its own timer (PSU
// power-safety, master §0.4). Cadence is gated on the world.epoch counter;
// phase + timing live on world.storyLoop, which persists across ticks exactly
// like world.crisis (the store writes the world doc free-form).
//
// Determinism firewall: rollWorldEvent is the SERVER-ONLY deterministic roller
// (makeRng off worldSeed+epoch). Its output is NARRATION + a vote — it is never
// fed into any run's rng stream, so shared/ stays untouched.

import { rollWorldEvent, WORLD_CRISES } from "../shared/storyteller.js";
import { closeVote, openVote, voteState } from "./voting.js";

const BEAT_EVERY = Number(process.env.STORY_BEAT_EVERY ?? 2); // epochs between beats (0 disables)
const VOTE_MS = Number(process.env.STORY_VOTE_MS) || 50_000; // < the 60s tick so it closes next tick
const OPTIONS = ["loot_surge", "calm", "faction_war"];

// Deterministically rotate the option order each beat so a low-turnout tie
// (closeVote breaks ties on the first option) doesn't always favour the same.
function rotated(epoch) {
  const r = (((epoch | 0) % OPTIONS.length) + OPTIONS.length) % OPTIONS.length;
  return OPTIONS.slice(r).concat(OPTIONS.slice(0, r));
}

// One procedural narration line for the beat — prefers the live crisis flavor,
// else a deterministic world-event blurb. No rng leaks into shared/.
function beatNarration(world) {
  const ac = world.crisis?.activeCrisis;
  if (ac && ac.phase === "active") {
    const def = WORLD_CRISES[ac.id];
    if (def?.activeText) return def.activeText;
  }
  // 0 is a legitimate uint32 seed — don't fall through to 1 (would desync the
  // narration from the world's actual deterministic seed). Match world-tick.js.
  const seed = world.worldSeed !== undefined ? world.worldSeed >>> 0 : 1;
  const we = rollWorldEvent(seed, `narrative_${world.epoch}`, world.epoch, 1.0);
  return we?.blurb || "The Abyss shifts in the dark, waiting on a choice.";
}

// World-tick sub-advancer. ctx = { store, world, players, rt, now }.
export function advance(ctx) {
  if (BEAT_EVERY <= 0) return; // disabled via env
  const { store, world, rt, now } = ctx || {};
  if (!world || !rt || !store) return;
  world.storyLoop ||= { phase: "idle", beatEpoch: 0 };
  const sl = world.storyLoop;
  const vote = voteState();

  if (sl.phase === "voting") {
    if (!vote || vote.endsAt !== sl.voteEndsAt) {
      // Our vote vanished (a restart cleared module state) OR an operator vote
      // replaced ours (POST /api/vote/open stomps the live vote). Abandon
      // ownership WITHOUT claiming a result that isn't ours — don't announce an
      // operator poll as a story beat. Persist so the recovery is explicit.
      sl.phase = "idle";
      sl.beatEpoch = world.epoch;
      store.putWorldState(world);
      return;
    }
    if (now < vote.endsAt) return; // still inside the voting window
    // Window closed → tally, apply the winning effect to the world, announce.
    const r = closeVote(world, now);
    sl.phase = "idle";
    sl.beatEpoch = world.epoch;
    if (r.ok) {
      store.putWorldState(world);
      const entry = store.pushFeed({
        kind: "narrative",
        label: `🗳 ${r.result.label} wins (${r.result.total} votes) — ${r.result.message}`,
      });
      rt.broadcast({ t: "feed", entry });
      rt.broadcast({ t: "voteResult", result: r.result, at: now });
      rt.broadcast({
        t: "storyBeat",
        phase: "resolved",
        text: r.result.message,
        winner: r.result.label,
        votes: r.result.total,
        at: now,
      });
    }
    return;
  }

  // idle → open a new beat on cadence, unless an operator vote is already live.
  if (world.epoch - (sl.beatEpoch || 0) < BEAT_EVERY) return;
  if (vote) return; // never stomp an operator-opened vote
  const text = beatNarration(world);
  const opened = openVote({ options: rotated(world.epoch), durationMs: VOTE_MS, now });
  if (!opened.ok) return;
  sl.phase = "voting";
  sl.beatEpoch = world.epoch;
  sl.voteEndsAt = opened.vote.endsAt; // ownership tag — proves the live vote is ours
  store.putWorldState(world);
  const entry = store.pushFeed({ kind: "narrative", label: `📖 ${text}` });
  rt.broadcast({ t: "feed", entry });
  rt.broadcast({ t: "voteOpen", vote: opened.vote, at: now });
  rt.broadcast({
    t: "storyBeat",
    phase: "beat",
    text,
    options: opened.vote.options, // [{id,label,votes}]
    endsAt: opened.vote.endsAt,
    at: now,
  });
}
