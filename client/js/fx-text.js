// SIGMA ABYSS — combat text FX.
//
// Owns the floating-text list. The FX manifest spawns entries with a
// named style; this module knows what each style looks and behaves like
// (size, color, glow, jitter, rise, life, optional letter-by-letter
// reveal for boss-intro lines). combat-view.js calls draw() each frame
// inside the encounter scene.

const FONT = "JetBrains Mono, monospace";

const STYLES = {
  // damage numbers
  normal: {
    size: 24,
    color: "#ff6b81",
    stroke: "#000",
    strokeW: 4,
    rise: 60,
    life: 760,
    glow: null,
  },
  crit: {
    size: 38,
    color: "#ffd24a",
    stroke: "#000",
    strokeW: 5,
    rise: 80,
    life: 940,
    glow: "#ff9d2e",
    jitter: 3,
  },
  magic: {
    size: 26,
    color: "#b86bff",
    stroke: "#000",
    strokeW: 4,
    rise: 60,
    life: 800,
    glow: "#b86bff",
  },
  enemy: { size: 24, color: "#ff4d6d", stroke: "#000", strokeW: 4, rise: 60, life: 760 },
  thorn: { size: 22, color: "#9be0ff", stroke: "#000", strokeW: 4, rise: 50, life: 660 },
  heal: { size: 26, color: "#5bd16a", stroke: "#000", strokeW: 4, rise: 56, life: 780 },
  dim: { size: 22, color: "#9aa4b2", stroke: "#000", strokeW: 4, rise: 50, life: 620 },
  loss: { size: 22, color: "#ff9d2e", stroke: "#000", strokeW: 4, rise: 60, life: 860 },

  // banners — slower rise, longer life, glow
  banner_heal: {
    size: 38,
    color: "#5bd16a",
    stroke: "#000",
    strokeW: 5,
    rise: 30,
    life: 1100,
    glow: "#5bd16a",
  },
  banner_crit: {
    size: 38,
    color: "#ffd24a",
    stroke: "#000",
    strokeW: 5,
    rise: 30,
    life: 1100,
    glow: "#ffd24a",
  },
  banner_danger: {
    size: 38,
    color: "#ff4d6d",
    stroke: "#000",
    strokeW: 5,
    rise: 30,
    life: 1100,
    glow: "#ff4d6d",
  },
  dim_banner: { size: 30, color: "#9aa4b2", stroke: "#000", strokeW: 5, rise: 30, life: 1000 },

  // boss-intro typography — large, staggered letter reveal, holds longer
  boss_intro: {
    size: 60,
    color: "#ff4d6d",
    stroke: "#000",
    strokeW: 6,
    rise: 0,
    life: 2400,
    glow: "#ff4d6d",
    stagger: 38,
    jitter: 1,
  },
};

let floats = [];

export function spawn(text, x, y, styleName = "normal") {
  const style = STYLES[styleName] || STYLES.normal;
  floats.push({ text: String(text), x, y, style, born: performance.now() });
}

export function reset() {
  floats = [];
}

export function draw(ctx, now) {
  if (!floats.length) return;
  floats = floats.filter((f) => now - f.born < f.style.life);
  for (const f of floats) {
    const s = f.style;
    const age = (now - f.born) / s.life;
    const op = Math.max(0, 1 - age);
    const jit = s.jitter ? (Math.random() - 0.5) * s.jitter * 2 : 0;
    const x = f.x + jit;
    const y = f.y - age * s.rise + jit;

    let shown = f.text;
    if (s.stagger) {
      const reveal = Math.min(f.text.length, Math.floor((now - f.born) / s.stagger));
      shown = f.text.slice(0, reveal);
    }

    ctx.save();
    ctx.globalAlpha = op;
    ctx.font = `bold ${s.size}px ${FONT}`;
    ctx.textAlign = "center";
    if (s.glow) {
      ctx.shadowColor = s.glow;
      ctx.shadowBlur = 16;
    }
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeW;
    ctx.strokeText(shown, x, y);
    ctx.fillStyle = s.color;
    ctx.fillText(shown, x, y);
    ctx.restore();
  }
}
