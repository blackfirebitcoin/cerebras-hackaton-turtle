// Vibe Coder Sim — Pokémon Red/Blue (Gen 1) trainer avatar
//
// 24×32 sprite-pixel grid, scaled at PS=2 to a 48×64 virtual canvas.
// Strict 4-color grayscale palette (Gen 1 Game Boy) at the encoding
// level, then role-tinted per-chatter at draw time (hat/shirt/pants/
// shoes/hair/skin/mouth). Each chatter's seed picks default colors
// and !color/!hair/!hatstyle chat commands override.
//
// State machine (see getStateAndFrame): idle, walk, sleep, eat, happy,
// look. Walk frames are driven by motion velocity from vibe-coder-sim.js
// (pet._motion.vx/vz). The body never hops — characters walk with a leg
// cycle and stay vertically static, like the Pokémon overworld.
//
// Faces are drawn as pixel art (eyes + mouth), not emoji overlays.

import {
  ACCESS_CONFIG,
  AURA_CONFIG,
  COMPANION_CONFIG,
  DRESS_CONFIG,
  HEAD_CONFIG,
  ITEM_RARITY,
  POSE_CONFIG,
  RARITY_COLOR,
  RARITY_GLOW,
  RARITY_HALO_ALPHA,
  RARITY_PULSE_MS,
  TRAIL_CONFIG,
  WINGS_CONFIG,
} from "./cosmetics.js";

// ── Gen 1 grayscale palette ───────────────────────────────────────────
// Index 0 = transparent; 1-4 = Game Boy 4-color palette (lightest→darkest)

const PAL = [null, "#f8f8f8", "#b8b8b8", "#606060", "#000000"];

// ── Per-chatter palette (hat/shirt/pants/shoes/hair/skin) ─────────────
// The Gen 1 base sprite is monochrome; we map each pixel's
// (x, y, paletteIdx) to a semantic role and substitute the chatter's
// color for that role at draw time. Defaults are seeded from
// pet.seed so every chatter looks distinct without any `!color`
// customization. Explicit pet.cosmetics.c_* values override.

const COLOR_PRESETS = {
  // skin tones
  pale: "#f8d7b6",
  fair: "#f0c8a0",
  tan: "#d4a368",
  olive: "#b08560",
  brown: "#8b5a3c",
  deep: "#5a3a26",
  // hair-ish
  black: "#1a1a1a",
  blonde: "#e8c994",
  auburn: "#a04a1e",
  ginger: "#cc6633",
  silver: "#c8c8c8",
  white: "#f5f5f5",
  // common
  red: "#e74c3c",
  blue: "#3498db",
  green: "#2ecc71",
  yellow: "#f1c40f",
  orange: "#e67e22",
  purple: "#9b59b6",
  pink: "#ff66cc",
  cyan: "#1abc9c",
  navy: "#2c3e50",
  mint: "#a3e4d7",
  gray: "#7f8c8d",
  maroon: "#800000",
  teal: "#16a085",
  gold: "#d4af37",
  lime: "#a3ff00",
  magenta: "#d63384",
};

function resolveColor(value, fallback) {
  if (!value) return fallback;
  const s = String(value).trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return s;
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return COLOR_PRESETS[s] ?? fallback;
}

function adjustHsl(hex, dLight) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  const d = max - min;
  if (d > 0.0001) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l2 = Math.min(1, Math.max(0, l + dLight));
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l2 * 100)}%)`;
}

function defaultColors(seed) {
  const s = Math.abs(seed | 0) || 1;
  const skinList = ["#f8d7b6", "#f0c8a0", "#d4a368", "#b08560", "#8b5a3c", "#5a3a26"];
  return {
    hat: `hsl(${(s * 71) % 360} 60% 45%)`,
    shirt: `hsl(${(s * 47) % 360} 60% 55%)`,
    pants: `hsl(${(s * 23 + 200) % 360} 30% 28%)`,
    shoes: "#1a1a1a",
    hair: `hsl(${(s * 13) % 360} 35% 28%)`,
    skin: skinList[s % skinList.length],
  };
}

function makePalette(pet) {
  const c = pet?.cosmetics ?? {};
  const d = defaultColors(pet?.seed);
  const hat = resolveColor(c.c_hat, d.hat);
  const shirt = resolveColor(c.c_shirt, d.shirt);
  const pants = resolveColor(c.c_pants, d.pants);
  const shoes = resolveColor(c.c_shoes, d.shoes);
  const hair = resolveColor(c.c_hair, d.hair);
  const skin = resolveColor(c.c_skin, d.skin);
  return {
    outline: "#000000",
    hat,
    hat_accent: adjustHsl(hat, 0.22),
    hat_brim: adjustHsl(hat, -0.18),
    shirt,
    shirt_accent: adjustHsl(shirt, 0.22),
    belt: adjustHsl(pants, -0.06),
    pants,
    shoes,
    hair,
    skin,
    mouth: adjustHsl(skin, -0.32), // darker tone of skin for mouth line
  };
}

// Role assignment from raw pixel (x, y, paletteIdx). The sprite is laid
// out in fixed Y-bands (hat 2-7, face 8-16, torso 17-24, legs 25-29,
// shoes 30-31) — so a pure positional lookup works. idx 4 is outline.
function roleOf(_x, y, idx) {
  if (idx === 4) return "outline";
  if (y >= 2 && y <= 7) {
    if (idx === 1) return "hat_accent";
    if (idx === 3) return "hat_brim";
    return "hat";
  }
  if (y >= 8 && y <= 16) {
    if (idx === 3) return "mouth";
    return "skin"; // idx 1 or 2 inside face zone
  }
  if (y >= 17 && y <= 24) {
    if (idx === 3) return "belt";
    if (idx === 1) return "shirt_accent";
    return "shirt";
  }
  if (y >= 25 && y <= 29) return "pants";
  if (y >= 30 && y <= 31) return "shoes";
  return null;
}

// Sleeping figure lies horizontally: head at cols 1-6, body at cols 8-19.
// Y-band lookup doesn't apply, so split by X.
function roleOfSleep(x, _y, idx) {
  if (idx === 4) return "outline";
  if (x >= 1 && x <= 6) {
    if (idx === 3) return "mouth"; // closed-eye line
    return "skin";
  }
  if (x >= 8) {
    if (idx === 3) return "belt";
    if (idx === 1) return "shirt_accent";
    return "shirt";
  }
  return null;
}

function tintPixels(pixels, palette, roleFn = roleOf) {
  const out = [];
  for (const p of pixels) {
    const [x, y, idx] = p;
    const role = roleFn(x, y, idx);
    const color = (role && palette[role]) || PAL[idx];
    if (!color) continue;
    out.push([x, y, color]);
  }
  return out;
}

// ── Sprite geometry ───────────────────────────────────────────────────

const PS = 2; // virtual pixels per sprite-pixel (chunky 1996 feel)
const SPW = 24; // sprite-pixel width  (3 tiles × 8 px)
const SPH = 32; // sprite-pixel height (4 tiles × 8 px)
const AW = SPW * PS; // 48 virtual px
const AH = SPH * PS; // 64 virtual px

// ── Compact sprite encoding ───────────────────────────────────────────
// Each frame is an array of 32 strings, one per row. Characters:
//   '.' = transparent
//   '1' = lightest (#f8f8f8)   — hat brim band, accent
//   '2' = light gray (#b8b8b8) — hat / shirt fill
//   '3' = dark gray (#606060)  — hat band, shirt shadow, pants
//   '4' = darkest (#000000)    — outline
//   'F' = face overlay zone (transparent — emoji image is drawn here)

// All states share a trunk (hat + body); only legs/arms swap per frame.

// Hat sprite styles — all share rows 0-7 of the assembled frame so the
// face below stays aligned. Tinted at draw time via roleOf().
const HAT_STYLES = {
  cap: [
    "........................", // 0
    "........................", // 1
    ".........44444444.......", // 2  hat top
    "........422222222244....", // 3
    ".......42222222222244...", // 4  hat crown
    ".......41111111111114...", // 5  brim band (white)
    "......4333333333333334..", // 6  brim
    "......44444444444444444.", // 7
  ],
  beanie: [
    "........................", // 0
    "........................", // 1
    "........................", // 2
    ".........44444444.......", // 3
    "........4322222234......", // 4
    ".......432222222234.....", // 5
    ".......411111111114.....", // 6  cuff
    ".......444444444444.....", // 7
  ],
  tophat: [
    "..........44444.........", // 0
    ".........4222244........", // 1
    ".........4111114........", // 2  band stripe
    ".........4222224........", // 3
    ".........4222224........", // 4
    "........44222244........", // 5
    ".......43333333334......", // 6  flange
    ".......44444444444......", // 7
  ],
  cowboy: [
    "........................", // 0
    "........................", // 1
    "..........4444..........", // 2
    ".........422224.........", // 3
    ".........422224.........", // 4
    "........4222222244......", // 5
    ".....4433333333333344...", // 6  wide brim
    ".....44444444444444444..", // 7
  ],
  wizard: [
    "..........444...........", // 0
    ".........41114..........", // 1
    ".........42224..........", // 2
    "........422224..........", // 3
    ".......4222224..........", // 4
    "......4222222244........", // 5
    ".....43333333334........", // 6  brim
    ".....44444444444444.....", // 7
  ],
  bare: [
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
  ],
};
const _HAT = HAT_STYLES.cap; // back-compat reference if anything reads it

// Pixel-art face (matches lab IDLE_DOWN style): skin fill with eye pupils
// and a small mouth. idx 2 → skin (tinted per chatter), idx 3 → mouth
// (darker tone derived from skin), idx 4 → outline (black).
const FACE = [
  "......42222222222224....", // 8  forehead
  "......42222222222224....", // 9
  "......42222222222224....", // 10
  "......42244222244224....", // 11 eyes (pupils at cols 9-10, 15-16)
  "......42244222244224....", // 12
  "......42222222222224....", // 13
  "......42222233222224....", // 14 mouth (cols 12-13)
  "......42222222222224....", // 15
  "......44444444444444....", // 16 jawline outline
];

// Hair layer — drawn separately with the chatter's hair color (not
// palette '1234'). Each entry is a list of [x, y] sprite-pixels.
// Positioned to peek out around the hat brim and frame the face.
// Pixels with y < 8 are above the hat-line and only show when the
// chatter is bareheaded; y >= 8 pixels sit at temples and always show.
const HAIR_STYLES = {
  none: [],
  short: [
    [5, 9],
    [5, 10],
    [5, 11],
    [18, 9],
    [18, 10],
    [18, 11],
  ],
  long: [
    [5, 9],
    [5, 10],
    [5, 11],
    [5, 12],
    [5, 13],
    [5, 14],
    [5, 15],
    [5, 16],
    [4, 11],
    [4, 12],
    [4, 13],
    [4, 14],
    [4, 15],
    [4, 16],
    [4, 17],
    [4, 18],
    [3, 14],
    [3, 15],
    [3, 16],
    [3, 17],
    [3, 18],
    [3, 19],
    [18, 9],
    [18, 10],
    [18, 11],
    [18, 12],
    [18, 13],
    [18, 14],
    [18, 15],
    [18, 16],
    [19, 11],
    [19, 12],
    [19, 13],
    [19, 14],
    [19, 15],
    [19, 16],
    [19, 17],
    [19, 18],
    [20, 14],
    [20, 15],
    [20, 16],
    [20, 17],
    [20, 18],
    [20, 19],
  ],
  bob: [
    [5, 9],
    [5, 10],
    [5, 11],
    [5, 12],
    [5, 13],
    [5, 14],
    [4, 11],
    [4, 12],
    [4, 13],
    [18, 9],
    [18, 10],
    [18, 11],
    [18, 12],
    [18, 13],
    [18, 14],
    [19, 11],
    [19, 12],
    [19, 13],
  ],
  ponytail: [
    [5, 9],
    [5, 10],
    [5, 11],
    [18, 9],
    [18, 10],
    [18, 11],
    [21, 3],
    [21, 4],
    [21, 5],
    [21, 6],
    [21, 7],
    [21, 8],
    [22, 4],
    [22, 5],
    [22, 6],
    [22, 7],
  ],
  spiky: [
    [9, 0],
    [11, 0],
    [13, 0],
    [15, 0],
    [9, 1],
    [10, 1],
    [11, 1],
    [12, 1],
    [13, 1],
    [14, 1],
    [15, 1],
    [8, 2],
    [16, 2],
    [5, 10],
    [5, 11],
    [18, 10],
    [18, 11],
  ],
  afro: [
    [6, 3],
    [7, 3],
    [8, 3],
    [9, 3],
    [10, 3],
    [11, 3],
    [12, 3],
    [13, 3],
    [14, 3],
    [15, 3],
    [16, 3],
    [17, 3],
    [5, 4],
    [6, 4],
    [17, 4],
    [18, 4],
    [5, 5],
    [18, 5],
    [5, 6],
    [18, 6],
    [5, 9],
    [5, 10],
    [5, 11],
    [18, 9],
    [18, 10],
    [18, 11],
  ],
};

const TORSO = [
  "......422222222222244...", // 17  shoulders
  ".....4222222222222224...", // 18
  ".....422222111122222244.", // 19  shirt with light center
  ".....422222111122222224.", // 20
  ".....422333333333322224.", // 21  belt
  ".....422222222222222224.", // 22
  "......4222222222222224..", // 23
  "......44444444444444....", // 24  hem
];

// Leg+foot frames — 4 stride phases
const LEG_FRAMES = [
  // 0: idle / mid-stride (feet together)
  [
    "........43333.43334.....", // 25
    "........43333.43334.....", // 26
    "........43333.43334.....", // 27
    "........43333.43334.....", // 28
    "........43333.43334.....", // 29
    ".......44444.4444444....", // 30  shoes top
    ".......4444..44444444...", // 31  shoes bottom
  ],
  // 1: left foot fwd / right back
  [
    "........43333.43334.....",
    ".......443333.43334.....",
    "......4433333.43334.....",
    "......443333..43334.....",
    ".......4444...43334.....",
    "......44444...44444.....",
    ".....44444.....44444....",
  ],
  // 2: mid-stride (mirror of 0)
  [
    "........43333.43334.....",
    "........43333.43334.....",
    "........43333.43334.....",
    "........43333.43334.....",
    "........43333.43334.....",
    ".......44444.4444444....",
    ".......4444..44444444...",
  ],
  // 3: right foot fwd / left back
  [
    "........43333.43334.....",
    "........43333.433344....",
    "........43333.4333344...",
    "........43333..3334344..",
    "........43333...44444...",
    "........44444...44444...",
    ".......44444.....44444..",
  ],
];

// Arm frames — slight swing on alternate stride
const ARM_FRAMES = [
  // 0: rest
  [
    ".....442............244.", // 17 arms tucked at sides (overlays torso rows)
    ".....432............234.",
    ".....432............234.",
    ".....432............234.",
    ".....442............244.",
    "......44............44..",
    "......................",
    "......................",
  ],
  // 1: forward / back (right arm fwd)
  [
    ".....443............244.",
    ".....443............234.",
    "......443...........234.",
    ".......443..........234.",
    ".......443..........244.",
    "........44...........44.",
    "......................",
    "......................",
  ],
  // 2: same as 0
  null,
  // 3: opposite of 1 (left arm fwd)
  [
    ".....244............344.",
    ".....234............344.",
    ".....234...........344..",
    ".....234..........344...",
    ".....244..........344...",
    ".....44...........44....",
    "......................",
    "......................",
  ],
];

// Eating animation — character holds food up to face
const EAT_OVERLAY_FRAMES = [
  // 0: pull out food (hand reaches forward + small food pixel)
  [{ row: 14, cols: { 17: 1, 18: 1 } }],
  // 1: raise food
  [{ row: 11, cols: { 16: 1, 17: 1 } }],
  // 2: bite (food touching face)
  [{ row: 11, cols: { 14: 1, 15: 1 } }],
  // 3: chew
  [{ row: 11, cols: { 14: 1, 15: 1 } }],
  // 4: chew swallow
  [{ row: 11, cols: { 14: 1 } }],
  // 5: happy/finish
  [],
];

// Bed sprite — Gen 1 grayscale frame + mattress + pillow + blanket.
// Drawn under the sleeping figure. 24 wide × ~10 tall, sits at rows 17-27.
const BED_SPRITE = [
  "........................", // 0
  "........................", // 1
  "........................", // 2
  "........................", // 3
  "........................", // 4
  "........................", // 5
  "........................", // 6
  "........................", // 7
  "........................", // 8
  "........................", // 9
  "........................", // 10
  "........................", // 11
  "........................", // 12
  "........................", // 13
  "........................", // 14
  "........................", // 15
  "........................", // 16
  "4444444444444444444444..", // 17 bed top rail
  "4111122222222222222224..", // 18 pillow (light) + blanket header
  "4111122222222222222224..", // 19
  "4111122333333333333334..", // 20 blanket band (dark)
  "4444422222222222222224..", // 21
  "....422222222222222224..", // 22 blanket continues
  "....422333333333333334..", // 23 blanket band 2
  "....422222222222222224..", // 24
  "....4444444444444444444.", // 25 bottom rail
  "....4...............4...", // 26 bed legs
  "....4...............4...", // 27
  "....4444............4444", // 28 feet of bed
  "........................", // 29
  "........................", // 30
  "........................", // 31
];

// Sleeping body — trainer lying on the bed (pillow at left).
// Head is at the pillow end (cols 1-6), feet stretch to cols 8-19.
// The head is rendered as real pixel-art (no longer an emoji overlay):
// skin fill with a closed-eye line.
const SLEEP_BODY_FRAMES = [
  // Sleep frame 1 (breathing in)
  [
    "........................", // 0
    "........................", // 1
    "........................", // 2
    "........................", // 3
    "........................", // 4
    "........................", // 5
    "........................", // 6
    "........................", // 7
    "........................", // 8
    "........................", // 9
    "........................", // 10
    "........................", // 11
    "........................", // 12
    "..4444..................", // 13 head top
    ".422224.................", // 14 head outline + skin
    ".422224.44444444........", // 15 head + body top
    ".423324.4222222244......", // 16 closed eye + body inside
    ".422224.422222224.......", // 17 head bottom + body
    "..4444..422222224.......", // 18 head bottom + body
    "........4222222224......", // 19 body
    "........4444444443......", // 20 legs
    "........................", // 21
    "........................", // 22
    "........................", // 23
    "........................", // 24
    "........................", // 25
    "........................", // 26
    "........................", // 27
    "........................", // 28
    "........................", // 29
    "........................", // 30
    "........................", // 31
  ],
  // Sleep frame 2 (breathing out — torso shifts down 1px)
  [
    "........................", // 0
    "........................", // 1
    "........................", // 2
    "........................", // 3
    "........................", // 4
    "........................", // 5
    "........................", // 6
    "........................", // 7
    "........................", // 8
    "........................", // 9
    "........................", // 10
    "........................", // 11
    "........................", // 12
    "..4444..................", // 13
    ".422224.................", // 14
    ".422224.................", // 15
    ".423324.44444444........", // 16 closed eye + body top (1 row lower)
    ".422224.4222222244......", // 17 head + body
    "..4444..422222224.......", // 18 head bottom + body
    "........422222224.......", // 19 body
    "........4222222224......", // 20 body
    "........4444444443......", // 21 legs
  ],
];

// ── Decode string-grid frames to pixel arrays ─────────────────────────

function decodeFrame(rows) {
  const pixels = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "." || ch === "F") continue;
      const idx = parseInt(ch, 10);
      if (idx >= 1 && idx <= 4) pixels.push([x, y, idx]);
    }
  }
  return pixels;
}

function buildAwakeFrame(legFrameIdx, armFrameIdx, eatOverlay, hatStyle) {
  const hat = HAT_STYLES[hatStyle] || HAT_STYLES.cap;
  const rows = [...hat, ...FACE, ...TORSO, ...LEG_FRAMES[legFrameIdx]];
  // Merge arm overlay onto torso rows (start row 17)
  const arms = ARM_FRAMES[armFrameIdx] || ARM_FRAMES[0];
  for (let i = 0; i < arms.length && i < 8; i++) {
    const targetRow = 17 + i;
    const armRow = arms[i];
    // Overlay non-'.' chars from arm row onto rows[targetRow]
    const base = rows[targetRow] || "".padEnd(SPW, ".");
    const merged = [];
    for (let x = 0; x < SPW; x++) {
      const aCh = armRow[x] ?? ".";
      const bCh = base[x] ?? ".";
      merged.push(aCh !== "." ? aCh : bCh);
    }
    rows[targetRow] = merged.join("");
  }
  const pixels = decodeFrame(rows);

  // Eating overlay (palette 1, white food pixel)
  if (eatOverlay) {
    for (const op of eatOverlay) {
      for (const col of Object.keys(op.cols)) {
        pixels.push([parseInt(col, 10), op.row, op.cols[col]]);
      }
    }
  }

  return pixels;
}

// ── State + frame selection ───────────────────────────────────────────

const STATES = {
  idle: { fps: 2, frames: 2 },
  walk: { fps: 8, frames: 4 },
  sleep: { fps: 1, frames: 2 },
  eat: { fps: 4, frames: 6 },
  happy: { fps: 6, frames: 4 },
  look: { fps: 3, frames: 2 },
};

function getStateAndFrame(pet, frameMs, motion) {
  if (pet.sleeping) {
    const s = STATES.sleep;
    return { state: "sleep", frame: Math.floor((frameMs * s.fps) / 1000) % s.frames };
  }
  if (motion) {
    const moving = Math.abs(motion.vx) > 0.5 || Math.abs(motion.vz) > 0.001;
    if (moving) {
      const s = STATES.walk;
      return { state: "walk", frame: Math.floor((frameMs * s.fps) / 1000) % s.frames };
    }
  }
  // Idle — subtle 2-frame breathing loop
  const s = STATES.idle;
  return { state: "idle", frame: Math.floor((frameMs * s.fps) / 1000) % s.frames };
}

// ── Cached sprite build ───────────────────────────────────────────────

const CACHE_MAX = 200;
const _lru = new Map();

function cacheKey(pet, state, frame) {
  const c = pet.cosmetics ?? {};
  return [
    pet.seed,
    state,
    frame,
    c.wings,
    c.dress,
    c.head,
    c.hat_style,
    c.hair_style,
    c.c_hat,
    c.c_shirt,
    c.c_pants,
    c.c_shoes,
    c.c_hair,
    c.c_skin,
  ].join("|");
}

function getCache(key) {
  const e = _lru.get(key);
  if (!e) return null;
  e.lastUsed = Date.now();
  return e.canvas;
}

function setCache(key, canvas) {
  if (_lru.size >= CACHE_MAX) {
    let oldest = null,
      t = Infinity;
    for (const [k, v] of _lru) {
      if (v.lastUsed < t) {
        oldest = k;
        t = v.lastUsed;
      }
    }
    if (oldest) _lru.delete(oldest);
  }
  _lru.set(key, { canvas, lastUsed: Date.now() });
}

function drawPixels(ctx, pixels) {
  for (const p of pixels) {
    const v = p[2];
    const color = typeof v === "string" ? v : PAL[v];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(p[0] * PS, p[1] * PS, PS, PS);
  }
}

function drawHairLayer(ctx, styleKey, hairColor, hatStyle) {
  const style = HAIR_STYLES[styleKey];
  if (!style?.length || !hairColor) return;
  // Pixels above the brim (y < 8) only show when bareheaded; side hair
  // (y >= 8) frames the temples regardless of headwear.
  const hatWorn = hatStyle && hatStyle !== "bare";
  ctx.fillStyle = hairColor;
  for (const [x, y] of style) {
    if (hatWorn && y < 8) continue;
    ctx.fillRect(x * PS, y * PS, PS, PS);
  }
}

function buildBodyCanvas(pet, state, frame) {
  const oc = new OffscreenCanvas(AW, AH);
  const ctx = oc.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const c = pet.cosmetics ?? {};
  const palette = makePalette(pet);
  const hatStyle = c.hat_style || "cap";
  const hairStyle = c.hair_style || "short";

  if (state === "sleep") {
    drawPixels(ctx, decodeFrame(BED_SPRITE));
    drawPixels(ctx, tintPixels(decodeFrame(SLEEP_BODY_FRAMES[frame]), palette, roleOfSleep));
    return oc;
  }

  // Wings behind body
  if (c.wings) drawWingsPixels(ctx, c.wings);

  // Hair drawn BEFORE the hat-bearing body so the hat (rows 2-7) covers
  // any hair that would otherwise occupy the same pixels.
  drawHairLayer(ctx, hairStyle, palette.hair, hatStyle);

  let pixels;
  if (state === "walk") {
    pixels = buildAwakeFrame(frame, frame, null, hatStyle);
  } else if (state === "eat") {
    pixels = buildAwakeFrame(0, frame % 2 === 0 ? 1 : 0, EAT_OVERLAY_FRAMES[frame], hatStyle);
  } else if (state === "happy") {
    const armF = frame % 2 === 0 ? 1 : 3;
    pixels = buildAwakeFrame(frame === 1 || frame === 3 ? 0 : 2, armF, null, hatStyle);
  } else if (state === "look") {
    pixels = buildAwakeFrame(0, 0, null, hatStyle);
  } else {
    pixels = buildAwakeFrame(frame === 0 ? 0 : 2, 0, null, hatStyle);
  }
  drawPixels(ctx, tintPixels(pixels, palette));

  return oc;
}

function drawWingsPixels(ctx, wingKey) {
  const wc = WINGS_CONFIG[wingKey];
  if (!wc) return;
  ctx.fillStyle = wc.color;
  // Small pixel wings extending out from shoulders (rows 17-21)
  const wpx = [
    [3, 17],
    [4, 17],
    [19, 17],
    [20, 17],
    [2, 18],
    [3, 18],
    [20, 18],
    [21, 18],
    [2, 19],
    [3, 19],
    [20, 19],
    [21, 19],
    [3, 20],
    [4, 20],
    [19, 20],
    [20, 20],
  ];
  for (const [x, y] of wpx) ctx.fillRect(x * PS, y * PS, PS, PS);
}

// ── Public API ────────────────────────────────────────────────────────

export function composeAvatar(ctx, cx, groundY, pet, frameMs, scale = 1) {
  const c = pet.cosmetics ?? {};
  const motion = pet._motion;
  const { state, frame } = getStateAndFrame(pet, frameMs, motion);

  const key = cacheKey(pet, state, frame);
  let cached = getCache(key);
  if (!cached) {
    cached = buildBodyCanvas(pet, state, frame);
    setCache(key, cached);
  }

  const w = AW * scale;
  const h = AH * scale;
  const dx = Math.floor(cx - w / 2);
  const dy = Math.floor(groundY - h);

  // Aura — animated + rarity-tiered — sits behind everything (un-posed).
  if (c.aura) drawAura(ctx, cx, groundY - h / 2, h * 0.55, c.aura, frameMs);

  // Rarity halo — a colored glow cast from the sprite silhouette, sized to
  // the highest-rarity equipped cosmetic. Drawn behind the body sprite so
  // it reads as an outline glow, not a wash over the character.
  const showcase = showcaseRarity(c);
  if (showcase && showcase !== "common") {
    drawRarityHalo(ctx, cached, dx, dy, w, h, showcase, frameMs);
  }

  // Trail — ambient standing sample, behind the character (un-posed).
  if (c.trail && state !== "sleep") {
    drawTrailSample(ctx, cx, groundY, scale, c.trail, frameMs);
  }

  // Body + worn cosmetics (dress / accessory / head / shiny) ride the
  // optional pose transform together; aura / halo / trail / companion don't.
  ctx.save();
  if (c.pose && state !== "sleep") {
    applyPoseTransform(ctx, c.pose, cx, groundY, h, frameMs);
  }

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cached, dx, dy, w, h);
  ctx.imageSmoothingEnabled = prev;

  // Shiny treatment — a holographic sweep masked to the sprite's own pixels.
  if (Array.isArray(c.shiny) && c.shiny.length > 0 && state !== "sleep") {
    drawShinyOverlay(ctx, cached, dx, dy, w, h, frameMs);
  }

  if (c.dress && state !== "sleep") drawDress(ctx, dx, dy, scale, c.dress, frameMs);
  if (c.accessory && state !== "sleep") drawAccessory(ctx, dx, dy, scale, c.accessory, frameMs);
  if (c.head && state !== "sleep") drawHeadItem(ctx, dx, dy, scale, c.head, frameMs);

  ctx.restore();

  if (c.companion) drawCompanion(ctx, cx + w * 0.7, groundY, c.companion, frameMs, scale);

  // Floating "Z" for sleeping characters (small particle text)
  if (state === "sleep") drawSleepZ(ctx, cx, groundY - h * 0.85, frameMs, scale);
}

// ── Rarity / shiny treatment ──────────────────────────────────────────

const RARITY_RANK = { common: 0, rare: 1, royal: 2, mythic: 3 };
// Slots whose equipped item is a purchasable catalog cosmetic — these drive
// the showcase rarity. Aura/pose/hue/raw-color slots are excluded.
const RARITY_SLOTS = ["head", "wings", "dress", "accessory", "companion", "trail"];

// The single highest-rarity catalog item the chatter currently has equipped.
function showcaseRarity(c) {
  let best = null;
  let bestRank = -1;
  for (const slot of RARITY_SLOTS) {
    const rarity = ITEM_RARITY[c[slot]];
    const rank = RARITY_RANK[rarity];
    if (rank !== undefined && rank > bestRank) {
      bestRank = rank;
      best = rarity;
    }
  }
  return best;
}

// Cast a pulsing colored glow from the sprite's alpha silhouette. The sprite
// is drawn here only so its drop-shadow forms the halo — composeAvatar
// re-draws the opaque sprite immediately after, on top of this.
function drawRarityHalo(ctx, cached, dx, dy, w, h, rarity, frameMs) {
  const color = RARITY_COLOR[rarity];
  const glow = RARITY_GLOW[rarity];
  if (!color || !glow) return;

  const pulse = 0.5 + 0.5 * Math.sin((frameMs || 0) / (RARITY_PULSE_MS[rarity] || 1400));

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = (RARITY_HALO_ALPHA[rarity] || 0.5) * (0.55 + 0.45 * pulse);
  ctx.shadowColor = color;
  ctx.shadowBlur = glow * (0.7 + 0.6 * pulse);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cached, dx, dy, w, h);
  ctx.restore();
}

// One reusable offscreen for the shiny mask — shiny pets are rare (≈2% roll)
// and rendering is synchronous, so a single shared buffer is safe.
let _shinyOC = null;

function shinyCanvas(w, h) {
  if (!_shinyOC) {
    _shinyOC =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : document.createElement("canvas");
  }
  if (_shinyOC.width !== w || _shinyOC.height !== h) {
    _shinyOC.width = w;
    _shinyOC.height = h;
  }
  return _shinyOC;
}

// Holographic foil treatment for shiny-variant cosmetics: an iridescent hue
// wash plus a bright band that sweeps across the sprite, both masked to the
// sprite's own pixels via `source-atop` so it reads as a foil-card shimmer
// rather than a rectangle of light.
function drawShinyOverlay(ctx, cached, dx, dy, w, h, frameMs) {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  const oc = shinyCanvas(cw, ch);
  const octx = oc.getContext("2d");
  const t = frameMs || 0;

  octx.clearRect(0, 0, cw, ch);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cached, 0, 0, w, h);

  // Everything from here only paints where the sprite is already opaque.
  octx.globalCompositeOperation = "source-atop";

  // Iridescent full-sprite wash — slow hue cycle.
  octx.fillStyle = `hsla(${(t / 22) % 360}, 95%, 72%, 0.14)`;
  octx.fillRect(0, 0, w, h);

  // Sweeping highlight band.
  const sweep = (t / 1500) % 1;
  const bandX = -w * 0.6 + sweep * w * 2.2;
  const hue = (t / 14) % 360;
  const grad = octx.createLinearGradient(bandX - w * 0.35, 0, bandX + w * 0.35, h);
  grad.addColorStop(0.0, "rgba(255,255,255,0)");
  grad.addColorStop(0.46, `hsla(${hue}, 100%, 85%, 0)`);
  grad.addColorStop(0.5, `hsla(${hue}, 100%, 92%, 0.9)`);
  grad.addColorStop(0.54, `hsla(${(hue + 50) % 360}, 100%, 85%, 0)`);
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  octx.fillStyle = grad;
  octx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(oc, dx, dy, w, h);
  ctx.restore();
}

export function drawSleepZ(ctx, cx, cy, frameMs, scale) {
  const t = (frameMs / 800) % 1;
  const offsetX = Math.sin(t * Math.PI * 2) * 6 * scale;
  const offsetY = -t * 24 * scale;
  ctx.save();
  ctx.globalAlpha = 1 - t * 0.4;
  ctx.font = `bold ${Math.floor(18 * scale)}px FredokaOne, "Fredoka One", sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2 * scale;
  ctx.textAlign = "center";
  ctx.strokeText("z", cx + offsetX + 20 * scale, cy + offsetY);
  ctx.fillText("z", cx + offsetX + 20 * scale, cy + offsetY);
  ctx.restore();
}

// ── Head items (pixel shapes, kept colorful for cosmetic identity) ────

function drawHeadItem(ctx, dx, dy, scale, headKey, frameMs = 0) {
  const hc = HEAD_CONFIG[headKey];
  if (!hc) return;
  const S = PS * scale;
  const px = (x, y) => ctx.fillRect(dx + x * S, dy + y * S, S, S);

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = hc.color;

  if (hc.shape === "crown") {
    [
      [6, 0],
      [10, -1],
      [14, 0],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
      [10, 1],
      [11, 1],
      [12, 1],
      [13, 1],
      [14, 1],
      [6, 2],
      [7, 2],
      [8, 2],
      [9, 2],
      [10, 2],
      [11, 2],
      [12, 2],
      [13, 2],
      [14, 2],
    ].forEach(([x, y]) => px(x, y));
    if (hc.accent) {
      ctx.fillStyle = hc.accent;
      px(10, 1);
    }
  } else if (hc.shape === "tiara") {
    [
      [7, 1],
      [8, 1],
      [9, 1],
      [10, 1],
      [11, 1],
      [12, 1],
      [13, 1],
      [10, -1],
    ].forEach(([x, y]) => px(x, y));
    if (hc.accent) {
      ctx.fillStyle = hc.accent;
      px(10, 0);
    }
  } else if (hc.shape === "bow") {
    [
      [4, 1],
      [4, 2],
      [5, 1],
      [5, 2],
      [15, 1],
      [15, 2],
      [16, 1],
      [16, 2],
      [9, 1],
      [10, 1],
      [11, 1],
      [9, 2],
      [10, 2],
      [11, 2],
    ].forEach(([x, y]) => px(x, y));
    if (hc.accent) {
      ctx.fillStyle = hc.accent;
      px(10, 1);
    }
  } else if (hc.shape === "halo") {
    [
      [6, -1],
      [7, -1],
      [8, -1],
      [9, -1],
      [10, -1],
      [11, -1],
      [12, -1],
      [13, -1],
      [14, -1],
    ].forEach(([x, y]) => px(x, y));
  } else if (hc.shape === "horn") {
    [
      [10, -2],
      [10, -1],
      [11, -1],
    ].forEach(([x, y]) => px(x, y));
  } else if (hc.shape === "antlers") {
    [
      [4, -1],
      [5, 0],
      [6, 1],
      [16, -1],
      [15, 0],
      [14, 1],
      [3, -2],
      [17, -2],
    ].forEach(([x, y]) => px(x, y));
  }

  // Shimmer accent — a pulsing additive glint on shimmer-flagged headwear
  // (e.g. tiara_diamond). Drawn over the pixel shape.
  if (hc.shimmer) {
    const tw = 0.5 + 0.5 * Math.sin((frameMs || 0) / 260);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.35 + 0.65 * tw;
    px(10, 0);
    ctx.globalAlpha = (0.35 + 0.65 * tw) * 0.5;
    px(9, 1);
    px(11, 1);
    ctx.restore();
  }

  ctx.imageSmoothingEnabled = prev;
}

// ── Dress (bodice + per-cut skirt silhouette) ─────────────────────────

// Skirt profile per `cut` — rows of [row, startCol, endCol] inclusive fills.
const DRESS_SKIRT = {
  mini: [
    [23, 7, 16],
    [24, 6, 17],
    [25, 6, 17],
    [26, 5, 18],
  ],
  midi: [
    [23, 7, 16],
    [24, 7, 16],
    [25, 6, 17],
    [26, 6, 17],
    [27, 5, 18],
    [28, 5, 18],
  ],
  ball: [
    [22, 7, 16],
    [23, 6, 17],
    [24, 6, 17],
    [25, 5, 18],
    [26, 4, 19],
    [27, 4, 19],
    [28, 3, 20],
    [29, 3, 20],
    [30, 2, 21],
    [31, 2, 21],
  ],
  fairy: [
    [23, 7, 16],
    [24, 6, 17],
    [25, 7, 16],
    [26, 5, 18],
    [27, 6, 17],
    [28, 4, 19],
    [29, 5, 18],
  ],
};

function drawDress(ctx, dx, dy, scale, dressKey, frameMs = 0) {
  const dc = DRESS_CONFIG[dressKey];
  if (!dc) return;
  const S = PS * scale;
  const px = (x, y) => ctx.fillRect(dx + x * S, dy + y * S, S, S);
  const fillRow = (y, c0, c1) => {
    for (let x = c0; x <= c1; x++) px(x, y);
  };

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;

  const skirt = DRESS_SKIRT[dc.cut] || DRESS_SKIRT.midi;
  const hemRow = skirt[skirt.length - 1][0];

  // Bodice over the torso, with a secondary-color center seam.
  ctx.fillStyle = dc.primary;
  for (let y = 18; y <= 22; y++) fillRow(y, 7, 16);
  ctx.fillStyle = dc.secondary;
  for (let y = 18; y <= 22; y++) px(11, y);
  if (dc.collar) fillRow(17, 9, 14);

  // Skirt body, then a secondary-color hem on the bottom two rows.
  ctx.fillStyle = dc.primary;
  for (const [y, c0, c1] of skirt) fillRow(y, c0, c1);
  ctx.fillStyle = dc.secondary;
  for (const [y, c0, c1] of skirt) if (y >= hemRow - 1) fillRow(y, c0, c1);

  // Neon-edged gowns (cyber_neon) get a pulsing additive rim on the skirt.
  if (dc.neon) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = dc.secondary;
    ctx.globalAlpha = 0.45 + 0.4 * Math.sin((frameMs || 0) / 220);
    for (const [y, c0, c1] of skirt) {
      px(c0, y);
      px(c1, y);
    }
    ctx.restore();
  }
  // Shimmer-flagged gowns get a few pulsing white glints on the bodice.
  if (dc.shimmer) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin((frameMs || 0) / 300));
    px(9, 19);
    px(14, 21);
    px(11, 22);
    ctx.restore();
  }

  ctx.imageSmoothingEnabled = prev;
}

// ── Accessory (held / worn props) ─────────────────────────────────────

function drawAccessory(ctx, dx, dy, scale, accKey, _frameMs = 0) {
  const acc = ACCESS_CONFIG[accKey];
  if (!acc) return;
  const S = PS * scale;
  const px = (x, y) => ctx.fillRect(dx + x * S, dy + y * S, S, S);
  const dots = (arr) => {
    for (const [x, y] of arr) px(x, y);
  };

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = acc.color;

  if (acc.shape === "choker") {
    dots([
      [8, 16],
      [9, 16],
      [10, 16],
      [11, 16],
      [12, 16],
      [13, 16],
      [14, 16],
      [15, 16],
    ]);
    ctx.fillStyle = "#ffffff";
    px(11, 16);
    px(12, 16);
  } else if (acc.shape === "star_glasses") {
    dots([
      [8, 11],
      [9, 11],
      [10, 11],
      [11, 11],
      [12, 11],
      [13, 11],
      [14, 11],
      [15, 11],
      [16, 11],
      [17, 11],
      [8, 12],
      [11, 12],
      [14, 12],
      [17, 12],
    ]);
    if (acc.accent) ctx.fillStyle = acc.accent;
    px(8, 10);
    px(17, 10);
  } else if (acc.shape === "fan") {
    dots([
      [19, 17],
      [20, 17],
      [18, 18],
      [19, 18],
      [20, 18],
      [21, 18],
      [18, 19],
      [19, 19],
      [20, 19],
      [21, 19],
      [22, 19],
      [19, 20],
      [20, 20],
    ]);
    if (acc.accent) ctx.fillStyle = acc.accent;
    px(20, 21);
  } else if (acc.shape === "parasol") {
    dots([
      [18, 8],
      [19, 8],
      [20, 8],
      [17, 9],
      [18, 9],
      [19, 9],
      [20, 9],
      [21, 9],
      [16, 10],
      [17, 10],
      [18, 10],
      [19, 10],
      [20, 10],
      [21, 10],
      [22, 10],
    ]);
    if (acc.accent) ctx.fillStyle = acc.accent;
    dots([
      [19, 11],
      [19, 12],
      [19, 13],
      [19, 14],
      [19, 15],
      [19, 16],
      [19, 17],
      [19, 18],
      [19, 19],
      [19, 20],
    ]);
  } else if (acc.shape === "scepter") {
    dots([
      [19, 14],
      [19, 15],
      [19, 16],
      [19, 17],
      [19, 18],
      [19, 19],
      [19, 20],
      [19, 21],
      [19, 22],
      [19, 23],
    ]);
    if (acc.accent) ctx.fillStyle = acc.accent;
    dots([
      [19, 11],
      [18, 12],
      [19, 12],
      [20, 12],
      [18, 13],
      [19, 13],
      [20, 13],
    ]);
  }

  ctx.imageSmoothingEnabled = prev;
}

// ── Trail (ambient standing/preview sample — the real motion trail still
// fires from the sim loop while a pet actually walks) ──────────────────

function drawTrailParticle(ctx, x, y, r, kind, color, t) {
  ctx.fillStyle = kind === "shimmer" ? `hsl(${(t / 8) % 360}, 90%, 75%)` : color;
  if (kind === "heart") {
    ctx.fillRect(x - r, y - r * 0.5, r, r);
    ctx.fillRect(x, y - r * 0.5, r, r);
    ctx.fillRect(x - r * 0.5, y + r * 0.3, r, r);
  } else {
    // 4-point pixel sparkle (sparkle / shimmer / glamburst)
    ctx.fillRect(x - r * 0.4, y - r, r * 0.8, r * 2);
    ctx.fillRect(x - r, y - r * 0.4, r * 2, r * 0.8);
  }
}

export function drawTrailSample(ctx, cx, groundY, scale, trailKey, frameMs = 0) {
  const tc = TRAIL_CONFIG[trailKey];
  if (!tc) return;
  const t = frameMs || 0;
  // Fan a few particles down-and-back from the feet.
  const spots = [
    [-13, -6],
    [-21, -13],
    [-29, -5],
    [-10, -18],
    [-25, -22],
  ];

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  spots.forEach(([ox, oy], i) => {
    const bob = Math.sin(t / 360 + i) * 3;
    const x = cx + ox * scale;
    const y = groundY + oy * scale + bob;
    ctx.globalAlpha = Math.max(0.15, 0.4 + 0.4 * Math.sin(t / 300 + i * 1.7));
    drawTrailParticle(ctx, x, y, 3.2 * scale, tc.kind, tc.color, t);
  });
  ctx.restore();
}

// ── Pose (transform applied to the body + worn cosmetics) ─────────────
// Caller wraps this in save()/restore(). twirl = horizontal squash so a flat
// sprite reads as spinning; curtsy = a dip; finger_gun = a casual lean.

export function applyPoseTransform(ctx, poseKey, cx, groundY, h, frameMs) {
  const pc = POSE_CONFIG[poseKey];
  if (!pc) return;
  const t = frameMs || 0;

  if (pc.id === "twirl") {
    let sx = Math.cos(t / 320);
    if (Math.abs(sx) < 0.05) sx = 0.05 * (sx < 0 ? -1 : 1);
    ctx.translate(cx, 0);
    ctx.scale(sx, 1);
    ctx.translate(-cx, 0);
  } else if (pc.id === "curtsy") {
    ctx.translate(0, Math.abs(Math.sin(t / 750)) * h * 0.1);
  } else if (pc.id === "finger_gun") {
    ctx.translate(cx, groundY);
    ctx.rotate(Math.sin(t / 480) * 0.13);
    ctx.translate(-cx, -groundY);
  }
}

// ── Companion + Aura (cosmetic, kept colorful) ────────────────────────

export function drawCompanion(ctx, cx, groundY, compKey, frameMs, scale) {
  const cc = COMPANION_CONFIG[compKey];
  if (!cc) return;
  const sz = Math.max(2 * scale, Math.floor(10 * scale * (cc.size || 1)));
  const bounce = Math.sin(frameMs / 280) * 2 * scale;
  const cy = groundY - sz - bounce;

  // Glowing companions (e.g. sparkle_orb) get a pulsing additive halo.
  if (cc.glow) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = cc.accent || cc.body;
    ctx.shadowBlur = (6 + 6 * (0.5 + 0.5 * Math.sin((frameMs || 0) / 240))) * scale;
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = cc.accent || cc.body;
    ctx.beginPath();
    ctx.arc(cx, cy, sz * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = cc.body;
  ctx.fillRect(Math.floor(cx - sz / 2), Math.floor(cy - sz / 2), sz, sz);
  ctx.fillRect(Math.floor(cx - sz / 2 - 1), Math.floor(cy - sz / 4), sz + 2, Math.floor(sz / 2));
  ctx.fillStyle = "#000000";
  const eyeS = Math.max(1, Math.floor(2 * scale));
  ctx.fillRect(Math.floor(cx - sz / 3), Math.floor(cy - sz / 6), eyeS, eyeS);
  ctx.fillRect(Math.floor(cx + sz / 6), Math.floor(cy - sz / 6), eyeS, eyeS);
}

// Animated, rarity-tiered aura. Three additive layers — a breathing radial
// glow (all tiers), a rotating conic light sweep (rare+), and expanding pulse
// rings (royal/diamond/mythic) — so a chatter's trophy tier reads instantly
// from across the stage. All composited with `lighter` for a true glow.
export function drawAura(ctx, cx, cy, r, auraKey, frameMs = 0) {
  const ac = AURA_CONFIG[auraKey];
  if (!ac) return;

  const t = frameMs || 0;
  const pulse = 0.5 + 0.5 * Math.sin(t / (ac.pulseMs || 1800));

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Layer 1 — breathing radial glow.
  const baseR = r * (1.5 + 0.2 * pulse);
  const a8 = Math.round(ac.alpha * (0.7 + 0.5 * pulse) * 255)
    .toString(16)
    .padStart(2, "0");
  const gg = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, baseR);
  gg.addColorStop(0, "transparent");
  gg.addColorStop(0.5, ac.color + a8);
  gg.addColorStop(1, "transparent");
  ctx.fillStyle = gg;
  ctx.beginPath();
  ctx.ellipse(cx, cy, baseR, baseR * 1.25, 0, 0, Math.PI * 2);
  ctx.fill();

  // Layer 2 — rotating conic light sweep (rare+). Guarded for older CEF
  // builds that predate createConicGradient — the other layers still render.
  if (ac.spin && typeof ctx.createConicGradient === "function") {
    const cg = ctx.createConicGradient(t * ac.spin, cx, cy);
    cg.addColorStop(0.0, "transparent");
    cg.addColorStop(0.1, `${ac.color}cc`);
    cg.addColorStop(0.2, "transparent");
    cg.addColorStop(0.55, "transparent");
    cg.addColorStop(0.65, `${ac.color}66`);
    cg.addColorStop(0.75, "transparent");
    const sweepR = r * 1.45;
    ctx.globalAlpha = 0.5 + 0.35 * pulse;
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(cx, cy, sweepR, sweepR * 1.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Layer 3 — expanding pulse rings, each on its own phase so they ripple
  // outward continuously (royal: 1, diamond: 2, mythic: 3).
  const rings = ac.rings || 0;
  for (let i = 0; i < rings; i++) {
    const phase = (t / (ac.pulseMs || 1500) + i / rings) % 1;
    const ringR = r * (0.65 + phase * 1.7);
    ctx.globalAlpha = (1 - phase) * 0.5 * ac.alpha;
    ctx.strokeStyle = ac.color;
    ctx.lineWidth = Math.max(1, 3 * (1 - phase));
    ctx.beginPath();
    ctx.ellipse(cx, cy, ringR, ringR * 1.2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

// Avatar dimensions for vibe-coder-sim.js to position name labels + bubbles
export const AVATAR_DIMENSIONS = { width: AW, height: AH };
