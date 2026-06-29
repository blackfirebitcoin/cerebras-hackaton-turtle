// SIGMA ABYSS — combat FX manifest (the skill DSL).
//
// Every combat verb in shared/combat.js's event log expands here into
// a list of authored sub-events with ms offsets. This is THE file to
// edit when retuning combat feel — the renderer (combat-view.js), the
// audio bank (audio.js), the music state machine (fx-music.js), and
// the text FX (fx-text.js) all subscribe to the sub-event types this
// file emits. No renderer code needs to change to add a new skill.
//
// Sub-event types the renderer understands:
//   sfx       { id, vol? }                     — named stem in audio.js
//   lunge     { actor: 'hero'|'enemy', amount }
//   flash     { actor: 'hero'|'enemy', strong? }
//   hpDelta   { target: 'hero'|'enemy' }       — applies the base event's amt
//   kill      { target: 'enemy' }
//   shake     { intensity 0..1 }
//   aura      { actor, color, dur, strong? }
//   darken    { amount 0..1, dur }
//   text      { text? | source:'amount', style, side:'hero'|'enemy', prefix?, suffix? }
//   music     { cmd:'cut'|'phase'|'sting', value? }
//   alert     { actor:'enemy', dur }           — "!" aggro mark over the attacker
//   telegraph { actor:'enemy', dur }           — growing AoE danger zone at the hero
//   projectile{ actor:'enemy', count?, flight? }— bullet-hell bolts attacker→hero

// Variant selector — crits & magic strikes pick alternate timelines.
export function eventKey(ev) {
  if (ev.t === "hit" && ev.crit) return "hit_crit";
  if (ev.t === "overload") return ev.crit ? "overload_crit" : "overload";
  return ev.t;
}

// ── base attack ───────────────────────────────────────────────────────
const HIT = {
  duration: 300,
  sub: [
    { t: 0, type: "lunge", actor: "hero", amount: 22 },
    { t: 0, type: "sfx", id: "swing_light" },
    { t: 90, type: "sfx", id: "impact_light" },
    { t: 90, type: "flash", actor: "enemy" },
    { t: 90, type: "hpDelta", target: "enemy" },
    { t: 90, type: "shake", intensity: 0.1 },
    { t: 100, type: "text", source: "amount", style: "normal", side: "enemy" },
    { t: 200, type: "sfx", id: "impact_tail", vol: 0.18 },
  ],
};

// ── crit — long wind-up, heavy stack, gold typography ────────────────
const HIT_CRIT = {
  duration: 520,
  sub: [
    { t: 0, type: "sfx", id: "crit_charge" },
    { t: 0, type: "aura", actor: "hero", color: "#ffd24a", dur: 240 },
    { t: 130, type: "lunge", actor: "hero", amount: 38 },
    { t: 130, type: "sfx", id: "swing_heavy" },
    { t: 240, type: "sfx", id: "impact_heavy" },
    { t: 240, type: "flash", actor: "enemy", strong: true },
    { t: 240, type: "hpDelta", target: "enemy" },
    { t: 240, type: "shake", intensity: 0.45 },
    { t: 250, type: "text", source: "amount", style: "crit", side: "enemy", suffix: "!" },
    { t: 420, type: "sfx", id: "crit_tail" },
  ],
};

// ── overload — Intellect bonus strike, magical flavor ────────────────
const OVERLOAD = {
  duration: 320,
  sub: [
    { t: 0, type: "sfx", id: "overload_zap" },
    { t: 0, type: "aura", actor: "hero", color: "#4aa3ff", dur: 200 },
    { t: 70, type: "sfx", id: "impact_zap" },
    { t: 70, type: "flash", actor: "enemy" },
    { t: 70, type: "hpDelta", target: "enemy" },
    { t: 70, type: "shake", intensity: 0.18 },
    { t: 90, type: "text", source: "amount", style: "magic", side: "enemy" },
  ],
};

const OVERLOAD_CRIT = {
  duration: 460,
  sub: [
    { t: 0, type: "sfx", id: "crit_charge" },
    { t: 0, type: "aura", actor: "hero", color: "#b86bff", dur: 240, strong: true },
    { t: 140, type: "sfx", id: "overload_zap" },
    { t: 220, type: "sfx", id: "impact_heavy" },
    { t: 220, type: "flash", actor: "enemy", strong: true },
    { t: 220, type: "hpDelta", target: "enemy" },
    { t: 220, type: "shake", intensity: 0.5 },
    { t: 240, type: "text", source: "amount", style: "crit", side: "enemy", suffix: "!" },
    { t: 380, type: "sfx", id: "crit_tail" },
  ],
};

// ── enemy attack on the sigma ────────────────────────────────────────
// Now telegraphed: a "!" pops over the attacker and a red AoE danger zone
// swells at the hero's feet (windup) BEFORE the lunge + bullet-hell bolts +
// impact land — so an enemy blow reads as a deliberate, dodge-foreshadowed
// strike instead of damage appearing from nowhere.
const ENEMYHIT = {
  duration: 500,
  sub: [
    { t: 0, type: "alert", actor: "enemy", dur: 460 },
    { t: 0, type: "telegraph", actor: "enemy", dur: 280 },
    { t: 0, type: "sfx", id: "boss_footstep", vol: 0.13 },
    { t: 280, type: "lunge", actor: "enemy", amount: 28 },
    { t: 280, type: "sfx", id: "enemy_swing" },
    { t: 280, type: "projectile", actor: "enemy", count: 3, flight: 120 },
    { t: 400, type: "sfx", id: "enemy_impact" },
    { t: 400, type: "flash", actor: "hero" },
    { t: 400, type: "hpDelta", target: "hero" },
    { t: 400, type: "shake", intensity: 0.2 },
    { t: 420, type: "text", source: "amount", style: "enemy", side: "hero" },
  ],
};

// Thornmail rebound. The hero doesn't swing — its armour deflects — so a tiny
// recoil (negative lunge = no slash anim) + a cyan deflect aura signal the
// SOURCE before the enemy flashes, otherwise the foe appears to lose HP for
// no reason right after landing its own hit.
const REFLECT = {
  duration: 220,
  sub: [
    { t: 0, type: "sfx", id: "thorn_zing" },
    { t: 0, type: "aura", actor: "hero", color: "#9be0ff", dur: 180 },
    { t: 0, type: "lunge", actor: "hero", amount: -8 },
    { t: 40, type: "flash", actor: "enemy" },
    { t: 40, type: "hpDelta", target: "enemy" },
    { t: 60, type: "text", source: "amount", style: "thorn", side: "enemy" },
  ],
};

const MISS = {
  duration: 200,
  sub: [
    { t: 0, type: "sfx", id: "miss" },
    { t: 0, type: "text", text: "MISS", style: "dim", side: "hero" },
  ],
};

const KILL = {
  duration: 460,
  sub: [
    { t: 0, type: "sfx", id: "kill_pop" },
    { t: 0, type: "kill", target: "enemy" },
    { t: 90, type: "sfx", id: "kill_tail" },
    { t: 100, type: "shake", intensity: 0.22 },
  ],
};

const POTION = {
  duration: 300,
  sub: [
    { t: 0, type: "sfx", id: "potion_glug" },
    { t: 0, type: "aura", actor: "hero", color: "#5bd16a", dur: 280 },
    { t: 70, type: "hpDelta", target: "hero" },
    { t: 90, type: "text", source: "amount", style: "heal", prefix: "+", side: "hero" },
  ],
};

// ── rally events — pause, silence, then a burst — psychological reset
const SECONDWIND = {
  duration: 820,
  sub: [
    { t: 0, type: "music", cmd: "sting", value: "rally" },
    { t: 0, type: "sfx", id: "rally_charge" },
    { t: 0, type: "darken", amount: 0.35, dur: 700 },
    { t: 360, type: "sfx", id: "rally_burst" },
    { t: 360, type: "aura", actor: "hero", color: "#5bd16a", dur: 560, strong: true },
    { t: 360, type: "hpDelta", target: "hero" },
    { t: 360, type: "shake", intensity: 0.35 },
    { t: 380, type: "text", text: "SECOND WIND", style: "banner_heal", side: "hero" },
  ],
};

const DEATHSAVE = {
  duration: 820,
  sub: [
    { t: 0, type: "music", cmd: "sting", value: "rally" },
    { t: 0, type: "sfx", id: "rally_charge" },
    { t: 0, type: "darken", amount: 0.45, dur: 700 },
    { t: 360, type: "sfx", id: "rally_burst" },
    { t: 360, type: "aura", actor: "hero", color: "#ffd24a", dur: 560, strong: true },
    { t: 360, type: "hpDelta", target: "hero" },
    { t: 360, type: "shake", intensity: 0.4 },
    { t: 380, type: "text", text: "DEATH SAVED", style: "banner_crit", side: "hero" },
  ],
};

const HEX = {
  duration: 320,
  sub: [
    { t: 0, type: "sfx", id: "hex_shimmer" },
    { t: 0, type: "aura", actor: "hero", color: "#b86bff", dur: 300 },
    { t: 100, type: "text", text: "HEXED", style: "magic", side: "hero" },
  ],
};

const CURSE = {
  duration: 420,
  sub: [
    { t: 0, type: "sfx", id: "curse_whisper" },
    { t: 0, type: "darken", amount: 0.28, dur: 400 },
    { t: 0, type: "aura", actor: "hero", color: "#ff4d6d", dur: 400, strong: true },
    { t: 90, type: "shake", intensity: 0.2 },
    { t: 140, type: "text", text: "CURSED", style: "banner_danger", side: "hero" },
  ],
};

const STEAL = {
  duration: 340,
  sub: [
    { t: 0, type: "sfx", id: "steal_yoink" },
    {
      t: 70,
      type: "text",
      text: (ev) => `STOLEN: ${ev?.item || "loot"}`,
      style: "loss",
      side: "hero",
    },
  ],
};

const FLEE = {
  duration: 580,
  sub: [
    { t: 0, type: "sfx", id: "retreat" },
    { t: 0, type: "lunge", actor: "hero", amount: -18 },
    { t: 60, type: "text", text: "DISENGAGE", style: "dim_banner", side: "hero" },
  ],
};

const DEATH = {
  duration: 1500,
  sub: [
    { t: 0, type: "music", cmd: "sting", value: "death" },
    { t: 0, type: "sfx", id: "death_low" },
    { t: 0, type: "darken", amount: 0.65, dur: 1300 },
    { t: 0, type: "shake", intensity: 0.55 },
    { t: 0, type: "hpDelta", target: "hero" },
    { t: 220, type: "text", text: "DOWN", style: "banner_danger", side: "hero" },
    { t: 900, type: "sfx", id: "death_tail" },
  ],
};

// ── weapon art — bestiary skill (flurry / gale_slash / seven_fold_cut / …) ──
// These deal real damage in shared/combat.js but had NO manifest entry, so the
// timeline emitted only a silent gap: the enemy's HP fell (or it died) with no
// lunge, flash, or damage number — the classic "got hit for no reason" read.
// A heavy lunge + skill-name call-out + flash + the now-applied hpDelta give
// the art a visible, hard-hitting beat.
const ART = {
  duration: 460,
  sub: [
    { t: 0, type: "sfx", id: "crit_charge" },
    { t: 0, type: "aura", actor: "hero", color: "#ffd24a", dur: 260, strong: true },
    { t: 40, type: "text", text: (ev) => ev.name || "ART", style: "magic", side: "hero" },
    { t: 120, type: "lunge", actor: "hero", amount: 34 },
    { t: 120, type: "sfx", id: "swing_heavy" },
    { t: 220, type: "sfx", id: "impact_heavy" },
    { t: 220, type: "flash", actor: "enemy", strong: true },
    { t: 220, type: "hpDelta", target: "enemy" },
    { t: 220, type: "shake", intensity: 0.34 },
    { t: 240, type: "text", source: "amount", style: "crit", side: "enemy", suffix: "!" },
    { t: 400, type: "sfx", id: "crit_tail" },
  ],
};

// Cleave splash (gale_slash's secondary target) — area spill, not a direct
// strike, so it flashes + chips the bystander's HP with a number but no hero
// lunge. Without this the splashed enemy silently lost HP off-screen.
const ART_SPLASH = {
  duration: 280,
  sub: [
    { t: 0, type: "sfx", id: "impact_light", vol: 0.5 },
    { t: 0, type: "flash", actor: "enemy" },
    { t: 0, type: "hpDelta", target: "enemy" },
    { t: 0, type: "shake", intensity: 0.12 },
    { t: 20, type: "text", source: "amount", style: "magic", side: "enemy" },
  ],
};

// ── VS auto-fire weapon hit ────────────────────────────────────────────
// src: -1 (player), tgt: enemy index. A bolt streaks from the hero to the
// target (wpnBolt sub-event, rendered in combat-view.js), then flash + HP
// drain + purple damage number so every volley read as a distinct strike.
const WEAPON_HIT = {
  duration: 180,
  sub: [
    { t: 0, type: "wpnBolt" },
    { t: 80, type: "flash", actor: "enemy" },
    { t: 80, type: "hpDelta", target: "enemy" },
    { t: 80, type: "shake", intensity: 0.07 },
    { t: 90, type: "text", source: "amount", style: "magic", side: "enemy" },
  ],
};

export const EVENT_FX = {
  hit: HIT,
  hit_crit: HIT_CRIT,
  overload: OVERLOAD,
  overload_crit: OVERLOAD_CRIT,
  art: ART,
  "art-splash": ART_SPLASH,
  enemyhit: ENEMYHIT,
  reflect: REFLECT,
  miss: MISS,
  kill: KILL,
  potion: POTION,
  secondwind: SECONDWIND,
  deathsave: DEATHSAVE,
  hex: HEX,
  curse: CURSE,
  steal: STEAL,
  flee: FLEE,
  death: DEATH,
  weapon: WEAPON_HIT,
};

// ── boss entrance choreography — runs before the first combat event ──
//   Screen darkens → low rumble → two heavy footsteps → title slam →
//   music phase swap to boss layer. ~2.8s. Even in a text MMO this
//   anticipation window is what makes a boss feel like a boss.
export const BOSS_INTRO = {
  duration: 2800,
  sub: [
    { t: 0, type: "music", cmd: "cut" },
    { t: 0, type: "darken", amount: 0.78, dur: 2400 },
    { t: 220, type: "sfx", id: "boss_rumble" },
    { t: 700, type: "sfx", id: "boss_footstep" },
    { t: 700, type: "shake", intensity: 0.18 },
    { t: 1200, type: "sfx", id: "boss_footstep" },
    { t: 1200, type: "shake", intensity: 0.24 },
    { t: 1580, type: "text", text: "◆ THE ABYSS STIRS ◆", style: "boss_intro" },
    { t: 2200, type: "sfx", id: "boss_slam" },
    { t: 2200, type: "shake", intensity: 0.6 },
    { t: 2200, type: "music", cmd: "phase", value: "boss" },
  ],
};

// ── power-up modifiers ───────────────────────────────────────────────
// Stacked on top of a base timeline when the fighter has the named
// effect (derived from gear in stats.js). Each entry is keyed by the
// raw event verb (`hit`, `kill`, `enemyhit`) — the manifest looks it up
// after expanding the base timeline so crits still pick up the modifier.
export const EFFECT_MODS = {
  berserk: {
    hit: [
      { t: 0, type: "aura", actor: "hero", color: "#ff4d6d", dur: 240 },
      { t: 80, type: "sfx", id: "berserk_pulse", vol: 0.15 },
    ],
  },
  bloodthirst: {
    hit: [
      { t: 110, type: "aura", actor: "hero", color: "#ff4d6d", dur: 160 },
      { t: 110, type: "sfx", id: "blood_sip", vol: 0.18 },
    ],
  },
  vampire: {
    kill: [
      { t: 80, type: "aura", actor: "hero", color: "#ff4d6d", dur: 340, strong: true },
      { t: 80, type: "sfx", id: "vamp_drain" },
    ],
  },
  thornmail: {
    enemyhit: [{ t: 70, type: "aura", actor: "hero", color: "#9be0ff", dur: 120 }],
  },
  lucky_seven: {
    hit: [{ t: 0, type: "sfx", id: "luck_chime", vol: 0.1 }],
  },
  executioner: {
    hit: [{ t: 0, type: "aura", actor: "hero", color: "#ffd24a", dur: 200 }],
  },
  midas: {
    kill: [{ t: 120, type: "sfx", id: "midas_chime" }],
  },
  second_wind: {
    // base SECONDWIND already lights up; this just adds the lift the
    // first time the legendary fires by punching the rally_burst harder.
    secondwind: [{ t: 360, type: "sfx", id: "rally_burst", vol: 0.5 }],
  },
};
