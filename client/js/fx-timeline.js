// SIGMA ABYSS — combat FX timeline engine.
//
// Takes the deterministic event log from shared/combat.js plus the
// authored manifest, expands each event into a list of sub-events with
// ms-resolution offsets, then drains them in real time so anticipation /
// impact / aftermath read with the right pacing instead of marching one
// event per fixed beat.
//
// Determinism stays in shared/combat.js — this layer is presentation
// only. Two runs from the same event log + manifest will look identical
// frame-for-frame on a stable framerate.

import { BOSS_INTRO, EFFECT_MODS, EVENT_FX, eventKey } from "./fx-manifest.js";

// Gap inserted after an unrecognised event so the playback doesn't stall.
const FALLBACK_GAP = 200;

export function compose({ events, effects = [], boss = false }) {
  const queue = [];
  let cursor = 0;

  if (boss) {
    pushTimeline(queue, BOSS_INTRO.sub, cursor, {});
    cursor += BOSS_INTRO.duration;
  }

  for (const ev of events) {
    const key = eventKey(ev);
    const entry = EVENT_FX[key] || EVENT_FX[ev.t];
    if (!entry) {
      cursor += FALLBACK_GAP;
      continue;
    }
    pushTimeline(queue, entry.sub, cursor, ev);
    for (const eff of effects) {
      const mods = EFFECT_MODS[eff];
      if (!mods) continue;
      const m = mods[ev.t] || (key !== ev.t && mods[key]);
      if (m) pushTimeline(queue, m, cursor, ev);
    }
    cursor += entry.duration || FALLBACK_GAP;
  }

  queue.sort((a, b) => a.at - b.at);
  return { queue, totalMs: cursor };
}

function pushTimeline(out, sub, base, ev) {
  for (const s of sub) {
    out.push({
      at: base + (s.t || 0),
      type: s.type,
      payload: { ...s, baseEvent: ev },
    });
  }
}

// Drain-driven runner. The caller (combat-view) ticks it once per frame
// with the elapsed playback time; it returns every sub-event whose
// authored offset is now in the past, in order.
export function makeRunner(composed) {
  let i = 0;
  const queue = composed.queue;
  return {
    totalMs: composed.totalMs,
    drainUntil(elapsedMs) {
      const out = [];
      while (i < queue.length && queue[i].at <= elapsedMs) {
        out.push(queue[i]);
        i += 1;
      }
      return out;
    },
    isDone(elapsedMs) {
      return i >= queue.length && elapsedMs >= composed.totalMs;
    },
  };
}
