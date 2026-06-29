// SIGMA ABYSS — procedural chiptune SFX + layered combat stems.
//
// No audio files — every sound is synthesised at request time. Defaults
// to MUTED: an OBS browser source pipes audio into the stream mix, so
// the streamer opts in. A player on their own screen just hits the ♪
// button.
//
// Two surfaces:
//
//   sfx.<one-shot>()      legacy callers (game.js, ui.js) — unchanged.
//   playStem(id, opts)    manifest-driven layered stems. Each ID is a
//                         stack of 1–3 oscillator/noise voices that read
//                         as a "wind-up / impact / aftermath" beat in
//                         a combat timeline (see fx-manifest.js).
//
// fx-music.js owns the adaptive music state machine and pulls the audio
// context + dedicated music bus from getCtx() / getMusicBus().

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let muted = true;

function ensure() {
  if (ctx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    sfxBus = ctx.createGain();
    // SFX kept VERY low — on the stream mix, viewers were hearing a loud noise
    // on every single hit. This bus scales every sound effect (hits, kills,
    // potions, voice chirps) but NOT music (which has its own bus), so combat
    // stays a soft texture under the music instead of a barrage.
    sfxBus.gain.value = 0.14;
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.55;
    sfxBus.connect(master);
    musicBus.connect(master);
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
}

export function setMuted(m) {
  muted = !!m;
  if (!muted) {
    ensure();
    if (ctx && ctx.state === "suspended") ctx.resume();
  }
}
export function isMuted() {
  return muted;
}
export function toggleMuted() {
  setMuted(!muted);
  return muted;
}

// fx-music pulls these to wire its own layer graph onto the shared bus.
export function getCtx() {
  ensure();
  return ctx;
}
export function getMusicBus() {
  ensure();
  return musicBus;
}

// ── primitive voices ─────────────────────────────────────────────────
function blip(freq, dur, type = "square", vol = 0.5, slideTo = null, bus = null) {
  if (muted) return;
  ensure();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
  g.gain.setValueAtTime(Math.max(0.0001, vol), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(bus || sfxBus || master);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

function noise(dur, vol = 0.4, lowpass = 1800, bus = null) {
  if (muted) return;
  ensure();
  if (!ctx) return;
  const t = ctx.currentTime;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) ch[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = lowpass;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(0.0001, vol), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(lp);
  lp.connect(g);
  g.connect(bus || sfxBus || master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function chord(freqs, dur, type = "square", vol = 0.45, gap = 60) {
  freqs.forEach((f, i) => setTimeout(() => blip(f, dur, type, vol), i * gap));
}

// ── layered combat stems — referenced by manifest IDs ────────────────
// Each one stacks 1–3 voices to read as a real combat beat instead of
// one square-wave "blip". The combat manifest schedules these on
// authored ms offsets so wind-up / impact / aftermath have spacing.
const STEMS = {
  // hero attacks
  swing_light() {
    blip(330, 0.05, "triangle", 0.18, 540);
    noise(0.04, 0.1, 2400);
  },
  swing_heavy() {
    blip(140, 0.1, "sawtooth", 0.32, 70);
    noise(0.08, 0.22, 1600);
  },
  impact_light() {
    // Soft, short tick — a connecting hit reads without thumping the mix.
    blip(180, 0.05, "square", 0.2, 110);
    noise(0.04, 0.12, 900);
  },
  impact_heavy() {
    blip(70, 0.16, "sawtooth", 0.48, 32);
    blip(420, 0.08, "square", 0.3, 110);
    noise(0.1, 0.36, 600);
  },
  impact_tail() {
    noise(0.18, 0.08, 500);
  },
  impact_zap() {
    blip(880, 0.06, "sawtooth", 0.3, 240);
    blip(1320, 0.05, "square", 0.22, 380);
  },
  crit_charge() {
    blip(220, 0.16, "triangle", 0.18, 660);
  },
  crit_tail() {
    blip(880, 0.18, "sine", 0.1, 1320);
  },
  overload_zap() {
    blip(660, 0.05, "sawtooth", 0.22, 1320);
  },

  // enemy attacks
  enemy_swing() {
    noise(0.05, 0.14, 1400);
  },
  enemy_impact() {
    // Soft thud — an enemy connecting reads without booming the mix.
    blip(110, 0.07, "sawtooth", 0.2, 70);
    noise(0.05, 0.12, 700);
  },
  thorn_zing() {
    blip(1100, 0.06, "triangle", 0.18, 2200);
  },
  miss() {
    blip(300, 0.04, "triangle", 0.18);
  },

  // results
  kill_pop() {
    blip(330, 0.1, "square", 0.36, 540);
  },
  kill_tail() {
    noise(0.18, 0.1, 1200);
  },

  // sustain / heal / rally
  potion_glug() {
    blip(420, 0.1, "triangle", 0.32, 720);
    blip(540, 0.1, "triangle", 0.22, 880);
  },
  rally_charge() {
    blip(140, 0.4, "triangle", 0.18, 280);
  },
  rally_burst() {
    chord([523, 659, 784, 1046], 0.18, "square", 0.36, 60);
  },

  // status
  hex_shimmer() {
    blip(880, 0.1, "sine", 0.22, 540);
    blip(1320, 0.1, "sine", 0.16, 880);
  },
  curse_whisper() {
    noise(0.32, 0.2, 380);
    blip(110, 0.32, "sawtooth", 0.18, 70);
  },
  steal_yoink() {
    blip(660, 0.1, "sawtooth", 0.3, 200);
    blip(220, 0.06, "triangle", 0.18, 110);
  },
  retreat() {
    blip(340, 0.18, "triangle", 0.34, 180);
  },

  // death
  death_low() {
    blip(140, 0.5, "sawtooth", 0.5, 38);
    noise(0.4, 0.18, 280);
  },
  death_tail() {
    noise(0.6, 0.1, 200);
  },

  // boss entrance
  boss_rumble() {
    noise(0.6, 0.32, 140);
    blip(48, 0.6, "sawtooth", 0.4, 36);
  },
  boss_footstep() {
    blip(60, 0.18, "sawtooth", 0.36, 38);
    noise(0.1, 0.22, 220);
  },
  boss_slam() {
    blip(40, 0.4, "sawtooth", 0.6, 28);
    noise(0.3, 0.42, 380);
    blip(880, 0.06, "square", 0.18, 220);
  },

  // power-up flavors
  berserk_pulse() {
    blip(80, 0.1, "sawtooth", 0.12, 70);
  },
  blood_sip() {
    blip(220, 0.06, "sine", 0.1, 440);
  },
  vamp_drain() {
    blip(330, 0.18, "sine", 0.22, 660);
    blip(440, 0.18, "sine", 0.16, 880);
  },
  luck_chime() {
    blip(1320, 0.06, "triangle", 0.1, 1760);
  },
  midas_chime() {
    chord([784, 988, 1175], 0.1, "triangle", 0.2, 40);
  },
};

// Per-sigma "voice" blip for a bark bubble — a tiny two-note chirp pitched
// from the character seed so each sigma reads as having its own little voice
// (Animal-Crossing / Undertale text-blip energy). Deliberately quiet so it
// charms instead of grating. Muted-gated like every other voice.
export function voiceBlip(seed = 0) {
  if (muted) return;
  ensure();
  if (!ctx) return;
  const base = 300 + ((seed >>> 0) % 9) * 34; // 300..572 Hz, stable per sigma
  blip(base, 0.035, "square", 0.12, base * 1.1);
  setTimeout(() => blip(base * 1.16, 0.03, "triangle", 0.1, base * 1.28), 52);
}

export function playStem(id, opts = {}) {
  const fn = STEMS[id];
  if (!fn) return;
  const prev = master?.gain.value;
  if (opts && typeof opts.vol === "number" && master) {
    // local one-shot gain ride — clamp on the master for the duration of
    // this call only. Cheap and correct because every voice samples the
    // current gain value at the moment it's scheduled.
    master.gain.value = Math.max(0.02, Math.min(1, prev * (opts.vol / 0.3)));
    fn();
    master.gain.value = prev;
  } else {
    fn();
  }
}

// ── legacy one-shot surface (game.js, ui.js) — DO NOT BREAK ─────────
export const sfx = {
  hit() {
    playStem("impact_light");
  },
  crit() {
    playStem("impact_heavy");
  },
  enemyHit() {
    playStem("enemy_impact");
  },
  miss() {
    playStem("miss");
  },
  kill() {
    playStem("kill_pop");
  },
  loot(rank = 0) {
    blip(440 + rank * 85, 0.14, "triangle", 0.45, 660 + rank * 130);
  },
  levelUp() {
    chord([523, 659, 784], 0.16, "square", 0.5, 70);
  },
  bossWarn() {
    playStem("boss_rumble");
  },
  death() {
    playStem("death_low");
  },
  deploy() {
    blip(260, 0.12, "square", 0.4, 420);
  },
  retreat() {
    playStem("retreat");
  },
  bank() {
    chord([392, 523, 659], 0.12, "triangle", 0.4, 55);
  },
  ascend() {
    chord([523, 659, 784, 1046], 0.2, "square", 0.5, 90);
  },
  ui() {
    blip(520, 0.03, "triangle", 0.15);
  },
};
