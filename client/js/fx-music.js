// SIGMA ABYSS — adaptive procedural music state machine.
//
// Four crossfaded layers sharing one BPM grid, all routed through the
// shared musicBus in audio.js. Layers are continuous oscillator chains
// whose gains we ramp; "phase" is just which set of gains we lift.
//
//   exploration  ambient pad     — town + delve idle
//   combat       4-on-the-floor  — fades in for any encounter, intensity-driven
//   boss         deeper pad      — replaces exploration when a boss is up
//   critical     heartbeat       — fades in when fighter HP < 25%
//
// No samples; perc layer schedules its own oscillator hits a bar ahead
// of the audio clock to stay stable when the tab loses focus and the
// setTimeout scheduler stutters.

import { getCtx, getMusicBus, isMuted } from "./audio.js";

const BPM = 110;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const LOOKAHEAD_BARS = 1.5; // schedule this much ahead of currentTime
const TICK_MS = Math.round(BAR * 1000 * 0.5);

let layers = null;
let phase = "idle"; // idle | town | delve | combat | boss
let intensity = 0;
let critical = false;
let schedAt = 0;
let timerId = 0;

function ensureLayers() {
  if (layers) return layers;
  if (isMuted()) return null;
  const ctx = getCtx();
  if (!ctx) return null;
  const bus = getMusicBus();
  layers = {
    exploration: makePad(ctx, bus, [165, 247, 311], "sine", 1100),
    combat: makePercBus(ctx, bus),
    boss: makePad(ctx, bus, [110, 165, 220, 277], "sawtooth", 700),
    critical: makeHeartbeatBus(ctx, bus),
  };
  schedAt = ctx.currentTime + 0.05;
  scheduleAhead();
  return layers;
}

function makePad(ctx, bus, freqs, type, lpHz) {
  const g = ctx.createGain();
  g.gain.value = 0.0;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = lpHz;
  lp.Q.value = 0.6;
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const og = ctx.createGain();
    og.gain.value = (1 / freqs.length) * 0.5;
    // slow LFO detune so the pad breathes
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.15;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 1.5;
    lfo.connect(lfoGain);
    lfoGain.connect(o.detune);
    lfo.start();
    o.connect(og);
    og.connect(lp);
    o.start();
  }
  lp.connect(g);
  g.connect(bus);
  return { g };
}

function makePercBus(ctx, bus) {
  const g = ctx.createGain();
  g.gain.value = 0.0;
  g.connect(bus);
  return { g, ctx };
}

function makeHeartbeatBus(ctx, bus) {
  const g = ctx.createGain();
  g.gain.value = 0.0;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  lp.Q.value = 0.3;
  lp.connect(g);
  g.connect(bus);
  return { g, lp, ctx };
}

function playAt(ctx, bus, when, freq, dur, type, vol) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g);
  g.connect(bus);
  o.start(when);
  o.stop(when + dur + 0.04);
}

function noiseAt(ctx, bus, when, dur, vol, lowpass) {
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
  g.gain.setValueAtTime(Math.max(0.0001, vol), when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(lp);
  lp.connect(g);
  g.connect(bus);
  src.start(when);
  src.stop(when + dur + 0.04);
}

function schedulePercBar(ctx, at) {
  const bus = layers.combat.g;
  // 4-on-the-floor sawtooth thumps + an off-beat hat-ish noise pop.
  playAt(ctx, bus, at + 0, 60, 0.08, "sawtooth", 0.55);
  playAt(ctx, bus, at + BEAT, 60, 0.06, "sawtooth", 0.34);
  playAt(ctx, bus, at + BEAT * 2, 60, 0.08, "sawtooth", 0.55);
  playAt(ctx, bus, at + BEAT * 3, 60, 0.06, "sawtooth", 0.34);
  noiseAt(ctx, bus, at + BEAT * 2.5, 0.04, 0.12, 4500);
}

function scheduleHeartbeatBar(ctx, at) {
  const bus = layers.critical.g;
  // double-thump heartbeat — lub-dub at half-bar intervals
  for (let i = 0; i < 2; i += 1) {
    playAt(ctx, bus, at + i * BAR * 0.5, 70, 0.1, "sine", 0.65);
    playAt(ctx, bus, at + i * BAR * 0.5 + 0.18, 60, 0.12, "sine", 0.55);
  }
}

function scheduleAhead() {
  if (!layers) return;
  const ctx = getCtx();
  if (!ctx) return;
  while (schedAt < ctx.currentTime + BAR * LOOKAHEAD_BARS) {
    schedulePercBar(ctx, schedAt);
    scheduleHeartbeatBar(ctx, schedAt);
    schedAt += BAR;
  }
  clearTimeout(timerId);
  timerId = setTimeout(scheduleAhead, TICK_MS);
}

function ramp(node, target, dur = 0.6) {
  if (!node) return;
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  node.gain.cancelScheduledValues(t);
  node.gain.setValueAtTime(node.gain.value, t);
  node.gain.linearRampToValueAtTime(target, t + dur);
}

function applyMix() {
  if (!layers) return;
  const expOn = phase === "town" || phase === "delve" || phase === "combat";
  const combOn = phase === "combat" || phase === "boss";
  const bossOn = phase === "boss";
  ramp(layers.exploration.g, expOn ? 0.32 : 0);
  ramp(layers.combat.g, combOn ? 0.25 + 0.45 * intensity : 0);
  ramp(layers.boss.g, bossOn ? 0.42 : 0);
  ramp(layers.critical.g, critical ? 0.55 : 0);
}

export const music = {
  setPhase(name) {
    phase = name;
    if (isMuted()) return;
    if (!ensureLayers()) return;
    applyMix();
  },
  setIntensity(x) {
    intensity = Math.max(0, Math.min(1, x));
    applyMix();
  },
  setCriticalHp(on) {
    critical = !!on;
    applyMix();
  },
  // Hard mute — used at the start of the boss intro to create silence
  // before the slam. Layers come back on the next applyMix().
  cut() {
    if (!layers) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const k of ["exploration", "combat", "boss", "critical"]) {
      const g = layers[k].g;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0.0, t + 0.05);
    }
  },
  // Future hook for musical stings on rare events (rally, death). The
  // FSM is the right home; today it's a stub so the manifest doesn't
  // need to know whether stings are wired yet.
  sting(_kind) {
    /* no-op */
  },
  // Re-prime the layer graph after the user unmutes — until then the
  // shared audio context is closed and ensureLayers() bails. Calling
  // setPhase later wouldn't catch up, so the unmute handler pokes this.
  refresh() {
    if (isMuted()) return;
    if (!ensureLayers()) return;
    applyMix();
  },
};
