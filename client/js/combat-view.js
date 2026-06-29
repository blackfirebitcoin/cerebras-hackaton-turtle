// SIGMA ABYSS — encounter renderer.
//
// delveTick() has already resolved the fight; this plays it back as a
// short, watchable animation. The deterministic event log from
// shared/combat.js is fed through the FX timeline (fx-timeline.js +
// fx-manifest.js), which expands each verb into authored sub-events
// with ms offsets. We apply the sub-events to a small render state and
// draw it each frame.
//
// What lives here:
//   - hero + enemy state (HP, dead set, flash + lunge timers, auras)
//   - the post-shake darken overlay
//   - the camera-shake transform
//   - the canvas-side draw pipeline (LPC composer + HP bars + VS banner)
//   - text FX delegation to fx-text.js
//
// What does NOT live here (intentionally):
//   - which sound plays for a crit, how long the wind-up is, etc.
//     edit fx-manifest.js, not this file.

import { composeAvatar, composeEnemy } from "/avatar/lpc-avatar.js";
import { VH, VW } from "/shared/constants.js";
import { derive } from "/shared/stats.js";
import { playStem } from "./audio.js";
import * as barks from "./barks.js";
import { music } from "./fx-music.js";
import * as fxText from "./fx-text.js";
import { compose, makeRunner } from "./fx-timeline.js";

// Sized to read against the hero (composeAvatar scale 4.6). The old values
// rendered a normal mob at ~1/4 the hero's height — a tiny speck way off on
// the right — so the screen never read as a face-off. These land a normal
// roughly 0.7×, an elite ~1×, and a boss towering over the hero.
const ENEMY_SCALE = { normal: 3.3, elite: 4.0, boss: 4.9 };
const HEAD_FROM_GROUND = 51;
const HOLD_MS = 620;
const HERO_X = VW * 0.25;
const GROUND = VH * 0.74;

let active = false;
let A = null;

export function isPlaying() {
  return active;
}

export function play({
  enemies,
  events,
  fighterStartHp,
  fighterMaxHp,
  character,
  onDone,
  isFaint = false,
}) {
  const isBoss = enemies.some((e) => e.kind === "boss");
  const effects = character?.run ? derive(character.run, character).effects || [] : [];
  const fx = compose({ events: events || [], effects, boss: isBoss });
  // Hero + per-enemy level. The sim stamps each enemy at the same effective
  // level buildEncounter() used (progression.js: run.level + floor(depth/2)) but
  // doesn't store it on the combatant, so derive it here from the run. Only fill
  // in when absent so a sim that ever starts carrying enemy.level wins.
  const heroLevel = character?.run?.level ?? 1;
  const enemyLevel = heroLevel + Math.floor((character?.run?.depth || 0) / 2);
  for (const e of enemies) if (e.level == null) e.level = enemyLevel;
  A = {
    level: heroLevel,
    enemies,
    xs: layout(enemies.length),
    runner: makeRunner(fx),
    startedAt: 0,
    fighterHp: fighterStartHp,
    fighterMaxHp,
    enemyHp: enemies.map((e) => e.maxHp),
    dead: new Set(),
    deadAt: {},
    fFlash: 0,
    fLunge: 0,
    fAnim: "idle", // hero animation — flips to "slash" while mid-swing
    fAnimUntil: 0,
    eFlash: enemies.map(() => 0),
    eLunge: enemies.map(() => 0),
    fAura: null,
    eAura: enemies.map(() => null),
    eAlert: enemies.map(() => 0), // src → "!" aggro mark until-ms
    eTelegraph: enemies.map(() => null), // src → { born, dur } windup zone
    eProjectiles: [], // { fromX, toX, born, dur } attack bolts
    shake: 0,
    darken: 0,
    darkenStart: 0,
    darkenDur: 0,
    pet: {
      seed: character.seed,
      cosmetics: character.cosmetics || {},
      sleeping: false,
      _motion: { vx: 0, vz: 0, facing: 1 },
      // Equipped weapon → the in-hand blade layer (lpcBuild reads this) so the
      // hero visibly swings a weapon during the fight, not bare fists.
      weapon: character.run?.gear?.weapon || null,
    },
    onDone,
    finishedAt: 0,
    lowHpBarked: false, // one-shot "I'm in danger" cue per scare
    // VS layer — only active when the sigma carries a weapon loadout
    vsActive: Array.isArray(character.weapons) && character.weapons.length > 0,
    isFaint,
    gems: [], // XP gem particles: spawn at enemy kill, magnetize to hero
    wpnBolts: [], // auto-fire weapon projectiles: hero → enemy
  };
  fxText.reset();
  barks.reset();
  music.setPhase(isBoss ? "boss" : "combat");
  music.setIntensity(1);
  music.setCriticalHp(fighterStartHp / fighterMaxHp < 0.25);
  active = true;
  // The sigma reacts the moment a boss looms — a scared/cocky line over the
  // long boss-intro choreography. Forced past the throttle so it always lands.
  if (isBoss) barks.say("boss", { force: true, life: 2000 });
}

// Mid-fight player agency feedback. The deterministic encounter is already
// resolved + locked, so this changes NOTHING about the outcome — it just makes
// mashing PANIC POTION / EMERGENCY RECALL during the playback FEEL real-time:
// instant aura + sound + bark. game.js applies the actual HP/recall math at the
// end of the encounter (post-resolution, never inside the sim).
export function injectPanic(kind) {
  if (!active || !A) return;
  const now = performance.now();
  if (kind === "potion") {
    A.fAura = { color: "#5bd16a", born: now, dur: 360, strong: true };
    playStem("potion_glug");
    fxText.spawn("PANIC SIP", HERO_X, GROUND - 200, "heal");
    barks.say("potion", { force: true });
  } else if (kind === "recall") {
    A.fAura = { color: "#4aa3ff", born: now, dur: 420, strong: true };
    playStem("retreat");
    fxText.spawn("RECALL!", HERO_X, GROUND - 210, "banner_heal");
    barks.say("recall", { force: true, life: 1700 });
  }
}

function layout(n) {
  const xs = [];
  const a = VW * 0.55,
    b = VW * 0.82;
  // Single foe sits at 0.62 (was 0.72) so the duel reads tighter — hero on
  // the left quarter, enemy just right of centre, facing each other.
  for (let i = 0; i < n; i += 1) xs.push(n <= 1 ? VW * 0.62 : a + (b - a) * (i / (n - 1)));
  return xs;
}

// ── sub-event dispatch ─────────────────────────────────────────────────
function applySub(sub, now) {
  const ev = sub.payload.baseEvent || {};
  const p = sub.payload;
  switch (sub.type) {
    case "sfx":
      playStem(p.id, p.vol != null ? { vol: p.vol } : undefined);
      break;

    case "lunge": {
      const amt = p.amount || 22;
      if (p.actor === "hero") {
        A.fLunge = amt;
        // A forward lunge IS the hero's attack — play the slash so the player
        // visibly strikes instead of standing idle. Negative amounts are the
        // disengage/retreat lunge, which should stay idle.
        if (amt > 0) {
          A.fAnim = "slash";
          // Hold long enough for the full 6-frame @13fps slash (~462ms) to play
          // and read as a slash; it falls back to idle once this window passes.
          A.fAnimUntil = now + 520;
        }
      } else if (typeof ev.src === "number" && ev.src >= 0 && ev.src < A.eLunge.length) {
        A.eLunge[ev.src] = -Math.abs(amt);
      }
      break;
    }

    case "flash":
      if (p.actor === "hero") {
        A.fFlash = now;
      } else if (typeof ev.tgt === "number" && ev.tgt >= 0 && ev.tgt < A.eFlash.length) {
        A.eFlash[ev.tgt] = now;
      }
      break;

    case "alert":
      // "!" over the attacking enemy (ev.src) — it's about to strike.
      if (typeof ev.src === "number" && ev.src >= 0 && ev.src < A.eAlert.length) {
        A.eAlert[ev.src] = now + (p.dur || 600);
      }
      break;

    case "telegraph":
      // Arm the red AoE windup zone at the hero (the attack's landing spot).
      if (typeof ev.src === "number" && ev.src >= 0 && ev.src < A.eTelegraph.length) {
        A.eTelegraph[ev.src] = { born: now, dur: p.dur || 260 };
      }
      break;

    case "projectile": {
      // Loose a fan of bolts from the attacker toward the hero.
      const src = ev.src;
      const fromX = typeof src === "number" && A.xs[src] != null ? A.xs[src] : VW * 0.62;
      const n = p.count || 3;
      for (let i = 0; i < n; i += 1) {
        const off = (i - (n - 1) / 2) * 18;
        A.eProjectiles.push({ fromX, toX: HERO_X + off, born: now, dur: p.flight || 120 });
      }
      break;
    }

    case "hpDelta": {
      const t = ev.t;
      if (t === "hit" || t === "overload" || t === "reflect" || t === "art" || t === "art-splash") {
        if (typeof ev.tgt === "number" && ev.tgt >= 0 && ev.tgt < A.enemyHp.length) {
          A.enemyHp[ev.tgt] = Math.max(0, A.enemyHp[ev.tgt] - (ev.amt || 0));
        }
        // The sigma trash-talks as it lands blows. Crits get the hype line.
        if (t === "hit" && ev.crit) barks.say("crit", { chance: 0.85 });
        else if (t === "hit") barks.say("hit", { chance: 0.4 });
      } else if (t === "enemyhit") {
        A.fighterHp = Math.max(0, A.fighterHp - (ev.amt || 0));
        barks.say("hurt", { chance: 0.5 });
      } else if (t === "potion") {
        A.fighterHp = Math.min(A.fighterMaxHp, A.fighterHp + (ev.amt || 0));
        barks.say("potion", { chance: 0.7 });
      } else if (t === "secondwind" || t === "deathsave") {
        A.fighterHp = ev.amt || 0;
        barks.say("victory", { force: true });
      } else if (t === "death") {
        A.fighterHp = 0;
        barks.say("death", { force: true, life: 2200 });
      }
      // One-shot "I'm in real danger" cue when HP first crosses the brink —
      // a scared bark + soft alarm so the watching player knows NOW is the
      // moment to slam PANIC POTION / EMERGENCY RECALL.
      const frac = A.fighterHp / A.fighterMaxHp;
      if (frac > 0 && frac <= 0.3 && !A.lowHpBarked) {
        A.lowHpBarked = true;
        barks.say("lowHp", { force: true, life: 1800 });
        playStem("boss_footstep", { vol: 0.16 });
      } else if (frac > 0.45) {
        A.lowHpBarked = false;
      }
      music.setCriticalHp(frac < 0.25);
      break;
    }

    case "kill": {
      if (typeof ev.tgt === "number" && ev.tgt >= 0 && ev.tgt < A.enemies.length) {
        A.dead.add(ev.tgt);
        A.deadAt[ev.tgt] = now;
        barks.say("kill", { chance: 0.6 });
        // VS: spawn XP gem particles at the screen position of the killed enemy
        if (A.vsActive) {
          const ex = A.xs[ev.tgt] ?? VW * 0.62;
          const kind = A.enemies[ev.tgt]?.kind ?? "normal";
          const count = kind === "boss" ? 9 : kind === "elite" ? 4 : 2;
          for (let gi = 0; gi < count; gi += 1) {
            const ang = (gi / count) * Math.PI * 2 + Math.PI * 0.3;
            const r = 22 + gi * 10;
            A.gems.push({
              x: ex + Math.cos(ang) * r,
              y: GROUND - 60 + Math.sin(ang) * r * 0.35,
              born: now,
              life: 820 + gi * 70,
              value: kind === "boss" ? 3 : kind === "elite" ? 2 : 1,
            });
          }
        }
      }
      break;
    }

    case "wpnBolt": {
      // VS auto-fire bolt: hero → target enemy
      const tgt = ev.tgt;
      const toX = typeof tgt === "number" && A.xs[tgt] != null ? A.xs[tgt] : VW * 0.62;
      A.wpnBolts.push({ fromX: HERO_X, toX, born: now, dur: 110 });
      break;
    }

    case "shake":
      A.shake = Math.max(A.shake, p.intensity || 0.2);
      break;

    case "aura": {
      const aura = { color: p.color || "#fff", born: now, dur: p.dur || 240, strong: !!p.strong };
      if (p.actor === "hero") {
        A.fAura = aura;
      } else if (typeof ev.src === "number" && ev.src >= 0 && ev.src < A.eAura.length) {
        A.eAura[ev.src] = aura;
      }
      break;
    }

    case "darken":
      A.darken = p.amount || 0.4;
      A.darkenStart = now;
      A.darkenDur = p.dur || 500;
      break;

    case "text": {
      let text = null;
      if (typeof p.text === "function") text = p.text(ev);
      else if (p.text != null) text = p.text;
      else if (p.source === "amount" && ev.amt != null) {
        text = `${p.prefix || ""}${ev.amt}${p.suffix || ""}`;
      }
      if (!text && text !== 0) break;
      const x = textX(p, ev);
      const y = textY(p);
      fxText.spawn(text, x, y, p.style || "normal");
      break;
    }

    case "music":
      if (p.cmd === "cut") music.cut();
      else if (p.cmd === "phase") music.setPhase(p.value || "combat");
      else if (p.cmd === "sting") music.sting(p.value);
      break;
  }
}

function textX(p, ev) {
  if (p.style === "boss_intro") return VW / 2;
  if (p.side === "enemy") {
    const idx =
      typeof ev.tgt === "number" && ev.tgt >= 0
        ? ev.tgt
        : typeof ev.src === "number" && ev.src >= 0
          ? ev.src
          : -1;
    if (idx >= 0) return (A.xs[idx] ?? VW * 0.72) + (Math.random() - 0.5) * 30;
    return VW * 0.72;
  }
  if (p.side === "hero") return HERO_X + (Math.random() - 0.5) * 30;
  return VW / 2;
}

function textY(p) {
  if (p.style === "boss_intro") return VH * 0.34;
  if (p.style?.startsWith("banner")) return GROUND - 240;
  if (p.side === "hero") return GROUND - 180;
  return GROUND - 160;
}

// ── canvas helpers ─────────────────────────────────────────────────────
function bar(ctx, cx, y, w, frac, color) {
  const h = 12;
  ctx.fillStyle = "#000";
  ctx.fillRect(cx - w / 2 - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = "#1a1a26";
  ctx.fillRect(cx - w / 2, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(cx - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
}

// Compact "Lv N" pill — a small rounded badge drawn centred on (cx, cy).
// `big` bumps the size for bosses/elites so it reads at their scale.
function levelPill(ctx, cx, cy, level, accent, big) {
  const label = `Lv ${level}`;
  const fs = big ? 16 : 13;
  ctx.font = `bold ${fs}px JetBrains Mono, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padX = big ? 9 : 7;
  const w = ctx.measureText(label).width + padX * 2;
  const h = fs + (big ? 9 : 7);
  const r = h / 2;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(8,8,14,0.85)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.fillText(label, cx, cy + 0.5);
  ctx.restore();
  ctx.textBaseline = "alphabetic"; // restore the canvas default the rest of the file assumes
}

function drawAura(ctx, cx, baseY, aura, now) {
  if (!aura) return;
  const age = (now - aura.born) / aura.dur;
  if (age >= 1) return;
  const op = (1 - age) * (aura.strong ? 0.55 : 0.32);
  const r = (aura.strong ? 88 : 70) + Math.sin(now / 80) * 6 - age * 12;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = aura.color;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - 100, r, r * 1.45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEnemy(ctx, i, now) {
  const enemy = A.enemies[i];
  const cx = A.xs[i];
  const base = ENEMY_SCALE[enemy.kind] || ENEMY_SCALE.normal;
  const eff = base * (enemy.lpc?.scale || 1);
  const dead = A.dead.has(i);
  drawAura(ctx, cx, GROUND, A.eAura[i], now);

  if (dead) {
    const k = Math.min(1, (now - (A.deadAt[i] || now)) / 460);
    if (k >= 1) return;
    ctx.save();
    ctx.globalAlpha = (1 - k) * 0.92;
    if (!composeEnemy(ctx, cx, GROUND - k * 46, enemy.lpc, "hurt", now, base)) {
      ctx.fillStyle = `hsl(${enemy.hue ?? 280} 52% 46%)`;
      ctx.fillRect(cx - 44, GROUND - 120 - k * 46, 88, 120);
    }
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = (1 - k) * 0.8;
    ctx.fillStyle = "#e6e6f0";
    for (let p = 0; p < 8; p += 1) {
      const ang = (p / 8) * Math.PI * 2;
      const d = k * 62;
      ctx.fillRect(cx + Math.cos(ang) * d - 5, GROUND - 70 + Math.sin(ang) * d - 5, 10, 10);
    }
    ctx.restore();
    return;
  }

  const bob = Math.sin(now / 440 + i * 2) * 3;
  const x = cx + (A.eLunge[i] || 0);
  const flash = !!(A.eFlash[i] && now - A.eFlash[i] < 95);
  const anim = (A.eLunge[i] || 0) < -4 ? "slash" : "walk";

  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, GROUND, 14 + 11 * eff, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (!composeEnemy(ctx, x, GROUND - bob, enemy.lpc, anim, now, base, flash)) {
    const h = enemy.kind === "boss" ? 240 : enemy.kind === "elite" ? 150 : 96;
    const w = h * 0.66;
    ctx.fillStyle = flash ? "#ffffff" : `hsl(${enemy.hue ?? 280} 52% 46%)`;
    ctx.fillRect(x - w / 2, GROUND - h - bob, w, h);
  }

  const headY = GROUND - HEAD_FROM_GROUND * eff - bob;
  const frac = A.enemyHp[i] / enemy.maxHp;
  const barColor =
    enemy.kind === "boss" ? "#ff4d6d" : enemy.kind === "elite" ? "#ff9d2e" : "#d46a7a";
  const barW = Math.max(80, 30 * eff);
  bar(ctx, cx, headY - 18, barW, frac, barColor);
  ctx.fillStyle = enemy.kind === "normal" ? "#c6cad8" : barColor;
  ctx.font = `${enemy.kind === "boss" ? "bold 24" : "18"}px JetBrains Mono, monospace`;
  ctx.textAlign = "center";
  ctx.fillText(enemy.name, cx, headY - 30);
  // "Lv N" pill pinned just left of the HP bar; boss/elite get the larger size.
  if (enemy.level != null) {
    const big = enemy.kind !== "normal";
    levelPill(ctx, cx - barW / 2 - (big ? 26 : 20), headY - 12, enemy.level, barColor, big);
  }

  // "!" aggro mark — pops over the enemy as it winds up an attack.
  if (A.eAlert[i] && now < A.eAlert[i]) {
    const ay = headY - 56 - Math.abs(Math.sin(now / 110)) * 4;
    ctx.save();
    ctx.font = "900 30px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText("!", cx, ay);
    ctx.shadowColor = "#ff5a5a";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "#ff3b3b";
    ctx.fillText("!", cx, ay);
    ctx.restore();
  }
}

// ── main render ────────────────────────────────────────────────────────
export function draw(ctx, now) {
  if (!active || !A) return false;
  if (!A.startedAt) A.startedAt = now;
  const elapsed = now - A.startedAt;

  // drain authored sub-events whose offset has elapsed
  const due = A.runner.drainUntil(elapsed);
  for (const sub of due) applySub(sub, now);

  // decay transient state
  A.fLunge *= 0.82;
  for (let i = 0; i < A.eLunge.length; i += 1) A.eLunge[i] *= 0.82;
  A.shake *= 0.88;

  // camera shake — translate the whole scene then restore at the end
  const shakeAmp = A.shake * 22;
  const sx = (Math.random() - 0.5) * shakeAmp;
  const sy = (Math.random() - 0.5) * shakeAmp;
  ctx.save();
  ctx.translate(sx, sy);

  // backdrop (oversized so shake doesn't reveal the void)
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, "#100a14");
  g.addColorStop(1, "#05050a");
  ctx.fillStyle = g;
  ctx.fillRect(-shakeAmp - 4, -shakeAmp - 4, VW + shakeAmp * 2 + 8, VH + shakeAmp * 2 + 8);
  ctx.strokeStyle = "#ffffff10";
  ctx.lineWidth = 2;
  for (let i = 1; i < 5; i += 1) {
    const y = VH * 0.4 + i * 70;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(VW, y);
    ctx.stroke();
  }

  // hero
  drawAura(ctx, HERO_X, GROUND, A.fAura, now);
  const fFlash = A.fFlash && now - A.fFlash < 95;
  const hx = HERO_X + A.fLunge;
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(HERO_X, GROUND, 60, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.translate(hx, 0);
  const fAnim = A.fAnimUntil > now ? A.fAnim : "idle";
  composeAvatar(ctx, 0, GROUND, A.pet, now, 4.6, fAnim);
  ctx.restore();
  if (fFlash) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#ff4d6d";
    ctx.fillRect(hx - 110, GROUND - 290, 220, 300);
    ctx.restore();
  }
  bar(ctx, HERO_X, GROUND - 320, 200, A.fighterHp / A.fighterMaxHp, "#ff4d6d");
  ctx.fillStyle = "#f0f2f8";
  ctx.font = "bold 20px JetBrains Mono, monospace";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.ceil(A.fighterHp)} / ${A.fighterMaxHp}`, HERO_X, GROUND - 330);
  // hero "Lv N" pill, just left of the HP bar (bar is 200px wide, centred on HERO_X)
  if (A.level != null) levelPill(ctx, HERO_X - 100 - 22, GROUND - 314, A.level, "#9ad0ff", false);

  // the sigma's battle-bark speech bubble, floating above its HP readout
  barks.draw(ctx, hx, GROUND - 360, now);

  // enemy attack telegraphs — a red AoE danger zone swells at the hero's feet
  // while a monster winds up, foreshadowing the incoming blow (under sprites).
  for (let i = 0; i < A.eTelegraph.length; i += 1) {
    const tg = A.eTelegraph[i];
    if (!tg) continue;
    const age = (now - tg.born) / tg.dur;
    if (age >= 1) {
      A.eTelegraph[i] = null;
      continue;
    }
    ctx.save();
    ctx.translate(HERO_X, GROUND);
    ctx.scale(1, 0.4);
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,72,72,${0.1 + 0.18 * age})`;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,72,72,0.85)";
    ctx.beginPath();
    ctx.arc(0, 0, 120, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,210,120,${0.4 + 0.6 * age})`;
    ctx.beginPath();
    ctx.arc(0, 0, 120 * (1 - age * 0.8), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // enemies
  for (let i = 0; i < A.enemies.length; i += 1) drawEnemy(ctx, i, now);

  // enemy attack bolts — bullet-hell streaks flying from the attacker to the
  // hero, the visible payload of a telegraphed strike (over sprites).
  for (let i = A.eProjectiles.length - 1; i >= 0; i -= 1) {
    const pr = A.eProjectiles[i];
    const t = (now - pr.born) / pr.dur;
    if (t >= 1) {
      A.eProjectiles.splice(i, 1);
      continue;
    }
    const e = t * (2 - t);
    const x = pr.fromX + (pr.toX - pr.fromX) * e;
    const y = GROUND - 120;
    const dir = Math.sign(pr.toX - pr.fromX) || 1;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.strokeStyle = "hsl(8 100% 62%)";
    ctx.lineWidth = 5;
    ctx.globalAlpha = 0.85 * (1 - t * 0.25);
    ctx.beginPath();
    ctx.moveTo(x - 14 * dir, y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "hsl(8 100% 82%)";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // VS weapon bolts — auto-fire streak from hero to target enemy (over sprites)
  for (let bi = A.wpnBolts.length - 1; bi >= 0; bi -= 1) {
    const pr = A.wpnBolts[bi];
    const bt = (now - pr.born) / pr.dur;
    if (bt >= 1) {
      A.wpnBolts.splice(bi, 1);
      continue;
    }
    const be = bt * (2 - bt); // ease-out
    const bx = pr.fromX + (pr.toX - pr.fromX) * be;
    const by = GROUND - 140;
    const dir = Math.sign(pr.toX - pr.fromX) || 1;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.strokeStyle = "hsl(270 100% 72%)";
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.9 * (1 - bt * 0.2);
    ctx.beginPath();
    ctx.moveTo(bx - 18 * dir, by);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "hsl(270 100% 90%)";
    ctx.beginPath();
    ctx.arc(bx, by, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // VS XP gems — diamond particles that magnetize from kill position to hero
  for (let gi = A.gems.length - 1; gi >= 0; gi -= 1) {
    const g = A.gems[gi];
    const gt = Math.min(1, (now - g.born) / g.life);
    if (gt >= 1) {
      A.gems.splice(gi, 1);
      continue;
    }
    const ease = gt * (2 - gt); // ease-out magnetize toward hero
    const gx = g.x + (HERO_X - g.x) * ease;
    const gy = g.y + (GROUND - 110 - g.y) * ease;
    const alpha = gt < 0.1 ? gt / 0.1 : gt > 0.78 ? 1 - (gt - 0.78) / 0.22 : 1;
    const sz = 7 + g.value * 2;
    ctx.save();
    ctx.globalAlpha = alpha * 0.92;
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(gx, gy);
    ctx.rotate(now / 380 + gi * 0.9);
    const gemGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, sz);
    gemGrad.addColorStop(0, "#ffffff");
    gemGrad.addColorStop(0.4, "#a3e4ff");
    gemGrad.addColorStop(1, "#3b82f6");
    ctx.fillStyle = gemGrad;
    ctx.beginPath();
    ctx.moveTo(0, -sz);
    ctx.lineTo(sz * 0.6, 0);
    ctx.lineTo(0, sz);
    ctx.lineTo(-sz * 0.6, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // VS banner
  ctx.fillStyle = "#ff9d2e";
  ctx.font = "bold 26px JetBrains Mono, monospace";
  ctx.textAlign = "center";
  ctx.fillText("— ENCOUNTER —", VW / 2, 70);

  // text FX layer — damage numbers, banners, boss-intro reveal
  fxText.draw(ctx, now);

  ctx.restore(); // ── un-shake ─────────────────────────────────────────

  // darken overlay (above shake — covers everything uniformly)
  if (A.darken > 0) {
    const dAge = (now - A.darkenStart) / A.darkenDur;
    if (dAge < 1) {
      const env = dAge < 0.25 ? dAge / 0.25 : 1 - (dAge - 0.25) / 0.75;
      ctx.save();
      ctx.globalAlpha = A.darken * Math.max(0, Math.min(1, env));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, VW, VH);
      ctx.restore();
    } else {
      A.darken = 0;
    }
  }

  // finish — wait a beat after the last authored sub-event before returning
  const done = A.runner.isDone(elapsed);
  if (done && !A.finishedAt) {
    A.finishedAt = now;
    // VS faint: flash a "FAINTED" banner so the viewer sees the weapon-loss beat
    if (A.isFaint) fxText.spawn("FAINTED", VW / 2, GROUND - 240, "banner_danger");
  }
  const holdExtra = A.isFaint ? 700 : 0;
  if (A.finishedAt && now - A.finishedAt > HOLD_MS + holdExtra) {
    active = false;
    const cb = A.onDone;
    A = null;
    fxText.reset();
    if (cb) cb();
  }
  return true;
}
