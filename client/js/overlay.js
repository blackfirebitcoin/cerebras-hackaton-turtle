// SIGMA ABYSS — broadcast overlay logic.
//
// Render-only WS consumer for the OBS browser source. Subscribes to the
// same realtime stream as the playable client but never sends a `hello`
// — so it has no token, no save round-trip, and doesn't count as a
// player. Display priority is duel > raid > featured; whoever owns the
// arena right now wins the center stage.
//
// Frames it cares about:
//
//   t:'stats'          → leaderboard + player count
//   t:'feed'           → live feed row append
//   t:'featured'       → idle state: a chatter + their next foe
//   t:'bossSpawn'      → 6-second cinematic banner (also starts a raid)
//   t:'raidStart'      → co-op boss appears; render shared HP bar
//   t:'raidUpdate'     → periodic HP push (2.5s cadence)
//   t:'raidHit'        → +damage popup
//   t:'raidDefeated'   → boss dies → rewards screen for 6s → back to featured
//   t:'duelChallenge'  → ribbon at top: "X vs Y for N gold — !accept"
//   t:'duelStart'      → enter duel arena state
//   t:'duelTick'       → per-round HP update + crit flash
//   t:'duelEnd'        → winner banner, back to featured
//   t:'twitchAction'   → action flash (FIGHT / DELVE / etc) at center
//
// Reconnect is exponential-backoff, capped at 8s.

import { composeAvatar, composeEnemy, lpcReady } from "/avatar/lpc-avatar.js";
import { ZONES } from "/shared/zones.js";

const ZONE_NAME = Object.fromEntries(ZONES.map((z) => [z.id, z.name]));

// Inline SVG gear icons. The OBS browser source on Linux ships without a
// color-emoji font, so 🛡️ / ⚔️ render as tofu squares. SVG paths render
// pixel-identically on every host and read as armor/weapon at icon size.
const ARMOR_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" stroke="rgba(0,0,0,0.55)" stroke-width="1" stroke-linejoin="round" ' +
  'd="M12 2 L20 5 V12 C20 17 16 21 12 22 C8 21 4 17 4 12 V5 Z"/>' +
  '<path fill="rgba(255,255,255,0.18)" d="M12 4 L18 6 V12 C18 15.5 15 19 12 20 Z"/>' +
  "</svg>";
const SWORD_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" stroke="rgba(0,0,0,0.55)" stroke-width="1" stroke-linejoin="round" ' +
  'd="M20 2 L22 4 L10.5 15.5 L8.5 13.5 Z M9 14 L10 15 L5.5 19.5 L4 18 Z M3 19 L5 21 L3.5 22.5 L2 21 Z"/>' +
  "</svg>";

// Boss canvas render loop — runs whenever the raid card is showing so
// the LPC sprite animates ("walk" frames) and any pending hit-shake or
// hit-flash plays out. Kept self-contained: starts on raid open, stops
// when the card is hidden or replaced, so it never busy-loops in idle.
const bossSprite = {
  raf: 0,
  canvas: null,
  ctx: null,
  lpc: null,
  hue: 280,
  hitFlashUntil: 0,
  shakeUntil: 0,
  shakeAmp: 0,
};

function stopBossSprite() {
  if (bossSprite.raf) cancelAnimationFrame(bossSprite.raf);
  bossSprite.raf = 0;
  bossSprite.canvas = null;
  bossSprite.ctx = null;
  bossSprite.lpc = null;
}

function startBossSprite(canvas, lpc, hue) {
  if (bossSprite.raf) cancelAnimationFrame(bossSprite.raf);
  bossSprite.canvas = canvas;
  bossSprite.ctx = canvas.getContext("2d");
  bossSprite.lpc = lpc || null;
  bossSprite.hue = Number.isFinite(hue) ? hue : 280;
  const draw = (now) => {
    if (!bossSprite.canvas || !bossSprite.ctx) {
      bossSprite.raf = 0;
      return;
    }
    const w = bossSprite.canvas.width;
    const h = bossSprite.canvas.height;
    bossSprite.ctx.clearRect(0, 0, w, h);
    let shakeX = 0;
    let shakeY = 0;
    if (now < bossSprite.shakeUntil) {
      const amp = bossSprite.shakeAmp;
      shakeX = (Math.random() - 0.5) * amp;
      shakeY = (Math.random() - 0.5) * amp * 0.6;
    }
    // Shadow under the boss
    bossSprite.ctx.save();
    bossSprite.ctx.fillStyle = "rgba(0,0,0,0.45)";
    bossSprite.ctx.beginPath();
    bossSprite.ctx.ellipse(w / 2 + shakeX, h - 18, 40, 9, 0, 0, Math.PI * 2);
    bossSprite.ctx.fill();
    bossSprite.ctx.restore();
    const flash = now < bossSprite.hitFlashUntil;
    const ok =
      lpcReady() &&
      composeEnemy(
        bossSprite.ctx,
        w / 2 + shakeX,
        h - 20 + shakeY,
        bossSprite.lpc,
        "walk",
        now,
        2.6,
        flash,
        "left",
      );
    if (!ok) {
      // LPC sprite not ready / no build — paint a colored slab as a
      // fallback so the raid card never looks blank.
      bossSprite.ctx.save();
      bossSprite.ctx.fillStyle = `hsl(${bossSprite.hue} 56% 48%)`;
      bossSprite.ctx.fillRect(w / 2 - 36 + shakeX, h - 110 + shakeY, 72, 92);
      bossSprite.ctx.restore();
    }
    bossSprite.raf = requestAnimationFrame(draw);
  };
  bossSprite.raf = requestAnimationFrame(draw);
}

function bossHitPulse() {
  const now = performance.now();
  bossSprite.hitFlashUntil = now + 110;
  bossSprite.shakeUntil = now + 280;
  bossSprite.shakeAmp = 6;
}

// ── Fit-to-viewport ────────────────────────────────────────────────
// The full /overlay route is authored at 1920×1080 and gets scaled to
// fit whatever OBS browser source size it's installed at. The compact
// /overlay/panel route is authored at native 720×420 and signals that
// via `<body data-panel="true">` — we skip the auto-fit there so fonts
// render at their authored size.
const IS_PANEL = document.body?.dataset && document.body.dataset.panel === "true";

function fitStage() {
  if (IS_PANEL) return;
  const stage = document.getElementById("stage");
  if (!stage) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const s = Math.min(vw / 1920, vh / 1080);
  const w = 1920 * s;
  const h = 1080 * s;
  stage.style.transform = `scale(${s})`;
  stage.style.left = `${(vw - w) / 2}px`;
  stage.style.top = `${(vh - h) / 2}px`;
}
if (!IS_PANEL) {
  window.addEventListener("resize", fitStage);
  window.addEventListener("load", fitStage);
  fitStage();
}

// Enemy presentation — tag → emoji. The LPC paperdoll is data on the
// wire (`m.nextEnemy.lpc`) but we render a chunky emoji icon here for
// instant readability at 1920×1080 in OBS.
const ENEMY_EMOJI = {
  runt: "👹",
  thief: "🥷",
  bones: "💀",
  hexer: "🧙‍♂️",
  imp: "😈",
  rider: "🏍️",
  knight: "⚔️",
  crawler: "🦂",
  wolf: "🐺",
  boar: "🐗",
  bandit: "🥷",
  troll: "🧌",
  trickster: "🎭",
  colossus: "💀",
  champion: "🔥",
  hunter: "🏹",
  ogre: "👺",
  werewolf: "🐺",
  king: "👑",
  druid: "🌿",
  centurion: "🤖",
  tyrant: "☠️",
  sigma: "🌑",
};
const enemyEmoji = (tag) => ENEMY_EMOJI[tag] || "👁️";

const $ = (id) => document.getElementById(id);
const els = {
  players: $("players-count"),
  leaderboard: $("leaderboard"),
  arena: $("arena"),
  feature: $("featured-card"),
  feed: $("feed"),
  boss: $("boss-banner"),
  bossName: $("boss-name"),
  bossReason: $("boss-reason"),
  bossHpbar: $("boss-hpbar"),
  bossHpbarName: $("boss-hpbar-name"),
  bossHpbarMeta: $("boss-hpbar-meta"),
  bossHpbarFill: $("boss-hpbar-fill"),
  bossHpbarValue: $("boss-hpbar-value"),
  conn: $("conn-dot"),
};

let bossHpbarShakeTimer = 0;
function showBossHpbar(name) {
  if (!els.bossHpbar) return;
  els.bossHpbar.classList.remove("hidden");
  if (name && els.bossHpbarName) els.bossHpbarName.textContent = String(name).toUpperCase();
}
function hideBossHpbar() {
  if (!els.bossHpbar) return;
  els.bossHpbar.classList.add("hidden");
}
function updateBossHpbar(r) {
  if (!els.bossHpbar || !r) return;
  if (els.bossHpbarName) els.bossHpbarName.textContent = String(r.name || "Boss").toUpperCase();
  const pct = Math.max(0, Math.min(100, (r.hp / Math.max(1, r.maxHp)) * 100));
  if (els.bossHpbarFill) els.bossHpbarFill.style.width = `${pct.toFixed(1)}%`;
  if (els.bossHpbarValue) {
    els.bossHpbarValue.textContent =
      fmtNum(Math.max(0, Math.round(r.hp))) +
      " / " +
      fmtNum(r.maxHp) +
      " · " +
      pct.toFixed(0) +
      "%";
  }
  if (els.bossHpbarMeta) {
    const c = r.contributors || 0;
    els.bossHpbarMeta.textContent = c
      ? c + (c === 1 ? " FIGHTER" : " FIGHTERS")
      : "!FIGHT TO ENGAGE";
  }
}
function pulseBossHpbar() {
  if (!els.bossHpbar) return;
  els.bossHpbar.classList.add("hit");
  clearTimeout(bossHpbarShakeTimer);
  bossHpbarShakeTimer = setTimeout(() => {
    els.bossHpbar?.classList.remove("hit");
  }, 240);
}

const FEED_MAX = 14;
let feedList = null;

// ── Arena state machine — duel > raid > featured ────────────────
const state = {
  featured: null, // last featured payload
  raid: null, // active raid {boss_id, name, hp, maxHp, ...}
  duel: null, // active duel {loginA, loginB, a, b, wager, round}
  pendingChallenges: [],
};

function ensureFeedList() {
  if (feedList) return feedList;
  feedList = document.createElement("div");
  feedList.className = "feed-list";
  els.feed.appendChild(feedList);
  return feedList;
}

function fmtNum(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? 0);
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function escapeText(s) {
  return String(s ?? "").replace(
    /[<>&"]/g,
    (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[ch],
  );
}

function renderLeaderboard(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    els.leaderboard.innerHTML =
      '<span class="lb-row"><span class="lb-stat">leaderboard empty — be the first sigma</span></span>';
    return;
  }
  els.leaderboard.innerHTML = rows
    .slice(0, 6)
    .map((r, i) => {
      const lvl = r.level || 1;
      const k = r.kills || 0;
      return (
        `<span class="lb-row">` +
        `<span class="lb-rank">#${i + 1}</span>` +
        `<span class="lb-name">${escapeText(r.name)}</span>` +
        `<span class="lb-stat">L${lvl} · ${fmtNum(k)}k</span>` +
        `</span>`
      );
    })
    .join("");
}

function paintArena() {
  // Priority: duel > raid > featured > empty
  if (state.duel) {
    stopBossSprite();
    return renderDuel(state.duel);
  }
  if (state.raid && state.raid.hp > 0) return renderRaid(state.raid);
  // Anything else: tear down the boss sprite loop if it's still running
  stopBossSprite();
  if (state.featured) return renderFeatured(state.featured);
  renderEmpty();
}

function renderEmpty() {
  els.feature.classList.add("empty", "mode-empty");
  els.feature.classList.remove("mode-featured", "mode-raid", "mode-duel");
  els.feature.innerHTML =
    `<div class="featured-empty">` +
    `<span class="empty-pulse"></span>` +
    `waiting for chatter activity — type <span class="cmd">!fight</span> to deploy your sigma` +
    `</div>`;
}

function fighterCard(name, hp, maxHp, accent, emoji, sub) {
  const pct = Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100));
  return (
    `<div class="fighter fighter-${accent}">` +
    `<div class="fighter-emoji">${emoji}</div>` +
    `<div class="fighter-name">${escapeText(name)}</div>` +
    (sub ? `<div class="fighter-sub">${escapeText(sub)}</div>` : "") +
    `<div class="fighter-hp">` +
    `<div class="fighter-hp-bar"><div class="fighter-hp-fill" style="width:${pct.toFixed(1)}%"></div></div>` +
    `<div class="fighter-hp-val">${fmtNum(Math.round(hp))} / ${fmtNum(maxHp)}</div>` +
    `</div>` +
    `</div>`
  );
}

function renderFeatured(f) {
  els.feature.className = "featured-card mode-featured";
  const zoneName = ZONE_NAME[f.zone] || f.zoneName || "Unknown";
  const titleLine = f.title ? `<div class="fc-title-badge">${escapeText(f.title)}</div>` : "";
  const loginLine = f.login ? `<span class="fc-login">${escapeText(f.login)}</span>` : "";
  const wpn = f.weapon || { name: "Bare Fists", rarity: "common", starter: true };
  const arm = f.armor;
  const armPart = arm
    ? `<span class="gear-slot armor">${ARMOR_SVG}</span><span class="gear-name gear-${escapeText(arm.rarity || "common")}">${escapeText(arm.name)}</span>`
    : `<span class="gear-slot armor">${ARMOR_SVG}</span><span class="gear-name gear-empty">no armor</span>`;
  const weaponLine =
    `<div class="fc-gear-row">` +
    `<span class="gear-slot">${SWORD_SVG}</span>` +
    `<span class="gear-name gear-${escapeText(wpn.rarity || "common")}">${escapeText(wpn.name)}</span>` +
    (wpn.starter ? `<span class="gear-tag">starter</span>` : "") +
    armPart +
    `</div>`;
  const hpPct = Math.min(100, Math.max(0, ((f.hp || 0) / Math.max(1, hpCap(f))) * 100));
  const enemy = f.nextEnemy;

  els.feature.innerHTML =
    `<div class="fc-header">` +
    `<div class="fc-title"><span class="label-accent">FEATURED</span> · NEXT ENCOUNTER</div>` +
    loginLine +
    `</div>` +
    `<div class="versus">` +
    `<div class="vs-side vs-sigma">` +
    `<div class="vs-tag">SIGMA</div>` +
    `<div class="fc-name">${escapeText(f.name)}</div>` +
    titleLine +
    `<div class="fc-zone">in <span class="zone-tag">${escapeText(zoneName)}</span> · depth ${f.depth || 0}</div>` +
    weaponLine +
    `<div class="fc-hp-row">` +
    `<span class="fc-hp-label">HP</span>` +
    `<div class="fc-hp-bar"><div class="fc-hp-fill" style="width:${hpPct.toFixed(1)}%"></div></div>` +
    `<span class="fc-hp-val">${fmtNum(f.hp || 0)}</span>` +
    `</div>` +
    `</div>` +
    `<div class="vs-divider">VS</div>` +
    `<div class="vs-side vs-enemy">` +
    (enemy
      ? `<div class="vs-tag enemy-kind-${escapeText(enemy.kind || "normal")}">${(enemy.kind || "NORMAL").toUpperCase()}</div>` +
        `<div class="enemy-emoji">${enemyEmoji(enemy.tag)}</div>` +
        `<div class="enemy-name">${escapeText(enemy.name)}</div>` +
        (enemy.special
          ? `<div class="enemy-special">${escapeText(enemy.special.toUpperCase())}</div>`
          : '<div class="enemy-special spacer">—</div>')
      : `<div class="vs-tag">QUIET ZONE</div>` +
        `<div class="enemy-emoji">🌫️</div>` +
        `<div class="enemy-name">No threats nearby</div>` +
        `<div class="enemy-special spacer">—</div>`) +
    `</div>` +
    `</div>` +
    `<div class="fc-stats-strip">` +
    statTile("level", "LEVEL", f.level || 1) +
    statTile("xp", "PRESTIGE", f.prestige || 0) +
    statTile("gold", "GOLD", fmtNum(f.gold || 0)) +
    statTile("", "DEPTH", f.depth || 0) +
    `</div>` +
    // Live XP bar — fills in real time as chat drives this sigma's real delve.
    `<div class="fc-xp-row">` +
    `<span class="fc-xp-label">XP</span>` +
    `<div class="fc-xp-bar"><div class="fc-xp-fill" style="width:${Math.max(0, Math.min(100, ((f.xp || 0) / Math.max(1, f.xpToNext || 1)) * 100)).toFixed(1)}%"></div></div>` +
    `<span class="fc-xp-val">${fmtNum(f.xp || 0)} / ${fmtNum(f.xpToNext || 0)}</span>` +
    `</div>` +
    `<div class="fc-footer">` +
    `<span class="tag">type <span class="cmd">!fight</span> to challenge</span>` +
    `<span class="tag"><span class="cmd">!duel @user</span> to challenge</span>` +
    `<span class="tag"><span class="cmd">!sigma</span> for stats</span>` +
    `</div>`;
}

function renderRaid(r) {
  els.feature.className = "featured-card mode-raid";
  const pct = Math.max(0, Math.min(100, (r.hp / Math.max(1, r.maxHp)) * 100));
  const top = (r.topContributors || []).slice(0, 5);
  const contribRows = top.length
    ? top
        .map(
          (c, i) =>
            `<div class="contrib-row">` +
            `<span class="contrib-rank">#${i + 1}</span>` +
            `<span class="contrib-name">${escapeText(c.login || "?")}</span>` +
            `<span class="contrib-dmg">${fmtNum(c.dmg)} dmg</span>` +
            `</div>`,
        )
        .join("")
    : `<div class="contrib-empty">first hit gets bonus loot — type <span class="cmd">!fight</span></div>`;

  els.feature.innerHTML =
    `<div class="fc-header">` +
    `<div class="fc-title raid-pulse"><span class="label-accent">RAID</span> · BOSS IN THE ABYSS</div>` +
    (r.reason
      ? `<span class="fc-login">${escapeText(r.reason)}${r.fromLogin ? ` · @${escapeText(r.fromLogin)}` : ""}</span>`
      : "") +
    `</div>` +
    `<div class="raid-arena">` +
    `<div class="raid-boss">` +
    `<canvas id="raid-boss-canvas" class="raid-boss-canvas" width="220" height="220"></canvas>` +
    `<div class="raid-boss-name">${escapeText(r.name)}</div>` +
    `<div class="raid-hpbar">` +
    `<div class="raid-hpfill" style="width:${pct.toFixed(1)}%"></div>` +
    `<div class="raid-hpval">${fmtNum(Math.round(r.hp))} / ${fmtNum(r.maxHp)} · ${pct.toFixed(0)}%</div>` +
    `</div>` +
    `</div>` +
    `<div class="raid-side">` +
    `<div class="raid-side-title">TOP FIGHTERS · ${r.contributors || 0} engaged</div>` +
    `<div class="contrib-list">${contribRows}</div>` +
    `</div>` +
    `</div>` +
    `<div class="fc-footer raid-cta">` +
    `<span class="tag big">⚔️ type <span class="cmd">!fight</span> to engage · chat to swing · <span class="cmd">!run</span> to flee</span>` +
    `<span class="tag">last hit gets bonus loot</span>` +
    `</div>`;

  const canvas = els.feature.querySelector("#raid-boss-canvas");
  if (canvas) startBossSprite(canvas, r.lpc, r.hue);
}

function updateRaidHpInPlace(r) {
  const fill = els.feature.querySelector(".raid-hpfill");
  const val = els.feature.querySelector(".raid-hpval");
  if (!fill || !val) return;
  const pct = Math.max(0, Math.min(100, (r.hp / Math.max(1, r.maxHp)) * 100));
  fill.style.width = `${pct.toFixed(1)}%`;
  val.textContent = `${fmtNum(Math.round(r.hp))} / ${fmtNum(r.maxHp)} · ${pct.toFixed(0)}%`;
}

function _bossTagFromId(id) {
  // Best-effort mapping from boss_id → tag for emoji selection
  const map = {
    goblin_king: "king",
    hollow_druid: "druid",
    chrome_centurion: "centurion",
    catacomb_tyrant: "tyrant",
    hollow_sigma: "sigma",
  };
  return map[id] || "king";
}

function renderDuel(d) {
  els.feature.className = "featured-card mode-duel";
  els.feature.innerHTML =
    `<div class="fc-header">` +
    `<div class="fc-title duel-pulse"><span class="label-accent">DUEL ARENA</span> · ROUND ${d.round || 0}</div>` +
    `<span class="fc-login">⚔️ combat</span>` +
    `</div>` +
    `<div class="duel-stage">` +
    fighterCard(`${d.a.name} (@${d.loginA})`, d.a.hp, d.a.maxHp, "blue", "⚔️", null) +
    `<div class="duel-vs"><div class="duel-vs-text">VS</div></div>` +
    fighterCard(`${d.b.name} (@${d.loginB})`, d.b.hp, d.b.maxHp, "red", "🗡️", null) +
    `</div>` +
    `<div class="fc-footer duel-cta">` +
    `<span class="tag big">last fighter standing wins</span>` +
    `</div>`;
}

function hpCap(f) {
  return 26 + (f.level || 1) * 7 + (f.depth || 0) * 4;
}

function statTile(kind, label, value) {
  return (
    `<div class="stat-tile ${kind}">` +
    `<span class="stat-label">${label}</span>` +
    `<span class="stat-value">${escapeText(value)}</span>` +
    `</div>`
  );
}

function pushFeed(entry) {
  if (!entry || typeof entry !== "object") return;
  const list = ensureFeedList();
  const row = document.createElement("div");
  row.className = `feed-row kind-${entry.kind || "misc"}`;
  row.innerHTML = formatFeed(entry);
  list.insertBefore(row, list.firstChild);
  while (list.children.length > FEED_MAX) list.removeChild(list.lastChild);
}

function formatFeed(e) {
  const who = (s) => `<span class="who">${escapeText(s)}</span>`;
  const what = (s) => `<span class="what">${escapeText(s)}</span>`;
  switch (e.kind) {
    case "death":
      return `${who(e.name || "A sigma")} ${what(`fell to ${e.killedBy || "the abyss"}`)}`;
    case "legendary":
      return `${who(e.name || "A sigma")} ${what(`found ${e.item || "a legendary"}`)}`;
    case "boss":
      return e.reason === "defeated"
        ? `${who(e.name || "A boss")} ${what(`defeated by ${e.contributors || 0} fighters`)}`
        : `${who(e.name || "A boss")} ${what(`rose — ${e.reason || "event"}`)}`;
    case "ascend":
      return `${who(e.name || "A sigma")} ${what(`ascended — prestige ${e.prestige || ""}`)}`;
    case "milestone":
      return `${who(e.name || "A sigma")} ${what(e.label || "hit a milestone")}`;
    case "twitch_redemption":
      return `${who(`@${e.login || "?"}`)} ${what((e.action || "").toUpperCase())}`;
    case "duel_end":
      return `${who(`@${e.winner || "?"}`)} ${what(`won the duel vs @${e.loser || "?"}`)}`;
    default:
      return what(e.label || e.kind || "event");
  }
}

function showBoss(b) {
  els.bossName.textContent = String(b.name || "Boss").toUpperCase();
  const reasonText =
    b.reason === "raid" && b.fromLogin ? `raid from @${b.fromLogin}` : b.reason || "";
  els.bossReason.textContent = reasonText;
  els.boss.classList.remove("hidden");
  void els.boss.offsetWidth;
  els.boss.style.opacity = "1";
  clearTimeout(showBoss._t);
  showBoss._t = setTimeout(() => {
    els.boss.classList.add("hidden");
  }, 5500);
}

function flashAction(kind, login) {
  const el = document.createElement("div");
  el.className = "action-flash";
  el.textContent = `${(kind || "").toUpperCase()} · @${login || "?"}`;
  els.arena.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function flashRaidHit(login, dmg) {
  const el = document.createElement("div");
  el.className = "raid-hit-flash";
  el.textContent = `−${fmtNum(dmg)}  @${login}`;
  els.arena.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

function flashDuelHit(side, dmg, crit) {
  const el = document.createElement("div");
  el.className = `duel-hit-flash duel-hit-${side} ${crit ? "crit" : ""}`;
  el.textContent = `−${fmtNum(dmg)}${crit ? " CRIT!" : ""}`;
  els.arena.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function showResult(text, sub, ms = 6000, kind = "") {
  // Only one result banner at a time — a fresh big moment replaces a stale one
  // so rapid level-ups / deaths across many chatters never stack up z-indexed.
  for (const old of els.arena.querySelectorAll(".result-banner")) old.remove();
  const el = document.createElement("div");
  el.className = `result-banner${kind ? ` result-${kind}` : ""}`;
  el.innerHTML = `<div class="result-title">${escapeText(text)}</div>${sub ? `<div class="result-sub">${escapeText(sub)}</div>` : ""}`;
  els.arena.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── Navi distress-call hologram — the new-player CTA ─────────────
// On t:'naviCall' we raise a flickering cyan Navi in a light cone and type
// in her plea by name, then auto-dismiss. New chatters can arrive in a burst,
// so calls QUEUE (FIFO, one at a time) — each newcomer gets their own moment
// instead of stomping the last. The figure is composeAvatar() tinted cyan;
// that call always paints SOMETHING (LPC when ready, else a procedural
// figure), so the projection is never blank during the asset boot race.
const naviEls = {
  root: $("navi-call"),
  holo: $("nc-holo"),
  tag: $("nc-tag"),
  line: $("nc-line"),
  sub: $("nc-sub"),
  cta: $("nc-cta"),
};
const naviQueue = [];
let naviBusy = false;
let naviRaf = 0;
let naviTypeTimer = 0;
let naviHoldTimer = 0;

const NAVI_HOLD_MS = 8600; // time on screen before the flicker-out
const NAVI_TYPE_MS = 34; // per-character type-on for the dramatic line

function enqueueNaviCall(m) {
  if (!naviEls.root || !naviEls.holo) return;
  if (naviQueue.length >= 6) naviQueue.shift(); // bound a new-chatter flood
  naviQueue.push(m);
  if (!naviBusy) playNextNaviCall();
}

function playNextNaviCall() {
  const m = naviQueue.shift();
  if (!m) {
    naviBusy = false;
    return;
  }
  naviBusy = true;
  const root = naviEls.root;

  naviEls.tag.textContent = m.tag || "INCOMING TRANSMISSION";
  naviEls.sub.textContent = m.sub || "";
  naviEls.cta.textContent = m.cta || "▸ chat anything to answer the call";

  // Type the dramatic line in behind a blinking caret.
  const line = String(m.line || "");
  naviEls.line.innerHTML = '<span class="nc-typed"></span><span class="nc-caret">▍</span>';
  const typed = naviEls.line.querySelector(".nc-typed");
  let i = 0;
  clearInterval(naviTypeTimer);
  naviTypeTimer = setInterval(() => {
    i += 1;
    typed.textContent = line.slice(0, i);
    if (i >= line.length) clearInterval(naviTypeTimer);
  }, NAVI_TYPE_MS);

  // Show + glitch-in (restart the CSS animation).
  root.classList.remove("hidden", "outro");
  void root.offsetWidth;
  root.classList.add("intro");
  startNaviHolo(m);

  // Hold → flicker out → hide → advance the queue after a short gap.
  clearTimeout(naviHoldTimer);
  naviHoldTimer = setTimeout(() => {
    root.classList.remove("intro");
    root.classList.add("outro");
    setTimeout(() => {
      root.classList.add("hidden");
      stopNaviHolo();
      setTimeout(playNextNaviCall, 400);
    }, 820);
  }, NAVI_HOLD_MS);
}

function startNaviHolo(m) {
  const canvas = naviEls.holo;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const pet = { seed: m.seed || 70010, cosmetics: m.cosmetics || {} };
  if (naviRaf) cancelAnimationFrame(naviRaf);
  const draw = (now) => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    composeAvatar(ctx, w / 2, h - 18, pet, now, 4.0);
    // Tint every drawn pixel hologram-cyan (source-atop masks to the figure).
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const g = ctx.createLinearGradient(0, h * 0.08, 0, h);
    g.addColorStop(0, "rgba(186,250,255,0.62)");
    g.addColorStop(1, "rgba(64,196,255,0.82)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Travelling scanlines across the figure.
    ctx.fillStyle = "rgba(2,22,32,0.34)";
    const off = Math.floor(now / 55) % 3;
    for (let y = off; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    ctx.restore();
    naviRaf = requestAnimationFrame(draw);
  };
  naviRaf = requestAnimationFrame(draw);
}

function stopNaviHolo() {
  if (naviRaf) cancelAnimationFrame(naviRaf);
  naviRaf = 0;
  clearInterval(naviTypeTimer);
}

// ── Navi speech toast — the onboarding rite ──────────────────────
// t:'naviSay' carries Navi's question/ack lines as chat answers !os / !found /
// !agent. Queued like the hologram so a fast triple-answer reads cleanly.
const naviSayEls = { root: $("navi-say"), text: $("ns-text"), prog: $("ns-progress") };
const naviSayQueue = [];
let naviSayBusy = false;
let naviSayTimer = 0;
const NAVI_SAY_MS = 6000;

function enqueueNaviSay(m) {
  if (!naviSayEls.root) return;
  if (naviSayQueue.length >= 6) naviSayQueue.shift();
  naviSayQueue.push(m);
  if (!naviSayBusy) playNextNaviSay();
}

function playNextNaviSay() {
  const m = naviSayQueue.shift();
  if (!m) {
    naviSayBusy = false;
    return;
  }
  naviSayBusy = true;
  const root = naviSayEls.root;
  naviSayEls.text.textContent = m.text || "";
  const total = m.total || 3;
  const prog = Math.max(0, Math.min(total, m.progress || 0));
  let dots = "";
  for (let i = 0; i < total; i += 1) dots += i < prog ? "●" : "○";
  naviSayEls.prog.textContent = m.done
    ? `✦ rite complete   ${dots}`
    : `trial ${prog}/${total}   ${dots}`;
  root.classList.toggle("done", !!m.done);
  root.classList.toggle("warn", m.ok === false);
  root.classList.remove("hidden");
  void root.offsetWidth;
  root.classList.add("in");
  clearTimeout(naviSayTimer);
  naviSayTimer = setTimeout(() => {
    root.classList.remove("in");
    setTimeout(() => {
      root.classList.add("hidden");
      setTimeout(playNextNaviSay, 250);
    }, 420);
  }, NAVI_SAY_MS);
}

// ── Dynamic storyteller beat ─────────────────────────────────────
// t:'storyBeat' — phase 'beat' raises the narration ribbon with the !vote
// options (the live tally lives in the world panel); phase 'resolved' flashes
// the crowd's winning choice as a brief center banner.
const storyEls = {
  root: $("story-ribbon"),
  tag: $("sr-tag"),
  text: $("sr-text"),
  vote: $("sr-vote"),
};
let storyTimer = 0;

function showStoryBeat(m) {
  if (m.phase === "resolved") {
    showResult(`🗳 ${m.winner || "The crowd decides"}`, m.text || "", 4200, "story");
    return;
  }
  if (!storyEls.root || !storyEls.text || !storyEls.vote) return;
  storyEls.text.textContent = m.text || "";
  const opts = Array.isArray(m.options) ? m.options : [];
  storyEls.vote.innerHTML = opts
    .map((o) => `<span class="sr-opt">!vote ${escapeText(o.id)}</span>`)
    .join("");
  storyEls.root.classList.remove("hidden");
  void storyEls.root.offsetWidth;
  storyEls.root.classList.add("in");
  clearTimeout(storyTimer);
  storyTimer = setTimeout(() => {
    storyEls.root.classList.remove("in");
    setTimeout(() => storyEls.root.classList.add("hidden"), 500);
  }, 16000);
}

// ── WS plumbing ──────────────────────────────────────────────────
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
    els.conn.classList.remove("offline");
    els.conn.classList.add("online");
  });
  ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    // One malformed or unexpected frame must never throw out of the switch and
    // kill the entire onmessage loop (which would freeze the live overlay).
    try {
      switch (m.t) {
        case "stats":
          if (typeof m.players === "number") els.players.textContent = String(m.players);
          if (Array.isArray(m.leaderboard)) renderLeaderboard(m.leaderboard);
          break;
        case "feed":
          if (m.entry) pushFeed(m.entry);
          break;
        case "featured":
          state.featured = m;
          // If we have an active raid we drop the featured frame on the floor —
          // the painter prioritizes raid over featured.
          if (m.raid) {
            state.raid = { ...m.raid };
            showBossHpbar(m.raid.name);
            updateBossHpbar(state.raid);
          }
          paintArena();
          break;
        case "bossSpawn":
          showBoss(m);
          break;
        case "raidStart":
          state.raid = {
            boss_id: m.boss_id,
            name: m.name,
            hue: m.hue,
            lpc: m.lpc,
            hp: m.hp,
            maxHp: m.maxHp,
            contributors: 0,
            topContributors: [],
            reason: m.reason,
            fromLogin: m.fromLogin,
          };
          showBossHpbar(m.name);
          updateBossHpbar(state.raid);
          paintArena();
          break;
        case "raidUpdate":
          if (state.raid) {
            state.raid.hp = m.hp;
            state.raid.maxHp = m.maxHp;
            state.raid.contributors = m.contributors || 0;
            state.raid.topContributors = m.topContributors || [];
            // Refresh in-place if showing the raid
            if (els.feature.classList.contains("mode-raid")) renderRaid(state.raid);
            updateBossHpbar(state.raid);
          }
          break;
        case "raidHit":
          if (state.raid) {
            state.raid.hp = m.hp;
            state.raid.maxHp = m.maxHp;
            state.raid.contributors = m.contributors || state.raid.contributors;
            // Re-render only on command swings so the canvas isn't torn
            // down every 200ms during a noisy chat-driven flurry.
            if (els.feature.classList.contains("mode-raid")) {
              if (m.source === "command") {
                renderRaid(state.raid);
              } else {
                // Cheap in-place update: rewrite HP bar text + width without
                // throwing away the canvas (which would restart the loop).
                updateRaidHpInPlace(state.raid);
              }
            }
            updateBossHpbar(state.raid);
          }
          flashRaidHit(m.login, m.dmg);
          bossHitPulse();
          pulseBossHpbar();
          break;
        case "raidDefeated": {
          const name = state.raid?.name || m.name || "The boss";
          state.raid = null;
          hideBossHpbar();
          let sub;
          if (!m.victory) {
            sub = "escaped — too few fighters";
          } else if (m.drop?.item) {
            sub = `@${m.killer || "?"} — drops ${m.drop.item.rarity.toUpperCase()} ${m.drop.item.name}`;
          } else {
            sub = `slain by @${m.killer || "?"}`;
          }
          showResult(
            m.victory ? `${name.toUpperCase()} DEFEATED` : `${name.toUpperCase()} ESCAPED`,
            sub,
          );
          paintArena();
          break;
        }
        case "duelChallenge":
          // Add to pending; banner is shown by the topbar elsewhere
          state.pendingChallenges.unshift({
            challenger: m.challenger,
            defender: m.defender,
            wager: m.wager,
            at: m.at,
          });
          state.pendingChallenges = state.pendingChallenges.slice(0, 6);
          pushFeed({
            kind: "duel_challenge",
            label: `⚔️ @${m.challenger} challenged @${m.defender} · !accept`,
          });
          break;
        case "duelStart":
          state.duel = {
            loginA: m.loginA,
            loginB: m.loginB,
            wager: m.wager,
            round: 0,
            a: { name: m.a.name, hp: m.a.hp, maxHp: m.a.maxHp },
            b: { name: m.b.name, hp: m.b.hp, maxHp: m.b.maxHp },
          };
          paintArena();
          break;
        case "duelTick":
          if (state.duel) {
            state.duel.round = m.round;
            if (typeof m.a?.hp === "number") state.duel.a.hp = m.a.hp;
            if (typeof m.b?.hp === "number") state.duel.b.hp = m.b.hp;
            renderDuel(state.duel);
            if (m.b?.dmg) flashDuelHit("right", m.b.dmg, !!m.b.crit);
            if (m.a?.dmg) flashDuelHit("left", m.a.dmg, !!m.a.crit);
          }
          break;
        case "duelEnd": {
          const _d = state.duel;
          state.duel = null;
          showResult(`@${m.winner} WINS`, `last fighter standing vs @${m.loser}`);
          paintArena();
          break;
        }
        case "duelDeclined":
          pushFeed({ kind: "duel_decline", label: `@${m.defender} declined @${m.challenger}` });
          break;
        case "duelExpired":
          pushFeed({ kind: "duel_expired", label: `challenge from @${m.challenger} expired` });
          break;
        case "twitchAction":
          flashAction(m.kind, m.login);
          break;
        case "naviCall":
          enqueueNaviCall(m);
          break;
        case "naviSay":
          enqueueNaviSay(m);
          break;
        case "storyBeat":
          showStoryBeat(m);
          break;
        case "levelUp":
          // Celebrate the FEATURED chatter's level-up on the card. Gated to the
          // one on camera so 64 chatters can't flood the banner — everyone else
          // still gets a milestone feed row from the server, so nothing is lost.
          if (m.login && state.featured && m.login === state.featured.login) {
            showResult(
              `@${m.login} — LEVEL ${m.level}`,
              "the abyss makes them stronger",
              2600,
              "levelup",
            );
          }
          break;
        case "delveDeath":
          // Death cinematic — only for a notable run so low-level deaths don't
          // interrupt. The feed always carries the death row regardless.
          if ((m.level || 0) >= 8 || (m.depth || 0) >= 6) {
            showResult(
              `@${m.login} FELL`,
              `${m.deathBy ? `slain by ${m.deathBy}` : "lost to the abyss"} · Lv ${m.level || "?"}, depth ${m.depth || 0} · +${m.prestigeGained || 0} prestige`,
              4200,
              "death",
            );
          }
          break;
        default:
          break;
      }
    } catch (err) {
      console.error("overlay: frame handler error", m?.t, err);
    }
  });
  ws.addEventListener("close", () => {
    els.conn.classList.remove("online");
    els.conn.classList.add("offline");
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

// ── Persistent-world panel (factions / crisis / treasury / vote) ──────
// Additive (invariant 9): self-injects its DOM + styles into the stage and
// polls the read-only world snapshots — never touches the arena/WS pipeline.
// Surfaces the M1–M8 living world on stream: faction standings + territory,
// the active world crisis + its chat-resolve progress, the treasury, and any
// open chat vote (so viewers can see what to !vote / !pray / !fight for).
const WORLD_POLL_MS = 8000;
let worldPanelEl = null;

function ensureWorldPanel() {
  if (worldPanelEl) return worldPanelEl;
  if (!document.getElementById("world-panel-style")) {
    const style = document.createElement("style");
    style.id = "world-panel-style";
    style.textContent = `
      #world-panel{position:absolute;left:18px;bottom:18px;width:340px;z-index:40;
        font-family:ui-monospace,Menlo,Consolas,monospace;color:#e8eef6;
        background:linear-gradient(180deg,rgba(10,14,22,.86),rgba(10,14,22,.72));
        border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:12px 14px;
        backdrop-filter:blur(6px);box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:13px;line-height:1.4}
      #world-panel h4{margin:0 0 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8aa0b8;font-weight:700}
      #world-panel .wp-fac{display:flex;align-items:center;gap:7px;margin:2px 0}
      #world-panel .wp-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}
      #world-panel .wp-fname{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #world-panel .wp-fstat{color:#9fb3c8;font-size:11px}
      #world-panel .wp-crown{color:#ffd75e}
      #world-panel .wp-crisis{margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}
      #world-panel .wp-crisis-name{color:#ff7a8a;font-weight:700}
      #world-panel .wp-bar{height:6px;border-radius:4px;background:rgba(255,255,255,.10);margin-top:4px;overflow:hidden}
      #world-panel .wp-bar > i{display:block;height:100%;background:linear-gradient(90deg,#ff4d6d,#ffb347)}
      #world-panel .wp-vote{margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}
      #world-panel .wp-vote-opt{color:#7ee0a8}
      #world-panel .wp-meta{margin-top:8px;color:#8aa0b8;font-size:11px;display:flex;justify-content:space-between}
      #world-panel .wp-mode{color:#ffb347;font-weight:700}
    `;
    document.head.appendChild(style);
  }
  worldPanelEl = document.createElement("div");
  worldPanelEl.id = "world-panel";
  (document.getElementById("stage") || document.body).appendChild(worldPanelEl);
  return worldPanelEl;
}

function renderWorldPanel(world, economy, vote) {
  const el = ensureWorldPanel();
  if (!world?.factions) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  // Faction standings — members + zones held (conquest).
  const held = {};
  for (const z of Object.values(world.zones || {})) {
    if (z.conquestOwner) held[z.conquestOwner] = (held[z.conquestOwner] || 0) + 1;
  }
  const facs = Object.values(world.factions)
    .sort((a, b) => (b.memberCount | 0) - (a.memberCount | 0))
    .map((f) => {
      const zones = held[f.id] ? ` <span class="wp-crown">⌖${held[f.id]}</span>` : "";
      return (
        `<div class="wp-fac"><span class="wp-dot" style="color:${f.color};background:${f.color}"></span>` +
        `<span class="wp-fname">${escapeText(f.name)}</span>` +
        `<span class="wp-fstat">${fmtNum(f.memberCount | 0)}♟${zones}</span></div>`
      );
    })
    .join("");

  let crisisHtml = "";
  const cr = world.activeCrisis;
  if (cr && cr.phase === "active") {
    const pct = Math.min(100, ((cr.total | 0) / Math.max(1, cr.target | 0)) * 100);
    crisisHtml =
      `<div class="wp-crisis"><span class="wp-crisis-name">⚠ ${escapeText(cr.name)}</span> ` +
      `<span class="wp-fstat">— !${escapeText(cr.contributeVerb)} to resolve (${fmtNum(cr.total | 0)}/${fmtNum(cr.target | 0)})</span>` +
      `<div class="wp-bar"><i style="width:${pct.toFixed(0)}%"></i></div></div>`;
  }

  let voteHtml = "";
  if (vote && Array.isArray(vote.options) && vote.options.length) {
    const opts = vote.options
      .map(
        (o) => `<span class="wp-vote-opt">!vote ${escapeText(o.id)}</span> ${fmtNum(o.votes | 0)}`,
      )
      .join(" · ");
    voteHtml = `<div class="wp-vote"><h4>Chat vote — steer the Abyss</h4>${opts}</div>`;
  }

  const treasury = economy ? economy.treasury | 0 : 0;
  const mode = economy?.treasuryMode ? ` <span class="wp-mode">· TREASURY MODE</span>` : "";
  el.innerHTML =
    `<h4>The Abyss — epoch ${fmtNum(world.epoch | 0)}</h4>${facs}${crisisHtml}${voteHtml}` +
    `<div class="wp-meta"><span>treasury ${fmtNum(treasury)}g${mode}</span><span>${fmtNum(world.graveCount | 0)} graves</span></div>`;
}

async function pollWorld() {
  try {
    const [world, economy, vote] = await Promise.all([
      fetch("/api/world")
        .then((r) => r.json())
        .catch(() => null),
      fetch("/api/economy")
        .then((r) => r.json())
        .catch(() => null),
      fetch("/api/vote")
        .then((r) => r.json())
        .catch(() => null),
    ]);
    renderWorldPanel(world, economy, vote?.vote);
  } catch {
    /* overlay stays resilient — a failed poll is a no-op */
  }
}

setInterval(pollWorld, WORLD_POLL_MS);
pollWorld();
