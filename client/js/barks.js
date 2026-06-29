// SIGMA ABYSS — self-driven battle dialogue ("barks").
//
// Pure PRESENTATION. The sigma blurts a funny one-liner over its head while
// fighting, kiting, looting, panicking, and dying — even when the player is
// silent and never types in chat. This is NOT part of shared/ → it never
// touches the deterministic sim, so it is free to use the JS RNG.
//
// One bubble is shown at a time (global), throttled per-category so the barks
// punctuate the action instead of spamming it. combat-view.js draws the
// bubble over the hero during a fight; world.js draws it over the sigma while
// it walks the delve. They are mutually exclusive (the loop renders one scene
// or the other) so a single global bubble is all we need.
//
// The line bank was authored + judged by a 5-voice comedy workflow
// (gigachad / doomer / rage-gamer / deadpan-corporate / anime-protagonist).

import { voiceBlip } from "./audio.js";

// ── the line bank ──────────────────────────────────────────────────────
const BANK = {
  deploy: [
    "Abyss? More like cardio.",
    "Sigmas don't tutorial.",
    "queue popped, lets go",
    "Marching to my doom.",
    "main character energy",
    "Deploying to prod.",
    "Time to go plus ultra!",
    "Already regret this.",
    "Witness me, weak monsters.",
    "send it boys",
  ],
  idle: [
    "Grindset never sleeps.",
    "bro where the mobs",
    "Bored to literal death.",
    "afk dont report me",
    "Quiet quitting active.",
    "Training arc, but nap.",
    "this zone is dead lol",
    "Mouse-jiggler mode.",
    "Even villains need lunch.",
    "Loot drought arc.",
  ],
  hit: [
    "Skill issue, monster.",
    "tickle damage lmao",
    "Cope, monster.",
    "FALCON... whatever!",
    "Ticket closed.",
    "get poked nerd",
    "That's for existing.",
    "DPS check passed",
    "Eat hope, monster!",
    "ratio + L + hit",
  ],
  crit: [
    "BUILT DIFFERENT!",
    "deleted his hp bar",
    "Crit? In THIS economy?",
    "Employee of the month.",
    "OVER 9000, baby!",
    "yellow text gang",
    "RNG loves me",
    "NANI?! That was ME?!",
    "Raise me NOW.",
    "PLUS ULTRA SMACK!",
  ],
  kill: [
    "Cope, seethe, despawn.",
    "uninstall the mob",
    "Sent to the shadow realm.",
    "Offboarded.",
    "report him for dying",
    "Omae wa mou... dead.",
    "Rest in pieces, I guess.",
    "back to lobby loser",
    "You weren't even canon.",
    "Headcount reduced.",
  ],
  hurt: [
    "All according to plan.",
    "Lag. Definitely lag.",
    "i was afk i swear",
    "Above my pay grade!",
    "Cute. Do it again.",
    "Filing a complaint.",
    "Nani?! It hit back?!",
    "ow my pixels",
    "Scope creep!",
    "Tch! Lucky shot, fiend!",
  ],
  lowHp: [
    "Strategic low HP, bro.",
    "This is fine. Trust.",
    "im cooked help",
    "Comeback arc loading.",
    "Running on spite now.",
    "PTO REQUEST URGENT.",
    "Plot armor, do your job!",
    "where heals WHERE",
    "HERO down! HERO DOWN!",
    "Resignation pending!",
  ],
  potion: [
    "Hydration check, bro.",
    "chug chug CHUG",
    "Cracked open a cold W.",
    "Senzu bean, GULP!",
    "Drinking my problems.",
    "potion diff get good",
    "Wellness break!",
    "Tastes like regret.",
    "panic sip lmao",
    "Coffee, I mean potion.",
  ],
  recall: [
    "Tactical retreat, bro.",
    "Catch you in NG+.",
    "nope teleporting bye",
    "Coward? Yes. Alive too.",
    "Working from home.",
    "Teleport jutsu, GO!",
    "abort abort ABORT",
    "I'm taking PTO. Now.",
    "Sequel hook, BAIL!",
    "smoke break, monster",
  ],
  flee: [
    "Kiting is a flex.",
    "run forrest run",
    "Strategic moonwalk.",
    "Nope nope nope.",
    "Parking lot it!",
    "Smell ya later, fiend!",
    "catch me lagging",
    "Out for lunch.",
    "Not flee. Repositioning!",
    "strategic yeet",
  ],
  boss: [
    "Finally, a warmup.",
    "He's mid, just tall.",
    "thats a big nope",
    "Oh great, the CEO.",
    "NANI?! It's HUGE!",
    "im not paid for this",
    "Boss music. My funeral.",
    "This is a P0.",
    "My rival... at last!",
    "Cue dramatic close-up!",
  ],
  loot: [
    "Loot? I deserve loot.",
    "Drip secured, bro.",
    "orange text POG",
    "Loot? For ME? Suspicious.",
    "Quarterly bonus!",
    "The chosen loot chose ME!",
    "shiny mine MINE",
    "Severance package!",
    "Cope, but it's purple.",
    "New gear, new arc!",
  ],
  levelUp: [
    "Gains unlocked, bro.",
    "DING get good",
    "Level up. Suffering up.",
    "Senior Sigma now.",
    "ASCENSION, baby!",
    "stronger than u now",
    "I peaked. Downhill now.",
    "Leveled my LinkedIn.",
    "power creep me",
    "My aura got a glow-up!",
  ],
  death: [
    "Strategic respawn, bro.",
    "Sigmas don't die. AFK.",
    "GG no re lol",
    "Death. My old friend.",
    "I'm putting in notice.",
    "Permadeath? PERMA-NANI?!",
    "lag killed me fr",
    "Ticket: won't fix.",
    "Avenge me, side chars!",
    "Finally. Some peace.",
  ],
  victory: [
    "Easy. Next zone.",
    "Chat, clip that.",
    "GG EZ, frame it.",
    "Victory tastes like dread.",
    "Project shipped!",
    "BELIEVE IT, I WON!",
    "boss got ratiod",
    "Boss offboarded!",
    "That was my SECOND form!",
    "carried myself fr",
  ],
};

// Border tint per mood — the bubble edge colour signals the beat.
const CAT_TINT = {
  deploy: "#9aa4b2",
  idle: "#7b8096",
  hit: "#ff9d2e",
  crit: "#ffd24a",
  kill: "#ff9d2e",
  hurt: "#ff4d6d",
  lowHp: "#ff4d6d",
  potion: "#5bd16a",
  recall: "#4aa3ff",
  flee: "#4aa3ff",
  boss: "#b86bff",
  loot: "#ffe44d",
  levelUp: "#ffd24a",
  death: "#ff4d6d",
  victory: "#5bd16a",
};

// Per-category minimum spacing — frequent beats (hit/hurt) can repeat sooner,
// idle quips stay rare so the walk doesn't turn into a monologue.
const CAT_GAP = {
  default: 2600,
  hit: 1500,
  hurt: 1400,
  crit: 1200,
  kill: 1700,
  idle: 5400,
};
const GLOBAL_GAP = 650; // ms — min spacing between ANY two barks
const VOICE_GAP = 500; // ms — min spacing between voice chirps (forced barks skip the text throttle, so the voice gets its own)
const LIFE = 1500; // ms a bubble lives by default

let active = null; // { text, cat, born, life }
const lastByCat = {}; // cat -> last line shown (avoid an immediate repeat)
const nextOkByCat = {}; // cat -> earliest perf.now() this cat may bark again
let lastAnyAt = 0; // perf.now() of the most recent bark of any kind
let lastVoiceAt = 0; // perf.now() of the most recent voice chirp
let voiceSeed = 0; // per-sigma pitch for the voice blip

const nowMs = () => performance.now();
const rand = (n) => Math.floor(Math.random() * n);

// Set the speaking sigma's voice pitch (called when the character loads).
export function setVoice(seed) {
  voiceSeed = (seed | 0) >>> 0;
}

// Try to say a line from `cat`. Respects the throttle unless opts.force.
// Returns the chosen line (or null if throttled / unknown category).
export function say(cat, opts = {}) {
  const lines = BANK[cat];
  if (!lines?.length) return null;
  const t = nowMs();
  if (!opts.force) {
    if (t < lastAnyAt + GLOBAL_GAP) return null;
    if (t < (nextOkByCat[cat] || 0)) return null;
    if (typeof opts.chance === "number" && Math.random() > opts.chance) return null;
  }
  let line = lines[rand(lines.length)];
  if (lines.length > 1) {
    let guard = 0;
    while (line === lastByCat[cat] && guard++ < 6) line = lines[rand(lines.length)];
  }
  lastByCat[cat] = line;
  active = { text: line, cat, born: t, life: opts.life || LIFE };
  lastAnyAt = t;
  nextOkByCat[cat] = t + (CAT_GAP[cat] || CAT_GAP.default);
  // Voice has its OWN throttle: forced barks (death/recall/loot/…) bypass the
  // text gap, so without this a burst of forced barks would chirp rapidly.
  if (opts.voice !== false && t >= lastVoiceAt + VOICE_GAP) {
    lastVoiceAt = t;
    voiceBlip(voiceSeed);
  }
  return line;
}

// Clear the active bubble (called when a scene hands off, e.g. fight starts).
export function reset() {
  active = null;
}

export function isActive() {
  return !!active;
}

// ── rounded-rect helper (manual — avoids relying on ctx.roundRect) ──────
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function easeOutBack(p) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = p - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function activeScale(active, t, extraScale = 1) {
  const popT = Math.min(1, (t - active.born) / 140);
  return (0.6 + 0.4 * easeOutBack(popT)) * extraScale;
}

function measureBubble(ctx, active, t, extraScale = 1) {
  const scale = activeScale(active, t, extraScale);
  ctx.save();
  ctx.font = "bold 22px JetBrains Mono, monospace";
  const tw = ctx.measureText(active.text).width;
  ctx.restore();
  return {
    width: (tw + 32) * scale,
    height: 58 * scale,
  };
}

// Draw the active bubble with its tail tip anchored at (cx, anchorY) — pass
// the y a little above the sigma's head. No-op when no bubble is active.
export function draw(ctx, cx, anchorY, t) {
  if (!active) return;
  if ((t - active.born) / active.life >= 1) {
    active = null;
    return;
  }
  paintBubble(ctx, active, cx, anchorY, t);
}

// Paint one bubble at (cx, anchorY). Split out of draw() so the per-speaker
// arena layer (drawFor) reuses the EXACT same look. `extraScale` shrinks the
// whole bubble for tight surfaces (the arena Game-Bar strip / barMode).
function paintBubble(ctx, active, cx, anchorY, t, extraScale = 1) {
  const age = (t - active.born) / active.life;
  const scale = activeScale(active, t, extraScale);
  const op = age > 0.78 ? Math.max(0, 1 - (age - 0.78) / 0.22) : 1;
  const tint = CAT_TINT[active.cat] || "#41415d";
  const text = active.text;
  const bob = Math.sin(t / 260) * 2;

  ctx.save();
  ctx.globalAlpha = op;
  ctx.translate(cx, anchorY + bob);
  ctx.scale(scale, scale);

  ctx.font = "bold 22px JetBrains Mono, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const tw = ctx.measureText(text).width;
  const padX = 16;
  const bw = tw + padX * 2;
  const bh = 40;
  const bx = -bw / 2;
  const by = -bh - 14; // body sits above the (0,0) tail tip

  // tail (draw first so the body outline sits on top of its base)
  ctx.beginPath();
  ctx.moveTo(-10, by + bh - 1);
  ctx.lineTo(10, by + bh - 1);
  ctx.lineTo(0, 4);
  ctx.closePath();
  ctx.fillStyle = "#0c0c16f2";
  ctx.fill();

  // body
  roundRectPath(ctx, bx, by, bw, bh, 9);
  ctx.fillStyle = "#0c0c16f2";
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = tint;
  ctx.shadowColor = tint;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // re-stroke the tail edges so they read as one shape with the body
  ctx.beginPath();
  ctx.moveTo(-10, by + bh - 1);
  ctx.lineTo(0, 4);
  ctx.lineTo(10, by + bh - 1);
  ctx.strokeStyle = tint;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // text
  ctx.fillStyle = "#f4f5fb";
  ctx.fillText(text, 0, by + bh / 2 + 7);
  ctx.restore();
}

// ── per-speaker layer (the arena overlay: many chatters fighting at once) ─
// The global say()/draw()/reset() above suit the single-player client, whose
// loop only ever shows ONE hero. The arena spectator (overlay/arena) paints
// EVERY chatter duelling their own foe at the same time, so it needs one bubble
// + throttle PER chatter. Same BANK / tints / spacing; all state keyed by the
// chatter login. (Mirrors the per-speaker barks in the chat-elixir
// vibe-coder-sim overlay — both surfaces show several heads at once.)
const speakers = new Map(); // id → { active, lastByCat, nextOkByCat, lastAnyAt }

function speakerState(id) {
  let s = speakers.get(id);
  if (!s) {
    s = { active: null, lastByCat: {}, nextOkByCat: {}, lastAnyAt: 0 };
    speakers.set(id, s);
  }
  return s;
}

// Per-speaker say(): same throttle as say(), but independent per `id`. Silent
// (no voiceBlip) by design — a whole screen of chatters chirping is noise.
export function sayFor(id, cat, opts = {}) {
  const lines = BANK[cat];
  if (!lines?.length) return null;
  const s = speakerState(id);
  const t = nowMs();
  if (!opts.force) {
    if (t < s.lastAnyAt + GLOBAL_GAP) return null;
    if (t < (s.nextOkByCat[cat] || 0)) return null;
    if (typeof opts.chance === "number" && Math.random() > opts.chance) return null;
  }
  let line = lines[rand(lines.length)];
  if (lines.length > 1) {
    let guard = 0;
    while (line === s.lastByCat[cat] && guard++ < 6) line = lines[rand(lines.length)];
  }
  s.lastByCat[cat] = line;
  s.active = { text: line, cat, born: t, life: opts.life || LIFE };
  s.lastAnyAt = t;
  s.nextOkByCat[cat] = t + (CAT_GAP[cat] || CAT_GAP.default);
  return line;
}

// Forget a speaker's bubble + throttle (call when a chatter leaves the roster).
export function resetFor(id) {
  if (id == null) {
    speakers.clear();
    return;
  }
  speakers.delete(id);
}

export function measureFor(ctx, id, t, extraScale = 1) {
  const s = speakers.get(id);
  if (!s?.active) return null;
  if ((t - s.active.born) / s.active.life >= 1) {
    s.active = null;
    return null;
  }
  return measureBubble(ctx, s.active, t, extraScale);
}

// Draw `id`'s active bubble. Same look as draw(); `extraScale` lets the arena
// shrink it on the tight Game-Bar strip. No-op when that speaker has none.
export function drawFor(ctx, id, cx, anchorY, t, extraScale = 1) {
  const s = speakers.get(id);
  if (!s?.active) return;
  if ((t - s.active.born) / s.active.life >= 1) {
    s.active = null;
    return;
  }
  paintBubble(ctx, s.active, cx, anchorY, t, extraScale);
}
