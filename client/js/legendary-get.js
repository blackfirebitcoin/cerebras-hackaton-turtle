// SIGMA ABYSS — legendary "item get" flourish.
//
// The Legend-of-Zelda beat: when a legendary-or-better drop lands, the screen
// dims, golden god-rays spin out from behind the hero, the hero strikes a
// raised "presenting" pose holding the loot overhead, and a starburst + drifting
// sparkles + a rarity-coloured banner sell the moment. When the drop was a
// weapon that auto-equipped (progression.js equips legendary weapons straight
// off the ground), the banner reads NOW WIELDING and the hero is already holding
// the new blade in hand (composeAvatar renders run.gear.weapon).
//
// Pure client presentation — drawn ON TOP of the scene each frame by game.js's
// loop. No sim state, no RNG in shared/. (Math.random here is client-only and
// fine; it only jitters sparkles.)

import { composeAvatar } from "/avatar/lpc-avatar.js";
import { RARITY_COLOR } from "/shared/constants.js";

const DURATION = 2300; // ms — fade-in → hold → fade-out
const SPARKLES = 22;

let active = null;

// Four-point sparkle star.
function star(ctx, x, y, r, color, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    const a2 = a + Math.PI / 4;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(a2) * r * 0.32, y + Math.sin(a2) * r * 0.32);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Start the flourish. `pet` is a render pet built from the character so the
// hero (and its equipped weapon) draws inside the overlay. Re-triggering
// restarts it — a fresh legendary always wins the screen.
export function trigger(item, { equipped = false, pet = null } = {}) {
  const sparkles = [];
  for (let i = 0; i < SPARKLES; i += 1) {
    sparkles.push({
      a: Math.random() * Math.PI * 2,
      dist: 26 + Math.random() * 70,
      rise: 30 + Math.random() * 80,
      r: 2 + Math.random() * 4,
      twk: 0.4 + Math.random() * 0.9,
      ph: Math.random() * Math.PI * 2,
    });
  }
  active = { item, equipped, pet, start: null, sparkles };
}

export function isPlaying() {
  return !!active;
}

export function cancel() {
  active = null;
}

// Drawn last in the frame, in the virtual VW×VH coordinate space.
export function draw(ctx, now, vw, vh, overlayMode = false) {
  if (!active) return;
  if (active.start == null) active.start = now;
  const t = now - active.start;
  if (t >= DURATION) {
    active = null;
    return;
  }
  const p = t / DURATION; // 0..1
  // Envelope: rise/fade-in, long hold, fade-out.
  const fadeIn = Math.min(1, t / 260);
  const fadeOut = p > 0.84 ? Math.max(0, 1 - (p - 0.84) / 0.16) : 1;
  const env = fadeIn * fadeOut;

  const item = active.item;
  const color = RARITY_COLOR[item?.rarity] || "#ff9d2e";
  const cx = vw / 2;
  const groundY = vh * 0.72;
  const headY = groundY - vh * 0.42; // roughly where the loot floats, above the hands

  ctx.save();

  // 1) Backdrop dim — skipped on the transparent OBS overlay so we don't black
  //    out the stream; there the rays + sparkles carry it.
  if (!overlayMode) {
    const vig = ctx.createRadialGradient(cx, groundY - vh * 0.18, vh * 0.1, cx, vh / 2, vh * 0.85);
    vig.addColorStop(0, `rgba(8,6,20,${0.18 * env})`);
    vig.addColorStop(1, `rgba(2,1,8,${0.74 * env})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, vw, vh);
  }

  // 2) Rotating golden god-rays behind the hero.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(cx, headY + vh * 0.14);
  ctx.rotate((t / 1000) * 0.5);
  const rayLen = vh * 0.9;
  const rays = 14;
  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2;
    const wob = 0.06 + 0.03 * Math.sin(t / 200 + i);
    ctx.save();
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, rayLen, 0);
    g.addColorStop(0, `rgba(255,228,150,${0.28 * env})`);
    g.addColorStop(1, "rgba(255,228,150,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(rayLen, -rayLen * wob);
    ctx.lineTo(rayLen, rayLen * wob);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // 3) The hero — raised "presenting" pose, holding the equipped weapon. A
  //    gentle rise + bob at the climax. Falls back to the procedural avatar if
  //    LPC isn't ready; either way the silhouette reads.
  if (active.pet) {
    const rise = (1 - fadeIn) * vh * 0.05;
    const bob = Math.sin(t / 260) * vh * 0.006;
    const scale = vh / 150;
    try {
      composeAvatar(ctx, cx, groundY + rise + bob, active.pet, now, scale, "spellcast");
    } catch (_) {
      /* one bad cosmetic shouldn't kill the flourish */
    }
  }

  // 4) Starburst over the hero's hands + the floating loot sparkle.
  const burst = Math.min(1, t / 420);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  star(
    ctx,
    cx,
    headY,
    vh * (0.05 + 0.09 * burst) * (0.9 + 0.1 * Math.sin(t / 110)),
    "#fff7df",
    env,
  );
  star(ctx, cx, headY, vh * (0.035 + 0.06 * burst), color, env * 0.85);
  ctx.restore();

  // 5) Drifting sparkles around the loot.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const s of active.sparkles) {
    const sx = cx + Math.cos(s.a) * s.dist * (0.6 + 0.7 * burst);
    const sy = headY + Math.sin(s.a) * s.dist * 0.6 - p * s.rise;
    const tw = 0.5 + 0.5 * Math.sin(t * 0.006 * s.twk + s.ph);
    star(ctx, sx, sy, s.r * (0.7 + tw), "#fff7df", env * tw);
  }
  ctx.restore();

  // 6) Banner — rarity tier + item name (+ NOW WIELDING when it auto-equipped).
  const tier = (item?.rarity || "legendary").toUpperCase().replace("ONEOFONE", "ONE OF ONE");
  const slideY = vh * 0.86 - (1 - fadeIn) * 16;
  ctx.textAlign = "center";
  ctx.globalAlpha = env;
  ctx.font = `700 ${Math.round(vh * 0.05)}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.fillText(`✦ ${tier} ✦`, cx, slideY);
  ctx.shadowBlur = 0;
  if (active.equipped) {
    ctx.font = `600 ${Math.round(vh * 0.026)}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffe9a8";
    ctx.fillText("NOW WIELDING", cx, slideY - vh * 0.05);
  }
  if (item?.name) {
    ctx.font = `500 ${Math.round(vh * 0.032)}px system-ui, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(item.name, cx, slideY + vh * 0.045);
  }

  ctx.restore();
}
