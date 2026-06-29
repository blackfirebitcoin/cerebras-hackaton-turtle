// SIGMA ABYSS — progression feedback: make the real delve LEGIBLE.
//
// Turns a liveDelve() events summary into (a) overlay frames the broadcast
// scenes render (levelUp burst, delveDeath cinematic), (b) feed rows for the
// social ticker, and (c) ONE rate-limited literal-chat callout for the single
// biggest moment. Pure except for a module-local rate-limit map — the caller
// (chat-ping) does the actual rt.broadcast / store.pushFeed / response.say.
//
// Anti-spam is the whole point: 64 chat-only sigmas each advancing every line
// would flood the feed and Twitch chat. So feed rows fire only on MILESTONES
// (every-5 level, rare+ loot, death, boss), and the chat callout is throttled
// hard (per-login + global) and only for the biggest events.

import { RARITY_RANK } from "../shared/constants.js";

const CALLOUT_COOLDOWN_MS = Number(process.env.CALLOUT_COOLDOWN_MS) || 45_000; // per-login
const CALLOUT_GLOBAL_GAP_MS = Number(process.env.CALLOUT_GLOBAL_GAP_MS) || 6_000; // protect chat rate limits
const COOLDOWN_MAP_MAX = 5000;
const lastCalloutAt = new Map();
let lastGlobalAt = 0;

function calloutThrottled(login, now) {
  if (now - lastGlobalAt < CALLOUT_GLOBAL_GAP_MS) return true;
  const prev = lastCalloutAt.get(login) || 0;
  if (now - prev < CALLOUT_COOLDOWN_MS) return true;
  // delete-then-set so this login re-inserts as the NEWEST entry — otherwise a
  // long-lived chatter (inserted early) keeps their original map position and
  // their fresh timestamp could be evicted in the same call, bypassing the cooldown.
  lastCalloutAt.delete(login);
  lastCalloutAt.set(login, now);
  lastGlobalAt = now;
  if (lastCalloutAt.size > COOLDOWN_MAP_MAX) {
    const drop = Math.ceil(COOLDOWN_MAP_MAX * 0.1);
    let i = 0;
    for (const k of lastCalloutAt.keys()) {
      lastCalloutAt.delete(k);
      if (++i >= drop) break;
    }
  }
  return false;
}

const rank = (r) => RARITY_RANK[r] ?? -1;

// Highest-rarity item from the tick's loot, or null.
function bestLoot(loot) {
  let best = null;
  for (const it of loot || []) if (!best || rank(it.rarity) > rank(best.rarity)) best = it;
  return best;
}

// Build the single biggest-moment chat line, or null. Priority:
// death > legendary+ loot > boss clear > milestone level.
function bigMoment(ev, name) {
  if (ev.death) {
    const s = ev.death.summary || {};
    return `💀 ${name} fell to ${ev.death.deathBy} — Lv ${s.level || ev.level}, depth ${s.depth || ev.depth}. +${ev.death.prestigeGained} prestige. The abyss claims another.`;
  }
  const loot = bestLoot(ev.loot);
  if (loot && rank(loot.rarity) >= rank("legendary")) {
    return `✨ ${name} pulled a ${String(loot.rarity).toUpperCase()} ${loot.name} from the abyss!`;
  }
  if (ev.boss) return `⚔️ ${name} cleared a zone boss in the abyss!`;
  if (ev.leveled && (ev.newLevel % 10 === 0 || ev.newLevel === 5)) {
    return `📈 ${name} reached Level ${ev.newLevel} — just by chatting. !sigma to see them.`;
  }
  return null;
}

// Returns { frames:[...], feedEntries:[...], say:string|null }. `allowCallout`
// is false on a ping that ALSO carried a chat !command — that command's
// reply owns the chat line, so we skip the delve callout entirely (and don't
// burn a throttle slot on a `say` the bridge would discard anyway).
export function delveFeedback(ev, { login, name, now, allowCallout = true }) {
  const out = { frames: [], feedEntries: [], say: null };
  if (!ev) return out;
  const who = name || login;

  if (ev.leveled) {
    out.frames.push({
      t: "levelUp",
      login,
      name: who,
      level: ev.newLevel,
      levelsGained: ev.levelsGained,
      at: now,
    });
    if (ev.newLevel % 5 === 0 || ev.newLevel <= 5) {
      out.feedEntries.push({
        kind: "milestone",
        name: who,
        login,
        label: `reached Level ${ev.newLevel}`,
      });
    }
  }

  const loot = bestLoot(ev.loot);
  if (loot && rank(loot.rarity) >= rank("rare")) {
    if (rank(loot.rarity) >= rank("legendary")) {
      out.feedEntries.push({ kind: "legendary", name: who, login, item: loot.name });
    } else {
      out.feedEntries.push({
        kind: "milestone",
        name: who,
        login,
        label: `found a ${loot.rarity} ${loot.name}`,
      });
    }
  }

  if (ev.boss) {
    out.feedEntries.push({ kind: "milestone", name: who, login, label: "cleared a zone boss" });
  }

  if (ev.death) {
    out.frames.push({
      t: "delveDeath",
      login,
      name: who,
      deathBy: ev.death.deathBy,
      level: ev.death.summary?.level || ev.level,
      depth: ev.death.summary?.depth || ev.depth,
      prestigeGained: ev.death.prestigeGained,
      at: now,
    });
    // resolveDeath's feedEntry is {kind:'death', name, detail}; add killedBy so
    // the overlay's formatFeed renders "fell to <killer>" instead of "the abyss".
    out.feedEntries.push({ ...ev.death.feedEntry, killedBy: ev.death.deathBy, login });
  }

  const moment = allowCallout ? bigMoment(ev, who) : null;
  if (moment && !calloutThrottled(login, now)) out.say = moment;
  return out;
}
