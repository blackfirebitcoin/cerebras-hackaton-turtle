// SIGMA ABYSS — LPC sprite renderer.
//
// Drop-in replacement for avatar.js's composeAvatar(): same signature, so
// world.js and combat-view.js only change an import. Renders the hero, NPCs,
// and enemies as layered 64×64 Universal-LPC paperdolls — real body / hair /
// clothes / hats / wings sprites — palette-recoloured per chatter.
//
// Pipeline:
//   cosmetics.lpcBuild(pet)  → ordered LPC layers (assetId + recolour)
//   pick anim + direction from pet state (idle / walk / sit + facing)
//   composite the 64×64 frame  (cached per build-signature × anim × dir × frame)
//   blit scaled to the game canvas, feet on groundY
//   draw the procedural FX on top (aura / trail / companion / pose / props) —
//     those are positional effects LPC has no sprite for; avatar.js still owns them.
//
// Until index.json + the body sheet have loaded, composeAvatar() transparently
// delegates to the procedural avatar.js so the game never shows an empty stage.

import {
  applyPoseTransform,
  drawAura,
  drawCompanion,
  drawSleepZ,
  drawTrailSample,
  composeAvatar as proceduralCompose,
} from "./avatar.js";
import { drawLpcProps, enemyBuild, lpcBuild } from "./cosmetics.js";
import { animSpec, DIR_ROW, FRAME, LPC_BASE } from "./lpc-manifest.js";
import { makeCanvas, recolorCanvas } from "./lpc-recolor.js";

// Where the character's feet sit inside the 64-tall frame, and a size nudge so
// an LPC paperdoll reads at roughly the same on-stage size as the old 24×32.
const FOOT_Y = 60;
const SCALE_BOOST = 1.3;

export const AVATAR_DIMENSIONS = { width: FRAME, height: FRAME };

// ── async asset state ─────────────────────────────────────────────────
let index = null; // /assets/lpc/index.json — what actually shipped
let indexReady = false;
const imgCache = new Map(); // url → { img, ready }
const sheetCache = new Map(); // assetId|anim|part|ramp → recoloured sheet canvas
const frameCache = new Map(); // sig|anim|dir|frame → composited 64×64 canvas
const CACHE_MAX = 280;

function lru(map, key, value) {
  if (value !== undefined) {
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
  }
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

function loadImage(url) {
  let e = imgCache.get(url);
  if (e) return e;
  e = { img: new Image(), ready: false, failed: false };
  e.img.onload = () => {
    e.ready = true;
  };
  e.img.onerror = () => {
    e.failed = true;
  };
  e.img.src = url;
  imgCache.set(url, e);
  return e;
}

async function init() {
  try {
    // index.json is the live asset manifest — it changes on every deploy that
    // adds or renames a sprite, so revalidate it (`no-cache`, a cheap 304).
    // `force-cache` pinned a stale copy: expandLayers() then drops any newly
    // named layer, and a dropped dress renders the avatar NAKED.
    const res = await fetch(`${LPC_BASE}/index.json`, { cache: "no-cache" });
    index = await res.json();
    indexReady = true;
    // Warm the layers every sigma needs so the swap-in is instant.
    for (const anim of ["idle", "walk"]) {
      loadImage(`${LPC_BASE}/body_human/${anim}.png`);
      loadImage(`${LPC_BASE}/hair_plain/${anim}.png`);
      loadImage(`${LPC_BASE}/shirt_basic/${anim}.png`);
      loadImage(`${LPC_BASE}/pants_basic/${anim}.png`);
      loadImage(`${LPC_BASE}/shoes_basic/${anim}.png`);
    }
  } catch {
    indexReady = false; // stay on the procedural fallback forever — still playable
  }
}
init();

// ── anim / direction selection ────────────────────────────────────────
function pickState(pet, animOverride) {
  if (pet?.sleeping) return { anim: "sit", dir: "down" };
  const m = pet?._motion;
  // Opt-in explicit facing for scenes that need to face the camera or
  // face away from it (e.g. the JRPG-style boss arena, where the party
  // faces up and the boss faces down). Backwards-compatible: existing
  // callers don't set m.dir so they fall through to the left/right
  // logic from `facing`.
  const explicit =
    m && (m.dir === "up" || m.dir === "down" || m.dir === "left" || m.dir === "right")
      ? m.dir
      : null;
  const moving = m && (Math.abs(m.vx) > 0.5 || Math.abs(m.vz) > 0.001);
  const dir = explicit || (m && m.facing < 0 ? "left" : "right");
  // An explicit anim (e.g. "slash" while the hero is mid-swing) overrides the
  // motion-derived idle/walk so combat can SHOW the avatar attacking; the
  // facing row still follows `facing`/`dir`. Callers that don't pass one keep
  // the old idle/walk behaviour exactly.
  return { anim: animOverride || (moving ? "walk" : "idle"), dir };
}

// The anim a given asset will actually use (skeletons have no idle/sit, etc.).
const ANIM_FALLBACK = {
  idle: ["idle", "walk"],
  walk: ["walk", "idle"],
  sit: ["sit", "idle", "walk"],
  slash: ["slash", "thrust", "walk"],
  thrust: ["thrust", "slash", "walk"],
  hurt: ["hurt", "idle", "walk"],
  spellcast: ["spellcast", "idle", "walk"],
};
function resolveAnim(assetId, want) {
  const have = index?.[assetId]?.anims || [];
  for (const a of ANIM_FALLBACK[want] || [want]) {
    if (have.includes(a)) return a;
  }
  return have[0] || want;
}

// ── sheet access (load + recolour, cached) ────────────────────────────
function getSheet(assetId, anim, part, recolor) {
  const ramp = recolor ? recolor.ramp : "";
  const key = `${assetId}|${anim}|${part}|${ramp}`;
  const cached = lru(sheetCache, key);
  if (cached) return cached;

  const suffix = part === "_" ? "" : `.${part}`;
  const entry = loadImage(`${LPC_BASE}/${assetId}/${anim}${suffix}.png`);
  if (!entry.ready) return entry.failed ? "fail" : null; // null = not ready yet

  let sheet = makeCanvas(entry.img.width, entry.img.height);
  sheet.getContext("2d").drawImage(entry.img, 0, 0);
  if (recolor) sheet = recolorCanvas(sheet, recolor.material, recolor.ramp);
  return lru(sheetCache, key, sheet);
}

// Expand an lpcBuild() result into flat, z-sorted render layers.
function expandLayers(build) {
  const out = [];
  for (const layer of build) {
    const meta = index[layer.assetId];
    if (!meta) continue;
    for (const part of meta.parts || ["_"]) {
      const z = part === "bg" ? (meta.zBack ?? meta.z - 1) : meta.z;
      out.push({ assetId: layer.assetId, part, z, recolor: layer.recolor || null });
    }
  }
  return out.sort((a, b) => a.z - b.z);
}

// Composite one 64×64 frame from z-sorted layers. Returns { canvas, complete }.
function compositeFrame(layers, want, dir, frameMs) {
  const wantSpec = animSpec(want);
  const tick = Math.floor((frameMs * wantSpec.fps) / 1000);
  const sig = layers
    .map((l) => `${l.assetId}${l.part}${l.recolor ? l.recolor.ramp : ""}`)
    .join(",");
  // `hold` anims (sit, jump — see lpc-manifest.js ANIMS) play to their last
  // frame and CLAMP there instead of looping. Without this a knocked-out
  // chatter's `sit` cycles the stand→sit transition forever instead of
  // staying down on the floor.
  const baseFrame = wantSpec.hold ? wantSpec.frames - 1 : tick % wantSpec.frames;
  const key = `${sig}|${want}|${dir}|${baseFrame}`;
  const cached = lru(frameCache, key);
  if (cached) return { canvas: cached, complete: true };

  const out = makeCanvas(FRAME, FRAME);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  let complete = true;

  for (const layer of layers) {
    const anim = resolveAnim(layer.assetId, want);
    const sheet = getSheet(layer.assetId, anim, layer.part, layer.recolor);
    if (sheet === "fail") continue;
    if (!sheet) {
      complete = false;
      continue;
    }
    const spec = animSpec(anim);
    const frame = spec.hold ? spec.frames - 1 : tick % spec.frames;
    const row = spec.rows === 1 ? 0 : (DIR_ROW[dir] ?? DIR_ROW.right);
    octx.drawImage(sheet, frame * FRAME, row * FRAME, FRAME, FRAME, 0, 0, FRAME, FRAME);
  }
  if (complete) lru(frameCache, key, out);
  return { canvas: out, complete };
}

// ── public: hero / NPC ────────────────────────────────────────────────
export function composeAvatar(ctx, cx, groundY, pet, frameMs, scale = 1, animOverride = null) {
  const build = indexReady ? lpcBuild(pet) : null;
  const bodyId = build?.[0]?.assetId;
  const bodyReady =
    bodyId &&
    getSheet(
      bodyId,
      resolveAnim(bodyId, pickState(pet, animOverride).anim),
      "_",
      build[0].recolor,
    ) instanceof Object;

  // Boot race / missing assets → procedural avatar, mirrored for facing.
  if (!indexReady || !build || !bodyReady) {
    ctx.save();
    if (pet?._motion && pet._motion.facing < 0) {
      ctx.translate(cx * 2, 0);
      ctx.scale(-1, 1);
    }
    proceduralCompose(ctx, cx, groundY, pet, frameMs, scale);
    ctx.restore();
    return;
  }

  const { anim, dir } = pickState(pet, animOverride);
  const layers = expandLayers(build);
  const { canvas } = compositeFrame(layers, anim, dir, frameMs);

  const s = scale * SCALE_BOOST;
  const w = FRAME * s;
  const h = FRAME * s;
  const dx = Math.round(cx - w / 2);
  const dy = Math.round(groundY - FOOT_Y * s);

  const c = pet?.cosmetics || {};
  // Aura + trail sit behind the body.
  if (c.aura) drawAura(ctx, cx, groundY - h * 0.42, h * 0.5, c.aura, frameMs);
  if (c.trail && !pet.sleeping) drawTrailSample(ctx, cx, groundY, s, c.trail, frameMs);

  ctx.save();
  if (c.pose && !pet.sleeping) applyPoseTransform(ctx, c.pose, cx, groundY, h, frameMs);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, dx, dy, w, h);
  ctx.imageSmoothingEnabled = prev;
  // Held props + fantasy headpieces LPC has no layer for (halo, antlers, fan…).
  drawLpcProps(ctx, cx, dy, s, pet, frameMs);
  ctx.restore();

  if (c.companion) drawCompanion(ctx, cx + w * 0.34, groundY, c.companion, frameMs, s * 0.5);
  if (pet.sleeping) drawSleepZ(ctx, cx, groundY - h * 0.7, frameMs, scale);
}

// ── public: enemy ─────────────────────────────────────────────────────
// `lpcSpec` is an enemy's `lpc` field from shared/enemies.js. enemyBuild() turns
// it into render layers; the result is cached by spec identity (enemy defs are
// stable singletons) so this is cheap to call every frame.
const enemyBuildCache = new Map();
export function composeEnemy(
  ctx,
  cx,
  groundY,
  lpcSpec,
  anim,
  frameMs,
  scale = 1,
  flash = false,
  dir = "left",
) {
  if (!indexReady || !lpcSpec) return false;
  let build = enemyBuildCache.get(lpcSpec);
  if (build === undefined) {
    build = enemyBuild(lpcSpec);
    enemyBuildCache.set(lpcSpec, build);
  }
  if (!build?.layers) return false;
  const layers = expandLayers(build.layers);
  if (!layers.length) return false;
  let { canvas } = compositeFrame(layers, anim || "walk", dir, frameMs);

  // Hit flash — tint a scratch copy white so the flash stays masked to the sprite.
  if (flash) {
    const scratch = makeCanvas(FRAME, FRAME);
    const sctx = scratch.getContext("2d");
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(canvas, 0, 0);
    sctx.globalCompositeOperation = "source-atop";
    sctx.globalAlpha = 0.8;
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, FRAME, FRAME);
    canvas = scratch;
  }

  const s = scale * (build.scale || 1);
  const w = FRAME * s;
  const h = FRAME * s;
  const dx = Math.round(cx - w / 2);
  const dy = Math.round(groundY - FOOT_Y * s);

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, dx, dy, w, h);
  ctx.imageSmoothingEnabled = prev;
  return true;
}

export function lpcReady() {
  return indexReady;
}
