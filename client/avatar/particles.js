// Vibe Coder Sim — unified particle system
// emit(type, opts) → spawn one or more particles
// tickAndDraw(ctx, dtMs) → advance + render all live particles

const MAX_PARTICLES = 1500;

// Particle pool — typed-array-friendly objects
const pool = [];

function newParticle() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    life: 0,
    ttl: 1,
    size: 4,
    hue: 60,
    alpha: 1,
    kind: "sparkle",
    rot: 0,
    rotV: 0,
    gravity: 0,
    drag: 0.98,
  };
}

function alloc() {
  if (pool.length < MAX_PARTICLES) {
    const p = newParticle();
    pool.push(p);
    return p;
  }
  // Evict oldest (first in array)
  const p = pool[0];
  pool.splice(0, 1);
  pool.push(p);
  return p;
}

export function emit(kind, opts) {
  const count = opts.count ?? 1;
  for (let i = 0; i < count; i++) {
    const p = alloc();
    const spread = opts.spread ?? 0;
    p.x = opts.x + (Math.random() - 0.5) * spread;
    p.y = opts.y + (Math.random() - 0.5) * spread;
    p.vx = (opts.vx ?? 0) + (Math.random() - 0.5) * (opts.vxRand ?? 0);
    p.vy = (opts.vy ?? -1.2) + (Math.random() - 0.5) * (opts.vyRand ?? 0);
    p.ax = opts.ax ?? 0;
    p.ay = opts.ay ?? 0;
    p.gravity = opts.gravity ?? 0;
    p.drag = opts.drag ?? 0.98;
    p.life = 0;
    p.ttl = opts.ttl ?? 800;
    p.size = opts.size ?? 5;
    p.hue = opts.hue ?? 60;
    p.alpha = 1;
    p.kind = kind;
    p.rot = Math.random() * Math.PI * 2;
    p.rotV = (Math.random() - 0.5) * 0.12;
  }
}

// Preset helpers
export function emitSparkle(x, y, hue = 55, count = 1) {
  emit("sparkle", {
    x,
    y,
    spread: 8,
    vy: -0.8,
    vyRand: 1.2,
    vxRand: 1.2,
    size: 3 + Math.random() * 4,
    hue,
    ttl: 700,
    count,
  });
}

export function emitHearts(x, y, count = 2) {
  emit("heart", {
    x,
    y,
    spread: 10,
    vy: -1.0,
    vyRand: 0.8,
    vxRand: 1.5,
    size: 6,
    hue: 340,
    ttl: 1200,
    drag: 0.95,
    count,
  });
}

export function emitGlamburst(x, y, hue = 300, count = 80) {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const speed = 3 + Math.random() * 4;
    emit("glamburst", {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      drag: 0.92,
      gravity: 0.04,
      size: 4 + Math.random() * 5,
      hue: hue + (Math.random() - 0.5) * 40,
      ttl: 900,
      count: 1,
    });
  }
}

export function emitConfetti(x, y, count = 40) {
  for (let i = 0; i < count; i++) {
    emit("confetti", {
      x,
      y,
      spread: 60,
      vy: -3 - Math.random() * 3,
      vyRand: 1,
      vxRand: 4,
      gravity: 0.08,
      drag: 0.97,
      size: 6,
      hue: Math.random() * 360,
      ttl: 1800,
      count: 1,
    });
  }
}

export function emitShimmer(x, y, count = 6) {
  emit("shimmer", {
    x,
    y,
    spread: 16,
    vy: -0.5,
    vyRand: 0.8,
    vxRand: 0.8,
    size: 4,
    hue: 200,
    ttl: 1000,
    count,
  });
}

function normalizeHue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return ((value % 360) + 360) % 360;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return ((numeric % 360) + 360) % 360;
    }
  }
  return null;
}

function hueFromHex(color) {
  if (typeof color !== "string") return null;
  const match = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const hex = match[1];
  const normalized = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  if (delta === 0) return 0;
  let base = 0;
  if (max === r) base = ((g - b) / delta) % 6;
  else if (max === g) base = (b - r) / delta + 2;
  else base = (r - g) / delta + 4;
  return (base * 60 + 360) % 360;
}

function resolveTrailHue(hue, cfg = {}) {
  return normalizeHue(cfg.hue) ?? hueFromHex(cfg.color) ?? normalizeHue(hue) ?? 55;
}

export function emitTrail(kind, x, y, hue = 55, cfg = {}) {
  const resolvedHue = resolveTrailHue(hue, cfg);
  if (kind === "sparkle") {
    emitSparkle(x, y, resolvedHue);
  } else if (kind === "heart") {
    emit("heart", {
      x,
      y,
      spread: 10,
      vy: -1.0,
      vyRand: 0.8,
      vxRand: 1.5,
      size: 6,
      hue: resolvedHue,
      ttl: 1200,
      drag: 0.95,
      count: 2,
    });
  } else if (kind === "shimmer") {
    emit("shimmer", {
      x,
      y,
      spread: 16,
      vy: -0.5,
      vyRand: 0.8,
      vxRand: 0.8,
      size: 4,
      hue: resolvedHue,
      ttl: 1000,
      count: 6,
    });
  } else if (kind === "glamburst") {
    // Mythic aurora trail — a small burst of hue-cycling shimmer rather than
    // a single flat sparkle, so the top-tier trail reads as premium.
    emit("shimmer", {
      x,
      y,
      spread: 11,
      vy: -0.7,
      vyRand: 1.0,
      vxRand: 1.3,
      size: 4,
      hue: resolvedHue,
      ttl: 950,
      count: 2,
    });
  }
}

export function tickAndDraw(ctx, dtMs) {
  const dt = Math.min(dtMs, 50); // cap to avoid jumps after tab focus
  let i = 0;

  while (i < pool.length) {
    const p = pool[i];
    p.life += dt;
    if (p.life >= p.ttl) {
      pool.splice(i, 1);
      continue;
    }

    // Physics
    p.vy += p.gravity;
    p.vx *= p.drag;
    p.vy *= p.drag;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.rotV;

    const progress = p.life / p.ttl;
    const fade = 1 - progress;

    ctx.save();
    ctx.globalAlpha = fade;

    if (p.kind === "sparkle") {
      ctx.globalCompositeOperation = "lighter";
      drawStar(ctx, p.x, p.y, p.size * (0.8 + 0.4 * Math.sin(progress * Math.PI)), p.hue);
    } else if (p.kind === "shimmer") {
      ctx.globalCompositeOperation = "lighter";
      const h = (p.hue + p.life * 0.3) % 360;
      drawStar(ctx, p.x, p.y, p.size, h);
    } else if (p.kind === "glamburst") {
      ctx.globalCompositeOperation = "lighter";
      const h = (p.hue + progress * 60) % 360;
      ctx.fillStyle = `hsl(${h},100%,70%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * fade, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.kind === "heart") {
      ctx.globalCompositeOperation = "source-over";
      const s = p.size * (1 + 0.3 * progress);
      drawHeart(ctx, p.x, p.y, s, p.hue);
    } else if (p.kind === "confetti") {
      ctx.globalCompositeOperation = "source-over";
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = `hsl(${p.hue},90%,60%)`;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    }

    ctx.restore();
    i++;
  }
}

function drawStar(ctx, cx, cy, r, hue) {
  ctx.fillStyle = `hsl(${hue},100%,75%)`;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const cx2 = cx + Math.cos(angle + Math.PI / 4) * r * 0.3;
    const cy2 = cy + Math.sin(angle + Math.PI / 4) * r * 0.3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(cx2, cy2);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawHeart(ctx, cx, cy, s, hue) {
  ctx.fillStyle = `hsl(${hue},90%,70%)`;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.35);
  ctx.bezierCurveTo(cx, cy, cx - s * 0.5, cy - s * 0.2, cx - s * 0.5, cy - s * 0.5 + s * 0.2);
  ctx.bezierCurveTo(cx - s * 0.5, cy - s * 0.5, cx, cy - s * 0.5, cx, cy - s * 0.2);
  ctx.bezierCurveTo(
    cx,
    cy - s * 0.5,
    cx + s * 0.5,
    cy - s * 0.5,
    cx + s * 0.5,
    cy - s * 0.5 + s * 0.2,
  );
  ctx.bezierCurveTo(cx + s * 0.5, cy - s * 0.2, cx, cy, cx, cy + s * 0.35);
  ctx.fill();
}
