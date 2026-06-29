// SIGMA ABYSS — arena overlay renderer.
//
// Canvas-based "every chatter on stage" view. Render-only WS consumer
// for the OBS browser source — never sends `hello`, so it doesn't count
// as a player and doesn't push saves.
//
// Layout: chatters are seated on a virtual ground plane in a horizontal
// strip; each gets an LPC avatar, a name + HP bar above the head, and a
// foe sprite squared off in front of them with its own HP bar.
//
// Frames consumed:
//   t:'welcome'        → initial roster snapshot (`arena.chatters[]`)
//   t:'arenaRoster'    → periodic full refresh
//   t:'arenaJoin'      → new chatter (fade-in slot)
//   t:'arenaLeave'     → chatter reaped (fade-out)
//   t:'arenaHit'       → swing landed; pop a damage number, update HP
//   t:'arenaKill'      → foe slain; little flourish over the chatter
//   t:'arenaFoeSwap'   → next foe slid in
//   t:'arenaDown'      → chatter HP hit 0; sprite goes ragdoll, respawn pending
//   t:'arenaRespawn'   → chatter back at full HP

import { AVATAR_DIMENSIONS, composeAvatar, composeEnemy } from "/avatar/lpc-avatar.js";
import * as barks from "./barks.js";

// The arena is authored against the live OBS canvas (1920×1080) but is also
// embedded inside the unified Game Bar widget (1244×170). When the canvas
// element is sized small we drop into "bar mode": fewer chatters, tighter
// gaps, smaller sprites, and no idle "waiting for chat" text.
const VW = 1920;
const VH = 1080;
const GROUND_Y = 880;
const ROW_GAP_FULL = 280;
const ROW_GAP_BAR = 240;
const MAX_PER_ROW_FULL = 7;
const MAX_PER_ROW_BAR = 8;
const _AV_H = AVATAR_DIMENSIONS.height;
// Below this rendered height (in CSS pixels) we count as "bar mode".
const BAR_MODE_HEIGHT_PX = 320;

// "Raid-only" mode — hides the idle chatter grid so the canvas is empty
// (fully transparent) when no raid is active. Set via the embed URL
// `?mode=raid-only`, used when this overlay is iframed inside another
// scene that already shows the chatter roster differently.
const RAID_ONLY = (() => {
  try {
    return new URLSearchParams(location.search).get("mode") === "raid-only";
  } catch {
    return false;
  }
})();

// "Mobs-only" mode — shows the chatter grid with big kind-colored foe
// pills above each enemy. Set via `?mode=mobs-only`. Used when this
// overlay is embedded as a streaming snapshot and the foe name needs to
// read at a glance.
const MOBS_ONLY = (() => {
  try {
    return new URLSearchParams(location.search).get("mode") === "mobs-only";
  } catch {
    return false;
  }
})();

// "Foes-only" mode — renders each chatter's foe sprite + HP bar + name
// but suppresses the chatter avatar/HUD itself. Set via `?mode=foes-only`.
// Used when this overlay is iframed behind a scene that already paints
// the chatters (e.g. vibe-coder-sim apartment), so monsters appear
// without duplicating the chatter sprites.
const FOES_ONLY = (() => {
  try {
    return new URLSearchParams(location.search).get("mode") === "foes-only";
  } catch {
    return false;
  }
})();

const canvas = document.getElementById("arena-canvas");
const ctx = canvas.getContext("2d");
const connDot = document.getElementById("conn-dot");

// roster: login -> chatterState
const roster = new Map();
// transient damage popups: { x, y, text, color, until }
const popups = [];

// Active raid — when non-null, the renderer switches to JRPG boss
// layout (big boss centered at top, party gathered below). Populated
// from raidStart / raidUpdate / raidHit frames; cleared on raidDefeated.
let raid = null;
// Per-tick boss render state: hit flash + recoil shake. Set by raidHit
// frames so the big boss sprite jerks visibly on every chip damage.
const bossFx = { flashUntil: 0, shakeUntil: 0, shakeAmp: 0 };
// Swing animation — when a chatter lands a raid swing, lift them into
// a brief lunge upward so the eye picks up who's hitting. Map<login, untilMs>.
const swingAnim = new Map();
// FOES_ONLY combat animation — when a chatter lands a hit on their foe,
// recoil the foe upward briefly + flash it white so each blow reads as
// combat instead of monsters idle-walking in place. Map<login, untilMs>.
const foeLungeAnim = new Map();
const foeFlashAnim = new Map();
// Foe death animation — a kill snapshot kept alive past arenaFoeSwap so
// the dying sprite can flash white, scale down, and fall away while the
// next foe drops into the slot. Map<login, { foe, startedAt }>.
const foeDeathAnim = new Map();
const FOE_DEATH_MS = 600;
// New-foe drop-in — the swapped-in foe descends into its slot from a
// short distance above instead of teleporting, so every swap reads as
// "next opponent arrives." Map<login, untilMs>.
const foeSpawnAnim = new Map();
const FOE_SPAWN_MS = 380;
// FOES_ONLY roam — rather than pinning each foe to a static idx-grid slot,
// every foe-owning chatter gets a slow, self-directed prowl around the
// bottom desktop strip, so the monsters roam the stage instead of walking
// in place. Map<login, { x, y, tx, ty, speed, facing, pauseUntil, repickAt }>.
const foeRoam = new Map();
// Roam bounds — the bottom desktop-capture strip, kept clear of the OBS
// facecam (x≳1420) and the right-column widget stack so a foe can never
// wander onto the streamer's face or the widgets.
const FOE_ROAM = { xMin: 120, xMax: 1180, yMin: 640, yMax: 1000 };
// FOES_ONLY aggro + bullet-hell telegraph. A foe pops a "!" the instant it
// engages a fresh target (join / swap / respawn), and on a slow cadence it
// BRACES (a growing danger ring) then looses a fan of bolts in its facing
// direction — so the named monsters read as actively attacking instead of
// idly prowling. The attacker that hits a foe lives off-canvas in the
// apartment iframe, so a player swing also paints a brief incoming-strike arc
// on the foe, giving the white hit-flash a visible cause (it otherwise reads
// as "the monster got hit for no reason"). All pure client spectacle — real
// combat stays server-authoritative. Map<login, untilMs> + a bolt pool.
const foeAlertAnim = new Map(); // "!" aggro marker
const foeStrikeAnim = new Map(); // incoming-blow slash (visible cause for a hit)
const foeProjectiles = []; // { x, y, vx, vy, born, ttl } in-flight bolts
// Fighter→boss projectile pool — melee dash replaced ranged bolts; pool kept
// as a drain sink for any late-arriving straggler frames on reconnect.
const raidProjectiles = []; // { x, y, tx, ty, vx, vy, born, ttl, dmg }
// Boss-anchored floating damage numbers — spawn on raidHit, float upward off
// the boss sprite. Separate from the fighter-anchored popup pool.
const bossPopups = []; // { x, y, text, color, born, ttl }
// Melee slash impacts — short-lived sparks that spawn at melee contact point.
// { x, y, born, ttl } — pure glow arc, no DOM.
const meleeSlashPool = []; // bounded to 12 entries
// Boss attack cosmetic cycle — pure client spectacle, no server involvement.
// nextAt: when to start the next telegraph; the rest are until-timestamps.
const bossAtk = { nextAt: 0, telegraphUntil: 0, strikeUntil: 0, recoverUntil: 0 };
// Shockwave rings emitted on boss strike. { x, y, born, ttl, vy }
const bossShock = []; // bounded to 6
// Global party recoil — while now < partyHitUntil, alive fighters show knockback.
let partyHitUntil = 0;
const FOE_ALERT_MS = 900;
const FOE_TELEGRAPH_MS = 540; // windup before a volley
const FOE_ATK_CD = 2600; // base gap between a foe's volleys
const FOE_STRIKE_MS = 190; // incoming-strike slash lifetime
const FOE_PROJECTILES_PER = 3;

// Agent-session drops: id -> { id, kind, value, x, y, name, rarity, slot,
// createdAt, expiresAt, bob, taken? }. Taken drops linger for the claim
// animation, then are deleted from the map by the anim itself.
const drops = new Map();
// Active claim flights: { fromX, fromY, toLogin, kind, value, rarity, name,
// startedAt, until }.
const claimAnims = [];
// Banner for the "<agent> rains loot — chat to grab!" announce on session.
let sessionBanner = null; // { text, accent, until }

// Vibe-coder-sim pets: login -> { source, x, y, radius, lastSeen }. Driven
// by `vcs:pets` postMessage from the parent apartment overlay every frame.
// We use these for spatial collision with the open drop pool — when a pet
// sprite walks over a drop the iframe fires a POST /api/drops/claim/:id
// against its own (same-origin) server. The parent canvas (port 8081)
// can't reach this server cross-origin, so the iframe owns the claim.
const vcsPets = new Map();
const VCS_PET_TTL_MS = 1500;
// Drops with an in-flight claim fetch. We skip subsequent collisions on the
// same id until the WS dropClaim broadcast deletes the entry from `drops`.
const claimingDrops = new Set();
// Drop-radius for spatial pickup; the chatter sprite's effective hitbox
// half-size is sent by the parent (`radius`) so a smaller chibi reaches
// roughly the same as a full-size LPC sprite. Drops use a fixed pickup
// radius slightly larger than their visual footprint so a near-miss still
// vacuums it up (the OBS source compresses the canvas vertically and
// pixel-perfect collision would feel unfair).
const DROP_PICKUP_RADIUS = 42;

window.addEventListener("message", (e) => {
  const m = e?.data;
  if (!m || typeof m !== "object") return;
  if (m.type !== "vcs:pets" || !Array.isArray(m.pets)) return;
  const now = nowMs();
  for (const p of m.pets) {
    if (!p || typeof p.login !== "string") continue;
    vcsPets.set(p.login.toLowerCase(), {
      source: typeof p.source === "string" ? p.source : "twitch",
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      radius: Math.max(8, Math.min(120, Number(p.radius) || 40)),
      lastSeen: now,
    });
  }
  // Reap pets that stopped reporting (they left the apartment roster).
  for (const [login, rec] of vcsPets) {
    if (now - rec.lastSeen > VCS_PET_TTL_MS) vcsPets.delete(login);
  }
});

// Run hit-tests once per draw frame. Each drop checks against every active
// pet; on hit, POST the claim. Tracks in-flight ids so a single drop only
// fires once even if the pet sits on it for multiple frames before the WS
// dropClaim broadcast lands.
function tickDropCollisions() {
  if (!drops.size || !vcsPets.size) return;
  const nowReal = Date.now();
  for (const d of drops.values()) {
    if (!d?.id || claimingDrops.has(d.id)) continue;
    if ((d.expiresAt || 0) < nowReal) continue;
    let hit = null;
    for (const [login, p] of vcsPets) {
      if (p.source !== "twitch") continue; // only twitch sigmas can credit
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      const r = DROP_PICKUP_RADIUS + p.radius;
      if (dx * dx + dy * dy <= r * r) {
        hit = login;
        break;
      }
    }
    if (!hit) continue;
    claimingDrops.add(d.id);
    fetch(`/api/drops/claim/${encodeURIComponent(d.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: hit }),
    })
      .catch(() => {
        /* network blip — drop is still in the pool, retry on next frame */
      })
      .finally(() => {
        // Release the lock so the next frame can retry if the WS broadcast
        // got dropped on the floor (still in `drops` map). The server is
        // idempotent: takeDropById returns null after the first success.
        claimingDrops.delete(d.id);
      });
  }
}

// Rarity → glow color, matching shared/constants.js RARITY_COLOR so
// epic-and-up loot really pops.
const RARITY_COLOR = {
  common: "#9aa4b2",
  uncommon: "#5bd16a",
  rare: "#4aa3ff",
  epic: "#b86bff",
  legendary: "#ff9d2e",
  mythic: "#ff4d6d",
  oneofone: "#ffe44d",
};

function nowMs() {
  return performance.now();
}

function setRosterFromSnapshot(snap) {
  if (!snap || !Array.isArray(snap.chatters)) return;
  const seen = new Set();
  for (const c of snap.chatters) {
    const key = (c.login || "").toLowerCase();
    if (!key || seen.has(key)) continue; // dedup: server snapshot may contain duplicates
    seen.add(key);
    upsertChatter(c, /* fromSnapshot */ true);
  }
  // Drop chatters not in the snapshot — the server is authoritative.
  for (const k of [...roster.keys()]) {
    if (!seen.has(k)) {
      roster.delete(k);
      foeRoam.delete(k);
      foeAlertAnim.delete(k);
      foeStrikeAnim.delete(k);
    }
  }
}

function upsertChatter(c, fromSnapshot = false) {
  if (!c?.login) return;
  // Key on lowercased login — prevents duplicate roster entries when the server
  // sends frames for "Alice" and "alice" (TTL reaper eviction + re-join).
  const key = c.login.toLowerCase();
  const existing = roster.get(key);
  const next = existing || {
    login: key,
    name: c.name || key,
    cosmetics: c.cosmetics || {},
    seed: hashSeed(key),
    hp: c.hp ?? 1,
    maxHp: c.maxHp ?? 1,
    foe: c.foe || null,
    down: !!c.down,
    level: c.level || 1,
    xp: c.xp || 0,
    xpToNext: c.xpToNext || 100,
    zone: c.zone || "town",
    weapon: c.weapon || null,
    auraTier: c.auraTier ?? 0,
    // Inc5: tactical position tag ("front"|"mid"|"back"), default "mid".
    position: c.position || "mid",
    facing: 1,
    bob: Math.random() * Math.PI * 2,
    appearedAt: nowMs(),
  };
  next.name = c.name || next.name;
  next.cosmetics = c.cosmetics || next.cosmetics;
  next.hp = c.hp ?? next.hp;
  next.maxHp = c.maxHp ?? next.maxHp;
  next.foe = c.foe ?? next.foe;
  next.down = !!c.down;
  // Always copy progression fields — server publicEntry() sends the real values.
  if (c.level != null) next.level = c.level;
  if (c.xp != null) next.xp = c.xp;
  if (c.xpToNext != null) next.xpToNext = c.xpToNext;
  if (c.zone != null) next.zone = c.zone;
  if (c.weapon !== undefined) next.weapon = c.weapon;
  if (c.auraTier != null) next.auraTier = c.auraTier;
  if (c.position != null) next.position = c.position;
  next.lastTouchedAt = nowMs();
  roster.set(key, next);
  if (!fromSnapshot && !existing) {
    // A joining chatter brings a foe that immediately squares off → "!" aggro.
    if (next.foe) foeAlertAnim.set(key, nowMs() + FOE_ALERT_MS);
    // join flash
    popups.push({
      x: 0,
      y: 0,
      anchorLogin: key,
      dy: -120,
      text: "+ JOINED",
      color: "#7bd16a",
      until: nowMs() + 1200,
      big: true,
    });
  }
}

function dropChatter(login) {
  const key = (login || "").toLowerCase();
  roster.delete(key);
  foeRoam.delete(key);
  foeAlertAnim.delete(key);
  foeStrikeAnim.delete(key);
  barks.resetFor(key);
  for (let i = popups.length - 1; i >= 0; i -= 1) {
    if (popups[i].anchorLogin === key) popups.splice(i, 1);
  }
}

function upsertDrop(d) {
  if (!d?.id) return;
  const existing = drops.get(d.id);
  drops.set(d.id, {
    ...(existing || {}),
    ...d,
    bob: existing?.bob ?? Math.random() * Math.PI * 2,
  });
}

function setDropsFromSnapshot(snap) {
  if (!snap || !Array.isArray(snap.drops)) return;
  const seen = new Set();
  for (const d of snap.drops) {
    seen.add(d.id);
    upsertDrop(d);
  }
  // Drops that vanished from the server snapshot are reaped here too.
  for (const k of [...drops.keys()]) {
    if (!seen.has(k)) drops.delete(k);
  }
}

// Kicks off the fly-to-chatter animation for a claimed drop. If the
// chatter isn't on the roster yet (e.g. claim fired before their
// arenaJoin frame), we still pop a generic floating "+value" at the
// original drop coords so viewers see the credit happen.
function startClaimAnim(id, login, summary) {
  const drop = drops.get(id);
  if (drop) drops.delete(id);
  const now = nowMs();
  const kind = summary?.kind || drop?.kind || "xp";
  const value = summary?.value || drop?.value || 0;
  const rarity = summary?.rarity || drop?.rarity || null;
  const name = summary?.name || drop?.name || null;
  const fromX = drop?.x ?? VW / 2;
  const fromY = drop?.y ?? VH / 2;
  claimAnims.push({
    id,
    fromX,
    fromY,
    toLogin: login,
    kind,
    value,
    rarity,
    name,
    startedAt: now,
    until: now + 750,
  });
}

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

let barMode = false;
// rAF timestamp of the previous draw() — for the foe-roam frame delta.
let lastDrawAt = 0;

function fitCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // Bar mode = the iframe lives inside the 1244×170 Game Bar widget,
  // so we stretch (not letterbox) the virtual coords to fill it.
  barMode = h < BAR_MODE_HEIGHT_PX;
  if (barMode) {
    ctx.setTransform(dpr * (w / VW), 0, 0, dpr * (h / 170), 0, 0);
  } else {
    const scale = Math.min(w / VW, h / VH);
    const ox = (w - VW * scale) / 2;
    const oy = (h - VH * scale) / 2;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  }
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

function barRowCount(total) {
  if (total <= MAX_PER_ROW_BAR) return 1;
  if (total <= MAX_PER_ROW_BAR * 2) return 2;
  return 3;
}

function barRowY(row, rows) {
  if (rows <= 1) return 132;
  if (rows === 2) return row === 0 ? 144 : 88;
  return [152, 108, 64][Math.min(row, 2)];
}

// Compute slot positions on the fly so we don't have to track "who left".
// Slots wrap to a second row past MAX_PER_ROW.
function slotPosition(idx, total) {
  if (barMode) {
    const rows = barRowCount(total);
    const perRow = Math.max(1, Math.ceil(total / rows));
    const row = Math.floor(idx / perRow);
    const col = idx % perRow;
    const cols = Math.min(perRow, total - row * perRow);
    const available = VW - 160;
    const rowGap = Math.min(ROW_GAP_BAR, available / Math.max(1, cols - 1));
    const totalWidth = (cols - 1) * rowGap;
    const startX = VW / 2 - totalWidth / 2;
    return {
      x: startX + col * rowGap,
      y: barRowY(row, rows),
      row,
      rows,
    };
  }
  const maxPerRow = barMode ? MAX_PER_ROW_BAR : MAX_PER_ROW_FULL;
  const rowGap = barMode ? ROW_GAP_BAR : ROW_GAP_FULL;
  const perRow = Math.min(maxPerRow, Math.max(1, total));
  const row = Math.floor(idx / perRow);
  const col = idx % perRow;
  const cols = Math.min(perRow, total - row * perRow);
  const totalWidth = (cols - 1) * rowGap;
  const startX = VW / 2 - totalWidth / 2;
  const x = startX + col * rowGap;
  const y = GROUND_Y - row * 360;
  return { x, y };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function drawBarkBubbles(anchors, now) {
  if (!anchors.length) return;
  const active = [];
  for (const anchor of anchors) {
    const box = barks.measureFor(ctx, anchor.id, now, anchor.scale);
    if (box) active.push({ ...anchor, ...box });
  }
  if (!active.length) return;

  if (!barMode) {
    for (const b of active) barks.drawFor(ctx, b.id, b.x, b.anchorY, now, b.scale);
    return;
  }

  const lanes = [34, 72, 110];
  const gap = 10;
  const byLane = lanes.map((y) => ({ y, placed: [] }));
  for (const b of active.sort((a, c) => a.x - c.x)) {
    let best = null;
    for (const lane of byLane) {
      const half = b.width / 2;
      const minX = half + 10;
      const maxX = VW - half - 10;
      let x = clamp(b.x, minX, maxX);
      for (const p of lane.placed) {
        if (Math.abs(x - p.x) < half + p.half + gap) x = p.x + half + p.half + gap;
      }
      if (x <= maxX) {
        const cost = Math.abs(x - b.x) + lane.placed.length * 24;
        if (!best || cost < best.cost) best = { lane, x, cost };
      }
      x = clamp(b.x, minX, maxX);
      for (let i = lane.placed.length - 1; i >= 0; i -= 1) {
        const p = lane.placed[i];
        if (Math.abs(x - p.x) < half + p.half + gap) x = p.x - half - p.half - gap;
      }
      if (x >= minX) {
        const cost = Math.abs(x - b.x) + lane.placed.length * 24;
        if (!best || cost < best.cost) best = { lane, x, cost };
      }
    }
    const lane = best?.lane || byLane[byLane.length - 1];
    const x = best?.x ?? clamp(b.x, b.width / 2 + 10, VW - b.width / 2 - 10);
    lane.placed.push({ x, half: b.width / 2 });
    lane.placed.sort((a, c) => a.x - c.x);
    barks.drawFor(ctx, b.id, x, lane.y, now, b.scale);
  }
}

/**
 * Foe slot center in FOES_ONLY layout — pure, idle-motion-free.
 *
 * The popup pass needs to land "-12" / "KO" over the FOE sprite, not over
 * the chatter slot at the bottom of the canvas (where the apartment iframe
 * paints the hero). Extracting the inline foe-grid math here lets both the
 * sprite renderer and the popup pass agree on the same anchor.
 *
 * Layout in non-bar mode is a horizontal row at the BOTTOM of the LEFT
 * portion of the canvas — clear of the OBS facecam (x≈1420+, y≈790+) and
 * the right-column widget stack (music playlist y≈478–758, overlay
 * y≈758–938). Foes sit over the Linux desktop screen capture so they
 * don't paint over the streamer's face or the widget column.
 */
function foeSlotPosition(idx, total) {
  if (barMode) {
    const foesPerRow = 12;
    const row = Math.floor(idx / foesPerRow);
    const col = idx % foesPerRow;
    const colsInRow = Math.min(foesPerRow, total - row * foesPerRow);
    const foeSpacing = Math.min(140, (VW - 80) / Math.max(1, colsInRow));
    const totalWidth = (colsInRow - 1) * foeSpacing;
    const startX = VW / 2 - totalWidth / 2;
    return { x: startX + col * foeSpacing, y: 110 + row * 80 };
  }
  // Bottom strip of the Linux desktop area. x stays in [100, 1280] so
  // the sprite (≈140 px wide at scale 2.2) never reaches the facecam at
  // x=1420. Wrap UPWARD so the first foes stay anchored at the bottom
  // and the additional rows stack above them, away from the chatter
  // apartment band (y≈600–1040).
  const foesPerRow = 6;
  const colStep = 200;
  const rowGap = 130;
  const startX = 110; // first foe center
  const baseY = 985; // bottom row center, well clear of canvas edge
  const row = Math.floor(idx / foesPerRow);
  const col = idx % foesPerRow;
  return { x: startX + col * colStep, y: baseY - row * rowGap };
}

// ── FOES_ONLY roam ─────────────────────────────────────────────────────
// Pick a fresh wander destination — a short hop from the foe's current
// spot (a prowl, not a sprint), clamped inside the roam box.
function pickFoeRoamTarget(r, now) {
  const ang = Math.random() * Math.PI * 2;
  const reach = 120 + Math.random() * 320;
  r.tx = Math.max(FOE_ROAM.xMin, Math.min(FOE_ROAM.xMax, r.x + Math.cos(ang) * reach));
  r.ty = Math.max(FOE_ROAM.yMin, Math.min(FOE_ROAM.yMax, r.y + Math.sin(ang) * reach));
  // Safety re-route so a foe never stalls if a target drifts out of reach.
  r.repickAt = now + 6000 + Math.random() * 4000;
}

// Get (or lazily seed) a foe's roam state. `seedX/seedY` is the static grid
// slot, used only on first sight so a foe doesn't teleport when it starts
// roaming.
function foeRoamState(login, seedX, seedY, now) {
  let r = foeRoam.get(login);
  if (!r) {
    r = {
      x: seedX,
      y: seedY,
      tx: seedX,
      ty: seedY,
      speed: 0.04 + Math.random() * 0.04, // virtual px/ms — a slow prowl
      facing: "left",
      moving: false,
      pauseUntil: 0,
      repickAt: 0,
      atkAt: now + 1600 + Math.random() * 2400, // first telegraphed volley
      telegraphUntil: 0, // >now → bracing for a volley
    };
    pickFoeRoamTarget(r, now);
    foeRoam.set(login, r);
  }
  return r;
}

// Advance one foe's prowl toward its target; idle a beat on arrival before
// re-routing, so the wander reads as "stalk, pause, stalk."
function stepFoeRoam(r, dt, now) {
  // Bullet-hell attack cadence — periodically BRACE (a growing danger ring,
  // drawn in drawChatter) then loose a fan of bolts in the facing direction.
  // The windup holds the foe still so the tell reads; the volley is spectacle.
  if (!r.telegraphUntil && now >= r.atkAt) {
    r.telegraphUntil = now + FOE_TELEGRAPH_MS;
  } else if (r.telegraphUntil && now >= r.telegraphUntil) {
    spawnFoeVolley(r, now);
    r.telegraphUntil = 0;
    r.atkAt = now + FOE_ATK_CD + Math.random() * 1900;
  }
  if (r.telegraphUntil) {
    r.moving = false;
    return;
  } // hold still while bracing
  // `moving` drives the render anim: walk while actually travelling, idle while
  // paused or arrived — otherwise the LPC sprite walk-cycles in place (the
  // "moonwalking monster" look).
  if (now < r.pauseUntil) {
    r.moving = false;
    return;
  }
  const dx = r.tx - r.x;
  const dy = r.ty - r.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 8 || now >= r.repickAt) {
    r.pauseUntil = now + 600 + Math.random() * 1800;
    pickFoeRoamTarget(r, now);
    r.moving = false;
    return;
  }
  const stepLen = Math.min(dist, r.speed * dt);
  r.x += (dx / dist) * stepLen;
  r.y += (dy / dist) * stepLen;
  r.moving = true;
  // Face travel direction so the LPC walk row matches the prowl.
  if (Math.abs(dx) > 2) r.facing = dx < 0 ? "left" : "right";
}

// Live screen anchor for a foe-targeted combat popup — the foe's roaming
// position when it has one, else its static grid slot (bar mode, or a foe
// not rendered yet this frame).
function foePopupAnchor(login, idx, total) {
  const r = foeRoam.get(login);
  return r ? { x: r.x, y: r.y } : foeSlotPosition(idx, total);
}

// Loose a fan of bolts in the foe's facing direction — the visible half of a
// telegraphed attack. Bolts are advanced + drawn in drawFoeProjectiles.
function spawnFoeVolley(r, now) {
  const dir = r.facing === "left" ? -1 : 1;
  for (let i = 0; i < FOE_PROJECTILES_PER; i += 1) {
    const ang = ((i - (FOE_PROJECTILES_PER - 1) / 2) * 13 * Math.PI) / 180;
    const speed = 0.92 + Math.random() * 0.16; // virtual px/ms
    foeProjectiles.push({
      x: r.x + dir * 30,
      y: r.y - 46,
      vx: Math.cos(ang) * speed * dir,
      vy: Math.sin(ang) * speed,
      born: now,
      ttl: 640,
    });
  }
}

// Advance + render every in-flight foe bolt; cull on TTL. Drawn additively
// with a trailing streak + bright head so the volley reads as bullet-hell fire.
function drawFoeProjectiles(now, dt) {
  for (let i = foeProjectiles.length - 1; i >= 0; i -= 1) {
    const p = foeProjectiles[i];
    const age = now - p.born;
    if (age > p.ttl) {
      foeProjectiles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const fade = 1 - age / p.ttl;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.strokeStyle = "hsl(8 100% 62%)";
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.85 * fade;
    ctx.beginPath();
    ctx.moveTo(p.x - p.vx * 9, p.y - p.vy * 9);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalAlpha = fade;
    ctx.fillStyle = "hsl(8 100% 82%)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Boss-anchored floating damage numbers. Float straight up off the boss.
// Spawned on raidHit; drawn on top of everything in drawBossScene.
function spawnBossPopup(x, y, dmg, crit) {
  bossPopups.push({
    x,
    y,
    text: `${crit ? "⚡" : ""}-${dmg}`,
    color: crit ? "#fcd34d" : "#ff6b6b",
    born: nowMs(),
    ttl: 1200,
    big: !!crit,
  });
}

function drawBossPopups(now) {
  for (let i = bossPopups.length - 1; i >= 0; i -= 1) {
    const p = bossPopups[i];
    const age = now - p.born;
    if (age > p.ttl) {
      bossPopups.splice(i, 1);
      continue;
    }
    const t = age / p.ttl; // 0→1
    const alpha = 1 - t * t; // quadratic fade
    const lift = t * 140; // float upward
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = p.big
      ? "900 34px JetBrains Mono, ui-monospace, monospace"
      : "bold 26px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.strokeText(p.text, p.x, p.y - lift);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y - lift);
    ctx.restore();
  }
}

// A bold red "!" that pops (scale-in) + bobs over a foe that just aggroed.
function drawFoeAlert(cx, y, scale, now, until) {
  const remain = (until - now) / FOE_ALERT_MS;
  const age = 1 - remain;
  const pop = age < 0.16 ? age / 0.16 : 1;
  const s = (scale / 2.2) * pop * (1 + 0.12 * Math.sin(now / 90));
  const bob = -Math.abs(Math.sin(now / 110)) * 4;
  ctx.save();
  ctx.translate(cx, y + bob);
  ctx.scale(s, s);
  ctx.globalAlpha = Math.min(1, remain * 3.2);
  ctx.font = "900 34px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText("!", 0, 0);
  ctx.shadowColor = "#ff5a5a";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#ff3b3b";
  ctx.fillText("!", 0, 0);
  ctx.restore();
}

function drawHpBar(cx, cy, w, h, hp, maxHp, color) {
  const pct = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(cx - w / 2 - 2, cy - 2, w + 4, h + 4);
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(cx - w / 2, cy, w, h);
  const grd = ctx.createLinearGradient(0, cy, 0, cy + h);
  grd.addColorStop(0, color);
  grd.addColorStop(1, "#000");
  ctx.fillStyle = grd;
  ctx.fillRect(cx - w / 2, cy, w * pct, h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2 + 0.5, cy + 0.5, w - 1, h - 1);
  ctx.restore();
}

function _drawLabel(cx, cy, text, color = "#fff", sub = null) {
  ctx.save();
  ctx.font = "bold 18px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, cx, cy);
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  if (sub) {
    ctx.font = "13px JetBrains Mono, ui-monospace, monospace";
    ctx.strokeText(sub, cx, cy - 22);
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(sub, cx, cy - 22);
  }
  ctx.restore();
}

// ── Gear Aura VFX ─────────────────────────────────────────────────────────
// Authored at heroScale≈1.8 (bar scale). drawAura() accepts a `scale`
// parameter so callers can pass the actual render scale and the function
// divides radii by 1.8 to produce display-scale radii. This keeps the
// config readable at bar scale where auras must clearly POP (operator note).
// Tier 0 → no aura. Tier 1..4 → progressively stronger glow + orbiting motes.
const AURA_CONFIG = [
  null, // tier 0: no aura
  // tier 1: soft green glow
  { color: "#4ade80", glowR: 38, alpha: 0.32, motes: 0 },
  // tier 2: blue glow
  { color: "#60a5fa", glowR: 48, alpha: 0.4, motes: 0 },
  // tier 3: purple glow + 3 orbiting motes
  { color: "#c084fc", glowR: 56, alpha: 0.48, motes: 3 },
  // tier 4: gold/orange pulsing aura + 6 fast motes + bright core flash
  // r62 at bar scale (heroScale 1.8), glowR116, alpha0.60
  { color: "#fbbf24", glowR: 116, alpha: 0.6, motes: 6, core: true },
];

// Draw the gear aura centred on (cx, cy — avatar feet anchor, same as drawShadow).
// `scale` is the avatar render scale (heroScale in draw path).
// `seed` is a stable per-chatter integer for phase-stable mote orbits.
// Skip when tier < 1. In drawPartyMember, skip when sleeping.
function drawAura(cx, cy, tier, scale, seed, now) {
  const cfg = AURA_CONFIG[tier];
  if (!cfg) return;
  // Convert authored bar-scale (1.8) radii to current display scale.
  const sf = scale / 1.8;
  const r = Math.round(cfg.glowR * sf);
  // Avatar midpoint — aura centres on the sprite body, not the feet.
  // At 64px sprite height the mid-body is ~0.5 heights above feet anchor.
  const midY = cy - Math.round(64 * scale * 0.5);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // Outer radial glow — pulses gently (tier 4 pulses more aggressively).
  const pulse =
    tier === 4
      ? 0.75 + 0.25 * Math.sin(now / 280 + (seed & 0xff))
      : 0.8 + 0.2 * Math.sin(now / 420 + (seed & 0xff));
  const effR = r * pulse;
  const grad = ctx.createRadialGradient(cx, midY, 0, cx, midY, effR);
  grad.addColorStop(0, `${cfg.color}88`); // inner bright
  grad.addColorStop(0.6, `${cfg.color}44`);
  grad.addColorStop(1, `${cfg.color}00`); // transparent edge
  ctx.globalAlpha = cfg.alpha * pulse;
  ctx.beginPath();
  ctx.arc(cx, midY, effR, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Orbiting motes — phase-stable from chatter.seed so they don't jitter.
  if (cfg.motes > 0) {
    const moteR = Math.max(2.5, 3.5 * sf);
    const orbitR = Math.round((tier === 4 ? 52 : 36) * sf);
    const speed = tier === 4 ? 0.0018 : 0.0012; // rad/ms
    for (let m = 0; m < cfg.motes; m += 1) {
      const phase = ((((seed * (m + 1) * 2654435761) >>> 0) % 1000) / 1000) * Math.PI * 2;
      const angle = now * speed + phase;
      const mx = cx + Math.cos(angle) * orbitR;
      const my = midY + Math.sin(angle) * orbitR * 0.45; // flatten to ellipse
      ctx.globalAlpha = cfg.alpha * (0.7 + 0.3 * Math.sin(angle * 2 + phase));
      ctx.beginPath();
      ctx.arc(mx, my, moteR, 0, Math.PI * 2);
      ctx.fillStyle = cfg.color;
      ctx.fill();
    }
  }

  // Tier 4 only — bright core flash that fires on a periodic beat.
  if (cfg.core) {
    const beatPeriod = 900; // ms
    const beatPhase = (now % beatPeriod) / beatPeriod; // 0..1
    const coreAlpha = beatPhase < 0.18 ? (1 - beatPhase / 0.18) * 0.85 : 0;
    if (coreAlpha > 0.01) {
      ctx.globalAlpha = coreAlpha;
      ctx.beginPath();
      ctx.arc(cx, midY, Math.round(14 * sf), 0, Math.PI * 2);
      ctx.fillStyle = "#fff9c4";
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawShadow(cx, cy, rx) {
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, rx * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function pushHitPopup(login, side, dmg, crit, opts = {}) {
  const color = side === "player" ? (crit ? "#fcd34d" : "#fef9c3") : "#ff6b6b";
  const target = opts.target || "hero";
  // Damage numbers should hover over whichever sprite just took the blow.
  // FOES_ONLY now puts foes in the right-column slot — popups float up
  // off the foe head normally (room above), while hero anchors stay the
  // same since the apartment paints chatters near the canvas floor.
  const defaultDy = target === "foe" ? -70 - Math.random() * 20 : -160 - Math.random() * 30;
  popups.push({
    anchorLogin: login,
    target,
    side,
    dx: side === "player" ? 30 : -30,
    dy: opts.dy != null ? opts.dy : defaultDy,
    text: `${crit ? "⚡" : ""}-${dmg}`,
    color,
    until: nowMs() + 1100,
    big: !!crit,
  });
}

function pushFlavorPopup(login, text, color, opts = {}) {
  const target = opts.target || "hero";
  popups.push({
    anchorLogin: login,
    target,
    dx: 0,
    dy: opts.dy != null ? opts.dy : target === "foe" ? -90 : -200,
    text,
    color,
    until: nowMs() + (opts.ttlMs || 1500),
    big: opts.big != null ? opts.big : true,
  });
}

function partySlotPosition(idx, total) {
  const perRow = Math.min(PARTY_MAX_PER_ROW, Math.max(1, total));
  const row = Math.floor(idx / perRow);
  const col = idx % perRow;
  const cols = Math.min(perRow, total - row * perRow);
  const totalWidth = (cols - 1) * PARTY_SPACING;
  const startX = VW / 2 - totalWidth / 2;
  const x = startX + col * PARTY_SPACING;
  const y = PARTY_GROUND_Y + row * 150;
  return { x, y };
}

function drawPopups(now) {
  // Group popups by anchor so they can stack instead of overlap on the
  // same chatter.
  const rosterArr = [...roster.values()];
  const indexByLogin = new Map();
  rosterArr.forEach((c, i) => indexByLogin.set(c.login, i));
  const inBoss = raid && !barMode;
  for (let i = popups.length - 1; i >= 0; i -= 1) {
    const p = popups[i];
    if (now > p.until) {
      popups.splice(i, 1);
      continue;
    }
    const idx = indexByLogin.get(p.anchorLogin);
    if (idx == null) {
      popups.splice(i, 1);
      continue;
    }
    const total = rosterArr.length;
    // FOES_ONLY paints foes at the top and leaves the bottom to the
    // apartment iframe — so combat popups need to anchor to the foe slot
    // or they land in empty space. Bosses (party mode) keep the hero
    // anchor since the boss is a single shared encounter, not per-row.
    const pos = inBoss
      ? partySlotPosition(idx, total)
      : p.target === "foe" && FOES_ONLY
        ? foePopupAnchor(p.anchorLogin, idx, total)
        : slotPosition(idx, total);
    const t = (p.until - now) / 1100; // 0..1 remaining
    const lift = (1 - t) * (barMode ? 22 : 50);
    const dyScale = barMode ? 0.4 : 1;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.4);
    ctx.font = barMode
      ? p.big
        ? "bold 14px JetBrains Mono, ui-monospace, monospace"
        : "bold 11px JetBrains Mono, ui-monospace, monospace"
      : p.big
        ? "bold 30px JetBrains Mono, ui-monospace, monospace"
        : "bold 22px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    const x = pos.x + (p.dx || 0) * dyScale;
    const y = pos.y + (p.dy || 0) * dyScale - lift;
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = p.color || "#fff";
    ctx.fillText(p.text, x, y);
    ctx.restore();
  }
}

function drawChatter(chatter, idx, total, now, dt) {
  const pos = slotPosition(idx, total);
  const baseX = pos.x;
  const baseY = pos.y;
  const bob = Math.sin(now / 380 + chatter.bob) * (barMode ? 1.5 : 4);
  const compactRows = pos.rows || 1;
  const compactScale = compactRows === 1 ? 1 : compactRows === 2 ? 0.7 : 0.54;

  // Tunables that compress for the Game Bar's tight vertical budget.
  // SAO-style HUD: bigger HP/XP bars, level chip, foe name visible.
  const heroScale = barMode ? 1.8 * compactScale : 3.2;
  const foeScale = barMode ? 1.3 * compactScale : 2.2;
  const foeOffset = barMode ? Math.round(64 * compactScale) : 110;
  const heroOffset = barMode ? Math.round(40 * compactScale) : 60;
  const heroHpY = barMode ? Math.round(62 * compactScale) : 124;
  const heroXpY = barMode ? Math.round(54 * compactScale) : 116; // XP bar above HP bar
  const heroLblY = barMode ? Math.round(78 * compactScale) : 134;
  const foeHpY = barMode ? Math.round(56 * compactScale) : 100;
  // Mobs-only mode renders the foe name as a big pill above the HP bar
  // — push it higher so the pill clears the bar with breathing room.
  const foeLblY = barMode ? Math.round(64 * compactScale) : MOBS_ONLY ? 142 : 108;
  const hpW = barMode ? Math.round(96 * compactScale) : 110;
  const foeHpW = barMode ? Math.round(70 * compactScale) : 70;
  const hpH = barMode ? Math.max(4, Math.round(6 * compactScale)) : 8;
  const xpH = barMode ? Math.max(2, Math.round(3 * compactScale)) : 4;
  const foeHpH = barMode ? Math.max(3, Math.round(5 * compactScale)) : 6;
  const shadowRx = barMode ? Math.round(18 * compactScale) : 28;
  const foeShadow = barMode ? Math.round(14 * compactScale) : 26;

  // Foe sprite position — two layouts:
  //   Normal:    foe is "squaring off" to the right of the chatter, facing left.
  //   FOES_ONLY: Pokémon trainer-battle layout — foes lined up at the top of
  //              the canvas facing DOWN toward the apartment pets below.
  //              Each chatter-hit recoils the foe upward + flashes it white.
  if (chatter.foe) {
    let foeX;
    let foeY;
    let foeDir;
    let foeFlash = false;
    // Animation state for the foe sprite — defaults to a standing idle so a
    // paused / non-roaming monster doesn't walk-cycle in place. Set to "walk"
    // only while actually travelling, and "hurt" during a hit recoil.
    let foeAnim = "idle";
    // Foe death animation overlay — drawn FIRST so the new foe (dropping
    // in below) renders on top. We always compute the slot position so
    // both the dying sprite and the spawn-in animation share it.
    let foeSlotX = 0;
    let foeSlotY = 0;
    let foeSpawnDY = 0;
    let foeSpawnAlpha = 1;
    if (FOES_ONLY) {
      const slot = foeSlotPosition(idx, total);
      // Per-foe phase (chatter.bob) staggers the row so foes never fidget
      // in unison. The "huff" is a sharp narrow upward jolt every ~6 s.
      const idlePhase = chatter.bob || 0;
      const fidgetT = (now / 950 + idlePhase) % (Math.PI * 2);
      const idleFidgetDY = -(Math.max(0, Math.sin(fidgetT)) ** 6) * (barMode ? 4 : 7);
      // Hit recoil — a brief upward jolt when the chatter lands a blow.
      const lungeUntil = foeLungeAnim.get(chatter.login);
      const lunging = !!(lungeUntil && now < lungeUntil);
      let lungeDY = 0;
      if (lunging) {
        const t = 1 - (lungeUntil - now) / 300;
        lungeDY = -Math.sin(t * Math.PI) * (barMode ? 10 : 18);
      }
      if (barMode) {
        // Game Bar strip (~170 px tall) — no room to roam; keep a gentle
        // in-place sway so the foe still reads as alive. It never travels, so
        // it stays on the idle anim (set above) rather than walking in place.
        const idleSwayX = Math.sin(now / 520 + idlePhase) * 2;
        foeSlotX = slot.x + idleSwayX;
        foeSlotY = slot.y + bob * 0.4 + lungeDY + idleFidgetDY;
        foeDir = "left";
      } else {
        // Full canvas — the foe prowls its own wandering path around the
        // bottom desktop strip instead of standing pinned in a grid slot.
        const r = foeRoamState(chatter.login, slot.x, slot.y, now);
        stepFoeRoam(r, dt, now);
        foeSlotX = r.x;
        foeSlotY = r.y + bob * 0.4 + lungeDY + idleFidgetDY;
        foeDir = r.facing;
        // Walk only while actually travelling; idle on a pause.
        foeAnim = r.moving ? "walk" : "idle";
      }
      // A blow just landed → play the hurt pose so the hit reads as combat
      // (the attacker lives in the apartment iframe below, off this canvas).
      if (lunging) foeAnim = "hurt";
      foeX = foeSlotX;
      foeY = foeSlotY;
      const flashUntil = foeFlashAnim.get(chatter.login);
      foeFlash = !!(flashUntil && now < flashUntil);

      // 1) Death sprite — fading + falling + flashing copy of the last
      //    foe, drawn under the new one so the eye reads "kill → next."
      const death = foeDeathAnim.get(chatter.login);
      if (death && now - death.startedAt < FOE_DEATH_MS) {
        const tDeath = (now - death.startedAt) / FOE_DEATH_MS;
        const deathScale = foeScale * (1 - tDeath * 0.55);
        const deathDY = tDeath * 60;
        const deathAlpha = 1 - tDeath;
        const deathFlash = tDeath < 0.25;
        // The corpse stays where the foe fell (snapshotted at arenaKill) so
        // it doesn't slide along with the next foe's prowl; falls back to
        // the live slot for bar mode / a kill before roam state existed.
        const deathX = death.x != null ? death.x : foeSlotX;
        const deathY = death.y != null ? death.y : foeSlotY;
        ctx.save();
        ctx.globalAlpha = deathAlpha;
        drawShadow(deathX, deathY + deathDY, foeShadow * (1 - tDeath * 0.4));
        const okDeath = composeEnemy(
          ctx,
          deathX,
          deathY + deathDY,
          death.foe?.lpc || null,
          "hurt",
          now,
          deathScale,
          deathFlash,
          foeDir,
        );
        if (!okDeath) {
          ctx.fillStyle = `hsl(${death.foe?.hue ?? 280} 52% 46%)`;
          ctx.fillRect(deathX - 18, deathY + deathDY - 56, 36, 56);
        }
        ctx.restore();
      } else if (death) {
        foeDeathAnim.delete(chatter.login);
      }

      // 2) Spawn drop-in — the swap-in foe descends from above + fades in.
      const spawnUntil = foeSpawnAnim.get(chatter.login);
      if (spawnUntil && now < spawnUntil) {
        const tSpawn = 1 - (spawnUntil - now) / FOE_SPAWN_MS;
        foeSpawnDY = -(1 - tSpawn) * 80;
        foeSpawnAlpha = 0.2 + tSpawn * 0.8;
      } else if (spawnUntil) {
        foeSpawnAnim.delete(chatter.login);
      }
      foeY = foeSlotY + foeSpawnDY;
    } else {
      foeX = baseX + foeOffset;
      foeY = baseY - bob * 0.5;
      foeDir = "left";
    }
    // Bullet-hell windup ring — while the foe braces (stepFoeRoam armed
    // telegraphUntil), a red danger ring swells + a bright ring converges to
    // the centre, telegraphing the imminent volley. Drawn under the sprite.
    if (FOES_ONLY && !barMode) {
      const rr = foeRoam.get(chatter.login);
      if (rr && rr.telegraphUntil > now) {
        const tB = 1 - (rr.telegraphUntil - now) / FOE_TELEGRAPH_MS;
        const ring = 40 * foeScale;
        ctx.save();
        ctx.translate(foeX, foeY - 6);
        ctx.scale(1, 0.5);
        ctx.beginPath();
        ctx.arc(0, 0, ring, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,72,72,${0.08 + 0.16 * tB})`;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255,72,72,0.9)";
        ctx.beginPath();
        ctx.arc(0, 0, ring, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 4;
        ctx.strokeStyle = `rgba(255,210,120,${0.4 + 0.6 * tB})`;
        ctx.beginPath();
        ctx.arc(0, 0, ring * (1 - tB * 0.8), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    drawShadow(foeX, foeY, foeShadow);
    ctx.save();
    if (foeSpawnAlpha !== 1) ctx.globalAlpha = foeSpawnAlpha;
    const ok = composeEnemy(
      ctx,
      foeX,
      foeY,
      chatter.foe.lpc || null,
      foeAnim,
      now,
      foeScale,
      foeFlash,
      foeDir,
    );
    if (!ok) {
      ctx.fillStyle = `hsl(${chatter.foe.hue ?? 280} 52% 46%)`;
      ctx.fillRect(foeX - 18, foeY - 56, 36, 56);
    }
    ctx.restore();
    // foe HP bar
    drawHpBar(foeX, foeY - foeHpY, foeHpW, foeHpH, chatter.foe.hp, chatter.foe.maxHp, "#f87171");
    // foe name — visible in BOTH modes. Mobs-only mode bumps it to a
    // big bold tag in a kind-colored pill so the enemy reads from a
    // streaming snapshot. Falls back to "ENEMY" if the foe somehow
    // ships without a name.
    const foeLabel = (chatter.foe.name || "ENEMY").toUpperCase();
    const foeKind = chatter.foe.kind || "normal";
    const foeTint =
      foeKind === "boss"
        ? "#fecaca" // soft red
        : foeKind === "elite"
          ? "#c4b5fd" // soft violet
          : "#fde047"; // yellow — pops on most scenes
    if (MOBS_ONLY && !barMode) {
      // Big-tag treatment: black pill + 2 px tint border + 24 px bold.
      ctx.save();
      ctx.font = "900 24px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const tm = ctx.measureText(foeLabel);
      const pillW = Math.max(60, Math.ceil(tm.width) + 22);
      const pillH = 28;
      const pillY = foeY - foeLblY - pillH + 6;
      ctx.fillStyle = "rgba(8, 12, 22, 0.78)";
      ctx.fillRect(foeX - pillW / 2, pillY, pillW, pillH);
      ctx.strokeStyle = foeTint;
      ctx.lineWidth = 2;
      ctx.strokeRect(foeX - pillW / 2 + 1, pillY + 1, pillW - 2, pillH - 2);
      ctx.fillStyle = foeTint;
      ctx.fillText(foeLabel, foeX, foeY - foeLblY + 4);
      ctx.restore();
    } else {
      ctx.save();
      ctx.font = barMode
        ? "bold 10px JetBrains Mono, ui-monospace, monospace"
        : "12px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(foeLabel, foeX, foeY - foeLblY);
      ctx.fillStyle = "#fca5a5";
      ctx.fillText(foeLabel, foeX, foeY - foeLblY);
      ctx.restore();
    }

    // FOES_ONLY combat polish — the attacker that hit this foe lives off-canvas
    // in the apartment iframe, so these give a hit a visible cause + flag a
    // fresh aggro. In normal/raid/mobs-only the chatter sprite is on THIS
    // canvas, so the cues are meaningless there — keep them scene-scoped.
    if (FOES_ONLY) {
      // Incoming-strike slash — a bright arc sweeps the foe after a player hit,
      // so the white hit-flash doesn't read as "hit for no reason."
      const strikeUntil = foeStrikeAnim.get(chatter.login);
      if (strikeUntil && now < strikeUntil) {
        const tS = 1 - (strikeUntil - now) / FOE_STRIKE_MS; // 0 → 1
        const reach = 34 * (foeScale / 2.2);
        const sweep = -Math.PI / 4 + tS * (Math.PI / 2);
        ctx.save();
        ctx.translate(foeX, foeY - 30 * (foeScale / 2.2));
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1 - tS;
        ctx.strokeStyle = "#fff6c2";
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.arc(0, 0, reach, sweep - 0.55, sweep + 0.55);
        ctx.stroke();
        ctx.restore();
      }

      // "!" aggro mark — pops over the foe the moment it engages a fresh target.
      const alertUntil = foeAlertAnim.get(chatter.login);
      if (alertUntil && now < alertUntil) {
        drawFoeAlert(foeX, foeY - foeLblY - 40, foeScale, now, alertUntil);
      }
    }

    // Permanent attacker handle above the foe — in FOES_ONLY the chatter
    // sprite lives in the apartment iframe below and there's no other
    // visible link between a monster and its owner. Painting "@name"
    // above each foe lets viewers see at a glance WHO is hitting it,
    // which is the read combat popups alone can't provide.
    if (FOES_ONLY) {
      const handle = `@${chatter.name || chatter.login}`;
      const handleY = foeY - foeLblY - (MOBS_ONLY && !barMode ? 36 : 22);
      ctx.save();
      ctx.font = barMode
        ? "bold 10px JetBrains Mono, ui-monospace, monospace"
        : "bold 14px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = barMode ? 3 : 4;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(handle, foeX, handleY);
      ctx.fillStyle = "#7dd3fc";
      ctx.fillText(handle, foeX, handleY);
      ctx.restore();
    }
  }

  // Foes-only mode: stop here. The chatter sprite + HP/XP bars + name +
  // weapon chip are owned by the host scene (vibe-coder-sim apartment);
  // re-painting them in the arena iframe would just duplicate the avatars.
  if (FOES_ONLY) return null;

  // Chatter sprite — port the same {seed, cosmetics, _motion} pet shape
  // world.js uses so composeAvatar paints the right paperdoll.
  const heroX = baseX - heroOffset;
  const heroY = baseY - bob;
  drawShadow(heroX, heroY, shadowRx);
  // Gear aura — drawn additive over shadow, under avatar sprite.
  // Skip while sleeping (down) so a KO'd chatter's aura doesn't distract.
  if ((chatter.auraTier ?? 0) >= 1 && !chatter.down) {
    drawAura(heroX, heroY, chatter.auraTier, heroScale, chatter.seed || 1, now);
  }
  const pet = {
    seed: chatter.seed,
    cosmetics: chatter.cosmetics,
    sleeping: chatter.down,
    _motion: { facing: 1, vx: chatter.down ? 0 : 0.5 },
  };
  composeAvatar(ctx, heroX, heroY, pet, now, heroScale);

  // HP (green) + XP (cyan) stacked — SAO uses a thin colored XP bar above HP.
  drawHpBar(heroX, heroY - heroHpY, hpW, hpH, chatter.hp, chatter.maxHp, "#22c55e");
  const xpToNext = Math.max(1, chatter.xpToNext || 100);
  drawHpBar(heroX, heroY - heroXpY, hpW, xpH, chatter.xp || 0, xpToNext, "#22d3ee");

  // Name + level — SAO style: "@login  Lv N" on one line above the bars.
  ctx.save();
  ctx.font = barMode
    ? "bold 12px JetBrains Mono, ui-monospace, monospace"
    : "bold 18px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = barMode ? 3 : 4;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  const lvl = chatter.level || 1;
  // Inc5: append compact position tag (F/M/B) so viewers can see battle line at a glance.
  const posTag = chatter.position === "front" ? " [F]" : chatter.position === "back" ? " [B]" : "";
  const label = `@${chatter.login}  Lv${lvl}${posTag}`;
  ctx.strokeText(label, heroX, heroY - heroLblY);
  ctx.fillStyle = "#fef3c7";
  ctx.fillText(label, heroX, heroY - heroLblY);
  ctx.restore();

  // Weapon class chip — SIGMA ABYSS is classless, the weapon IS the
  // class. "Hexblade +3 · Sorcerer" — color-coded by family.
  const weapon = chatter.weapon || null;
  if (weapon) {
    ctx.save();
    const chipY = heroY - heroLblY - (barMode ? 12 : 22);
    const chipText = weapon.plus
      ? `${weapon.base || weapon.label} +${weapon.plus} · ${weapon.label}`
      : `${weapon.base || weapon.label} · ${weapon.label}`;
    ctx.font = barMode
      ? "bold 10px JetBrains Mono, ui-monospace, monospace"
      : "bold 13px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = barMode ? 3 : 4;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(chipText, heroX, chipY);
    ctx.fillStyle = weapon.color || "#9ca3af";
    ctx.fillText(chipText, heroX, chipY);
    ctx.restore();
  }

  if (chatter.down) {
    // "DOWN" badge — flashes red, mostly so the streamer can see who is
    // about to respawn.
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.font = "bold 16px JetBrains Mono, ui-monospace, monospace";
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "center";
    ctx.fillText("DOWN", heroX, heroY - 150);
    ctx.restore();
  }

  // Battle dialogue ("barks") — the chatter's funny one-liner floats above its
  // name while it fights. Combat events (hit / crit / kill / hurt / down /
  // respawn) drive most lines from the WS handlers; this adds a rare ambient
  // quip so even a chatter between swings still feels alive (heavily throttled
  // inside barks — CAT_GAP.idle is 5.4 s — so it never becomes a monologue).
  if (chatter.foe && !chatter.down) barks.sayFor(chatter.login, "idle", { chance: 0.004 });
  // Anchor data is returned to draw(), which places all active bubbles in one
  // collision-aware pass. Drawing them inline lets neighboring chatters paint
  // over each other in the compact bar.
  return {
    id: chatter.login,
    x: heroX,
    anchorY: heroY - heroLblY - (barMode ? 30 * compactScale : 52),
    scale: barMode ? (compactRows === 1 ? 0.58 : compactRows === 2 ? 0.5 : 0.44) : 0.82,
  };
}

function drawDrop(d, now) {
  // In bar mode the original 0..1080 y-coords would push drops off the
  // 170-px strip; re-anchor a compact orb near the chatter row instead.
  if (barMode) {
    drawDropBar(d, now);
    return;
  }
  const bob = Math.sin(now / 300 + (d.bob || 0)) * 6;
  const y = d.y + bob;
  const x = d.x;
  const ttl = Math.max(0, (d.expiresAt || now) - now);
  const fadingOut = ttl < 4000;
  const alpha = fadingOut ? Math.max(0.25, ttl / 4000) : 1;
  ctx.save();
  ctx.globalAlpha = alpha;

  if (d.kind === "xp") {
    // Rotated diamond crystal — matches the chat-elixir vibe-coder-sim gem
    // sprite so XP drops read as a tangible diamond instead of a generic orb.
    const pulse = 0.78 + 0.22 * Math.sin(now / 220 + (d.bob || 0));
    const r = 30 * pulse;
    const hue = 145;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.shadowColor = `hsl(${hue} 95% 70%)`;
    ctx.shadowBlur = 16;
    ctx.fillStyle = `hsl(${hue} 90% 60%)`;
    ctx.fillRect(-r / 2, -r / 2, r, r);
    ctx.shadowBlur = 0;
    ctx.fillStyle = `hsl(${hue} 100% 85%)`;
    ctx.fillRect(-r / 2, -r / 2, r * 0.42, r * 0.42);
    ctx.restore();
  } else if (d.kind === "gold") {
    // Yellow coin
    const r = 20;
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#78350f";
    ctx.font = "bold 16px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", x, y);
  } else if (d.kind === "item") {
    // Rarity-tinted box with a sparkle pulse
    const color = RARITY_COLOR[d.rarity] || RARITY_COLOR.common;
    const pulse = 1 + 0.08 * Math.sin(now / 200);
    const s = 22 * pulse;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(x - s - 2, y - s - 2, (s + 2) * 2, (s + 2) * 2);
    ctx.fillStyle = color;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - s + 0.5, y - s + 0.5, s * 2 - 1, s * 2 - 1);
    // tiny sparkle dot
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x - s * 0.5, y - s * 0.5, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Label underneath (rarity + name for items, +value for xp/gold)
  ctx.font = "bold 13px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  let label;
  if (d.kind === "item") label = (d.name || "Item").toUpperCase();
  else if (d.kind === "gold") label = `+${d.value} gold`;
  else label = `+${d.value} XP`;
  ctx.strokeText(label, x, y + 30);
  ctx.fillStyle = d.kind === "item" ? RARITY_COLOR[d.rarity] || "#fff" : "#fef9c3";
  ctx.fillText(label, x, y + 30);
  ctx.restore();
}

function drawClaimAnims(now) {
  const rosterArr = [...roster.values()];
  const indexByLogin = new Map();
  rosterArr.forEach((c, i) => indexByLogin.set(c.login, i));
  for (let i = claimAnims.length - 1; i >= 0; i -= 1) {
    const a = claimAnims[i];
    if (now >= a.until) {
      claimAnims.splice(i, 1);
      continue;
    }
    const t = 1 - (a.until - now) / 750; // 0..1 progress
    const idx = indexByLogin.get(a.toLogin);
    let tx = a.fromX,
      ty = a.fromY - 60;
    if (idx != null) {
      const pos = slotPosition(idx, rosterArr.length);
      tx = pos.x;
      ty = pos.y - 60;
    }
    // Quadratic ease-in toward chatter
    const ease = t * t;
    const x = a.fromX + (tx - a.fromX) * ease;
    const y = a.fromY + (ty - a.fromY) * ease;
    const color =
      a.kind === "item"
        ? RARITY_COLOR[a.rarity] || "#fff"
        : a.kind === "gold"
          ? "#fbbf24"
          : "#86efac";
    ctx.save();
    ctx.globalAlpha = 1 - t * 0.5;
    // Trail dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 8 - t * 3, 0, Math.PI * 2);
    ctx.fill();
    // "+value" or item name pops at the chatter end
    if (t > 0.55) {
      const text =
        a.kind === "item"
          ? (a.name || "item").toUpperCase()
          : `+${a.value} ${a.kind === "gold" ? "GOLD" : "XP"}`;
      ctx.font = "bold 18px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(text, tx, ty - 30 - (t - 0.55) * 40);
      ctx.fillStyle = color;
      ctx.fillText(text, tx, ty - 30 - (t - 0.55) * 40);
    }
    ctx.restore();
  }
}

function drawSessionBanner(now) {
  if (!sessionBanner || now > sessionBanner.until) {
    sessionBanner = null;
    return;
  }
  const t = (sessionBanner.until - now) / 6000;
  const alpha = Math.min(1, t * 2);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (barMode) {
    // Top-of-bar streamer — 14 px in the 170-px strip is the biggest we
    // can fit without colliding with the chatter row at y=130.
    ctx.font = "bold 14px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.92)";
    ctx.strokeText(sessionBanner.text, VW / 2, 8);
    ctx.fillStyle = sessionBanner.accent || "#fde68a";
    ctx.fillText(sessionBanner.text, VW / 2, 8);
  } else {
    ctx.font = "bold 48px JetBrains Mono, ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.strokeText(sessionBanner.text, VW / 2, 80);
    ctx.fillStyle = sessionBanner.accent || "#fde68a";
    ctx.fillText(sessionBanner.text, VW / 2, 80);
  }
  ctx.restore();
}

// Compact drop renderer used inside the Game Bar embed. Drops snake along
// a single row above the chatter sprites so they read as "stuff on stage
// right now" even in 170 px of vertical room. Identity per drop is the
// id's first hex char → deterministic slot so they don't jitter frame to
// frame.
function drawDropBar(d, now) {
  const ttl = Math.max(0, (d.expiresAt || Date.now()) - Date.now());
  const fadingOut = ttl < 4000;
  const alpha = fadingOut ? Math.max(0.25, ttl / 4000) : 1;
  // Spread across the bar by id hash so a shower doesn't pile on top of
  // itself; bob slightly so they read as alive.
  const slotN = 16;
  const idHash = parseInt((d.id || "").slice(-3), 16) || 0;
  const slot = idHash % slotN;
  const x = 80 + slot * ((VW - 160) / (slotN - 1));
  const baseY = 36;
  const bob = Math.sin(now / 300 + (d.bob || 0)) * 3;
  const y = baseY + bob;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (d.kind === "xp") {
    const pulse = 0.82 + 0.18 * Math.sin(now / 220 + (d.bob || 0));
    const r = 14 * pulse;
    const hue = 145;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.shadowColor = `hsl(${hue} 95% 70%)`;
    ctx.shadowBlur = 10;
    ctx.fillStyle = `hsl(${hue} 90% 60%)`;
    ctx.fillRect(-r / 2, -r / 2, r, r);
    ctx.shadowBlur = 0;
    ctx.fillStyle = `hsl(${hue} 100% 85%)`;
    ctx.fillRect(-r / 2, -r / 2, r * 0.42, r * 0.42);
    ctx.restore();
  } else if (d.kind === "gold") {
    const r = 8;
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#78350f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  } else if (d.kind === "item") {
    const color = RARITY_COLOR[d.rarity] || RARITY_COLOR.common;
    const s = 9;
    ctx.fillStyle = color;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - s + 0.5, y - s + 0.5, s * 2 - 1, s * 2 - 1);
  }
  ctx.restore();
}

function drawHud(_now) {
  // No HUD chrome — the arena lives inside the Game Bar widget which
  // already owns its own pill/title/badge. When the roster is empty the
  // canvas is just transparent; chatting is what spawns sigmas here, so
  // an idle "waiting" prompt would crowd the bar with redundant text.
}

function draw(now) {
  // Clear to transparent — this is an OBS overlay, the base scene is
  // behind us.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  // CHANGE 3 — H-MMO blank main screen gate.
  // The full-screen (non-barMode) OBS source stays fully transparent,
  // except in VCS ?mode=foes-only where monsters must still render over
  // vibe-coder-sim and keep collision/auto-battle visuals running.
  // Outside that mode, all visible game content lives in the 1244×170
  // bar-mode Game Bar iframe to avoid duplicating the chatter grid.
  if (!barMode && !FOES_ONLY) {
    lastDrawAt = now;
    return;
  }

  // Frame delta for foe-roam motion. Clamp it so a backgrounded OBS source
  // resuming after a long pause doesn't teleport every foe across the strip.
  const dt = lastDrawAt ? Math.min(now - lastDrawAt, 80) : 16;
  lastDrawAt = now;

  const arr = [...roster.values()];

  // BAR-MODE renders the FULL compact game: between-raid roaming chatters
  // AND the raid fight when active. This is the only place the game shows.
  if (raid) {
    // Reuse the compact Elden Ring face-off renderer in bar mode. The previous
    // path drew only the HP strip, so the raid could be active while the boss
    // itself never appeared in the MMO canvas.
    drawCompactBossScene(RAID_ONLY ? [] : arr, now, dt);
    drawBossBarCompact(now);
  } else if (!RAID_ONLY) {
    const barkAnchors = [];
    arr.forEach((c, i) => {
      const anchor = drawChatter(c, i, arr.length, now, dt);
      if (anchor) barkAnchors.push(anchor);
    });
    drawBarkBubbles(barkAnchors, now);
  }
  // RAID_ONLY mode (set via ?mode=raid-only) suppresses the idle chatter
  // grid so the canvas is fully transparent when no raid is active.

  // Foe bullet-hell volleys — in the air over the prowling monsters.
  drawFoeProjectiles(now, dt);

  // Drops sit on top of chatters so they're never occluded by avatars.
  // Reap any that overran their server-side TTL in case a dropExpire
  // frame got dropped on the floor.
  const nowReal = Date.now();
  for (const [id, d] of drops) {
    if ((d.expiresAt || 0) < nowReal) drops.delete(id);
  }
  // Spatial-collision pickup: chatter pet walked over a drop in the parent
  // overlay → claim it server-side. Runs before drawing drops so the claim
  // anim takes over the same frame the drop is gone.
  tickDropCollisions();
  // Drop draw calls removed (A: declutter) — server economy + claim logic intact.
  // drawDrop, drawClaimAnims, drawSessionBanner suppressed from this overlay.

  // Combat popups only outside a raid (A: no floating numbers during boss fight).
  if (!raid) drawPopups(now);
  drawHud(now);
}

// ── Elden Ring face-off layout ─────────────────────────────────────────
// Boss anchored on the RIGHT ("Navi zone"), facing LEFT toward the party.
// Party clusters on the LEFT third, facing RIGHT toward the boss.
// A translucent void/ember parallax paints behind the fight without
// blacking out the transparent OBS overlay.
// B: Compact bottom-band layout. Fight sits in the thin strip just above the
// OBS game bar (~170px). Boss feet at y≈900 → head ≈ y≈759 at scale 2.2
// (64×2.2=140px tall). Party feet match. The fight hugs the very bottom.
const BOSS_GROUND_Y = 900; // feet y-anchor — above game-bar strip
const BOSS_ANCHOR_X = Math.round(1920 * 0.823); // ~1580 — right side, facing left
const PARTY_GROUND_Y = 900; // party feet match boss ground level
const PARTY_SPACING = 46; // tight cols for small fighters
const PARTY_MAX_PER_ROW = 10; // more per row at smaller scale
const PARTY_SCALE = 0.88; // small fighters to match compact boss
const PARTY_LEFT_ANCHOR = Math.round(1920 * 0.22); // left anchor unchanged
const BOSS_SCALE = 2.2; // ~⅓ of original 6.0
// Inc1: how long to keep the "STAGGERED" word visible (matches server STAGGER_MS=5s).
const STAGGER_DISPLAY_MS = 5_000;

// Parallax layer descriptors — three depth layers of translucent void embers.
// B: yBands now confined to the bottom fight strip (y≈760..920).
// Each layer: { speed (px/s relative drift), alpha, yBand [top,bot] }
const PARALLAX_LAYERS = [
  { speed: 18, alpha: 0.18, yBand: [760, 920] }, // far haze
  { speed: 34, alpha: 0.22, yBand: [770, 910] }, // mid drift
  { speed: 55, alpha: 0.28, yBand: [780, 900] }, // near floor
];

// Melee dash constants — D2 fighter charge→strike→retreat.
const MELEE_SWING_MS = 520; // total swing window
const MELEE_GAP = 80; // standoff distance scaled down for compact boss (was 210)
// Boss attack cycle constants — D3 cosmetic boss counter (subtle, proportional).
const BOSS_TELEGRAPH_MS = 680; // wind-up aura / rear-back
const BOSS_STRIKE_MS = 260; // lunge + shockwave
const BOSS_RECOVER_MS = 480; // ease back to anchor
const BOSS_ATK_CD = 4200; // idle gap between attacks
const BOSS_ATK_INITIAL_DELAY = 1500; // first attack starts after this ms

// Seeded ember positions so each layer has stable (non-random) coords.
const EMBER_COUNT = 28;
const _emberSeeds = Array.from({ length: EMBER_COUNT }, (_, i) => ({
  ox: ((i * 137.508 * 3) % 1.0) * VW, // pseudo-spread across width
  oy: ((i * 97.31 + i * 0.413) % 1.0) * 500, // vertical spread within band
  r: 1.5 + (i % 5) * 0.5, // radius 1.5..3.5
  phase: (i * 41.7) % (Math.PI * 2), // stagger the sine blink
}));

function drawBossParallax(now) {
  // Three parallax layers of drifting embers (no dark band — operator removed).
  const t = now / 1000; // seconds
  for (let li = 0; li < PARALLAX_LAYERS.length; li += 1) {
    const layer = PARALLAX_LAYERS[li];
    ctx.save();
    ctx.globalAlpha = layer.alpha;
    const [yTop, yBot] = layer.yBand;
    const bandH = yBot - yTop;
    for (let ei = 0; ei < EMBER_COUNT; ei += 1) {
      const seed = _emberSeeds[ei];
      // Drift rightward, wrapping at VW.
      const x = (seed.ox + t * layer.speed * (1 + (ei % 3) * 0.15)) % VW;
      // Vertical float — slow sine oscillation.
      const y = yTop + ((seed.oy + t * 8 * (1 + li * 0.4)) % bandH);
      // Ember flicker via sine brightness.
      const blink = 0.5 + 0.5 * Math.sin(t * 1.8 + seed.phase);
      const size = seed.r * (0.7 + 0.6 * blink);
      // ER ember palette: deep crimson → orange ember core
      const hue = 8 + li * 6;
      const lightness = 45 + Math.round(blink * 25);
      ctx.fillStyle = `hsl(${hue},85%,${lightness}%)`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawCompactBossScene(arr, now, dt = 16) {
  drawBossScene(arr, now, dt);
}

function drawBossScene(arr, now, _dt = 16) {
  // Hard-reset shadow state — ctx.clearRect does NOT clear shadow. Any
  // lingering shadowBlur from a previous frame corrupts compositing in Chrome
  // headless (entire sprite layer clips/disappears). Always zero before drawing.
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  // ── Parallax void (behind everything) ────────────────────────────
  drawBossParallax(now);

  // ── D3 boss attack cycle — advance state machine ─────────────────
  // Run BEFORE the boss draw so bossLungeX/bossTelegraphX are current,
  // and so the telegraph ring draws BEHIND the boss sprite this frame.
  if (bossAtk.nextAt === 0) {
    bossAtk.nextAt = now + BOSS_ATK_INITIAL_DELAY;
  }
  if (
    now >= bossAtk.nextAt &&
    bossAtk.telegraphUntil === 0 &&
    bossAtk.strikeUntil === 0 &&
    bossAtk.recoverUntil === 0
  ) {
    bossAtk.telegraphUntil = now + BOSS_TELEGRAPH_MS;
  }
  if (bossAtk.telegraphUntil > 0 && now >= bossAtk.telegraphUntil) {
    bossAtk.telegraphUntil = 0;
    bossAtk.strikeUntil = now + BOSS_STRIKE_MS;
    if (bossShock.length < 6) {
      bossShock.push({
        x: BOSS_ANCHOR_X - 40,
        y: BOSS_GROUND_Y - 64 * BOSS_SCALE * 0.45,
        born: now,
        ttl: 600,
      });
    }
    bossFx.shakeUntil = now + 180;
    bossFx.shakeAmp = 14;
    partyHitUntil = now + 220;
  }
  if (bossAtk.strikeUntil > 0 && now >= bossAtk.strikeUntil) {
    bossAtk.strikeUntil = 0;
    bossAtk.recoverUntil = now + BOSS_RECOVER_MS;
  }
  if (bossAtk.recoverUntil > 0 && now >= bossAtk.recoverUntil) {
    bossAtk.recoverUntil = 0;
    bossAtk.nextAt = now + BOSS_ATK_CD;
  }

  // ── Telegraph danger ring — draw BEHIND boss (before composeEnemy) ──
  // Centered on boss mid-body. Pure numeric offset already baked into bossX below.
  // Draw first so boss sprite renders on top of the aura.
  if (bossAtk.telegraphUntil > 0) {
    const tp = 1 - (bossAtk.telegraphUntil - now) / BOSS_TELEGRAPH_MS; // 0→1 ramp
    const ringR = 28 + tp * 60; // compact: proportional to small boss (was 80+180)
    const bossBodyCX = BOSS_ANCHOR_X; // use anchor, not shifted bossX (ring stays fixed)
    const bossBodyCY = BOSS_GROUND_Y - 64 * BOSS_SCALE * 0.5;
    ctx.save();
    ctx.shadowBlur = 0; // ensure no inherited shadow bleeds in
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 0.25 + tp * 0.55;
    ctx.strokeStyle = `hsl(0,95%,${55 + Math.round(tp * 15)}%)`;
    ctx.lineWidth = 6 + tp * 10;
    ctx.beginPath();
    ctx.arc(bossBodyCX, bossBodyCY, ringR, 0, Math.PI * 2);
    ctx.stroke();
    // Inner pulse ring
    ctx.globalAlpha = tp * 0.35;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ff8888";
    ctx.beginPath();
    ctx.arc(bossBodyCX, bossBodyCY, ringR * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }

  // ── Boss on the RIGHT, facing LEFT ───────────────────────────────
  let shakeX = 0;
  let shakeY = 0;
  if (now < bossFx.shakeUntil) {
    shakeX = (Math.random() - 0.5) * bossFx.shakeAmp;
    shakeY = (Math.random() - 0.5) * bossFx.shakeAmp * 0.6;
  }
  // D3 boss lunge offset — during strike phase the boss shifts LEFT toward party
  let bossLungeX = 0;
  if (bossAtk.strikeUntil > 0) {
    const sp = 1 - (bossAtk.strikeUntil - now) / BOSS_STRIKE_MS; // 0→1
    bossLungeX = -Math.sin(sp * Math.PI) * 70; // lunge left then snap back
  }
  // D3 telegraph rear-back — boss shifts slightly RIGHT (away from party) during wind-up
  let bossTelegraphX = 0;
  if (bossAtk.telegraphUntil > 0) {
    const tp2 = 1 - (bossAtk.telegraphUntil - now) / BOSS_TELEGRAPH_MS;
    bossTelegraphX = Math.sin(tp2 * Math.PI) * 30; // rear right then return
  }
  // Hard-reset shadow before boss draw — never let effects above bleed in
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  const bossX = BOSS_ANCHOR_X + shakeX + bossLungeX + bossTelegraphX;
  // composeEnemy's y is the FEET/ground line — the sprite stands on it and
  // extends UPWARD. BOSS_GROUND_Y is that feet anchor.
  const bossSpriteH = 64 * BOSS_SCALE; // 384px at scale 6 (head ≈ feet − this)
  const bossFeetY = BOSS_GROUND_Y + shakeY;
  // Compact ground shadow — scaled down for small boss
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(bossX, BOSS_GROUND_Y + shakeY + 6, 60, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const bossFlash = now < bossFx.flashUntil;
  // Boss faces LEFT (toward the party). composeEnemy supports all 4 LPC
  // dirs including "left". No horizontal flip needed — the LPC walkcycle
  // has a native left-facing row (DIR_ROW["left"] in lpc-avatar.js).
  const ok = composeEnemy(
    ctx,
    bossX,
    bossFeetY,
    raid.lpc,
    bossFlash ? "hurt" : "idle",
    now,
    BOSS_SCALE,
    bossFlash,
    "left",
  );
  if (!ok) {
    // Fallback slab — the boss should NEVER look like nothing
    ctx.save();
    ctx.fillStyle = `hsl(${raid.hue ?? 0} 60% 48%)`;
    ctx.fillRect(
      bossX - Math.round((32 * BOSS_SCALE) / 2),
      bossFeetY - bossSpriteH,
      Math.round(32 * BOSS_SCALE),
      bossSpriteH,
    );
    ctx.restore();
  }
  // A: boss name removed from main overlay (game bar shows it). Tiny HP nub above sprite.
  const bossPct = Math.max(0, Math.min(1, raid.hp / Math.max(1, raid.maxHp)));
  const nubW = 56;
  const nubY = bossFeetY - bossSpriteH - 6;
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(bossX - nubW / 2, nubY - 4, nubW, 4);
  ctx.fillStyle = "#c81e2e";
  ctx.fillRect(bossX - nubW / 2, nubY - 4, nubW * bossPct, 4);
  ctx.restore();

  // ── Party on the LEFT, facing RIGHT (toward boss) ─────────────────
  // Reset shadow before avatar draws — must be clean for composeAvatar.
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  const total = arr.length;
  const perRow = Math.min(PARTY_MAX_PER_ROW, Math.max(1, total));
  for (let i = 0; i < total; i += 1) {
    const chatter = arr[i];
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const cols = Math.min(perRow, total - row * perRow);
    // Left-anchored cluster: center of the cols around PARTY_LEFT_ANCHOR
    const totalWidth = (cols - 1) * PARTY_SPACING;
    const startX = PARTY_LEFT_ANCHOR - totalWidth / 2;
    const heroX = startX + col * PARTY_SPACING;
    const heroY = PARTY_GROUND_Y + row * 70; // B: tighter row gap for compact layout
    // D2 — melee dash: charge → strike at standoff → retreat.
    // Swing window is MELEE_SWING_MS. Three eased sub-phases:
    //   charge  0..0.42 — ease-out toward (BOSS_ANCHOR_X - MELEE_GAP)
    //   strike  0.42..0.58 — hold near standoff; spawn slash impact once
    //   retreat 0.58..1.0 — ease back to slot
    const genuinelyDownLoop = chatter.down && chatter.hp <= 0;
    const sleepingLoop = raid ? genuinelyDownLoop : chatter.down;
    const swingUntil = swingAnim.get(chatter.login);
    let swingLungeX = 0;
    let swingLiftY = 0;
    // Party recoil from boss strike — shift alive fighters left + white flash.
    let recoilX = 0;
    if (!sleepingLoop && now < partyHitUntil) {
      const rt = 1 - (partyHitUntil - now) / 220;
      recoilX = -Math.sin(rt * Math.PI) * 28;
    }
    if (swingUntil && now < swingUntil) {
      const tRaw = 1 - (swingUntil - now) / MELEE_SWING_MS; // 0..1
      const melee_target_x = BOSS_ANCHOR_X - MELEE_GAP - heroX;
      // Fan the strike point by fighter index so simultaneous dashers don't overlap
      const vertFan = ((i % 5) - 2) * 18;
      if (tRaw < 0.42) {
        // Charge phase — ease-out (decelerate as they close in)
        const tc = tRaw / 0.42; // 0..1 within charge
        const ease = 1 - (1 - tc) * (1 - tc); // ease-out quad
        swingLungeX = ease * melee_target_x;
        swingLiftY = -Math.sin(tc * Math.PI) * 12; // slight upward arc
      } else if (tRaw < 0.58) {
        // Strike phase — hold at standoff
        swingLungeX = melee_target_x;
        swingLiftY = vertFan * 0.3;
        // Spawn slash impact once per swing (when tRaw first crosses 0.42)
        // Use a stable per-swing discriminator: born = swingUntil - MELEE_SWING_MS
        const swingBorn = swingUntil - MELEE_SWING_MS;
        const impactX = heroX + swingLungeX - 20;
        const impactY = heroY + swingLiftY - 40 + vertFan;
        // Only spawn if there is no recent slash for this exact swing window
        const alreadySpawned = meleeSlashPool.some(
          (s) => s.swingBorn === swingBorn && s.login === chatter.login,
        );
        if (!alreadySpawned && meleeSlashPool.length < 12) {
          meleeSlashPool.push({
            x: impactX,
            y: impactY,
            born: now,
            ttl: 160,
            swingBorn,
            login: chatter.login,
          });
        }
      } else {
        // Retreat phase — ease-in back to slot
        const tr = (tRaw - 0.58) / 0.42; // 0..1 within retreat
        const ease = tr * tr; // ease-in quad
        swingLungeX = melee_target_x * (1 - ease);
        swingLiftY = 0;
      }
    }
    drawPartyMember(
      chatter,
      heroX + swingLungeX + recoilX,
      heroY + swingLiftY,
      now,
      now < partyHitUntil && !sleepingLoop,
    );
  }

  // ── Melee slash impacts at point of contact ───────────────────────
  for (let i = meleeSlashPool.length - 1; i >= 0; i -= 1) {
    const s = meleeSlashPool[i];
    const age = now - s.born;
    if (age > s.ttl) {
      meleeSlashPool.splice(i, 1);
      continue;
    }
    const f = 1 - age / s.ttl; // 1→0 fade
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = f * 0.9;
    // White-gold crescent arc
    ctx.strokeStyle = `hsl(45,100%,${80 + Math.round(f * 20)}%)`;
    ctx.lineWidth = 3 + f * 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(s.x, s.y, 22 + (1 - f) * 18, -0.8, 0.8);
    ctx.stroke();
    // Bright core
    ctx.globalAlpha = f * 0.7;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5 * f, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── Strike screen flash + shockwave rings (drawn after party) ───────
  // Strike flash: brief red wash when boss lunges.
  if (bossAtk.strikeUntil > 0) {
    const sp = 1 - (bossAtk.strikeUntil - now) / BOSS_STRIKE_MS;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = (1 - sp) * 0.18;
    ctx.fillStyle = "#ff2222";
    ctx.fillRect(0, 0, VW, VH);
    ctx.restore();
  }

  // Shockwave pool — expanding rings travel LEFT from boss toward party.
  // No shadowBlur here to avoid leaking into subsequent draw calls.
  for (let i = bossShock.length - 1; i >= 0; i -= 1) {
    const sw = bossShock[i];
    const age = now - sw.born;
    if (age > sw.ttl) {
      bossShock.splice(i, 1);
      continue;
    }
    const f = age / sw.ttl; // 0→1
    const fade = 1 - f;
    const r = 8 + f * 120; // compact: was 340, now proportional to small boss
    const scx = sw.x - f * 200; // travel left toward party
    const scy = sw.y;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = fade * 0.75;
    ctx.strokeStyle = `hsl(0,85%,${55 + Math.round(fade * 20)}%)`;
    ctx.lineWidth = 4 + fade * 6;
    ctx.beginPath();
    ctx.arc(scx, scy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Second ring slightly smaller/delayed for depth
    ctx.globalAlpha = fade * 0.4;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffaaaa";
    ctx.beginPath();
    ctx.arc(scx, scy, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // A: drawBossPopups removed (clean look during raid).
  // A: drawBossHpBarOnCanvas removed (progress lives in game bar).

  // ── Inc1: Poise pip + STAGGER flash + Enrage tint ──────────────────
  // Minimal: a thin secondary bar segment just below the boss feet, a
  // brief "STAGGERED" word flash over the boss, and a subtle red wash
  // when enraged. No extra chrome — the overlay stays decluttered.
  if (raid) {
    const now2 = nowMs();
    const isStaggered = raid.staggeredUntil > now2;
    const isEnraged = raid.enrageAt > 0 && now2 > raid.enrageAt;

    // Poise pip — a thin 4-px segment directly below the boss feet.
    // Width spans from BOSS_ANCHOR_X-80 to +80 (160px total).
    const poisePct = Math.max(0, Math.min(1, (raid.poise || 0) / Math.max(1, raid.maxPoise || 1)));
    const pipW = 160;
    const pipX = BOSS_ANCHOR_X - pipW / 2;
    const pipY = BOSS_GROUND_Y + 10;
    const pipH = 4;
    if (!barMode) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      // Track
      ctx.fillStyle = "rgba(10,10,20,0.8)";
      ctx.fillRect(pipX, pipY, pipW, pipH);
      // Fill — cyan-ish for poise, grey when staggered (resetting)
      ctx.fillStyle = isStaggered ? "#9ca3af" : "#38bdf8";
      ctx.fillRect(pipX, pipY, Math.round(pipW * poisePct), pipH);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // STAGGERED flash — white text over boss for 1.2s on stagger events
    if (isStaggered && !barMode) {
      const staggerFade = Math.max(
        0,
        1 - (now2 - (raid.staggeredUntil - STAGGER_DISPLAY_MS)) / STAGGER_DISPLAY_MS,
      );
      ctx.save();
      ctx.globalAlpha = Math.min(1, staggerFade * 2.5);
      ctx.font = "900 28px JetBrains Mono, ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeText("STAGGERED", BOSS_ANCHOR_X, BOSS_GROUND_Y - 64 * BOSS_SCALE * 1.1);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("STAGGERED", BOSS_ANCHOR_X, BOSS_GROUND_Y - 64 * BOSS_SCALE * 1.1);
      ctx.restore();
    }

    // Enrage tint — subtle red ambient wash at the edges; low alpha so it
    // doesn't overpower the scene.
    if (isEnraged && !barMode) {
      ctx.save();
      ctx.globalAlpha = 0.09 + 0.04 * Math.sin(now2 / 400);
      ctx.fillStyle = "#ff2222";
      ctx.fillRect(0, 0, VW, VH);
      ctx.restore();
    }
  }
}

function drawPartyMember(chatter, heroX, heroY, now, recoilFlash = false) {
  const shadowRx = 16; // scaled down for half-size fighters
  drawShadow(heroX, heroY, shadowRx);
  // During an active raid, chatter.down is the arena KO flag (boss counter-
  // attack knocked them out). A fighter with hp > 0 is alive and should
  // stand + face right even if downUntil hasn't cleared yet — they're a
  // raid participant, not an idle apartment sleeper. Only genuinely
  // hp-zero fighters (rare: shouldn't happen, server clamps to 0) sit.
  // Outside a raid the original sleep/idle semantics are preserved.
  const genuinelyDown = chatter.down && chatter.hp <= 0;
  const sleeping = raid ? genuinelyDown : chatter.down;
  // Gear aura — drawn additive over shadow, under avatar. Skip when sleeping.
  if ((chatter.auraTier ?? 0) >= 1 && !sleeping) {
    drawAura(heroX, heroY, chatter.auraTier, PARTY_SCALE, chatter.seed || 1, now);
  }
  const pet = {
    seed: chatter.seed,
    cosmetics: chatter.cosmetics,
    sleeping,
    // _motion.dir="right" → avatar faces the boss (rightward) while alive;
    // "down" for a truly downed fighter. composeAvatar / pickState / DIR_ROW
    // all support "right" natively.
    _motion: { facing: 1, vx: 0, dir: sleeping ? "down" : "right" },
  };
  composeAvatar(ctx, heroX, heroY, pet, now, PARTY_SCALE);

  // D3 recoil flash — brief white overlay on alive fighters hit by boss
  if (recoilFlash && !sleeping) {
    ctx.save();
    const avatarH = 64 * PARTY_SCALE;
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(heroX - 18, heroY - avatarH, 36, avatarH);
    ctx.restore();
  }

  // B: HP bar and label scaled down for compact fighters (PARTY_SCALE 0.88)
  const avatarDrawH = Math.round(64 * PARTY_SCALE); // ~56px
  const hpBarY = heroY - avatarDrawH - 3;
  drawHpBar(heroX, hpBarY, 32, 3, chatter.hp, chatter.maxHp, "#22c55e");
  // Name label — tiny, only login (no level) to keep it clean at this scale
  ctx.save();
  ctx.font = "bold 8px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  const label = `@${chatter.login}`;
  ctx.strokeText(label, heroX, hpBarY - 1);
  ctx.fillStyle = sleeping ? "#ef4444" : "#fef3c7";
  ctx.fillText(label, heroX, hpBarY - 1);
  ctx.restore();

  if (sleeping) {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.font = "bold 8px JetBrains Mono, ui-monospace, monospace";
    ctx.fillStyle = "#ef4444";
    ctx.textAlign = "center";
    ctx.fillText("DOWN", heroX, hpBarY - 10);
    ctx.restore();
  }
}

function drawBossHpBarOnCanvas(_now) {
  const barH = 32; // slim ER proportions
  const margin = 40;
  const barY = VH - 130; // above whatever "game bar" strip OBS layers on
  const barX = margin;
  const barW = VW - margin * 2;
  const pct = Math.max(0, Math.min(1, raid.hp / Math.max(1, raid.maxHp)));
  ctx.save();
  // Semi-transparent dark backplate (ER minimal chrome)
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(barX - 6, barY - 32, barW + 12, barH + 58);
  // Near-black border, thin
  ctx.strokeStyle = "rgba(200,30,46,0.55)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(barX - 6, barY - 32, barW + 12, barH + 58);
  // HP track — near-black
  ctx.fillStyle = "rgba(10,2,4,0.9)";
  ctx.fillRect(barX, barY, barW, barH);
  // HP fill — solid ER crimson (#c81e2e)
  ctx.fillStyle = "#c81e2e";
  ctx.fillRect(barX, barY, barW * pct, barH);
  // Boss name (left)
  ctx.font = "900 24px JetBrains Mono, ui-monospace, monospace";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffe4e6";
  ctx.fillText(raid.name.toUpperCase(), barX + 4, barY - 10);
  // Fighter count (right)
  ctx.font = "bold 16px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,228,230,0.78)";
  const c = raid.contributors || 0;
  ctx.fillText(c ? `${c} FIGHTER${c === 1 ? "" : "S"}` : "ENGAGE", barX + barW - 4, barY - 10);
  // HP value centered inside the bar
  ctx.font = "bold 15px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#fff";
  ctx.fillText(
    `${fmtBig(Math.max(0, Math.round(raid.hp)))} / ${fmtBig(raid.maxHp)} · ${Math.round(pct * 100)}%`,
    barX + barW / 2,
    barY + barH / 2 + 5,
  );
  ctx.restore();
}

// ── Compact boss bar for barMode (0..170 virtual space) ───────────────
// Renders inside the 1244×170 Game Bar widget. Uses the same red→orange→gold
// gradient as the full-screen bar, pinned near the TOP of the strip so it
// doesn't occlude the chatter row at y≈130.
function drawBossBarCompact(now) {
  if (!raid) return;
  const barH = 18;
  const margin = 16;
  const barY = 6; // top of the 0..170 strip
  const barX = margin;
  const barW = VW - margin * 2;
  const pct = Math.max(0, Math.min(1, raid.hp / Math.max(1, raid.maxHp)));

  ctx.save();

  // Subtle pulse on the backplate so viewers notice the boss is active.
  const pulse = 0.55 + 0.1 * Math.sin(now / 400);
  ctx.fillStyle = `rgba(0,0,0,${pulse})`;
  ctx.fillRect(barX - 4, barY - 2, barW + 8, barH + 22);
  ctx.strokeStyle = "rgba(255,58,79,0.65)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(barX - 4, barY - 2, barW + 8, barH + 22);

  // HP track
  ctx.fillStyle = "rgba(40,6,10,0.85)";
  ctx.fillRect(barX, barY, barW, barH);

  // HP fill — solid ER crimson (#c81e2e), same restyle as full bar
  ctx.fillStyle = "#c81e2e";
  ctx.fillRect(barX, barY, barW * pct, barH);

  // Flash on boss hit — same bossFx.flashUntil used by full-screen scene
  if (now < bossFx.flashUntil) {
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.fillRect(barX, barY, barW * pct, barH);
  }

  // Boss name left + hp% right inside the bar
  ctx.font = "bold 12px JetBrains Mono, ui-monospace, monospace";
  ctx.textBaseline = "middle";
  const midY = barY + barH / 2;

  ctx.textAlign = "left";
  ctx.fillStyle = "#ffe4e6";
  ctx.fillText(`⚔ ${raid.name.toUpperCase()}`, barX + 4, midY);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,228,230,0.85)";
  ctx.fillText(`${Math.round(pct * 100)}%`, barX + barW - 4, midY);

  // Small "BOSS RAID" label below the bar
  ctx.font = "bold 10px JetBrains Mono, ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(254,202,202,0.7)";
  const c = raid.contributors || 0;
  ctx.fillText(
    c ? `${c} FIGHTER${c === 1 ? "" : "S"} — !FIGHT TO JOIN` : "BOSS RAID — !FIGHT TO ENGAGE",
    barX + barW / 2,
    barY + barH + 10,
  );

  ctx.restore();
}

function fmtBig(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

// Enter boss-fight mode from any source: a live raidStart WS frame OR
// the on-connect snapshot (welcome.raid / /api/raid HTTP bootstrap). Both
// paths call this so a client that connects mid-raid sees the boss
// immediately without waiting for the next raidUpdate broadcast.
function applyRaidStart(m) {
  raid = {
    boss_id: m.boss_id,
    name: m.name || "Boss",
    hue: m.hue,
    lpc: m.lpc || null,
    hp: m.hp,
    maxHp: m.maxHp,
    contributors: m.contributors || 0,
    // Inc1: poise / stagger / enrage
    poise: m.poise != null ? m.poise : m.maxPoise || 0,
    maxPoise: m.maxPoise || 0,
    staggeredUntil: m.staggeredUntil || 0,
    enrageAt: m.enrageAt || 0,
  };
  // Discard any in-flight bolts from the previous fight.
  foeProjectiles.length = 0;
  raidProjectiles.length = 0;
  bossPopups.length = 0;
  meleeSlashPool.length = 0;
  bossShock.length = 0;
  partyHitUntil = 0;
  // Reset boss attack cycle with initial delay before first telegraph.
  const now = nowMs();
  bossAtk.nextAt = now + BOSS_ATK_INITIAL_DELAY;
  bossAtk.telegraphUntil = 0;
  bossAtk.strikeUntil = 0;
  bossAtk.recoverUntil = 0;
}

function loop(now) {
  requestAnimationFrame(loop);
  draw(now);
}
requestAnimationFrame(loop);

// ── WS plumbing ────────────────────────────────────────────────────
let ws = null;
let backoff = 500;
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    backoff = 500;
    connDot.classList.add("online");
    // Don't send `hello` — that would mint an anon token and count this
    // OBS browser source as a player. Instead, bootstrap the roster via
    // the read-only HTTP snapshot; subsequent t:'arenaRoster' broadcasts
    // keep us in sync.
    fetch("/api/arena")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && Array.isArray(j.chatters)) setRosterFromSnapshot(j);
      })
      .catch(() => {
        /* ignore — periodic roster broadcasts will fill in */
      });
    fetch("/api/drops")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && Array.isArray(j.drops)) setDropsFromSnapshot(j);
      })
      .catch(() => {
        /* ignore — dropSpawn frames will fill in */
      });
    // Bootstrap raid state — if the overlay loads mid-fight the JRPG
    // scene needs to kick in immediately rather than waiting for the
    // next raidUpdate broadcast.
    fetch("/api/raid")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.raid?.boss_id) applyRaidStart(j.raid);
      })
      .catch(() => {
        /* ignore — raidStart will fill in */
      });
  });

  ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "welcome":
        if (m.arena) setRosterFromSnapshot(m.arena);
        if (m.drops) setDropsFromSnapshot(m.drops);
        // D2 fix: if a raid is already active when this client connects,
        // enter boss mode from the snapshot without waiting for raidStart.
        if (m.raid && m.raid.boss_id) applyRaidStart(m.raid);
        break;
      case "sessionEvent":
        sessionBanner = {
          text: m.announce || `${m.agent || "agent"} session — chat to grab!`,
          accent: m.flavor === "boss" ? "#ef4444" : m.flavor === "shower" ? "#fde68a" : "#86efac",
          until: nowMs() + 6000,
        };
        break;
      case "dropSpawn":
        if (Array.isArray(m.drops)) for (const d of m.drops) upsertDrop(d);
        break;
      case "dropClaim":
        startClaimAnim(m.id, m.login, m.summary || {});
        break;
      case "dropExpire":
        if (m.id) drops.delete(m.id);
        break;
      case "arenaRoster":
        setRosterFromSnapshot(m);
        break;
      case "arenaJoin":
        if (m.chatter) upsertChatter(m.chatter, false);
        break;
      case "arenaLeave":
        if (m.login) dropChatter(m.login);
        break;
      case "arenaHit": {
        const c = roster.get(m.login);
        if (!c) break;
        if (m.side === "player" && c.foe) {
          c.foe.hp = m.hp;
          c.foe.maxHp = m.maxHp;
        } else if (m.side === "enemy") {
          c.hp = m.hp;
          c.maxHp = m.maxHp;
        }
        // In FOES_ONLY (Vibe Coder Sim OBS source), the chatter sprite
        // lives in the apartment iframe BELOW; combat popups need to
        // hover over the foe (top of canvas) or they vanish into empty
        // space. Damage numbers + weapon-art flashes anchor to the foe
        // on player swings, and to the foe row on enemy counters (since
        // the chatter is offscreen in this scene).
        const popupTarget = FOES_ONLY ? "foe" : "hero";
        pushHitPopup(m.login, m.side, m.dmg, m.crit, { target: popupTarget });
        // Weapon-art flash: SAO-style skill name pops above the chatter
        // in the family's class color. Only fires on player hits.
        if (m.art?.name && m.side === "player") {
          const tint = c.weapon?.color || "#fde68a";
          pushFlavorPopup(m.login, m.art.name, tint, { target: popupTarget });
        }
        // Foes-only combat read: when the chatter lands a hit, recoil
        // the foe upward + flash it white so each blow registers as
        // contact instead of monsters just walking in place.
        if (m.side === "player") {
          const tEnd = nowMs();
          foeLungeAnim.set(m.login, tEnd + 300);
          foeFlashAnim.set(m.login, tEnd + 140);
          // Paint the owner's incoming blow so the flash has a visible cause.
          foeStrikeAnim.set(m.login, tEnd + FOE_STRIKE_MS);
          // The chatter trash-talks as it lands a blow — crits get the hype
          // line (same cats + odds the single-player combat view uses).
          barks.sayFor(
            m.login,
            m.crit ? "crit" : "hit",
            m.crit ? { chance: 0.85 } : { chance: 0.4 },
          );
        } else if (m.side === "enemy") {
          // Took a counter-swing — a yelp.
          barks.sayFor(m.login, "hurt", { chance: 0.5 });
        }
        break;
      }
      case "arenaKill": {
        // Snapshot the dying foe so its death anim survives the imminent
        // arenaFoeSwap; the new foe drops in over it. Without this snapshot
        // the kill is invisible — the foe just teleport-swaps mid-stream.
        // Pin the snapshot to the foe's roam position so the corpse stays
        // where it fell instead of sliding with the next foe's prowl.
        const c = roster.get(m.login);
        if (c?.foe) {
          const roamAt = foeRoam.get(m.login);
          foeDeathAnim.set(m.login, {
            foe: { ...c.foe },
            startedAt: nowMs(),
            x: roamAt ? roamAt.x : null,
            y: roamAt ? roamAt.y : null,
          });
        }
        const attacker = c?.name || m.login;
        // KO over the foe slot in FOES_ONLY so viewers see "this monster
        // just died" right where the monster sprite is — not anchored to
        // a chatter slot the apartment iframe paints over. Include who
        // landed the killing blow so chat reads which chatter scored it.
        const koTarget = FOES_ONLY ? "foe" : "hero";
        const koText = `KO  @${attacker}`;
        pushFlavorPopup(m.login, koText, "#fde68a", { target: koTarget, ttlMs: 1800 });
        // The chatter gloats over the corpse — a kill is a highlight beat, so
        // force it past the throttle.
        barks.sayFor(m.login, "kill", { force: true });
        break;
      }
      case "arenaFoeSwap": {
        const c = roster.get(m.login);
        if (c) c.foe = m.foe || c.foe;
        // Drop-in: the new foe descends into its slot over FOE_SPAWN_MS.
        foeSpawnAnim.set(m.login, nowMs() + FOE_SPAWN_MS);
        // Fresh foe engaging → pop the "!" aggro marker.
        foeAlertAnim.set(m.login, nowMs() + FOE_ALERT_MS);
        break;
      }
      case "arenaDown": {
        const c = roster.get(m.login);
        if (c) {
          c.hp = 0;
          c.down = true;
        }
        const handle = c?.name || m.login;
        // In FOES_ONLY the chatter sprite isn't on this canvas — anchor
        // the DOWN flash over their foe slot so the column still reads.
        // Include foe name as "killed by …" attribution so chat sees why.
        const downTarget = FOES_ONLY ? "foe" : "hero";
        const downText = m.foeName ? `@${handle} DOWN  ← ${m.foeName}` : `@${handle} DOWN`;
        pushFlavorPopup(m.login, downText, "#ef4444", { target: downTarget, ttlMs: 1800 });
        // Last words — a (defiant) death quip, held a touch longer.
        barks.sayFor(m.login, "death", { force: true, life: 2000 });
        break;
      }
      case "arenaRespawn": {
        const c = roster.get(m.login);
        if (c) {
          c.hp = m.hp;
          c.maxHp = m.maxHp;
          c.down = false;
          c.foe = m.foe || c.foe;
        }
        const handle = c?.name || m.login;
        // A fresh foe stands across from the respawned chatter → "!" aggro.
        foeAlertAnim.set(m.login, nowMs() + FOE_ALERT_MS);
        const respawnTarget = FOES_ONLY ? "foe" : "hero";
        pushFlavorPopup(m.login, `@${handle} RISE`, "#bbf7d0", { target: respawnTarget });
        // Back on their feet — a fresh redeploy line.
        barks.sayFor(m.login, "deploy", { force: true });
        break;
      }
      case "raidStart":
        applyRaidStart(m);
        break;
      case "raidUpdate":
        if (raid) {
          raid.hp = m.hp;
          raid.maxHp = m.maxHp;
          raid.contributors = m.contributors || 0;
          // Inc1: poise / stagger / enrage
          if (m.poise != null) raid.poise = m.poise;
          if (m.maxPoise != null) raid.maxPoise = m.maxPoise;
          if (m.staggered != null)
            raid.staggeredUntil = m.staggered
              ? raid.staggeredUntil || nowMs() + STAGGER_DISPLAY_MS
              : 0;
          if (m.enrageAt != null) raid.enrageAt = m.enrageAt;
        }
        break;
      case "stagger":
        // Server broadcasts {t:"stagger", until} when poise hits 0.
        if (raid) {
          raid.poise = 0;
          raid.staggeredUntil = m.until || nowMs() + STAGGER_DISPLAY_MS;
        }
        // Extra boss shake on stagger.
        bossFx.shakeUntil = nowMs() + 600;
        bossFx.shakeAmp = 20;
        bossFx.flashUntil = nowMs() + 300;
        break;
      case "raidHit": {
        if (raid) {
          raid.hp = m.hp;
          raid.maxHp = m.maxHp;
          raid.contributors = m.contributors || raid.contributors;
          // Inc1: keep poise in sync from hit frames too.
          if (m.poise != null) raid.poise = m.poise;
          if (m.maxPoise != null) raid.maxPoise = m.maxPoise;
          if (m.staggeredUntil != null) raid.staggeredUntil = m.staggeredUntil;
          if (m.enrageAt != null) raid.enrageAt = m.enrageAt;
        }
        // Boss reaction — flash + shake on every chip so the overlay reads
        // as live combat, not a static HP bar.
        bossFx.flashUntil = nowMs() + 110;
        bossFx.shakeUntil = nowMs() + 240;
        bossFx.shakeAmp = 10;
        // D2 melee dash — swing window lengthened to MELEE_SWING_MS.
        if (m.login) swingAnim.set(m.login, nowMs() + MELEE_SWING_MS);
        // Boss-anchored damage number — floats up off the boss sprite,
        // clearly readable as "the boss taking a hit". Scatter x slightly
        // so stacked numbers don't perfectly overlap.
        if (m.dmg && !barMode) {
          const scatter = ((m.dmg * 137) % 120) - 60; // deterministic scatter
          // Popup at boss upper-chest so it floats upward into clear space
          const bossChestY = BOSS_GROUND_Y - 64 * BOSS_SCALE * 0.7;
          spawnBossPopup(BOSS_ANCHOR_X + scatter, bossChestY, m.dmg, !!m.crit);
        }
        break;
      }
      case "raidCombo": {
        // Project Ascendant Inc3 — cross-fighter combo flash.
        // Minimal: a brief flavour popup anchored to the boss + a stronger shake.
        // Bar-mode guard: skip heavy visual in the compact bar widget.
        if (raid) {
          raid.hp = m.hp ?? raid.hp;
          raid.maxHp = m.maxHp ?? raid.maxHp;
        }
        // Extra boss shake — combos hit harder visually.
        bossFx.flashUntil = nowMs() + 220;
        bossFx.shakeUntil = nowMs() + 380;
        bossFx.shakeAmp = 18;
        if (!barMode && m.label && m.trigger) {
          const comboColors = {
            SHATTER: "#93c5fd",
            ELECTROCUTE: "#fde047",
            STEAM: "#d1fae5",
            IGNITE: "#fb923c",
          };
          const col = comboColors[m.label] || "#fde68a";
          // Push directly into bossPopups so the combo name floats above the
          // boss in the elemental colour — same draw path as damage numbers,
          // just with custom text and a slightly longer TTL so it reads clearly.
          bossPopups.push({
            x: BOSS_ANCHOR_X,
            y: BOSS_GROUND_Y - 64 * BOSS_SCALE * 1.1,
            text: `${m.label}  @${m.trigger}`,
            color: col,
            born: nowMs(),
            ttl: 1800,
            big: true,
          });
        }
        break;
      }
      case "raidDefeated":
        raid = null;
        swingAnim.clear();
        break;
      default:
        break;
    }
  });

  ws.addEventListener("close", () => {
    connDot.classList.remove("online");
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 8000);
}

connect();
