// SIGMA ABYSS — bootstrap.
//
// Wires the DOM, opens the socket, reconciles the local cache against
// the server's copy, runs offline progression for the time you were
// away, then hands control to game.js. The network is an enhancement —
// if the server never answers, the game still boots and runs on the
// local save (or a fresh sigma).

import { FEED_MAX } from "/shared/constants.js";
import { freshCharacter, simulateOffline } from "/shared/progression.js";
import * as game from "./game.js";
import * as net from "./net.js";
import * as save from "./save.js";
import * as ui from "./ui.js";

let booted = false;
let token = null;
let feed = [];

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0 || 1;
}

// Prefer whichever save was touched most recently — the local cache can
// be ahead of the server if the last few autosaves never made it up.
function pickCharacter(server, local) {
  if (server && local) {
    return (local.lastSeen || 0) > (server.lastSeen || 0) ? local : server;
  }
  return server || local || null;
}

function startGame(character, isFirstVisit) {
  const away = Date.now() - (character.lastSeen || Date.now());
  const report = simulateOffline(character, away);
  character.lastSeen = Date.now();
  ui.setViewerUrl(location.origin);
  game.boot(character, token);
  ui.bootDone();
  if (overlayMode) {
    // Stream-overlay mode: no modals, force-deploy out of town so the
    // wandering enemies have a zone roster to draw from. Recommended zone
    // is the toughest one the account has earned access to.
    game.autoDeployForOverlay();
  } else {
    if (report?.ran) ui.showOfflineReport(report);
    else if (isFirstVisit) ui.showHowTo();
  }
  game.saveNow();
}

// ── build DOM + first paint ───────────────────────────────────────────
ui.init(game.handlers);
ui.boot("waking the abyss…");

const local = save.loadLocal();
token = local?.token;

// Twitch claim — a chatter who redeemed a channel-point reward before
// visiting the URL can claim their server-minted sigma by appending
// `?twitch=<login>` to the URL. Bounded server-side; bad input is ignored.
function readTwitchClaim() {
  try {
    const u = new URL(location.href);
    const raw = (u.searchParams.get("twitch") || "").toLowerCase().trim();
    return /^[a-z0-9_]{1,32}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
const twitchClaim = readTwitchClaim();

// Stream-overlay mode (`?overlay=1`): for OBS browser-source use. No chrome,
// no HOW-TO modal, no offline report, no background fills — JUST the sigma
// + wandering monsters on a transparent canvas. Auto-deploys to the
// recommended zone on boot so monsters start chasing immediately.
function readOverlayMode() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get("overlay") === "1" || u.searchParams.get("overlay") === "true";
  } catch {
    return false;
  }
}
const overlayMode = readOverlayMode();
if (overlayMode) {
  document.body.classList.add("overlay-mode");
  game.setOverlayMode(true);
}

// ── connect ───────────────────────────────────────────────────────────
net.connect({
  onOpen() {
    ui.setConnection(true);
    ui.boot("reaching the abyss…");
    net.hello(token, null, twitchClaim);
  },
  onClose() {
    ui.setConnection(false);
  },
  onError() {
    /* non-fatal — validation bounces, rate limits, etc. */
  },

  onWelcome(msg) {
    token = msg.token || token;
    feed = (msg.feed || []).slice(0, FEED_MAX);
    ui.setFeed(feed);
    ui.setStats(msg.players, msg.leaderboard);

    if (!booted) {
      booted = true;
      const character =
        pickCharacter(msg.character, local?.character) || freshCharacter(randomSeed());
      startGame(character, !local);
    } else {
      // A reconnect — refresh the social bits, push our live state up.
      game.saveNow();
    }
  },

  onFeed(entry) {
    feed.unshift(entry);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    ui.setFeed(feed);
  },

  onStats(msg) {
    ui.setStats(msg.players, msg.leaderboard);
  },

  onSaved() {
    /* server ack — nothing to do */
  },

  // Twitch channel-point redemption broadcast. Every connected client sees
  // these; clients whose own token matches apply the in-game effect, others
  // just get the feed entry (which the server already pushed separately).
  onTwitchAction(msg) {
    if (!msg || msg.token !== token) return; // not our sigma — ignore
    if (typeof game.applyTwitchAction === "function") {
      try {
        game.applyTwitchAction(msg.kind, msg.params || {});
      } catch (e) {
        console.warn("[twitchAction] handler threw:", e?.message ?? e);
      }
    } else {
      console.info("[twitchAction] received", msg.kind, msg.params);
    }
  },
});

// ── offline-first fallback ────────────────────────────────────────────
// If the socket hasn't delivered a welcome shortly, boot anyway on local
// state. game.js keeps running; net.js keeps retrying in the background.
setTimeout(() => {
  if (booted) return;
  booted = true;
  ui.setConnection(false);
  const character = local?.character || freshCharacter(randomSeed());
  startGame(character, !local);
}, 3500);
