// SIGMA ABYSS — overworld renderer.
//
// Two scenes, one ground plane: the safe hub (your sigma wanders
// Ironhollow) and an active delve (your sigma walks ever deeper while
// danger fog thickens). Both draw the hero through the ported
// composeAvatar() — the exact 24x32 layered-cosmetic renderer from the
// vibe-coder-sim. Combat itself is handed off to combat-view.js.

import { AVATAR_DIMENSIONS, composeAvatar, composeEnemy } from "/avatar/lpc-avatar.js";
import { DANGER_BOSS_AT, DANGER_ELITE_AT, VH, VW } from "/shared/constants.js";
import { ENEMIES } from "/shared/enemies.js";
import { zoneById } from "/shared/zones.js";
import { sfx } from "./audio.js";
import * as barks from "./barks.js";

const _AV_H = AVATAR_DIMENSIONS.height;

// Ground-plane bounds in virtual space.
const GROUND_TOP = 560;
const GROUND_Y = 968;

// Per-zone colour theme — keyed by zone id, escalating dread by tier.
const ZONE_THEME = {
  goblin_warrens: { hue: 110, dark: "#0a1208", mote: "#7bd16a" },
  cursed_forest: { hue: 96, dark: "#0c1206", mote: "#9fe06a" },
  infernal_highway: { hue: 22, dark: "#180a05", mote: "#ff8a3a" },
  demon_catacombs: { hue: 286, dark: "#10081a", mote: "#b86bff" },
  abyss_ruins: { hue: 268, dark: "#0a0612", mote: "#d9b3ff" },
  town: { hue: 36, dark: "#100c08", mote: "#ffcc77" },
};

let pet = null;
let character = null; // reference for zone lookups + featuredUntil
const motion = {
  x: VW * 0.5,
  z: 0.5,
  vx: 0,
  vz: 0,
  facing: 1,
  targetX: VW * 0.5,
  targetZ: 0.5,
  idleUntil: 0,
};
let scrollX = 0; // delve parallax offset
let motes = null; // ambient drifting specks

// Wandering enemies in the delve scene — pure decoration. They approach
// the hero, despawn on contact, and respawn from off-screen right. They
// don't drive combat (which fires on the auto-battler tick cadence) but
// give the abyss the "Pokémon-overworld with hostile sprites" feel the
// game's positioning promises.
const wanderingEnemies = [];
const MAX_WANDERERS = 3;
let lastWanderZoneId = null;
// When a wanderer reaches melee range the hero swings; this is the window
// (perf.now ms) the hero holds its slash pose so the overworld actually
// SHOWS the sigma fighting the monsters instead of them vanishing on contact.
let heroSwingUntil = 0;

// Stream-overlay mode (`?overlay=1`): strip all background art so the
// canvas can sit transparently on top of an OBS scene. Hero + wanderers
// only; no sky, ground plane, motes, NPCs, fog, scene labels.
let overlayMode = false;
export function setOverlayMode(on) {
  overlayMode = !!on;
}

export function setCharacter(c) {
  character = c;
  pet = {
    seed: c.seed,
    cosmetics: c.cosmetics || {},
    sleeping: c.posture === "rest",
    _motion: motion,
    // Equipped weapon → in-hand blade layer (lpcBuild reads pet.weapon) so the
    // sigma carries + swings its weapon in the overworld, not just in combat.
    weapon: c.run?.gear?.weapon || null,
  };
}

function pickWandererKind(zone) {
  const pool =
    zone && Array.isArray(zone.enemies) && zone.enemies.length ? zone.enemies : ["goblin"];
  return pool[Math.floor(Math.random() * pool.length)];
}

function spawnWanderer(zone) {
  const id = pickWandererKind(zone);
  const def = ENEMIES[id] || ENEMIES.goblin;
  // Keep monsters in the hero's lane (hero sits at z 0.62). The old 0.55..0.90
  // spread scattered them across the whole depth field — some floating high in
  // the back, some down at the camera — which read as "walking in weird
  // locations". A tight band still gives a little parallax without the chaos.
  const z = 0.56 + Math.random() * 0.14;
  return {
    id,
    lpc: def.lpc,
    kind: def.kind,
    hue: def.hue,
    // Stagger so the three don't spawn in a stack, but not so far back that the
    // stage sits empty waiting for them to walk on.
    x: VW + 60 + Math.random() * 380, // off-screen right
    z,
    speed: 0.1 + Math.random() * 0.07, // px/ms — approach, fast enough to reach the hero
    scale: 2.7, // approaching-monster size — reads next to the hero
    bob: Math.random() * 6.28, // phase offset for idle bob
    hitAt: 0, // perf.now when it reached the hero (mid-clash), else 0
  };
}

// Send a wanderer back off-screen right, reusing the object. Clearing hitAt is
// what ends the clash state — without it the recycled monster would respawn
// already "hit".
function recycleWanderer(e, zone) {
  Object.assign(e, spawnWanderer(zone));
  e.hitAt = 0;
}

function refreshWanderers(zone) {
  if (!zone || zone.safe) {
    wanderingEnemies.length = 0;
    lastWanderZoneId = null;
    return;
  }
  if (lastWanderZoneId !== zone.id) {
    wanderingEnemies.length = 0;
    lastWanderZoneId = zone.id;
  }
  while (wanderingEnemies.length < MAX_WANDERERS) {
    wanderingEnemies.push(spawnWanderer(zone));
  }
}

function ensureMotes() {
  if (motes) return;
  motes = [];
  for (let i = 0; i < 70; i += 1) {
    motes.push({
      x: Math.random() * VW,
      y: Math.random() * GROUND_Y,
      r: Math.random() * 2.4 + 0.6,
      sp: Math.random() * 0.5 + 0.15,
      ph: Math.random() * 6.28,
    });
  }
}

function project(x, z) {
  return {
    sx: x,
    sy: GROUND_TOP + z * (GROUND_Y - GROUND_TOP),
    scale: 3.2 + z * 1.7,
  };
}

// ── Motion ────────────────────────────────────────────────────────────
function wander(dt, now) {
  if (pet?.sleeping) {
    motion.vx = 0;
    motion.vz = 0;
    return;
  }
  if (now < motion.idleUntil) {
    motion.vx = 0;
    motion.vz = 0;
    return;
  }
  const dx = motion.targetX - motion.x;
  const dz = (motion.targetZ - motion.z) * (GROUND_Y - GROUND_TOP);
  const dist = Math.hypot(dx, dz);
  if (dist < 8) {
    motion.vx = 0;
    motion.vz = 0;
    motion.idleUntil = now + 500 + Math.random() * 1600;
    motion.targetX = VW * 0.2 + Math.random() * VW * 0.6;
    motion.targetZ = 0.25 + Math.random() * 0.6;
    return;
  }
  const spd = 0.13;
  // vx is screen px/ms; vz is z-units/ms (z is a 0..1 fraction, NOT pixels).
  motion.vx = (dx / dist) * spd;
  motion.vz = ((motion.targetZ - motion.z) / dist) * spd;
  motion.x += motion.vx * dt;
  motion.z += motion.vz * dt;
  motion.x = Math.max(VW * 0.08, Math.min(VW * 0.92, motion.x));
  motion.z = Math.max(0.05, Math.min(0.95, motion.z));
  motion.facing = motion.vx >= 0 ? 1 : -1;
}

export function step(dt, mode, now) {
  ensureMotes();
  if (mode === "town") {
    wander(dt, now);
    wanderingEnemies.length = 0;
    lastWanderZoneId = null;
    heroSwingUntil = 0;
  } else {
    // Delving — march rightward in place, the world scrolls past.
    motion.x = VW * 0.34;
    motion.z = 0.62;
    motion.vx = 1; // keeps avatar.js in its walk cycle
    motion.facing = 1;
    scrollX = (scrollX + dt * 0.16) % 240;

    // Wandering enemies chase leftward toward the hero. When one reaches melee
    // the hero swings (heroSwingUntil) and it recoils + flashes for a beat
    // before being sent back off-screen right. They're decorative — the
    // deterministic tick still owns real encounters — but now the overworld
    // actually shows the sigma fighting instead of monsters blinking out.
    const zone = character?.run ? zoneById(character.run.zone) : null;
    refreshWanderers(zone);
    const HERO_X = VW * 0.34;
    const MELEE = 70;
    for (const e of wanderingEnemies) {
      if (e.hitAt) {
        if (now - e.hitAt > 240) {
          recycleWanderer(e, zone);
          // monster sent packing — an occasional victory quip as it despawns
          barks.say("kill", { chance: 0.22 });
        }
        continue; // held in the clash — don't keep advancing
      }
      e.x -= e.speed * dt;
      if (e.x <= HERO_X + MELEE) {
        e.hitAt = now; // reached the hero — start the clash
        // Hold the slash long enough for the full 6-frame @13fps swing (~462ms)
        // to play and visibly read as a slash before snapping back to walk.
        heroSwingUntil = now + 520;
        // The overworld walk used to be SILENT — now you actually HEAR the
        // sigma connect when it clashes with a wandering monster.
        sfx.hit();
        barks.say("hit", { chance: 0.45 });
      }
    }
    // bored quips while nothing is happening — heavily throttled in barks.js
    barks.say("idle", { chance: 0.02 });
  }
  for (const m of motes) {
    m.x -= m.sp * dt * 0.06;
    if (m.x < -10) m.x = VW + 10;
  }
}

// ── Shared scenery ────────────────────────────────────────────────────
function drawGroundPlane(ctx, topTint) {
  const g = ctx.createLinearGradient(0, GROUND_TOP, 0, GROUND_Y + 60);
  g.addColorStop(0, topTint);
  g.addColorStop(1, "#00000020");
  ctx.fillStyle = g;
  ctx.fillRect(0, GROUND_TOP, VW, GROUND_Y - GROUND_TOP + 60);
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i += 1) {
    const y = GROUND_TOP + (GROUND_Y - GROUND_TOP) * (i / 4);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(VW, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMotes(ctx, color, now) {
  if (!motes) return;
  ctx.save();
  ctx.fillStyle = color;
  for (const m of motes) {
    ctx.globalAlpha = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(now / 700 + m.ph));
    ctx.fillRect(m.x, m.y, m.r, m.r);
  }
  ctx.restore();
}

// Effective combatant level shown in the overworld — mirrors the value
// buildEncounter() stamps onto fight enemies (run.level + floor(depth/2)) so the
// "Lv N" a wandering monster shows matches what the player will actually fight.
function enemyOverworldLevel() {
  const run = character?.run;
  if (!run) return 1;
  return (run.level || 1) + Math.floor((run.depth || 0) / 2);
}

// Compact "Lv N" pill, consistent with combat-view's styling but sized for the
// overworld scale. Drawn centred on (cx, cy). `big` bumps it for boss/elite.
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
  ctx.textBaseline = "alphabetic";
}

function drawHero(ctx, now) {
  if (!pet) return;
  const p = project(motion.x, motion.z);

  // Featured halo — set by the "Feature My Sigma" Twitch redemption. Pulsing
  // gold ring under the sigma's feet for the duration of the spotlight.
  const featuredUntil = character ? character.featuredUntil || 0 : 0;
  if (featuredUntil > Date.now()) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.35 * pulse;
    ctx.strokeStyle = "#ffd700";
    ctx.lineWidth = 4 + pulse * 3;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, 44 * (p.scale / 4), 12 * (p.scale / 4), 0, 0, Math.PI * 2);
    ctx.stroke();
    // Inner glow
    ctx.globalAlpha = 0.18 + 0.12 * pulse;
    ctx.fillStyle = "#fff3a8";
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, 36 * (p.scale / 4), 9 * (p.scale / 4), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // The LPC renderer reads pet._motion.facing and picks the L/R sprite row
  // itself — no canvas mirror needed (and a mirror would double-flip it).
  // Mid-clash the hero plays its slash so the player visibly attacks.
  const heroAnim = heroSwingUntil > now ? "slash" : null;
  composeAvatar(ctx, p.sx, p.sy, pet, now, p.scale, heroAnim);
  // soft contact shadow
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(p.sx, p.sy, 26 * (p.scale / 4), 7 * (p.scale / 4), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // hero "Lv N" floating just above the head, in both town and delve
  const heroLevel = character?.run?.level;
  if (heroLevel != null)
    levelPill(ctx, p.sx, p.sy - _AV_H * p.scale - 14, heroLevel, "#9ad0ff", false);
  return p;
}

function drawWanderers(ctx, now, band) {
  if (!wanderingEnemies.length) return;
  // Split around the hero's lane so nearer monsters (bigger z) draw IN FRONT
  // of the hero and farther ones behind — the caller draws "back" before the
  // hero and "front" after. Sort within the band by z for self-consistency.
  const list = wanderingEnemies.filter((e) =>
    band === "front" ? e.z > motion.z : e.z <= motion.z,
  );
  list.sort((a, b) => a.z - b.z);
  for (const e of list) {
    const clash = e.hitAt ? now - e.hitAt : -1;
    // Recoil right (knockback) while clashing with the hero.
    const recoil = clash >= 0 ? Math.min(20, clash * 0.12) : 0;
    const p = project(e.x + recoil, e.z);
    const bob = Math.sin(now / 220 + e.bob) * 3;
    // contact shadow
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, 22 * (p.scale / 4), 6 * (p.scale / 4), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Walking in, they face LEFT toward the hero. Mid-clash they flash white
    // (taking the hero's blow) and throw their own slash, so it reads as a
    // real trade rather than a sprite sliding into the hero and vanishing.
    const flash = clash >= 0 && clash < 140;
    const anim = clash >= 0 ? "slash" : "walk";
    const ok = composeEnemy(
      ctx,
      p.sx,
      p.sy - bob,
      e.lpc,
      anim,
      now,
      e.scale * (p.scale / 4),
      flash,
      "left",
    );
    if (!ok) {
      // LPC assets still loading — draw a coloured silhouette so the user
      // sees SOMETHING wandering rather than an empty stage.
      const w = 36 * (p.scale / 4);
      const h = e.kind === "boss" ? 72 : e.kind === "elite" ? 60 : 48;
      ctx.fillStyle = flash ? "#ffffff" : `hsl(${e.hue ?? 280} 52% 46%)`;
      ctx.fillRect(p.sx - w / 2, p.sy - h - bob, w, h * (p.scale / 4));
    }
    // "Lv N" above the monster's head; boss/elite get the larger pill + accent.
    const big = e.kind !== "normal";
    const accent = e.kind === "boss" ? "#ff4d6d" : e.kind === "elite" ? "#ff9d2e" : "#d46a7a";
    const top = p.sy - _AV_H * e.scale * (p.scale / 4) - bob - 12;
    levelPill(ctx, p.sx, top, enemyOverworldLevel(), accent, big);
  }
}

function vignette(ctx, strength, color) {
  const g = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.3, VW / 2, VH / 2, VH * 0.85);
  g.addColorStop(0, "transparent");
  g.addColorStop(1, color);
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
  ctx.restore();
}

// ── TOWN ──────────────────────────────────────────────────────────────
const BUILDINGS = [
  { x: 250, label: "BANK" },
  { x: 720, label: "BLACK MARKET" },
  { x: 1190, label: "GARAGE" },
  { x: 1620, label: "ARCANE LAB" },
];

// Townsfolk — one LPC NPC posted outside each building. Cosmetic only, they
// never move. Build specs share the `lpc` paperdoll shape from shared/enemies.js.
const NPCS = [
  {
    x: 250,
    y: 660,
    dir: "right",
    lpc: {
      body: "human",
      skin: "light",
      hair: "short",
      hairColor: "dark_gray",
      shirt: "navy",
      pants: "charcoal",
      hat: "hat_tophat",
    },
  },
  {
    x: 720,
    y: 664,
    dir: "down",
    lpc: {
      body: "human",
      skin: "taupe",
      hair: "long",
      hairColor: "black",
      shirt: "charcoal",
      pants: "charcoal",
      hat: "hat_cap",
    },
  },
  {
    x: 1190,
    y: 664,
    dir: "down",
    lpc: {
      body: "human",
      skin: "bronze",
      hair: "spiky",
      hairColor: "chestnut",
      shirt: "red",
      pants: "brown",
    },
  },
  {
    x: 1620,
    y: 660,
    dir: "left",
    lpc: {
      body: "human",
      skin: "olive",
      hair: "long",
      hairColor: "platinum",
      shirt: "purple",
      pants: "purple",
      hat: "hat_wizard",
    },
  },
];
const NPC_SCALE = 2.5;

function drawNpcs(ctx, now) {
  for (const npc of NPCS) {
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(npc.x, npc.y, 26, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    composeEnemy(ctx, npc.x, npc.y, npc.lpc, "idle", now, NPC_SCALE, false, npc.dir);
  }
}

export function drawTown(ctx, _character, now) {
  if (overlayMode) {
    // OBS browser-source mode — just the sigma on transparent canvas.
    // In town there are no wanderers (zone is safe), but auto-deploy in
    // main.js means we generally don't sit in town in overlay mode.
    drawHero(ctx, now);
    return;
  }

  ctx.fillStyle = "#0a0810";
  ctx.fillRect(0, 0, VW, VH);
  // warm hub haze
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_TOP);
  sky.addColorStop(0, "#140f08");
  sky.addColorStop(1, "#241a10");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VW, GROUND_TOP);

  // back-row buildings
  for (const b of BUILDINGS) {
    const bw = 230,
      bh = 260,
      bx = b.x - bw / 2,
      by = GROUND_TOP - bh + 30;
    ctx.fillStyle = "#15110d";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = "#332518";
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    // lit windows
    ctx.fillStyle = "#ffb84d";
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        if ((r + c + b.x) % 4 === 0) continue;
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(now / 900 + r + c + b.x);
        ctx.fillRect(bx + 30 + c * 60, by + 36 + r * 64, 28, 34);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#7b6a4f";
    ctx.font = "20px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(b.label, b.x, GROUND_TOP + 52);
  }

  drawGroundPlane(ctx, "#1c1208");
  drawMotes(ctx, ZONE_THEME.town.mote, now);
  drawNpcs(ctx, now);
  drawHero(ctx, now);
  vignette(ctx, 0.55, "#000");

  // scene label
  ctx.fillStyle = "#ffcc77";
  ctx.font = "bold 30px JetBrains Mono, monospace";
  ctx.textAlign = "left";
  ctx.fillText("IRONHOLLOW — the last lit place", 40, 60);
}

// ── DELVE ─────────────────────────────────────────────────────────────
export function drawDelve(ctx, character, now) {
  const run = character.run;
  const zone = zoneById(run.zone);
  const theme = ZONE_THEME[zone.id] || ZONE_THEME.abyss_ruins;
  const danger = run.danger || 0;

  if (overlayMode) {
    // Stream-overlay: NO background, NO sky, NO fog, NO pillars, NO
    // scene label — chatters see the live stream behind the canvas and
    // just the sigma + monsters chasing it on top.
    refreshWanderers(zone);
    // (world.step has already advanced wanderer positions for this frame)
    drawWanderers(ctx, now, "back");
    const hp = drawHero(ctx, now);
    drawWanderers(ctx, now, "front");
    if (hp) barks.draw(ctx, hp.sx, hp.sy - 40 * hp.scale, now);
    return;
  }

  // themed sky
  ctx.fillStyle = theme.dark;
  ctx.fillRect(0, 0, VW, VH);
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_TOP);
  sky.addColorStop(0, theme.dark);
  sky.addColorStop(1, `hsl(${theme.hue} 40% 8%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VW, GROUND_TOP);

  // scrolling depth pillars (parallax)
  ctx.save();
  ctx.strokeStyle = `hsl(${theme.hue} 30% 22%)`;
  ctx.lineWidth = 3;
  for (let i = -1; i < 10; i += 1) {
    const px = i * 240 - scrollX;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(px, 120);
    ctx.lineTo(px, GROUND_Y);
    ctx.stroke();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = `hsl(${theme.hue} 25% 14%)`;
    ctx.fillRect(px - 26, 120, 52, GROUND_Y - 120);
  }
  ctx.restore();

  drawGroundPlane(ctx, `hsl(${theme.hue} 30% 10%)`);
  drawMotes(ctx, theme.mote, now);

  // boss looming at the edge once danger is high
  if (danger >= DANGER_BOSS_AT) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.35 * pulse;
    const bg = ctx.createRadialGradient(VW - 120, VH * 0.55, 40, VW - 120, VH * 0.55, 520);
    bg.addColorStop(0, "#ff2d4d");
    bg.addColorStop(1, "transparent");
    ctx.fillStyle = bg;
    ctx.fillRect(VW - 700, 0, 700, VH);
    ctx.restore();
  }

  // Wanderers split around the hero's lane: farther-back ones draw behind the
  // hero, nearer ones in front, so a monster passing the camera-side reads
  // correctly instead of always sliding under the sigma.
  drawWanderers(ctx, now, "back");
  const heroP = drawHero(ctx, now);
  drawWanderers(ctx, now, "front");

  // danger fog — thickens + reddens with the danger meter
  if (danger > 0.02) {
    ctx.save();
    ctx.globalAlpha = Math.min(0.6, danger * 0.62);
    const fog = ctx.createLinearGradient(0, 0, VW, 0);
    fog.addColorStop(0, "#00000000");
    fog.addColorStop(1, danger >= DANGER_ELITE_AT ? "#5e0a16" : "#000000");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, VW, VH);
    ctx.restore();
  }
  vignette(ctx, 0.4 + danger * 0.4, danger >= DANGER_ELITE_AT ? "#1a0006" : "#000");

  // scene label
  ctx.fillStyle = theme.mote;
  ctx.font = "bold 30px JetBrains Mono, monospace";
  ctx.textAlign = "left";
  ctx.fillText(`${zone.name.toUpperCase()} — depth ${run.depth}`, 40, 60);

  // bark bubble last — crisp on top of the fog + vignette
  if (heroP) barks.draw(ctx, heroP.sx, heroP.sy - 40 * heroP.scale, now);
}

// Calm backdrop for boot / death overlays.
export function drawVoid(ctx, now) {
  ctx.fillStyle = "#06060a";
  ctx.fillRect(0, 0, VW, VH);
  ensureMotes();
  drawMotes(ctx, "#3a3a55", now);
  vignette(ctx, 0.7, "#000");
}
