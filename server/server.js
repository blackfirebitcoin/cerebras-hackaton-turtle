// SIGMA ABYSS — HTTP + realtime entry point.
//
// The first-party router (./router.js) serves the client; /shared exposes
// the deterministic sim modules to the browser; the WebSocket layer rides
// the same HTTP server. Background work (disk flush, stats broadcast) runs
// under the supervisor so a throwing tick never takes the process down.
//
// Binds loopback by default — pair with `cloudflared` (npm run tunnel)
// to hand viewers a public URL without exposing the box to the LAN.

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AILMENTS, detectCombo, familyTrigger, weaponAilment } from "../shared/ailments.js";
import {
  DANGER_BOSS_AT,
  DANGER_ELITE_AT,
  DEFAULT_PORT,
  GEAR_SLOTS,
  INVENTORY_MAX,
  LEGACY_TICK_EVERY,
  STATS_BROADCAST_MS,
  STORE_FLUSH_MS,
  WORLD_TICK_BASE_MS,
} from "../shared/constants.js";
import { ENEMIES } from "../shared/enemies.js";
import { FACTION_IDS, factionById } from "../shared/factions.js";
import { forgeRaidDrop, itemPower } from "../shared/loot.js";
import { freshMarket } from "../shared/market.js";
import { passivePointsFor, passiveTreePayload } from "../shared/passive-tree.js";
import { projectSigmacraftSnapshot } from "../shared/sigmacraft.js";
import {
  ensureStarterGear,
  freshCharacter,
  gainXp,
  swapBuildSet,
  xpForLevel,
} from "../shared/progression.js";
import { ensureQuests } from "../shared/quests.js";
import { RESERVABLE_SKILLS } from "../shared/skills.js";
import { derive } from "../shared/stats.js";
import {
  activeEvolutions,
  gemSnapshot,
  VS_TUNABLES,
  WEAPON_IDS,
  weaponCatalogPayload,
} from "../shared/vampire-survivors.js";
import { unlockedArts, upgradeCost, WEAPON_PLUS_MAX } from "../shared/weapons.js";
import { ZONES } from "../shared/zones.js";
import { attachAgentRealm } from "./agent-realm.js";
import * as arena from "./arena.js";
import { refreshLastSeen } from "./arena.js";
import { dispatchCommand, factionRepView, joinFaction, resolveFactionId } from "./commands.js";
import * as drops from "./drops.js";
import { delveFeedback } from "./feedback.js";
import * as forge from "./forge.js";
import { equipFromInventory, liveDelve, loadoutInventory } from "./live-delve.js";
import * as market from "./market.js";
import { buildNaviCall } from "./navi-call.js";
import * as npcWorld from "./npc-world.js";
import { startOnboarding } from "./onboarding.js";
import { attachOracleBazaar } from "./oracle-bazaar.js";
import { attachPlayOnboard } from "./play-onboard.js";
import * as raidState from "./raid-state.js";
import { attachRealtime } from "./realtime.js";
import * as retention from "./retention.js";
import express from "./router.js";
import * as store from "./store.js";
import * as sigmacraft from "./sigmacraft.js";
import { attachNpcPlanner } from "./sigmacraft-npc-agents.js";
import { attachDirector } from "./sigmacraft-director.js";
import * as storytellerLoop from "./storyteller-loop.js";
import {
  guard,
  health,
  installGlobalGuards,
  installShutdown,
  onShutdown,
  superviseInterval,
} from "./supervisor.js";
import { vCharacter, vEnum, vSigmacraftIntent } from "./validate.js";
import * as voting from "./voting.js";
import {
  contributeToCrisis,
  freshWorld,
  injectWorldState,
  publicFactions,
  startWorldTick,
} from "./world-tick.js";

const TWITCH_ACTION_KINDS = new Set(["fight", "delve", "rest", "resurrect", "featured", "summon"]);

// Agent-session event spawner. Whitelist the kinds and the agents we
// recognize so a typo can't poke arbitrary state.
const SESSION_AGENT_KINDS = new Set([
  "claude-code",
  "cursor",
  "codex",
  "gemini",
  "copilot",
  "antigravity",
  "pi",
  "generic",
]);
const SESSION_FLAVORS = ["boss", "shower", "xp_burst"];
// Boss IDs we'll roll for session-spawned bosses — pick from the
// weaker boss pool so we don't drop hollow_sigma on every Claude
// Code session start (that one's reserved for real raids).
const SESSION_BOSS_POOL = ["goblin_king", "hollow_druid", "chrome_centurion"];

// Ambient pulse — periodic spawn driven by concurrent chatter count AND
// chat volume (so a single active chatter can climb out of xp_burst into
// the shower tiers without needing a crowd). Boss raid still requires a
// real crowd (`ARENA_PULSE_BOSS_AT` concurrent chatters); below that the
// tier is picked from a blended score:
//
//   baseScore  = chatters + recentPings / VOLUME_DIVISOR
//   liftimePin = log10(1 + lifetimePings / 50) capped — long-running
//                streams ramp gradually
//   momentum   = consecutive non-quiet pulses (0..MAX), each adds
//                MOMENTUM_FACTOR to the multiplier
//   score      = (baseScore + lifetimeBonus) * (1 + momentum * factor)
//
// Set ARENA_PULSE_MS=0 to disable.
const ARENA_PULSE_MS = Number.isFinite(Number(process.env.ARENA_PULSE_MS))
  ? Number(process.env.ARENA_PULSE_MS)
  : 30_000;
const ARENA_PULSE_BOSS_AT = Number(process.env.ARENA_PULSE_BOSS_AT) || 30;
const ARENA_PULSE_VOLUME_WINDOW_MS = Number(process.env.ARENA_PULSE_VOLUME_WINDOW_MS) || 60_000;
const ARENA_PULSE_VOLUME_DIVISOR = Number(process.env.ARENA_PULSE_VOLUME_DIVISOR) || 2;
const ARENA_PULSE_MOMENTUM_MAX = Number(process.env.ARENA_PULSE_MOMENTUM_MAX) || 5;
const ARENA_PULSE_MOMENTUM_FACTOR = Number(process.env.ARENA_PULSE_MOMENTUM_FACTOR) || 0.15;

// Sliding-window log of chat-ping timestamps. Each /api/chat-ping push
// records `now` here; `chatPingsInLast` answers the volume question
// without an external chat-volume signal. Coalesced bridge pings (one
// per 8s per login) under-represent burst volume but are good enough to
// distinguish "1 idle chatter" from "1 chatter actively spamming".
const chatPingLog = [];
let lifetimePings = 0;
let pulseMomentum = 0;

function recordChatPing() {
  const now = Date.now();
  chatPingLog.push(now);
  lifetimePings += 1;
  // Keep ~2x the window so the prune cost is amortized.
  const cutoff = now - ARENA_PULSE_VOLUME_WINDOW_MS * 2;
  while (chatPingLog.length && chatPingLog[0] < cutoff) chatPingLog.shift();
}

function chatPingsInLast(ms) {
  const cutoff = Date.now() - ms;
  let count = 0;
  for (let i = chatPingLog.length - 1; i >= 0; i -= 1) {
    if (chatPingLog[i] >= cutoff) count += 1;
    else break;
  }
  return count;
}

// Broadcast-mode tunables. The OBS overlay subscribes to these.
const FEATURED_ROTATE_MS = Number(process.env.FEATURED_ROTATE_MS) || 18_000;
const FEATURED_RECENT_MS = Number(process.env.FEATURED_RECENT_MS) || 10 * 60_000;
const MMO_HMAC_KEY = process.env.MMO_HMAC_KEY || "";

// Raid + duel tunables. Raid HP scales off the boss's normal mults so a
// hollow_sigma is genuinely a pile compared to a goblin_king.
const RAID_HP_MULT = Number(process.env.RAID_HP_MULT) || 14;
const RAID_TIMEOUT_MS = Number(process.env.RAID_TIMEOUT_MS) || 6 * 60_000;
// XP is paid PER HIT (see fireRaidSwing) — a landed swing banks
// round(monster.xp * <MULT> * dmg / maxHp) on the spot. Summed over a
// kill that's ≈ monster.xp * <MULT> no matter how many chatters split
// the monster, so XP is never stolen by whoever lands the last blow.
// Bosses use RAID_XP_MULT (goblin_king xp=9 … hollow_sigma xp=46);
// regular `!fight` monsters use the lighter MONSTER_XP_MULT.
const RAID_XP_MULT = Number(process.env.RAID_XP_MULT) || 60;
const MONSTER_XP_MULT = Number(process.env.MONSTER_XP_MULT) || 30;
// `!fight` monster hunt — HP for a regular (non-boss) shared monster.
// Scales off the same L20/depth5 baseline startRaid() uses but with a
// much lighter multiplier, so a small chat clears one in under a minute.
const MONSTER_HP_MULT = Number(process.env.MONSTER_HP_MULT) || 2;
const MONSTER_HP_FLOOR = Number(process.env.MONSTER_HP_FLOOR) || 120;
const DUEL_TIMEOUT_MS = Number(process.env.DUEL_TIMEOUT_MS) || 90_000;
const DUEL_MAX_ROUNDS = 16;
const DUEL_TICK_MS = 850;
const DUEL_MIN_WAGER = 10;
const DUEL_MAX_WAGER = 250_000;

// Project Ascendant — Boss Poise & Stagger (server-only, Math.random allowed here).
// Poise is drained by fighter swings; at 0 the boss staggers for STAGGER_MS:
//   - party swings deal +50% and are guaranteed crits
//   - boss does NOT counter-attack
// After stagger expires poise resets to maxPoise. Enrage doubles boss damage
// once Date.now() > raid.enrageAt.
//
// POISE_PER_SWING_BY_FAMILY: how much poise each weapon family drains per hit.
// High-poise-drain families: hammer, greatsword, axe. Low: dagger, wand.
const POISE_PER_SWING_BY_FAMILY = {
  hammer: 28,
  greatsword: 22,
  axe: 20,
  fists: 12,
  sword: 14,
  spear: 14,
  dagger: 7,
  bow: 10,
  staff: 8,
  wand: 7,
};
const STAGGER_MS = Number(process.env.RAID_STAGGER_MS) || 5_000;
const ENRAGE_MS = Number(process.env.RAID_ENRAGE_MS) || 4 * 60_000; // 4 min default
// Poise scales with boss HP so larger bosses need more sustained pressure.
const POISE_PER_HP = 0.08; // maxPoise = maxHp * POISE_PER_HP
const POISE_MIN = 60; // floor so tiny bosses still have meaningful poise

// D3 — autonomous boss attacks. The boss picks a live party member and
// deals periodic damage on a cadence independent of player swings.
// Damage scales off the boss def's attack stat at a reduced fraction so
// a small party isn't instantly wiped. Scale with 0 to disable.
const RAID_BOSS_ATTACK_MS = Number(process.env.RAID_BOSS_ATTACK_MS) || 5_000;
const RAID_BOSS_ATTACK_DMG_SCALE = Number(process.env.RAID_BOSS_ATTACK_DMG_SCALE) || 0.35;

// D5 — autonomous fighter attacks. Each engaged fighter swings once per
// tick at RAID_FIGHTER_ATTACK_MS cadence so boss HP drains with zero chat.
// Boss HP is also scaled by roster size at raid start (clamped) so a
// full auto-engaged crowd takes tens of seconds, not an instant melt.
const RAID_FIGHTER_ATTACK_MS = Number(process.env.RAID_FIGHTER_ATTACK_MS) || 2_500;
// Per-fighter HP contribution: each chatter in the arena adds this many
// times the baseline HP. Min 1 so a solo fight is still winnable.
const RAID_HP_PER_FIGHTER = Number(process.env.RAID_HP_PER_FIGHTER) || 0.18;

// D4 — autonomous boss spawn timer. A boss auto-appears on this cadence
// while the server is live, so small streams still get raid content.
// A minimum gap prevents back-to-back spawns if one finishes fast.
const RAID_AUTO_SPAWN_MS = Number(process.env.RAID_AUTO_SPAWN_MS) || 10 * 60_000;
const RAID_AUTO_SPAWN_COOLDOWN_MS = Number(process.env.RAID_AUTO_SPAWN_COOLDOWN_MS) || 3 * 60_000;
// C: Chat-activity gate — boss only appears when chat is active.
// RAID_REQUIRE_CHAT_MS: recent-chat window that must have ≥1 ping to START.
// RAID_QUIET_END_MS: silence window after which an active raid auto-ends.
// Hysteresis: start needs activity in 60s, end requires 120s of zero pings.
const RAID_REQUIRE_CHAT_MS = Number(process.env.RAID_REQUIRE_CHAT_MS) || 60_000;
const RAID_QUIET_END_MS = Number(process.env.RAID_QUIET_END_MS) || 120_000;
let lastRaidEndedAt = 0; // track when the last raid finished for cooldown

// Boss IDs we accept from external triggers. Anything else 400s.
const SPAWNABLE_BOSSES = new Set(
  Object.entries(ENEMIES)
    .filter(([, def]) => def.kind === "boss")
    .map(([id]) => id),
);

// `!fight` hunt pool — the regular monsters `!fight` seeks out when no
// raid/boss is already up, in rough easy→hard order so a run of !fights
// walks the bestiary instead of re-fighting one goblin. Bosses stay
// event-only (spawn-boss / agent-session). The cursor advances on every
// spawn so "seek out the next monster" is literal.
const FIGHT_MONSTER_POOL = [
  "goblin",
  "wolf",
  "skeleton",
  "bandit",
  "imp",
  "boar",
  "rogue_wizard",
  "cursed_biker",
  "troll",
  "corrupted_knight",
  "abyss_crawler",
  "werewolf",
];
let fightMonsterCursor = 0;

function hmacSign(body, key) {
  return crypto.createHmac("sha256", key).update(body).digest("hex");
}

function summarizeItem(it) {
  if (!it || typeof it !== "object") return null;
  const out = {
    name: String(it.name || "Item").slice(0, 60),
    base: String(it.base || "").slice(0, 24),
    rarity: String(it.rarity || "common"),
    power: Number(it.power) || 0,
    starter: !!it.starter,
  };
  if (it.slot === "weapon" || it.family) {
    out.family = it.family || null;
    out.plus = Number(it.plus) || 0;
  }
  return out;
}

// Loadout payload shared by GET /api/sigma/:login/loadout and the equip POST.
// `gear` mirrors the per-slot summarizeItem() shapes used by /api/sigma; the
// full run.inventory is projected to the equippable subset (items carrying a
// .slot), tagged with their array index so the client can POST it back to equip.
function loadoutPayload(character) {
  const run = character?.run || {};
  const gear = {};
  for (const slot of GEAR_SLOTS) gear[slot] = summarizeItem(run.gear?.[slot]);
  // loadoutInventory (live-delve.js) owns the equippable-subset projection so
  // the index strategy stays single-sourced with the equip swap.
  return { gear, inventory: loadoutInventory(run) };
}

function summarizeEnemy(id) {
  const def = ENEMIES[id];
  if (!def) return null;
  return {
    id,
    name: def.name,
    kind: def.kind,
    hue: def.hue,
    tag: def.tag,
    lpc: def.lpc || null,
    special: def.special || null,
  };
}

// Non-mutating preview of the next encounter the chatter would draw.
// Mirrors buildEncounter()'s decision tree at a high level but never
// touches the run's persisted RNG state — the playable client still
// owns the authoritative tick.
function peekNextEnemy(character) {
  const run = character?.run;
  if (!run) return null;
  const zone = ZONES.find((z) => z.id === run.zone);
  if (!zone || zone.safe) return null;

  if (run.danger >= DANGER_BOSS_AT && zone.boss) {
    return summarizeEnemy(zone.boss);
  }
  if (run._twitchEliteNext && zone.elites?.length) {
    return summarizeEnemy(zone.elites[Math.floor(Math.random() * zone.elites.length)]);
  }
  if (run.danger >= DANGER_ELITE_AT && zone.elites?.length && Math.random() < 0.32) {
    return summarizeEnemy(zone.elites[Math.floor(Math.random() * zone.elites.length)]);
  }
  if (!zone.enemies?.length) return null;
  return summarizeEnemy(zone.enemies[Math.floor(Math.random() * zone.enemies.length)]);
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function newTokenForTwitch() {
  return `sig_${crypto.randomBytes(12).toString("hex")}`;
}

// Mint or look up a sigma for a Twitch login. First-time chatters get a
// fresh permadeath-ready character minted with a deterministic seed so
// the same login always rerolls to the same starting build if data is wiped.
function resolveTwitchSigma(login) {
  const key = String(login).toLowerCase();
  let token = store.getTokenByTwitch(key);
  let isNew = false;
  if (!token) {
    token = newTokenForTwitch();
    const seed =
      crypto.createHash("sha1").update(`twitch:${key}`).digest().readUInt32BE(0) >>> 0 || 1;
    const character = freshCharacter(seed, key);
    character.lastSeen = Date.now();
    store.putPlayer(token, character);
    store.linkTwitch(key, token);
    isNew = true;
  } else {
    // Self-heal any pre-bare-fists sigma we already had on disk.
    const rec = store.getPlayer(token);
    if (rec?.character) {
      const before = rec.character.run?.gear?.weapon || null;
      ensureStarterGear(rec.character);
      if (!before && rec.character.run?.gear?.weapon) store.putPlayer(token, rec.character);
    }
  }
  return { token, isNew };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HOST = process.env.HOST || "127.0.0.1";

installGlobalGuards();
store.initStore();
// Seed (or load) the persistent shared-world document — the 5 factions +
// 5 contested zones that the world tick advances (master design §0.5).
store.initWorldState(() => freshWorld());
// Seed (or load) the market document — listings + buy orders (master §0.5).
store.initMarketState(() => freshMarket());

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// Prototype cache policy: always pull fresh code (OBS CEF caches hard).
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");
  next();
});

const server = http.createServer(app);
const rt = attachRealtime(server, { getRaid: () => raidPublic(currentRaid) });

// ── API ───────────────────────────────────────────────────────────────
app.get(
  "/healthz",
  guard("GET /healthz", (_req, res) => {
    res.json({
      ok: true,
      ...health(),
      players: store.playerCount(),
      feed: store.getFeed().length,
      agents: store.agentCount(),
      oracleOpen: store.allOracleTasks().filter((t) => t.status === "open").length,
      uptime: Math.round(process.uptime()),
    });
  }),
);
app.get(
  "/api/feed",
  guard("GET /api/feed", (_req, res) => {
    res.json({ feed: store.getFeed() });
  }),
);
// Sigmacraft read model (integrate-this PR8 read surface). Optional ?token=
// scopes the snapshot to a player's place + valid actions; otherwise anonymous.
app.get(
  "/api/sigmacraft/snapshot",
  guard("GET /api/sigmacraft/snapshot", (req, res) => {
    const qs = (req.url || "").split("?")[1] || "";
    const token = String(new URLSearchParams(qs).get("token") || "").slice(0, 64);
    const character = token ? store.getPlayer(token)?.character || null : null;
    res.json({
      ok: true,
      snapshot: projectSigmacraftSnapshot(store.getWorldState(), character, { token }),
    });
  }),
);
// Static overworld tile graph (fetched once by the playtest UI + agents). The map
// is deterministic and never mutates, so it is served whole; the per-snapshot
// worldMap carries the live windowed neighborhood + npcCounts.
app.get(
  "/api/sigmacraft/map",
  guard("GET /api/sigmacraft/map", (_req, res) => {
    res.json({ ok: true, map: store.getWorldState()?.sigmacraft?.map || null });
  }),
);
// Sigmacraft intent write path (integrate-this PR5). A token-owning player
// queues ONE bounded, validated intent resolved by the next world tick. All
// inbound mutation passes the validate.js trust boundary; movement is gated by
// the player's unlocked zones; nonce de-dup is idempotent.
app.post(
  "/api/sigmacraft/intent",
  guard("POST /api/sigmacraft/intent", (req, res) => {
    const token = String(req.body?.token || "").slice(0, 64);
    const rec = token ? store.getPlayer(token) : null;
    if (!rec?.character) {
      res.status(401).json({ ok: false, error: "unknown token" });
      return;
    }
    let intent;
    try {
      intent = vSigmacraftIntent(req.body?.intent ?? req.body);
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message || "bad intent" });
      return;
    }
    // Tile moves are gated at apply time (existence + adjacency in the tick),
    // not here — the overworld is a free-roam graph, not level-locked zones.
    const world = store.getWorldState();
    const result = sigmacraft.enqueueSigmacraftIntent(world, token, intent);
    store.putWorldState(world);
    res.status(result.status === "rejected" ? 409 : 200).json({
      ok: result.status !== "rejected",
      ...result,
    });
  }),
);
// Playtest bootstrap: mint a fresh, roam-ready sigma server-side (no untrusted
// input — uses the canonical freshCharacter) and return its token + the initial
// Sigmacraft snapshot. Powers the /sigmacraft test interface end-to-end through
// the real intent/snapshot path.
app.post(
  "/api/sigmacraft/playtest",
  guard("POST /api/sigmacraft/playtest", (_req, res) => {
    const token = `sig_${crypto.randomBytes(12).toString("hex")}`;
    const seed = crypto.randomBytes(4).readUInt32BE(0) >>> 0 || 1;
    const character = freshCharacter(seed, "Playtester");
    character.highestLevel = 60; // unlock every zone (max minLevel is 50) for free roam
    character.lastSeen = Date.now();
    store.putPlayer(token, character);
    res.json({
      ok: true,
      token,
      snapshot: projectSigmacraftSnapshot(store.getWorldState(), character, { token }),
    });
  }),
);
app.get(
  "/api/leaderboard",
  guard("GET /api/leaderboard", (_req, res) => {
    res.json({ leaderboard: rt.stats().leaderboard });
  }),
);
app.get(
  "/api/stats",
  guard("GET /api/stats", (_req, res) => {
    res.json(rt.stats());
  }),
);

// Twitch channel-point redemptions land here. The redemption listener in
// sigmashake-obs forwards the chatter's login + action kind; we mint a sigma
// if needed, push a feed entry so chat sees the announcement, then broadcast
// the action over the WS so any open browser session for that chatter can
// apply the in-game effect.
app.post(
  "/api/twitch-action/:login",
  guard("POST /api/twitch-action", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const kind = String(req.body?.kind || "");
    const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};

    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    if (!TWITCH_ACTION_KINDS.has(kind)) {
      res
        .status(400)
        .json({ error: `invalid kind — valid: ${[...TWITCH_ACTION_KINDS].join("|")}` });
      return;
    }

    const { token, isNew } = resolveTwitchSigma(login);
    const at = Date.now();
    const rec = store.getPlayer(token);
    if (rec?.character) {
      rec.character.lastSeen = at;
      rec.character.twitchLogin = login;
      store.putPlayer(token, rec.character);
    }
    const entry = store.pushFeed({ kind: "twitch_redemption", login, action: kind, isNew, at });
    rt.broadcast({ t: "feed", entry });
    rt.broadcast({ t: "twitchAction", login, token, kind, params, at });
    const arenaJoin = arena.pingChatter(login, "twitch-action");
    if (arenaJoin) rt.broadcast(arenaJoin);
    // Auto-engage into an active raid (Twitch action joins like chat-ping).
    if (currentRaid && !raidState.isEngaged(login)) {
      const twWeapon = rec?.character?.run?.gear?.weapon || null;
      raidState.engage(login, twWeapon);
    }
    const claim = drops.tryClaim(login);
    if (claim)
      rt.broadcast({
        t: "dropClaim",
        id: claim.drop.id,
        login: claim.login,
        summary: claim.summary,
        at: Date.now(),
      });

    // D4 — on-demand boss summon via channel-point redemption.
    // kind=summon triggers a raid using the SPAWNABLE_BOSSES whitelist.
    // params.boss_id selects a specific boss; omit for a random pick.
    // No-ops if a raid is already active (one boss at a time).
    let summonResult = null;
    if (kind === "summon") {
      if (currentRaid) {
        summonResult = { skipped: true, reason: "raid_active", active: raidPublic(currentRaid) };
      } else if (chatPingsInLast(RAID_REQUIRE_CHAT_MS) === 0) {
        // C: No recent chat — boss only appears when people are chatting.
        summonResult = { skipped: true, reason: "no_recent_chat" };
      } else {
        const pool = [...SPAWNABLE_BOSSES];
        const requested = String(params.boss_id || "");
        const boss_id = SPAWNABLE_BOSSES.has(requested)
          ? requested
          : pool[Math.floor(Math.random() * pool.length)];
        startRaid(boss_id, "summon", login);
        const entry2 = store.pushFeed({
          kind: "boss",
          boss_id,
          name: ENEMIES[boss_id]?.name,
          reason: "summon",
          fromLogin: login,
          at: Date.now(),
        });
        rt.broadcast({ t: "feed", entry: entry2 });
        summonResult = { started: true, raid: raidPublic(currentRaid) };
      }
    }

    res.json({ ok: true, token, isNew, kind, claim, summon: summonResult });
  }),
);

// Chat ping — fired by sigmashake-chat-elixir on every real chat line.
// Unlike /api/twitch-action this is a no-op identity refresh: it mints
// the sigma if needed and adds them to the arena roster so the overlay
// canvas shows them. No game-state mutation, no rate-shaping side effect
// beyond keeping the chatter visible for ROSTER_TTL_MS.
app.post(
  "/api/chat-ping/:login",
  guard("POST /api/chat-ping", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    // Optional `lines` in the body lets the bridge tell us how many chat
    // messages were coalesced into this ping (1 by default). Either shape
    // is accepted so old/new bridges interop.
    const bodyLines = Number(req.body?.lines ?? 1);
    const lines = Math.max(1, Math.min(50, Number.isFinite(bodyLines) ? bodyLines : 1));
    for (let i = 0; i < lines; i += 1) recordChatPing();
    const { token, isNew } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    // Navi's distress-call — the new-player CTA. Fired ONCE, the first time a
    // chatter spawns a sigma. Built here (inside the persisted write below) so
    // the once-only `onboarding.naviCalledAt` flag is saved atomically; the
    // hologram frame is broadcast after putPlayer so the overlay plays it.
    let naviCall = null;
    let delveEv = null;
    if (rec?.character) {
      rec.character.lastSeen = Date.now();
      rec.character.twitchLogin = login;
      if (isNew && !rec.character.onboarding?.naviCalledAt) {
        startOnboarding(rec.character); // ensure onboarding obj + step 1
        rec.character.onboarding.naviCalledAt = Date.now();
        naviCall = buildNaviCall(rec.character.name, login);
      }
      // Save-read world-event injection (master §M4): accrue any pending
      // zone world events + the conquest combat mod onto this sigma's run.
      injectWorldState(rec.character, store.getWorldState());
      ensureQuests(rec.character); // keep the procedural quest board topped up (master §M5)
      retention.ensureFreshObjectives(rec.character, Date.now()); // daily/weekly board (master §M7)
      retention.syncAchievements(rec.character); // award any newly-earned achievements
      // REAL progression from chat (layer 1) — advance the persisted run with
      // real delveTick(s), but ONLY for chat-only sigmas: if a browser owns
      // this token it drives + saves its own run, and advancing run.rngState
      // from both sides would fork the RNG stream. delveTick is pure +
      // synchronous (no new timer — PSU safe); it rides this chat-ping. Runs
      // AFTER injectWorldState so this tick consumes any _pendingWorldEvents.
      if (!rt.isTokenOnline(token)) delveEv = liveDelve(rec.character, lines);
      store.putPlayer(token, rec.character);
    }
    const join = arena.pingChatter(login, "chat");
    if (join) rt.broadcast(join);
    // Auto-engage mid-raid joiners: if a raid is active and this chatter
    // isn't already engaged (no !fight required), enlist them now.
    if (currentRaid && !raidState.isEngaged(login)) {
      const tok2 = store.getTokenByTwitch(login);
      const weapon2 = tok2 ? store.getPlayer(tok2)?.character?.run?.gear?.weapon : null;
      raidState.engage(login, weapon2 || null);
    }
    // A brand-new sigma just woke — play Navi's hologram on the overlay and
    // drop a feed row announcing the recruit. Rare (once per chatter, ever),
    // so a plain broadcast is fine (no per-tick stream here).
    if (naviCall && rec?.character) {
      const naviEntry = store.pushFeed({
        kind: "navi_call",
        login,
        name: rec.character.name,
        detail: `Navi called @${login} into the Abyss`,
      });
      rt.broadcast({ t: "feed", entry: naviEntry });
      rt.broadcast({
        t: "naviCall",
        login,
        name: rec.character.name,
        tag: naviCall.tag,
        line: naviCall.line,
        sub: naviCall.sub,
        cta: naviCall.cta,
        seed: naviCall.seed,
        cosmetics: naviCall.cosmetics,
        at: Date.now(),
      });
    }

    // Real-progression feedback (layer 2) — overlay bursts (levelUp/delveDeath)
    // + milestone feed rows from the chat-only sigma's live delve. Milestone-
    // gated + throttled inside delveFeedback so the feed/chat never flood
    // across many simultaneous chatters.
    let delveSay = null;
    if (delveEv && rec?.character) {
      const fb = delveFeedback(delveEv, {
        login,
        name: rec.character.name,
        now: Date.now(),
        // A command ping's command.reply owns the chat line — suppress the
        // delve callout so the two never collide (and don't waste a throttle).
        allowCallout: !req.body?.cmd,
      });
      for (const fe of fb.feedEntries) {
        const e = store.pushFeed(fe);
        rt.broadcast({ t: "feed", entry: e });
      }
      for (const fr of fb.frames) rt.broadcast(fr);
      delveSay = fb.say;
    }

    // Engaged raiders: each chat line accumulates ticks against the
    // chatter's weapon speedMul; when ticks ≥ perSwing, fire raid damage
    // (which also rolls a boss counter-attack). Engaged chatters skip
    // the arena foe swings — they're committed to the boss, not goblins.
    let raidSwingsFired = 0;
    let raidKill = null;
    let downedByCounter = false;
    if (currentRaid && raidState.isEngaged(login)) {
      const swings = raidState.consumeChatTicks(login, lines);
      for (let i = 0; i < swings; i += 1) {
        if (!currentRaid) break;
        const r = fireRaidSwing(login, "chat");
        if (!r.ok) {
          if (r.error === "downed") downedByCounter = true;
          break;
        }
        raidSwingsFired += 1;
        if (r.raidDefeated) {
          raidKill = r;
          break;
        }
      }
    }

    // Non-engaged chatters fall back to the arena auto-battle pipeline
    // (swing at their goblin/skeleton foe) so chat still drives visible
    // action when no raid is up.
    const swingFrames = raidSwingsFired > 0 ? [] : arena.swingFor(login, lines);
    let killsThisPing = 0;
    for (const f of swingFrames) {
      rt.broadcast(f);
      if (f.t === "arenaKill") killsThisPing += 1;
    }
    // The arena overlay auto-battle is SPECTACLE ONLY — it never awards XP
    // or loot. Real progression comes exclusively from in-world delve kills
    // (`delveTick` in shared/progression.js). Spawning a kill reward here
    // double-counted: a chatter playing the game earned in-world XP *and*
    // a second helping just for chatting (the arena swings on every line).
    // Loot drops still rain from agent sessions (`spawnSessionDrops`).

    const claim = drops.tryClaim(login);
    if (claim)
      rt.broadcast({
        t: "dropClaim",
        id: claim.drop.id,
        login: claim.login,
        summary: claim.summary,
        at: Date.now(),
      });

    // Persistent-world chat verbs (master §5.1). chat-elixir's bridge adds
    // {cmd, args} parsed from `!cmd args`; we dispatch AFTER the base ping
    // so presence/arena/raid behaviour is unaffected. Unknown verbs no-op.
    let command = null;
    if (req.body?.cmd) {
      command = dispatchCommand(login, req.body.cmd, req.body.args, {
        token,
        character: store.getPlayer(token)?.character || null,
        store,
        rt,
        now: Date.now(),
      });
    }

    res.json({
      ok: true,
      token,
      isNew,
      joined: !!join,
      claim,
      lines,
      swings: swingFrames.length,
      kills: killsThisPing,
      raidSwings: raidSwingsFired,
      raidDefeated: !!raidKill,
      downed: downedByCounter,
      command,
      // Literal-chat line for a PRESENCE ping (the bridge posts rbody.say):
      // a brand-new spawn echoes Navi's distress call; otherwise a throttled
      // big-moment delve callout. A command ping's command.reply takes
      // precedence over this in the bridge, so the two never collide.
      say: naviCall ? naviCall.chatReply : delveSay,
    });
  }),
);

// ── Faction & persistent-world endpoints (master design §5.2) ─────────
// These are the canonical world-mutating verbs. `!join`/`!rep` from chat
// route through /api/chat-ping → dispatchCommand; these HTTP routes are
// the same logic for direct callers (channel-point redemptions, the
// overlay, tests) and reuse the shared faction core in commands.js.

// POST /api/faction/join/:login — body { faction } (id or alias).
app.post(
  "/api/faction/join/:login",
  guard("POST /api/faction/join", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    const factionId = resolveFactionId(req.body?.faction ?? req.query?.faction);
    if (!factionId) {
      res.status(400).json({ error: `unknown faction — valid: ${FACTION_IDS.join("|")}` });
      return;
    }
    const { token, isNew } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    const character = rec?.character;
    if (!character) {
      res.status(500).json({ error: "no sigma" });
      return;
    }
    character.twitchLogin = login;
    character.lastSeen = Date.now();
    const result = joinFaction(character, factionId, Date.now());
    if (!result.ok) {
      store.putPlayer(token, character);
      res.status(result.error === "cooldown" || result.error === "prestige_gate" ? 409 : 400).json({
        ok: false,
        token,
        isNew,
        ...result,
      });
      return;
    }
    store.putPlayer(token, character);
    const entry = store.pushFeed({
      kind: "faction_join",
      login,
      name: character.name,
      faction: result.faction,
      switched: result.switched,
      detail: `${character.name} ${result.switched ? "defected to" : "joined"} ${result.factionName}`,
    });
    rt.broadcast({ t: "feed", entry });
    rt.broadcast({
      t: "factionJoin",
      login,
      token,
      faction: result.faction,
      switched: result.switched,
      at: Date.now(),
    });
    res.json({ ok: true, token, isNew, ...result });
  }),
);

// GET /api/faction/rep/:login — read-only standing snapshot.
app.get(
  "/api/faction/rep/:login",
  guard("GET /api/faction/rep", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    if (!character) {
      res.json({ ok: true, login, faction: null, rank: 0, title: null, rep: {}, repInFaction: 0 });
      return;
    }
    character._now = Date.now();
    const view = factionRepView(character);
    delete character._now;
    res.json({ ok: true, login, ...view });
  }),
);

// GET /api/faction/:id — public faction detail.
app.get(
  "/api/faction/:id",
  guard("GET /api/faction/:id", (req, res) => {
    const id = String(req.params.id || "").toLowerCase();
    const def = factionById(id);
    if (!def) {
      res.status(404).json({ error: "unknown faction" });
      return;
    }
    const w = store.getWorldState();
    const wf = w?.factions?.[id] || null;
    res.json({
      ok: true,
      faction: {
        id: def.id,
        name: def.name,
        blurb: def.blurb,
        homeZone: def.homeZone,
        archetype: def.archetype,
        rival: def.rival,
        allied: def.allied,
        color: def.color,
        memberCount: wf?.memberCount | 0,
        activePlayers: wf?.activePlayers | 0,
        treasury: wf?.treasury | 0,
      },
    });
  }),
);

// GET /api/world — merged public snapshot of the living world (master §5.2).
app.get(
  "/api/world",
  guard("GET /api/world", (_req, res) => {
    const w = store.getWorldState();
    if (!w) {
      res.json({ ok: true, epoch: 0, factions: {}, zones: {} });
      return;
    }
    const zones = {};
    for (const [zid, z] of Object.entries(w.zones || {})) {
      zones[zid] = {
        pressure: z.pressure,
        conquestOwner: z.conquestOwner,
        status: z.status,
        contestantFactions: z.contestantFactions || [],
        killsThisHour: z.killsThisHour | 0,
        deathsThisHour: z.deathsThisHour | 0,
      };
    }
    res.json({
      ok: true,
      epoch: w.epoch | 0,
      lastTickAt: w.lastTickAt || 0,
      factions: publicFactions(w),
      zones,
      graveCount: Array.isArray(w.graves) ? w.graves.length : 0,
      activeCrisis: w.crisis?.activeCrisis || null,
      factionWar: w.retention?.factionWar || null,
    });
  }),
);

// GET /api/passive-tree — the static passive web (Project Ascendant Inc4) for
// the VCS graph UI to render. Pure static data (nodes + symmetric adjacency +
// mods, class start zones, keystones); no auth, no per-player state. Mirrors
// GET /api/agent/world's "serve the static map" posture.
app.get(
  "/api/passive-tree",
  guard("GET /api/passive-tree", (_req, res) => {
    res.json({ ok: true, ...passiveTreePayload() });
  }),
);

// GET /api/weapon-catalog — the static Vampire-Survivors catalog (weapon types
// + the synergy/evolution matrix + tunables) for the VCS combat UI to render.
// Pure static data; no auth, no per-player state. Mirrors GET /api/passive-tree.
app.get(
  "/api/weapon-catalog",
  guard("GET /api/weapon-catalog", (_req, res) => {
    res.json({ ok: true, ...weaponCatalogPayload() });
  }),
);

// ── Economy / market endpoints (master §5.2, 02-economy.md §8) ────────
// Shared shape: resolve (or mint) the chatter's sigma, build a context, and
// hand off to the server/market.js engine which owns all the mutation +
// persistence + feed. Responds 200 with the engine's {ok, ...} result so
// the Twitch bot can format one reply regardless of success/failure.
function marketHandler(req, res, fn) {
  const login = String(req.params.login || "")
    .toLowerCase()
    .slice(0, 32);
  if (!login.match(/^[a-z0-9_]{1,32}$/)) {
    res.status(400).json({ ok: false, error: "invalid login" });
    return;
  }
  const { token } = resolveTwitchSigma(login);
  const character = store.getPlayer(token)?.character;
  if (!character) {
    res.status(500).json({ ok: false, error: "no sigma" });
    return;
  }
  character.twitchLogin = login;
  character.lastSeen = Date.now();
  const result = fn({
    login,
    token,
    character,
    store,
    world: store.getWorldState(),
    market: store.getMarket(),
    rt,
    body: req.body || {},
    now: Date.now(),
  });
  res.json(result);
}

app.post(
  "/api/market/list/:login",
  guard("market.list", (req, res) => marketHandler(req, res, market.listItem)),
);
app.post(
  "/api/market/buy/:login",
  guard("market.buy", (req, res) => marketHandler(req, res, market.buyListing)),
);
app.post(
  "/api/market/bid/:login",
  guard("market.bid", (req, res) => marketHandler(req, res, market.bidListing)),
);
app.post(
  "/api/market/offer/:login",
  guard("market.offer", (req, res) => marketHandler(req, res, market.postOffer)),
);
app.post(
  "/api/market/unlist/:login",
  guard("market.unlist", (req, res) => marketHandler(req, res, market.unlist)),
);
app.post(
  "/api/salvage/:login",
  guard("salvage", (req, res) => marketHandler(req, res, market.salvage)),
);
app.post(
  "/api/reroll/:login",
  guard("reroll", (req, res) => marketHandler(req, res, market.reroll)),
);
app.post(
  "/api/vault/expand/:login",
  guard("vault.expand", (req, res) => marketHandler(req, res, market.vaultExpand)),
);

// GET /api/market — public listing snapshot (filterable).
app.get(
  "/api/market",
  guard("GET /api/market", (req, res) => {
    const m = store.getMarket();
    res.json({
      ok: true,
      listings: m
        ? market.browse(m, { slot: req.query?.slot, rarity: req.query?.rarity, limit: 20 })
        : [],
    });
  }),
);

// GET /api/market/price/:slot/:rarity — recent sale prices + median (!price).
app.get(
  "/api/market/price/:slot/:rarity",
  guard("GET /api/market/price", (req, res) => {
    res.json({
      ok: true,
      ...market.priceQuery(
        store.getWorldState(),
        String(req.params.slot),
        String(req.params.rarity),
      ),
    });
  }),
);

// GET /api/vault/:login — read-only vault contents (!vault).
app.get(
  "/api/vault/:login",
  guard("GET /api/vault", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    res.json({
      ok: true,
      login,
      vault: (character?.vault || []).map((i) => ({
        name: i.name,
        slot: i.slot,
        rarity: i.rarity,
        power: i.power | 0,
      })),
      vaultCapacity: character?.vaultCapacity || 20,
      shards: character?.shards | 0,
      runeDust: character?.runeDust | 0,
    });
  }),
);

// GET /api/economy — world economy snapshot (!economy / overlay).
app.get(
  "/api/economy",
  guard("GET /api/economy", (_req, res) => {
    const w = store.getWorldState();
    const e = w?.economy || {};
    res.json({
      ok: true,
      treasury: e.treasury | 0,
      goldInCirculation: e.goldInCirculation | 0,
      treasuryMode: !!e.treasuryMode,
      listings: store.getMarket() ? Object.keys(store.getMarket().listings).length : 0,
    });
  }),
);

// ── Crafting / talents / scars endpoints (master §M3, forge.js) ──────
app.post(
  "/api/craft/:login",
  guard("craft", (req, res) => marketHandler(req, res, forge.craft)),
);
app.get(
  "/api/recipes/:login",
  guard("recipes", (req, res) => marketHandler(req, res, forge.recipesView)),
);
app.get(
  "/api/talents/:login",
  guard("talents", (req, res) => marketHandler(req, res, forge.talentsView)),
);
app.post(
  "/api/talent/unlock/:login",
  guard("talent.unlock", (req, res) => marketHandler(req, res, forge.talentUnlock)),
);
app.post(
  "/api/talent/respec/:login",
  guard("talent.respec", (req, res) => marketHandler(req, res, forge.talentRespec)),
);
app.post(
  "/api/scars/cleanse/:login",
  guard("scars.cleanse", (req, res) => marketHandler(req, res, forge.scarCleanse)),
);

// ── Narrative / crisis / quest endpoints (master §M5) ────────────────
// Contribute to the active world crisis (the !pray/!rally/!gather/!fight verbs
// route here). One contribution per call; throttled at the chat layer.
app.post(
  "/api/world/contribute/:login",
  guard("world.contribute", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    resolveTwitchSigma(login);
    const world = store.getWorldState();
    const r = contributeToCrisis(world, login, 1);
    if (r.ok) store.putWorldState(world);
    res.json(r);
  }),
);

// The character's quest board (master §M5 — !quests).
app.get(
  "/api/sigma/:login/quests",
  guard("sigma.quests", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    if (!character) {
      res.json({ ok: true, login, quests: [], questXp: 0, questLevel: 0 });
      return;
    }
    const fresh = ensureQuests(character);
    if (fresh.length) store.putPlayer(token, character);
    res.json({
      ok: true,
      login,
      quests: (character.quests || []).filter((q) => q.status === "active"),
      questXp: character.questXp | 0,
      questLevel: character.questLevel | 0,
    });
  }),
);

// ── Retention endpoints (master §M7) ─────────────────────────────────
app.get(
  "/api/daily/:login",
  guard("daily", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    if (!character) {
      res.json({ ok: true, login, daily: [], weekly: [] });
      return;
    }
    retention.ensureFreshObjectives(character, Date.now());
    store.putPlayer(token, character);
    res.json({
      ok: true,
      login,
      daily: character.dailyObjectives,
      weekly: character.weeklyBounties,
    });
  }),
);
app.post(
  "/api/daily-chest/:login",
  guard("daily.chest", (req, res) =>
    marketHandler(req, res, (ctx) => {
      retention.ensureFreshObjectives(ctx.character, ctx.now);
      const r = retention.claimObjective(
        ctx.character,
        String(ctx.body?.objId || ctx.body?.id || ""),
      );
      if (r.ok) ctx.store.putPlayer(ctx.token, ctx.character);
      return r;
    }),
  ),
);
app.get(
  "/api/achievements/:login",
  guard("achievements", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    if (!character) {
      res.json({ ok: true, login, earned: [], score: 0 });
      return;
    }
    retention.syncAchievements(character);
    store.putPlayer(token, character);
    res.json({
      ok: true,
      login,
      earned: character.achievements.earned,
      score: character.achievements.score,
    });
  }),
);
app.get(
  "/api/bestiary/:login",
  guard("bestiary", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    res.json({ ok: true, login, bestiary: character?.bestiary || { kills: {} } });
  }),
);
app.get(
  "/api/museum/:login",
  guard("museum", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    const token = store.getTokenByTwitch(login);
    const character = token ? store.getPlayer(token)?.character : null;
    res.json({ ok: true, login, museum: character?.museum || [] });
  }),
);
app.post(
  "/api/equip-title/:login",
  guard("equip.title", (req, res) =>
    marketHandler(req, res, (ctx) => {
      const title = String(ctx.body?.title || "");
      if (!(ctx.character.titles || []).includes(title))
        return { ok: false, error: "title_not_earned" };
      ctx.character.activeTitle = title;
      ctx.store.putPlayer(ctx.token, ctx.character);
      return { ok: true, activeTitle: title };
    }),
  ),
);

// ── Chat voting endpoints (master §M8) — the crowd steers the world ──
// open/close are operator actions (loopback-bound server); /api/vote/:login is
// the chatter ballot. Register open/close BEFORE :login so they aren't shadowed.
app.get(
  "/api/vote",
  guard("vote.state", (_req, res) => res.json({ ok: true, vote: voting.voteState() })),
);
app.post(
  "/api/vote/open",
  guard("vote.open", (req, res) => {
    const r = voting.openVote({
      options: req.body?.options,
      durationMs: Number(req.body?.durationMs) || 60_000,
      now: Date.now(),
    });
    if (r.ok) rt.broadcast({ t: "voteOpen", vote: r.vote, at: Date.now() });
    res.json(r);
  }),
);
app.post(
  "/api/vote/close",
  guard("vote.close", (_req, res) => {
    const r = voting.closeVote(store.getWorldState(), Date.now());
    if (r.ok) {
      store.putWorldState(store.getWorldState());
      store.pushFeed({
        kind: "vote_result",
        detail: `Chat voted: ${r.result.label}. ${r.result.message || ""}`,
      });
      rt.broadcast({ t: "voteResult", result: r.result, at: Date.now() });
    }
    res.json(r);
  }),
);
app.post(
  "/api/vote/:login",
  guard("vote.cast", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    res.json(voting.castVote(login, String(req.body?.option || "")));
  }),
);

// ── NPC interaction endpoints (master §M6) ───────────────────────────
app.post(
  "/api/npc/greet/:login",
  guard("npc.greet", (req, res) =>
    marketHandler(req, res, (ctx) => npcWorld.handleNpcInteract(ctx, "greet")),
  ),
);
app.post(
  "/api/npc/ask/:login",
  guard("npc.ask", (req, res) =>
    marketHandler(req, res, (ctx) => npcWorld.handleNpcInteract(ctx, "ask")),
  ),
);
app.get(
  "/api/world/npc/:id",
  guard("world.npc", (req, res) => {
    const snap = npcWorld.npcSnapshot(
      store.getWorldState(),
      String(req.params.id || "").toLowerCase(),
    );
    if (!snap) {
      res.status(404).json({ ok: false, error: "unknown_npc" });
      return;
    }
    res.json({ ok: true, npc: snap });
  }),
);

// Read-only sigma summary for chat replies (`!sigma`, `!loot`). Mints
// a fresh sigma if the chatter hasn't redeemed yet — same identity
// bridge as the redemption endpoint.
app.get(
  "/api/sigma/:login",
  guard("GET /api/sigma", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    const { token, isNew } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    const c = rec?.character || null;
    res.json({
      ok: true,
      token,
      isNew,
      login,
      sigma: c
        ? (() => {
            const sheet = c.run ? derive(c.run, c) : null;
            return {
              name: c.name,
              level: c.run?.level || 1,
              depth: c.run?.depth || 0,
              zone: c.run?.zone || "town",
              hp: Math.round(c.run?.hp || 0),
              prestige: c.prestige || 0,
              gold: c.gold || 0,
              kills: c.lifetimeKills || 0,
              bestDepth: c.bestDepth || 0,
              highestLevel: c.highestLevel || 1,
              title: c.titles?.[c.titles.length - 1] || null,
              inventoryCount: (c.run?.inventory || []).length,
              bestItemPower: c.bestItemPower || 0,
              weapon: summarizeItem(c.run?.gear?.weapon),
              armor: summarizeItem(c.run?.gear?.armor),
              ring: summarizeItem(c.run?.gear?.ring),
              relic: summarizeItem(c.run?.gear?.relic),
              charm: summarizeItem(c.run?.gear?.charm),
              // Spirit Pool + Reservations (Project Ascendant Inc7).
              // spirit = pool size (from derive); spiritUsed = sum of reserved
              // skill costs (0 when no reservations — exact-identity for new chars).
              // reserved = ordered list of active reservable-skill ids.
              // auraBuffs = per-id buff summary for the VCS UI.
              spirit: sheet?.spirit ?? null,
              spiritUsed: sheet?.spiritUsed ?? 0,
              reserved: c.reserved || [],
              auraBuffs: (c.reserved || []).reduce((acc, id) => {
                const sk = RESERVABLE_SKILLS[id];
                if (sk)
                  acc[id] = {
                    name: sk.name,
                    kind: sk.kind,
                    spiritCost: sk.spiritCost,
                    buff: sk.buff,
                  };
                return acc;
              }, {}),
              // Passive tree (Project Ascendant Inc4). passives = allocated node
              // ids; passiveStart = class start zone; passivePoints = available
              // budget (highestLevel + prestige). Empty for an un-allocated char.
              passives: c.passives || [],
              passiveStart: c.passiveStart || null,
              passivePoints: passivePointsFor(c),
              // Vampire-Survivors layer. weapons = chosen loadout; activeWeapon
              // = the slot lost on a faint; gems = live combat snapshot the
              // overlay animates; fainted/lostWeapon = read-only feedback.
              weapons: c.weapons || [],
              activeWeapon: c.activeWeapon || null,
              evolutions: activeEvolutions(c.weapons || [], c.passives || []).map((e) => e.id),
              gems: c.run ? gemSnapshot(c.run) : [],
              fainted: c.fainted || 0,
              lostWeapon: c.lostWeapon || null,
              // Dual specialization (Project Ascendant Inc6). The Set A fields
              // above ARE the active set's build (canonical top-level storage).
              // activeSet = which profile is live ("A"|"B"); setB = the inactive
              // set's build snapshot (account fields + a summarized inactive gear
              // loadout), or null for a single-loadout character.
              activeSet: c.activeSet === "B" ? "B" : "A",
              setB: c.setB
                ? {
                    passives: c.setB.passives || [],
                    passiveStart: c.setB.passiveStart || null,
                    reserved: c.setB.reserved || [],
                    position: c.setB.position || "mid",
                    skillTalents: c.setB.skillTalents || {},
                    gear: {
                      weapon: summarizeItem(c.run?.gearB?.weapon),
                      armor: summarizeItem(c.run?.gearB?.armor),
                      ring: summarizeItem(c.run?.gearB?.ring),
                      relic: summarizeItem(c.run?.gearB?.relic),
                      charm: summarizeItem(c.run?.gearB?.charm),
                    },
                  }
                : null,
            };
          })()
        : null,
    });
  }),
);

// Full gear loadout for the VCS combat tab: equipped gear per slot + the
// chatter's equippable inventory (each tagged with its run.inventory index so
// the client can POST it back to /equip). Mints/resolves the sigma like
// GET /api/sigma so a known chatter always returns a loadout.
app.get(
  "/api/sigma/:login/loadout",
  guard("GET /api/sigma/loadout", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const { token } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    if (!rec?.character) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    ensureStarterGear(rec.character);
    res.json({ ok: true, login, ...loadoutPayload(rec.character) });
  }),
);

// Dual specialization (Project Ascendant Inc6) — manual build-set swap. Sets
// the active combat profile to "A" or "B" (body `{ set }`; defaults to toggling
// the other set when omitted). The swap is a between-request (between-tick) data
// shuffle handled by swapBuildSet — it NEVER runs mid-tick, so determinism is
// preserved. Set B is lazily materialized (a clone of the current loadout) the
// first time the player switches to it. Persists like every other sigma
// mutation, then returns the now-active set + a fresh derived sheet.
app.post(
  "/api/sigma/:login/swap-set",
  guard("sigma.swapSet", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const { token } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    if (!rec?.character) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    const c = rec.character;
    ensureStarterGear(c);
    const current = c.activeSet === "B" ? "B" : "A";
    const raw = req.body?.set;
    // Explicit target when valid; otherwise toggle to the other set.
    const target = raw === "A" || raw === "B" ? raw : current === "A" ? "B" : "A";
    const active = swapBuildSet(c, target);
    store.putPlayer(token, c);
    const sheet = c.run ? derive(c.run, c) : null;
    res.json({
      ok: true,
      login,
      activeSet: active,
      hasSetB: !!c.setB,
      spirit: sheet?.spirit ?? null,
      spiritUsed: sheet?.spiritUsed ?? 0,
      reserved: c.reserved || [],
      passives: c.passives || [],
      position: c.position || "mid",
      weapon: summarizeItem(c.run?.gear?.weapon),
    });
  }),
);

// Shared response payload for the three Project Ascendant build-setter endpoints.
// Mirrors the swap-set response shape so the VCS bridge can consume all four
// endpoints uniformly.
function buildSetPayload(login, c) {
  const sheet = c.run ? derive(c.run, c) : null;
  return {
    ok: true,
    login,
    activeSet: c.activeSet === "B" ? "B" : "A",
    hasSetB: !!c.setB,
    spirit: sheet?.spirit ?? null,
    spiritUsed: sheet?.spiritUsed ?? 0,
    reserved: c.reserved || [],
    passives: c.passives || [],
    passiveStart: c.passiveStart || null,
    passivePoints: passivePointsFor(c),
    position: c.position || "mid",
    setB: c.setB
      ? {
          passives: c.setB.passives || [],
          passiveStart: c.setB.passiveStart || null,
          reserved: c.setB.reserved || [],
          position: c.setB.position || "mid",
        }
      : null,
  };
}

// Helper: resolve a login to an existing character (no mint). Returns null when
// absent so callers can 404 cleanly without the full resolveTwitchSigma mint path.
function resolveExistingChar(login) {
  const token = store.getTokenByTwitch(login);
  if (!token) return null;
  const rec = store.getPlayer(token);
  if (!rec?.character) return null;
  return { token, character: rec.character };
}

// Helper: apply a mutation to EITHER the active set (top-level fields) OR the
// inactive set (setB), depending on `setParam`. Lazily materializes setB via
// swapBuildSet when targeting the inactive set. Returns the set that was written
// ("A"|"B"). Callers must re-validate + persist after calling this.
//
// `set` param semantics:
//   omitted / null / matches active → write active set (top-level)
//   "A" when activeSet === "A" → same
//   "B" when activeSet === "A" → swap to B, write, swap back (inactive edit)
//   "A" when activeSet === "B" → swap to A, write, swap back (inactive edit)
//   "B" when activeSet === "B" → write active (top-level)
//
// For v1 this covers the full edit-any-set contract. Determinism is preserved
// because swapBuildSet never draws RNG (tested in dual-spec.test.js).
function withBuildSet(c, setParam, mutateFn) {
  const active = c.activeSet === "B" ? "B" : "A";
  // Coerce: only "A" or "B" are valid; anything else → active set.
  const target = setParam === "A" || setParam === "B" ? setParam : active;
  if (target === active) {
    mutateFn(c, false); // write top-level (active) fields
    return active;
  }
  // Target is the INACTIVE set — swap there, mutate, swap back.
  swapBuildSet(c, target); // now `target` is active, fields live on top-level
  mutateFn(c, true); // write what are now top-level (formerly setB) fields
  swapBuildSet(c, active); // restore original active set
  return target;
}

// POST /api/sigma/:login/passives — set the passive node allocation for the
// active or specified build set. Body: { passives: [ids], set?: "A"|"B" }.
// vPassives (inside vCharacter) prunes to connected-from-start + caps to budget.
// Returns the standard Project Ascendant build payload.
app.post(
  "/api/sigma/:login/passives",
  guard("sigma.passives", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const raw = resolveExistingChar(login);
    if (!raw) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    const { token, character: c } = raw;
    const rawPassives = req.body?.passives;
    const setParam = vEnum(req.body?.set, ["A", "B"], null);
    withBuildSet(c, setParam, (ch) => {
      ch.passives = Array.isArray(rawPassives) ? rawPassives : ch.passives || [];
    });
    // Re-validate the full character so vPassives coerces connectivity + budget.
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    res.json(buildSetPayload(login, validated));
  }),
);

// Vampire-Survivors weapons payload: the loadout + the full available pool +
// the evolutions the loadout currently triggers + a live combat snapshot
// (in-flight gems, faint state). Mirrors buildSetPayload's shape/posture.
function weaponsPayload(login, c) {
  const run = c?.run || null;
  return {
    ok: true,
    login,
    weapons: c?.weapons || [],
    activeWeapon: c?.activeWeapon || null,
    available: WEAPON_IDS,
    maxSlots: VS_TUNABLES.maxWeaponSlots,
    evolutions: activeEvolutions(c?.weapons || [], c?.passives || []),
    fainted: c?.fainted || 0,
    lostWeapon: c?.lostWeapon || null,
    // Live combat snapshot the overlay animates.
    combat: {
      gems: run ? gemSnapshot(run) : [],
      fainted: c?.fainted || 0,
      lostWeapon: c?.lostWeapon || null,
    },
  };
}

// GET /api/sigma/:login/weapons — current VS loadout + available pool + active
// evolutions + combat snapshot. Mints/resolves the sigma like GET /api/sigma so
// a known chatter always returns a loadout.
app.get(
  "/api/sigma/:login/weapons",
  guard("GET /api/sigma/weapons", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const { token } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    if (!rec?.character) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    res.json(weaponsPayload(login, rec.character));
  }),
);

// POST /api/sigma/:login/weapons — set the VS weapon loadout. Body:
// { weapons: [ids], set?: "<activeWeaponId>" }. `set` selects the ACTIVE weapon
// (the slot lost on a faint); omitted → defaults to the first weapon. vCharacter
// (vWeapons/vWeaponId) drops unknown ids, de-dupes, slot-caps, and reconciles
// the active slot. Coerce, never reject. Returns the standard weapons payload.
app.post(
  "/api/sigma/:login/weapons",
  guard("sigma.weapons", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const raw = resolveExistingChar(login);
    if (!raw) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    const { token, character: c } = raw;
    if (Array.isArray(req.body?.weapons)) c.weapons = req.body.weapons;
    // `set` (or `active`) chooses which weapon is the ACTIVE slot (lost on faint).
    const rawActive = req.body?.set ?? req.body?.active;
    if (rawActive != null) c.activeWeapon = rawActive;
    // Re-validate so vWeapons/vWeaponId coerce ids + reconcile the active slot.
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    res.json(weaponsPayload(login, validated));
  }),
);

// POST /api/sigma/:login/reserve — set reserved aura ids for the active or
// specified build set. Body: { reserved: [ids], set?: "A"|"B" }.
// vReserved (inside vCharacter) drops unknown ids + clamps to the spirit pool.
// Returns the standard Project Ascendant build payload.
app.post(
  "/api/sigma/:login/reserve",
  guard("sigma.reserve", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const raw = resolveExistingChar(login);
    if (!raw) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    const { token, character: c } = raw;
    const rawReserved = req.body?.reserved;
    const setParam = vEnum(req.body?.set, ["A", "B"], null);
    withBuildSet(c, setParam, (ch) => {
      ch.reserved = Array.isArray(rawReserved) ? rawReserved : ch.reserved || [];
    });
    // Re-validate so vReserved coerces unknown ids + clamps to the spirit pool.
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    res.json(buildSetPayload(login, validated));
  }),
);

// POST /api/sigma/:login/position — set the tactical position for the active or
// specified build set. Body: { position: "front"|"mid"|"back", set?: "A"|"B" }.
// Unknown values coerce to "mid" (vEnum inside vCharacter). Returns the standard
// Project Ascendant build payload.
app.post(
  "/api/sigma/:login/position",
  guard("sigma.position", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const raw = resolveExistingChar(login);
    if (!raw) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    const { token, character: c } = raw;
    const rawPosition = req.body?.position;
    const setParam = vEnum(req.body?.set, ["A", "B"], null);
    withBuildSet(c, setParam, (ch) => {
      // Apply the raw value; vCharacter will coerce unknown → "mid".
      ch.position = rawPosition;
    });
    const validated = vCharacter(c);
    store.putPlayer(token, validated);
    res.json(buildSetPayload(login, validated));
  }),
);

// Real gear swap: move run.inventory[index] into run.gear[slot] and bench the
// previously-equipped piece back into the bag. The item's own .slot must match
// the target slot (a weapon can't go in the ring slot). Persists via the same
// store.putPlayer path the other sigma mutations use, then re-syncs the arena
// entry's cached maxHp/attack/weapon (arena.pingChatter → mintOrRefresh) so a
// chatter who equips mid-stream fights at the new power.
app.post(
  "/api/sigma/:login/equip",
  guard("POST /api/sigma/equip", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    // Coerce the two inputs up front; equipFromInventory revalidates strictly
    // (slot ∈ GEAR_SLOTS, integer index in range, item.slot === slot) so the
    // swap math lives in exactly one place (shared with autoEquip's pattern).
    const slot = String(req.body?.slot || "");
    const index = Number(req.body?.index);
    const { token } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    if (!rec?.character) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    ensureStarterGear(rec.character);
    const run = rec.character.run;
    const swap = equipFromInventory(run, slot, index);
    if (!swap.ok) {
      res.status(400).json({ ok: false, error: swap.error });
      return;
    }
    // A displaced piece that didn't fit the bag was vendored to gold (cap-safe).
    if (swap.vendoredGold) rec.character.gold = (rec.character.gold || 0) + swap.vendoredGold;
    // Re-derive: a worse armor swap can leave run.hp above the new maxHp, so
    // clamp it (mirrors arena.js "synced if the chatter levelled / equipped").
    const maxHp = derive(run, rec.character).maxHp;
    if (run.hp > maxHp) run.hp = maxHp;
    store.putPlayer(token, rec.character);
    // Re-sync the arena roster entry's cached power off the persisted character.
    arena.pingChatter(login, "equip");
    res.json({ ok: true, login, ...loadoutPayload(rec.character) });
  }),
);

// Spend gold to bump the chatter's weapon by +1. Cost ramps polynomially
// per upgradeCost(). Capped at WEAPON_PLUS_MAX. Each tier unlocks the
// next weapon art (see shared/weapons.js arts ladder). Mints the sigma
// if missing so a brand-new chatter can `!upgrade` on their first
// session — the starter Bare Fists upgrades into a real Brawler ladder.
app.post(
  "/api/upgrade-weapon/:login",
  guard("POST /api/upgrade-weapon", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ ok: false, error: "invalid login" });
      return;
    }
    const { token } = resolveTwitchSigma(login);
    const rec = store.getPlayer(token);
    if (!rec?.character) {
      res.status(404).json({ ok: false, error: "no character" });
      return;
    }
    ensureStarterGear(rec.character);
    const weapon = rec.character.run.gear.weapon;
    const currentPlus = weapon.plus | 0;
    if (currentPlus >= WEAPON_PLUS_MAX) {
      res.status(400).json({ ok: false, error: "max_plus", plus: currentPlus });
      return;
    }
    const cost = upgradeCost(currentPlus);
    const gold = rec.character.gold || 0;
    if (gold < cost) {
      res.status(402).json({ ok: false, error: "insufficient_gold", need: cost, have: gold });
      return;
    }
    rec.character.gold = gold - cost;
    weapon.plus = currentPlus + 1;
    weapon.power = itemPower(weapon);
    store.putPlayer(token, rec.character);
    const arts = unlockedArts(weapon.family, weapon.plus);
    res.json({
      ok: true,
      token,
      login,
      weapon: summarizeItem(weapon),
      arts: arts.map((a) => ({ id: a.id, name: a.name, desc: a.desc, plus: a.plus })),
      goldSpent: cost,
      goldRemaining: rec.character.gold,
    });
  }),
);

// Boss-spawn fanout target. HMAC-verified (raw-body signed). External
// callers: sigmashake-twitch-events (channel.raid, hype-train proxy),
// or the OBS chat handler when it sees a USERNOTICE/raid. The boss
// goes onto the live feed + a t:'bossSpawn' frame triggers the overlay
// banner. Duplicate event_ids are no-ops so retries are safe.
app.post(
  "/api/spawn-boss",
  express.text({ type: "*/*", limit: "16kb" }),
  guard("POST /api/spawn-boss", (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (MMO_HMAC_KEY) {
      const sig = String(req.get("X-MMO-Signature") || "");
      if (!sig || !timingSafeEq(sig, hmacSign(raw, MMO_HMAC_KEY))) {
        res.status(403).json({ error: "bad signature" });
        return;
      }
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }

    const event_id = String(body.event_id ?? "").slice(0, 80);
    const boss_id = String(body.boss_id ?? "goblin_king");
    const reason = String(body.reason ?? "event").slice(0, 24);
    const announce = String(body.announce ?? "").slice(0, 160);
    const fromLogin = String(body.from_login ?? "")
      .toLowerCase()
      .slice(0, 32);

    if (!SPAWNABLE_BOSSES.has(boss_id)) {
      res.status(400).json({ error: `unknown boss_id; valid: ${[...SPAWNABLE_BOSSES].join("|")}` });
      return;
    }
    if (event_id && store.markBossEvent(event_id)) {
      res.json({ ok: true, deduped: true, boss_id });
      return;
    }
    const def = ENEMIES[boss_id];
    const at = Date.now();
    const entry = store.pushFeed({
      kind: "boss",
      boss_id,
      name: def.name,
      reason,
      fromLogin,
      announce,
      at,
    });
    rt.broadcast({ t: "feed", entry });
    rt.broadcast({
      t: "bossSpawn",
      boss_id,
      name: def.name,
      hue: def.hue,
      lpc: def.lpc || null,
      reason,
      fromLogin,
      announce,
      at,
    });
    // The banner is the cinematic; the raid is the gameplay. Chatters
    // !fight to chip the shared HP bar — this is the co-op surface.
    if (!currentRaid) startRaid(boss_id, reason, fromLogin);
    res.json({ ok: true, boss_id, name: def.name, raid: raidPublic(currentRaid) });
  }),
);

// Agent-session event. Fires when a coding agent (claude-code, cursor,
// codex, …) spawns a session — typically wired from the agent host's
// SessionStart hook via a backgrounded curl. HMAC-verified the same way
// /api/spawn-boss is. event_id is required; duplicates are no-ops so the
// hook can be fire-and-forget without retry guards.
//
// Body: { event_id, agent, source?, cwd?, viewers?, flavor? }
//   - viewers (optional int): scale drop intensity by live YouTube viewers
//   - flavor (optional): force 'boss' | 'shower' | 'xp_burst' (else random)
app.post(
  "/api/agent-session",
  express.text({ type: "*/*", limit: "8kb" }),
  guard("POST /api/agent-session", (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    if (MMO_HMAC_KEY) {
      const sig = String(req.get("X-MMO-Signature") || "");
      if (!sig || !timingSafeEq(sig, hmacSign(raw, MMO_HMAC_KEY))) {
        res.status(403).json({ error: "bad signature" });
        return;
      }
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }

    const event_id = String(body.event_id ?? "").slice(0, 80);
    const agent = String(body.agent ?? "generic")
      .toLowerCase()
      .slice(0, 24);
    const source = String(body.source ?? "session-start").slice(0, 32);
    const cwd = String(body.cwd ?? "").slice(0, 200);
    // Caller can pass a viewer count explicitly; otherwise we fall back
    // to the freshest YouTube+Twitch numbers chat-elixir last pushed.
    const explicitViewers = Number(body.viewers);
    const cachedViewers = lastViewers.youtube + lastViewers.twitch;
    const viewers = Math.max(
      0,
      Math.min(
        1000,
        Number.isFinite(explicitViewers) && explicitViewers > 0 ? explicitViewers : cachedViewers,
      ),
    );
    const requested = String(body.flavor ?? "").toLowerCase();

    if (!SESSION_AGENT_KINDS.has(agent)) {
      res
        .status(400)
        .json({ error: `unknown agent; valid: ${[...SESSION_AGENT_KINDS].join("|")}` });
      return;
    }
    if (!event_id) {
      res.status(400).json({ error: "event_id required" });
      return;
    }
    if (store.markBossEvent(`session:${event_id}`)) {
      res.json({ ok: true, deduped: true });
      return;
    }

    // Intensity ≈ 1 baseline; each 5 YT viewers nudges +0.5; cap at 4.
    const intensity = Math.max(1, Math.min(4, 1 + viewers / 10));

    // Flavor pick: respect explicit body.flavor when valid, else weight
    // boss low (cinematic), shower high (most fun), xp_burst middle.
    let flavor = SESSION_FLAVORS.includes(requested) ? requested : null;
    if (!flavor) {
      const r = Math.random();
      if (r < 0.15) flavor = "boss";
      else if (r < 0.65) flavor = "shower";
      else flavor = "xp_burst";
    }

    const out = firePulse({
      flavor,
      intensity,
      viewers,
      announceFor: agent,
      feedKind: "agent_session",
      feedExtras: { agent, source, cwd: cwd || null },
      reason: "agent_session",
      bossReason: `agent:${agent}`,
    });
    res.json({ ok: true, agent, source, ...out });
  }),
);

// Shared pulse machinery: turns a (flavor, intensity) into drops/raid +
// broadcast + feed. Called by both /api/agent-session (external trigger)
// and the ambient arena pulse below.
function firePulse({
  flavor,
  intensity,
  viewers = 0,
  announceFor = "the abyss",
  feedKind = "pulse",
  feedExtras = {},
  reason = "pulse",
  bossReason = "pulse",
}) {
  const at = Date.now();
  let resolvedFlavor = flavor;
  let bossId = null;

  if (resolvedFlavor === "boss") {
    bossId = SESSION_BOSS_POOL[Math.floor(Math.random() * SESSION_BOSS_POOL.length)];
    if (!currentRaid) {
      startRaid(bossId, bossReason, "");
    } else {
      // Raid already going — fall back to a shower so the pulse still
      // produces something on-screen.
      resolvedFlavor = "shower";
    }
  }

  let spawned = [];
  if (resolvedFlavor === "shower") {
    spawned = drops.spawnSessionDrops({ intensity, itemLevel: 5 + Math.round(viewers / 10) });
  } else if (resolvedFlavor === "xp_burst") {
    spawned = drops.spawnXpBurst({ intensity });
  }

  const announce =
    resolvedFlavor === "boss"
      ? `${announceFor} summons a boss — chat to grab!`
      : resolvedFlavor === "shower"
        ? `${announceFor} rains loot — chat to grab!`
        : `${announceFor} scatters XP — chat to grab!`;

  const entry = store.pushFeed({
    kind: feedKind,
    flavor: resolvedFlavor,
    intensity,
    viewers,
    count: spawned.length,
    at,
    ...feedExtras,
  });
  rt.broadcast({ t: "feed", entry });
  rt.broadcast({
    t: "sessionEvent",
    flavor: resolvedFlavor,
    intensity,
    viewers,
    announce,
    at,
    ...feedExtras,
  });
  if (spawned.length) {
    rt.broadcast({ t: "dropSpawn", drops: spawned, reason, at, ...feedExtras });
  }
  return { flavor: resolvedFlavor, intensity, viewers, spawned: spawned.length, boss_id: bossId };
}

// Read-only snapshot of currently open drops. Used by overlay reconnect.
app.get(
  "/api/drops",
  guard("GET /api/drops", (_req, res) => {
    res.json(drops.snapshot());
  }),
);

// Spatial-collision claim. The vibe-coder-sim apartment overlay
// (sigmashake-chat-elixir at :8081) iframes the arena overlay (this server's
// /overlay/arena) at z=1, paints chatter pets on its own canvas at z=2, and
// every frame posts pet screen positions into the iframe via postMessage.
// The arena script runs per-frame hit-tests against the open drop pool and
// fires this endpoint when a pet sprite walks over a drop. First hit wins —
// tryClaimById is atomic over pool.splice.
app.post(
  "/api/drops/claim/:id",
  guard("POST /api/drops/claim/:id", (req, res) => {
    const id = String(req.params.id || "").slice(0, 64);
    const login = String(req.body?.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!id.match(/^drop_[a-f0-9]+$/)) {
      res.status(400).json({ error: "invalid drop id" });
      return;
    }
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    const claim = drops.tryClaimById(login, id);
    if (claim) {
      rt.broadcast({
        t: "dropClaim",
        id: claim.drop.id,
        login: claim.login,
        summary: claim.summary,
        at: Date.now(),
      });
    }
    res.json({ ok: true, claim });
  }),
);

// Live viewer count cache. chat-elixir pushes the YouTube concurrent
// viewer count here every ~60s; the agent-session endpoint reads it as
// the default intensity input when the caller doesn't pass `viewers`.
// Twitch viewer count can be PATCHed in the same shape later.
let lastViewers = { youtube: 0, twitch: 0, at: 0 };
app.post(
  "/api/viewers",
  guard("POST /api/viewers", (req, res) => {
    const body = req.body || {};
    const yt = Math.max(0, Math.min(100_000, Number(body.youtube) || 0));
    const tw = Math.max(0, Math.min(100_000, Number(body.twitch) || 0));
    lastViewers = { youtube: yt, twitch: tw, at: Date.now() };
    res.json({ ok: true, ...lastViewers });
  }),
);
app.get(
  "/api/viewers",
  guard("GET /api/viewers", (_req, res) => {
    res.json(lastViewers);
  }),
);

// ── Raid / monster: shared co-op combat ──────────────────────────────
// A single shared monster any chatter can damage with `!fight`. Two
// sources fill the slot: startMonster() (a regular monster `!fight`
// seeks out on demand) and startRaid() (a cinematic event boss from
// /api/spawn-boss — raid / cheer / sub). Whoever `!fight`s converges on
// whatever monster is already up. XP is credited PER HIT — two chatters
// splitting one monster both earn — while on kill the gold pot is split
// by damage and a boss also drops a guaranteed item to the last hitter.
let currentRaid = null;

function raidPublic(r) {
  if (!r) return null;
  const now = Date.now();
  return {
    boss_id: r.boss_id,
    name: r.name,
    hue: r.hue,
    lpc: r.lpc || null,
    hp: r.hp,
    maxHp: r.maxHp,
    contributors: r.contributors.size,
    topContributors: [...r.contributors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([login, dmg]) => {
        // Inc5: include position in the contributor record so overlay/client can show F/M/B.
        const tok = store.getTokenByTwitch(login);
        const pos = tok ? store.getPlayer(tok)?.character?.position || "mid" : "mid";
        return { login, dmg, position: pos };
      }),
    startedAt: r.startedAt,
    // Project Ascendant Inc1: poise / stagger / enrage
    poise: r.poise,
    maxPoise: r.maxPoise,
    staggered: r.staggeredUntil > now,
    staggeredUntil: r.staggeredUntil,
    enraged: r.enrageAt > 0 && now > r.enrageAt,
    enrageAt: r.enrageAt,
    // Project Ascendant Inc3: active boss ailments (id + stacks) for the client bar.
    bossAilments: r.bossAilments
      ? [...r.bossAilments.values()].map((a) => ({ id: a.id, stacks: a.stacks }))
      : [],
  };
}

function startRaid(boss_id, reason, fromLogin) {
  const def = ENEMIES[boss_id];
  if (!def) return null;
  // Same baseline buildEncounter uses; raid bosses scale at depth 5 / level 20.
  const baseline = 26 + 20 * 7 + 5 * 4;
  // Scale HP by current roster size so an auto-engaged crowd takes tens of
  // seconds to clear the boss rather than an instant melt. Each fighter adds
  // RAID_HP_PER_FIGHTER × baseline HP on top; clamped so an empty room still
  // gets a full-size boss and the cap keeps it finite.
  const rosterSize = arena.size();
  const rosterMult = 1 + Math.min(rosterSize, 40) * RAID_HP_PER_FIGHTER;
  const maxHp = Math.max(800, Math.round(baseline * def.hp * RAID_HP_MULT * rosterMult));
  const maxPoise = Math.max(POISE_MIN, Math.round(maxHp * POISE_PER_HP));
  raidState.clear();
  currentRaid = {
    boss_id,
    name: def.name,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
    contributors: new Map(),
    xpEarned: new Map(),
    startedAt: Date.now(),
    reason,
    fromLogin,
    // Project Ascendant Inc1: poise / stagger / enrage
    poise: maxPoise,
    maxPoise,
    staggeredUntil: 0,
    enrageAt: Date.now() + ENRAGE_MS,
    // Project Ascendant Inc3: boss ailment tracking for multiplayer combos.
    // Map<ailmentId, { id, stacks, ttl, appliedBy: login, dotAcc: number }>
    bossAilments: new Map(),
  };
  // Auto-engage every chatter currently on the arena roster. No !fight needed.
  // Chatters who appear after this are engaged via the chat-ping path below.
  // refreshLastSeen() is called BEFORE engage() so the TTL reaper (arena.reap,
  // ROSTER_TTL_MS ~5min) can't evict a fighter mid-raid — eviction triggers
  // arenaLeave + later arenaJoin which renders the fighter twice on the client.
  for (const login of arena.rosterLogins()) {
    if (raidState.isEngaged(login)) continue;
    refreshLastSeen(login);
    const tok = store.getTokenByTwitch(login);
    const weapon = tok ? store.getPlayer(tok)?.character?.run?.gear?.weapon : null;
    raidState.engage(login, weapon || null);
  }
  rt.broadcast({
    t: "raidStart",
    boss_id,
    name: def.name,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
    reason,
    fromLogin,
    at: Date.now(),
  });
  return currentRaid;
}

// Spawn the next regular monster as a shared encounter — the on-demand
// half of `!fight`. Reuses the raid plumbing (one shared HP bar every
// chatter can chip, the `raidState` engage-lock, the overlay frames) so
// `!fight` always has something to commit to. It just walks
// FIGHT_MONSTER_POOL ("seek out the next monster") and scales HP with the
// lighter MONSTER_HP_MULT. Cinematic event bosses still go via startRaid.
function startMonster(fromLogin) {
  const id = FIGHT_MONSTER_POOL[fightMonsterCursor % FIGHT_MONSTER_POOL.length];
  fightMonsterCursor += 1;
  const def = ENEMIES[id];
  if (!def) return null;
  // Same L20/depth5 baseline startRaid() measures against.
  const baseline = 26 + 20 * 7 + 5 * 4;
  const maxHp = Math.max(MONSTER_HP_FLOOR, Math.round(baseline * def.hp * MONSTER_HP_MULT));
  const monsterMaxPoise = Math.max(POISE_MIN, Math.round(maxHp * POISE_PER_HP));
  raidState.clear();
  currentRaid = {
    boss_id: id,
    name: def.name,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
    contributors: new Map(),
    xpEarned: new Map(),
    startedAt: Date.now(),
    reason: "hunt",
    fromLogin: fromLogin || "",
    // Project Ascendant Inc1: poise / stagger / enrage
    poise: monsterMaxPoise,
    maxPoise: monsterMaxPoise,
    staggeredUntil: 0,
    enrageAt: Date.now() + ENRAGE_MS,
    // Project Ascendant Inc3: boss ailment tracking for multiplayer combos.
    bossAilments: new Map(),
  };
  rt.broadcast({
    t: "raidStart",
    boss_id: id,
    name: def.name,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
    reason: "hunt",
    fromLogin: fromLogin || "",
    at: Date.now(),
  });
  return currentRaid;
}

function endRaid(victory, lastHitLogin) {
  if (!currentRaid) return null;
  const raid = currentRaid;
  currentRaid = null;
  lastRaidEndedAt = Date.now();
  raidState.clear();
  const sorted = [...raid.contributors.entries()].sort((a, b) => b[1] - a[1]);
  const totalDmg = sorted.reduce((s, [, d]) => s + d, 0) || 1;
  const rewards = [];
  let drop = null;
  if (victory) {
    const def = ENEMIES[raid.boss_id];
    const isBoss = def?.kind === "boss";
    const goldPot = Math.round(raid.maxHp * 0.6);

    for (const [login, dmg] of sorted) {
      const share = dmg / totalDmg;
      const goldReward = Math.max(1, Math.round(share * goldPot));
      // XP was already banked per hit during the fight (see
      // fireRaidSwing) — `xpEarned` is what this contributor accrued
      // across all their landed swings. The end payout is gold + (for
      // bosses) the guaranteed drop only.
      const xpEarned = raid.xpEarned?.get(login) || 0;
      const tok = store.getTokenByTwitch(login);
      if (!tok) {
        rewards.push({ login, dmg, gold: 0, xp: xpEarned });
        continue;
      }
      const rec = store.getPlayer(tok);
      if (!rec?.character) {
        rewards.push({ login, dmg, gold: 0, xp: xpEarned });
        continue;
      }

      rec.character.gold = (rec.character.gold || 0) + goldReward;
      ensureStarterGear(rec.character);

      // Last-hit credit. Bosses forge a guaranteed boss-specific drop
      // into the killer's inventory (vendored to gold if the bag is
      // full so the reward is never lost); regular monsters just bank
      // the kill toward lifetime kills.
      let dropForKiller = null;
      if (login === lastHitLogin) {
        rec.character.lifetimeKills = (rec.character.lifetimeKills || 0) + 1;
        if (isBoss) {
          const lvl = rec.character.run?.level || 1;
          const item = forgeRaidDrop(raid.boss_id, lvl);
          if (item) {
            const inv = rec.character.run?.inventory;
            if (Array.isArray(inv) && inv.length < INVENTORY_MAX) {
              inv.push(item);
              dropForKiller = {
                stored: "inventory",
                name: item.name,
                rarity: item.rarity,
                slot: item.slot,
                effect: item.effect,
                flavor: item.flavor,
              };
            } else {
              rec.character.gold += item.value || 0;
              dropForKiller = {
                stored: "sold",
                name: item.name,
                rarity: item.rarity,
                slot: item.slot,
                effect: item.effect,
                flavor: item.flavor,
                gold: item.value || 0,
              };
            }
            drop = { login, item: dropForKiller };
          }
        }
      }

      rec.character.lastSeen = Date.now();
      store.putPlayer(tok, rec.character);
      rewards.push({ login, dmg, gold: goldReward, xp: xpEarned });
    }
  }
  store.pushFeed({
    kind: "boss",
    boss_id: raid.boss_id,
    name: raid.name,
    reason: victory ? "defeated" : "escaped",
    killer: lastHitLogin,
    contributors: rewards.length,
    drop: drop ? { login: drop.login, name: drop.item.name, rarity: drop.item.rarity } : null,
    at: Date.now(),
  });
  rt.broadcast({
    t: "raidDefeated",
    boss_id: raid.boss_id,
    name: raid.name,
    victory,
    killer: lastHitLogin,
    rewards,
    drop,
    at: Date.now(),
  });
  return { rewards, drop };
}

superviseInterval(
  "raid.timeout",
  () => {
    if (!currentRaid) return;
    if (Date.now() - currentRaid.startedAt > RAID_TIMEOUT_MS) {
      endRaid(false, null);
    }
  },
  15_000,
);

app.get(
  "/api/raid",
  guard("GET /api/raid", (_req, res) => {
    res.json({ raid: raidPublic(currentRaid) });
  }),
);

// Fire one raid swing for `login`. Mutates currentRaid + broadcasts the
// raidHit frame and boss counter-attack frames. Returns null if there's
// nothing to do (no raid, missing character, chatter is downed).
//
// Source-tagged: "command" = explicit `!fight`, "chat" = engaged-chatter
// auto-swing from /api/chat-ping. The bridge needs that to label things
// in chat replies; the overlay uses it to skip the chip-shake on chat
// swings (which would otherwise jitter constantly during a busy raid).
//
// `endRaidIfDead` does the kill payout when HP hits 0. Returns either
// `{ raidDefeated, drop, ...killer rewards }` on a kill or `{ dmg, hp,
// maxHp }` for a normal swing.
function fireRaidSwing(login, source = "command") {
  if (!currentRaid) return { ok: false, error: "no_active_raid" };
  const safeLogin = String(login || "").toLowerCase();
  if (!safeLogin.match(/^[a-z0-9_]{1,32}$/)) return { ok: false, error: "invalid_login" };
  const arenaHp = arena.arenaHp(safeLogin);
  if (arenaHp?.down) return { ok: false, error: "downed", respawnAt: arenaHp.downUntil };
  const { token, isNew } = resolveTwitchSigma(safeLogin);
  const rec = store.getPlayer(token);
  if (!rec?.character) return { ok: false, error: "character_missing" };
  ensureStarterGear(rec.character);
  const sheet = derive(rec.character.run, rec.character);

  // Project Ascendant — poise + stagger + enrage.
  const now = Date.now();
  const isStaggered = currentRaid.staggeredUntil > now;
  const isEnraged = currentRaid.enrageAt > 0 && now > currentRaid.enrageAt;

  // ── Inc5: Tactical Positioning bonuses (server-only, Math.random allowed). ──
  // position is an account-side field ("front"|"mid"|"back", default "mid").
  // FRONTLINE: +20% melee/atk damage + extra poise drain (+6), BUT takes +30%
  //   boss counter damage and is the preferred counter target.
  // BACKLINE: +15% crit/ranged/spell damage (applied as a flat dmg mult), BUT
  //   takes +40% counter damage if hit (targeted last, but punished harder).
  // MIDLINE: small +5% flat bonus, balanced risk.
  const position = rec.character.position || "mid";
  const wFamilyForPos = rec.character.run?.gear?.weapon?.family || "fists";
  const isMeleeFamily = ["sword", "axe", "hammer", "greatsword", "spear", "fists"].includes(
    wFamilyForPos,
  );
  const isRangedFamily = ["bow", "wand", "staff", "dagger"].includes(wFamilyForPos);
  let posDmgMul = 1.0;
  let posExtraPoiseDrain = 0;
  let posCounterMul = 1.0; // multiplier applied to incoming boss counter damage
  if (position === "front") {
    if (isMeleeFamily) posDmgMul = 1.2;
    else posDmgMul = 1.08; // melee bonus is smaller for ranged weapons at front
    posExtraPoiseDrain = 6;
    posCounterMul = 1.3; // frontliners take more counter damage (exposed)
  } else if (position === "back") {
    if (isRangedFamily) posDmgMul = 1.15;
    else posDmgMul = 1.05; // smaller bonus for melee weapons at backline
    posExtraPoiseDrain = 0;
    posCounterMul = 1.4; // fragile if hit; targeted last but hit hard
  } else {
    // mid — small flat bonus, moderate risk
    posDmgMul = 1.05;
    posCounterMul = 1.0;
  }

  // Damage: stagger window grants +50% and forced crit (mul already in sheet.critMult).
  const swingMul = isStaggered ? 1.5 : 1.0;
  let dmg = Math.max(
    1,
    Math.round(sheet.attack * swingMul * posDmgMul * (0.85 + Math.random() * 0.4)),
  );
  if (isStaggered) {
    // Guaranteed crit during stagger — apply critMult on top.
    dmg = Math.max(1, Math.round(dmg * (sheet.critMult || 1.5)));
  }
  currentRaid.hp = Math.max(0, currentRaid.hp - dmg);
  currentRaid.contributors.set(safeLogin, (currentRaid.contributors.get(safeLogin) || 0) + dmg);

  // ── Project Ascendant Inc3: boss ailments + multiplayer combos ────────
  // Server-only Math.random allowed here (raid layer, not shared/).
  const wFamily = rec.character.run?.gear?.weapon?.family || "fists";
  const wPlus = rec.character.run?.gear?.weapon?.plus | 0;
  const ailmentSpec = weaponAilment(wFamily, wPlus);
  let comboResult = null;
  if (ailmentSpec && currentRaid.hp > 0) {
    // Proc roll — Math.random is fine in server/
    if (Math.random() < ailmentSpec.procChance) {
      const existing = currentRaid.bossAilments.get(ailmentSpec.id);
      // Check for a cross-fighter combo BEFORE applying/refreshing the ailment.
      // A combo fires when: (a) the ailment is already on the boss, (b) the
      // trigger for this weapon family matches a combo that requires that ailment,
      // AND (c) it was applied by a DIFFERENT fighter (cross-fighter payoff).
      const trigger = familyTrigger(wFamily);
      if (trigger && existing && existing.appliedBy !== safeLogin) {
        const combo = detectCombo(trigger, [existing.id]);
        if (combo) {
          // Bonus damage — apply multiplier to the base swing dmg.
          const bonusDmg = Math.max(1, Math.round(dmg * (combo.mul - 1)));
          currentRaid.hp = Math.max(0, currentRaid.hp - bonusDmg);
          currentRaid.contributors.set(
            safeLogin,
            (currentRaid.contributors.get(safeLogin) || 0) + bonusDmg,
          );
          dmg += bonusDmg;
          comboResult = {
            combo: combo.id,
            label: combo.label,
            trigger: safeLogin,
            source: existing.appliedBy,
            bonusDmg,
          };
          // Consume the ailment if the combo spec says so.
          if (combo.consumes) currentRaid.bossAilments.delete(existing.id);
        }
      }
      // Apply / refresh the ailment on the boss (only if combo didn't consume it
      // or there was no combo).
      if (!currentRaid.bossAilments.has(ailmentSpec.id)) {
        currentRaid.bossAilments.set(ailmentSpec.id, {
          id: ailmentSpec.id,
          stacks: ailmentSpec.stacks,
          ttl: ailmentSpec.ttl,
          appliedBy: safeLogin,
          dotAcc: 0,
        });
      } else {
        // Refresh ttl and re-attribute to this fighter (they refreshed it).
        const a = currentRaid.bossAilments.get(ailmentSpec.id);
        a.ttl = Math.max(a.ttl, ailmentSpec.ttl);
        a.stacks = Math.min(a.stacks + ailmentSpec.stacks, 5);
        a.appliedBy = safeLogin;
      }
    }
  }
  // Broadcast combo event + feed line when a cross-fighter combo fires.
  if (comboResult) {
    rt.broadcast({
      t: "raidCombo",
      combo: comboResult.combo,
      label: comboResult.label,
      trigger: comboResult.trigger,
      source: comboResult.source,
      bonusDmg: comboResult.bonusDmg,
      hp: currentRaid.hp,
      maxHp: currentRaid.maxHp,
      at: Date.now(),
    });
    store.pushFeed({
      kind: "raid_combo",
      combo: comboResult.label,
      trigger: comboResult.trigger,
      source: comboResult.source,
      bonusDmg: comboResult.bonusDmg,
      bossName: currentRaid.name,
      at: Date.now(),
    });
  }
  // ── end Inc3 ──────────────────────────────────────────────────────────

  // Drain poise by the swinger's weapon family + Inc5 frontline bonus.
  if (!isStaggered && currentRaid.poise > 0) {
    const wFamily = rec.character.run?.gear?.weapon?.family || "fists";
    const poiseDrain = (POISE_PER_SWING_BY_FAMILY[wFamily] || 10) + posExtraPoiseDrain;
    currentRaid.poise = Math.max(0, currentRaid.poise - poiseDrain);
    if (currentRaid.poise === 0) {
      // Stagger!
      currentRaid.staggeredUntil = now + STAGGER_MS;
      rt.broadcast({ t: "stagger", until: currentRaid.staggeredUntil, at: now });
    }
  } else if (isStaggered && currentRaid.staggeredUntil <= now) {
    // Stagger just ended — reset poise.
    currentRaid.poise = currentRaid.maxPoise;
    currentRaid.staggeredUntil = 0;
  }

  // XP on hit — every landed swing banks XP immediately, scaled to the
  // damage that swing dealt. Two chatters on the same monster each bank
  // XP from their own swings, so a shared kill is never "stolen" by
  // whoever lands the killing blow.
  const monDef = ENEMIES[currentRaid.boss_id];
  const xpMult = monDef?.kind === "boss" ? RAID_XP_MULT : MONSTER_XP_MULT;
  const xpValue = Math.round((monDef?.xp || 1) * xpMult);
  const xpForHit = Math.max(1, Math.round((xpValue * dmg) / Math.max(1, currentRaid.maxHp)));
  let xpGained = 0;
  let levelsGained = 0;
  let newLevel = rec.character.run?.level || 1;
  if (rec.character.run && rec.character.run.alive !== false) {
    const xpRes = gainXp(rec.character.run, xpForHit, rec.character);
    xpGained = xpForHit;
    levelsGained = xpRes.levelsGained || 0;
    newLevel = xpRes.newLevel || newLevel;
  }
  currentRaid.xpEarned.set(safeLogin, (currentRaid.xpEarned.get(safeLogin) || 0) + xpGained);

  rec.character.lastSeen = Date.now();
  rec.character.twitchLogin = safeLogin;
  store.putPlayer(token, rec.character);

  const at = Date.now();
  // Re-read stagger/enrage after poise logic above may have changed state.
  const nowAfterPoise = Date.now();
  rt.broadcast({
    t: "raidHit",
    login: safeLogin,
    dmg,
    hp: currentRaid.hp,
    maxHp: currentRaid.maxHp,
    poise: currentRaid.poise,
    maxPoise: currentRaid.maxPoise,
    staggered: currentRaid.staggeredUntil > nowAfterPoise,
    enraged: isEnraged,
    contributors: currentRaid.contributors.size,
    xp: xpGained,
    level: newLevel,
    source,
    at,
  });

  // Boss counter-attack — suppressed while boss is staggered (it's incapacitated).
  // 50% chance per landed swing for explicit commands, 35% for chat-driven swings.
  // Inc5: frontline is targeted first (counter bias) — raise chance by 10pp.
  //       backline is targeted last — lower chance by 10pp, but posCounterMul ×1.4 if hit.
  // Enrage doubles counter damage.
  const baseCounterChance = source === "chat" ? 0.35 : 0.5;
  const posCounterBias = position === "front" ? 0.1 : position === "back" ? -0.1 : 0;
  const counterChance = Math.min(0.9, Math.max(0.1, baseCounterChance + posCounterBias));
  if (!isStaggered && Math.random() < counterChance && currentRaid.hp > 0) {
    const bossDef = ENEMIES[currentRaid.boss_id];
    const counterBase = Math.max(6, Math.round((bossDef?.attack || 10) * 0.6));
    let counterDmg = counterBase + Math.round(Math.random() * counterBase * 0.6);
    // Enrage: boss counter damage ×2. Inc5 position: apply vulnerability multiplier.
    if (isEnraged) counterDmg = Math.round(counterDmg * 2);
    counterDmg = Math.max(1, Math.round(counterDmg * posCounterMul));
    const counterFrames = arena.applyBossCounter(safeLogin, currentRaid.name, counterDmg, true);
    for (const f of counterFrames) rt.broadcast(f);
    // If the counter knocks the chatter out, force-disengage so chat
    // pings don't keep wasting swings while they're on the floor.
    if (counterFrames.some((f) => f.t === "arenaDown")) raidState.disengage(safeLogin);
  }

  if (currentRaid.hp === 0) {
    const totalXp = currentRaid.xpEarned.get(safeLogin) || xpGained;
    const result = endRaid(true, safeLogin);
    const killerReward = result?.rewards?.find((r) => r.login === safeLogin) || null;
    return {
      ok: true,
      dmg,
      isNew,
      raidDefeated: true,
      drop: result?.drop || null,
      killerXp: totalXp,
      killerGold: killerReward?.gold || 0,
      levelsGained,
      newLevel,
    };
  }
  return {
    ok: true,
    dmg,
    isNew,
    hp: currentRaid.hp,
    maxHp: currentRaid.maxHp,
    xpGained,
    levelsGained,
    newLevel,
  };
}

app.post(
  "/api/raid/fight/:login",
  guard("POST /api/raid/fight", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    // Seek out the next monster — `!fight` with nothing already up
    // spawns one rather than no-opping, so combat is always available.
    // An event boss (spawn-boss) already occupying the slot is fought
    // as-is; everyone who !fights converges on the same shared monster.
    let spawned = false;
    if (!currentRaid) {
      if (startMonster(login)) spawned = true;
    }
    if (!currentRaid) {
      res.status(503).json({ ok: false, error: "spawn_failed" });
      return;
    }
    // Put the chatter on the arena canvas so the overlay shows them and
    // so monster counter-attacks can land on their HP bar.
    const arenaJoin = arena.pingChatter(login, "fight");
    if (arenaJoin) rt.broadcast(arenaJoin);
    const monsterName = currentRaid.name;
    const result = fireRaidSwing(login, "command");
    if (!result.ok) {
      // Surface "downed" explicitly so the bridge can tell chat the
      // chatter is on the floor (rather than printing a generic error).
      const status = result.error === "downed" ? 423 : 400;
      res.status(status).json({ ...result, spawned, monsterName });
      return;
    }
    // Engage so chat lines keep swinging until the monster is dead, the
    // chatter !runs, or they're knocked out — combat stays locked on.
    const { token } = resolveTwitchSigma(login);
    const weapon = store.getPlayer(token)?.character?.run?.gear?.weapon;
    raidState.engage(login, weapon);
    res.json({ ...result, spawned, monsterName });
  }),
);

// !run / !flee — disengage from the active raid. Idempotent; harmless
// if the chatter isn't engaged.
app.post(
  "/api/raid/run/:login",
  guard("POST /api/raid/run", (req, res) => {
    const login = String(req.params.login || "")
      .toLowerCase()
      .slice(0, 32);
    if (!login.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    const wasEngaged = raidState.disengage(login);
    res.json({ ok: true, wasEngaged });
  }),
);

// ── PvP: duel arena (mutual agreement, gold staked) ──────────────────
// `pendingDuels` is keyed by the sorted login pair, so a duplicate
// challenge in either direction collapses to one record. `activeDuel`
// is a singleton — the overlay only renders one duel at a time.
const pendingDuels = new Map();
let activeDuel = null;

function duelKey(a, b) {
  return [a, b].sort().join(":");
}

function duelPublic() {
  if (!activeDuel) return null;
  return {
    loginA: activeDuel.loginA,
    loginB: activeDuel.loginB,
    wager: activeDuel.wager,
    round: activeDuel.round,
    a: { name: activeDuel.a.name, hp: Math.round(activeDuel.a.hp), maxHp: activeDuel.a.maxHp },
    b: { name: activeDuel.b.name, hp: Math.round(activeDuel.b.hp), maxHp: activeDuel.b.maxHp },
    startedAt: activeDuel.startedAt,
  };
}

function startDuel(loginA, loginB, wager, tokenA, tokenB) {
  const recA = store.getPlayer(tokenA);
  const recB = store.getPlayer(tokenB);
  if (!recA?.character || !recB?.character) return false;
  ensureStarterGear(recA.character);
  ensureStarterGear(recB.character);
  const sheetA = derive(recA.character.run, recA.character);
  const sheetB = derive(recB.character.run, recB.character);
  activeDuel = {
    loginA,
    loginB,
    wager,
    tokenA,
    tokenB,
    round: 0,
    startedAt: Date.now(),
    a: {
      name: recA.character.name,
      hp: sheetA.maxHp,
      maxHp: sheetA.maxHp,
      atk: sheetA.attack,
      def: sheetA.defense,
      crit: sheetA.critChance,
      critMult: sheetA.critMult,
    },
    b: {
      name: recB.character.name,
      hp: sheetB.maxHp,
      maxHp: sheetB.maxHp,
      atk: sheetB.attack,
      def: sheetB.defense,
      crit: sheetB.critChance,
      critMult: sheetB.critMult,
    },
  };
  rt.broadcast({
    t: "duelStart",
    loginA,
    loginB,
    wager,
    a: { name: activeDuel.a.name, hp: activeDuel.a.hp, maxHp: activeDuel.a.maxHp },
    b: { name: activeDuel.b.name, hp: activeDuel.b.hp, maxHp: activeDuel.b.maxHp },
    at: Date.now(),
  });
  const tickId = setInterval(() => {
    if (!activeDuel) {
      clearInterval(tickId);
      return;
    }
    activeDuel.round += 1;
    const a = activeDuel.a,
      b = activeDuel.b;
    const aCrit = Math.random() < a.crit;
    const bCrit = Math.random() < b.crit;
    const aDmg = Math.max(
      1,
      Math.round(a.atk * (0.85 + Math.random() * 0.3) * (aCrit ? a.critMult : 1) - b.def * 0.4),
    );
    const bDmg = Math.max(
      1,
      Math.round(b.atk * (0.85 + Math.random() * 0.3) * (bCrit ? b.critMult : 1) - a.def * 0.4),
    );
    b.hp = Math.max(0, b.hp - aDmg);
    if (b.hp > 0) a.hp = Math.max(0, a.hp - bDmg);
    rt.broadcast({
      t: "duelTick",
      round: activeDuel.round,
      a: { hp: Math.round(a.hp), dmg: aDmg, crit: aCrit },
      b: { hp: Math.round(b.hp), dmg: bDmg, crit: bCrit },
      at: Date.now(),
    });
    if (a.hp <= 0 || b.hp <= 0 || activeDuel.round >= DUEL_MAX_ROUNDS) {
      clearInterval(tickId);
      let winnerSide;
      if (a.hp <= 0 && b.hp <= 0) winnerSide = a.maxHp >= b.maxHp ? "a" : "b";
      else if (a.hp <= 0) winnerSide = "b";
      else if (b.hp <= 0) winnerSide = "a";
      else winnerSide = a.hp >= b.hp ? "a" : "b";
      finishDuel(winnerSide);
    }
  }, DUEL_TICK_MS);
  return true;
}

function finishDuel(winnerSide) {
  if (!activeDuel) return;
  const d = activeDuel;
  activeDuel = null;
  const winnerLogin = winnerSide === "a" ? d.loginA : d.loginB;
  const loserLogin = winnerSide === "a" ? d.loginB : d.loginA;
  const winnerToken = winnerSide === "a" ? d.tokenA : d.tokenB;
  const pot = d.wager * 2;
  const winnerRec = store.getPlayer(winnerToken);
  if (winnerRec?.character) {
    winnerRec.character.gold = (winnerRec.character.gold || 0) + pot;
    store.putPlayer(winnerToken, winnerRec.character);
  }
  store.pushFeed({
    kind: "duel_end",
    winner: winnerLogin,
    loser: loserLogin,
    wager: d.wager,
    pot,
    at: Date.now(),
  });
  rt.broadcast({
    t: "duelEnd",
    winner: winnerLogin,
    loser: loserLogin,
    wager: d.wager,
    pot,
    a: { hp: Math.round(d.a.hp), maxHp: d.a.maxHp },
    b: { hp: Math.round(d.b.hp), maxHp: d.b.maxHp },
    at: Date.now(),
  });
}

superviseInterval(
  "duel.expire",
  () => {
    const now = Date.now();
    for (const [k, p] of pendingDuels) {
      if (now - p.createdAt > DUEL_TIMEOUT_MS) {
        pendingDuels.delete(k);
        rt.broadcast({ t: "duelExpired", challenger: p.challenger, defender: p.defender, at: now });
      }
    }
  },
  10_000,
);

app.get(
  "/api/duel",
  guard("GET /api/duel", (_req, res) => {
    res.json({
      active: duelPublic(),
      pending: [...pendingDuels.values()].map((p) => ({
        challenger: p.challenger,
        defender: p.defender,
        wager: p.wager,
        expiresIn: Math.max(0, DUEL_TIMEOUT_MS - (Date.now() - p.createdAt)),
      })),
    });
  }),
);

app.post(
  "/api/duel/challenge",
  guard("POST /api/duel/challenge", (req, res) => {
    const challenger = String(req.body?.challenger || "")
      .toLowerCase()
      .slice(0, 32);
    const defender = String(req.body?.defender || "")
      .toLowerCase()
      .slice(0, 32);
    const wager = Math.max(
      DUEL_MIN_WAGER,
      Math.min(DUEL_MAX_WAGER, Math.floor(Number(req.body?.wager) || DUEL_MIN_WAGER)),
    );
    if (!challenger.match(/^[a-z0-9_]{1,32}$/) || !defender.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    if (challenger === defender) {
      res.json({ ok: false, error: "self_duel" });
      return;
    }
    if (activeDuel) {
      res.json({ ok: false, error: "duel_in_progress" });
      return;
    }
    const { token } = resolveTwitchSigma(challenger);
    const rec = store.getPlayer(token);
    const bal = rec?.character?.gold || 0;
    if (bal < wager) {
      res.json({ ok: false, error: "insufficient_gold", balance: bal, wager });
      return;
    }
    resolveTwitchSigma(defender); // mint defender side so /api/sigma works for them
    const key = duelKey(challenger, defender);
    pendingDuels.set(key, { challenger, defender, wager, createdAt: Date.now() });
    rt.broadcast({ t: "duelChallenge", challenger, defender, wager, at: Date.now() });
    res.json({ ok: true, wager });
  }),
);

app.post(
  "/api/duel/accept",
  guard("POST /api/duel/accept", (req, res) => {
    const accepter = String(req.body?.accepter || "")
      .toLowerCase()
      .slice(0, 32);
    const challenger = String(req.body?.challenger || "")
      .toLowerCase()
      .slice(0, 32);
    if (!accepter.match(/^[a-z0-9_]{1,32}$/) || !challenger.match(/^[a-z0-9_]{1,32}$/)) {
      res.status(400).json({ error: "invalid login" });
      return;
    }
    if (activeDuel) {
      res.json({ ok: false, error: "duel_in_progress" });
      return;
    }
    const key = duelKey(challenger, accepter);
    const pending = pendingDuels.get(key);
    if (!pending || pending.challenger !== challenger || pending.defender !== accepter) {
      res.json({ ok: false, error: "no_challenge" });
      return;
    }
    const cTok = resolveTwitchSigma(challenger).token;
    const aTok = resolveTwitchSigma(accepter).token;
    const cRec = store.getPlayer(cTok);
    const aRec = store.getPlayer(aTok);
    if ((cRec.character.gold || 0) < pending.wager) {
      pendingDuels.delete(key);
      res.json({ ok: false, error: "challenger_broke" });
      return;
    }
    if ((aRec.character.gold || 0) < pending.wager) {
      res.json({ ok: false, error: "insufficient_gold", balance: aRec.character.gold || 0 });
      return;
    }
    pendingDuels.delete(key);
    // Escrow both wagers
    cRec.character.gold -= pending.wager;
    aRec.character.gold -= pending.wager;
    store.putPlayer(cTok, cRec.character);
    store.putPlayer(aTok, aRec.character);
    if (!startDuel(challenger, accepter, pending.wager, cTok, aTok)) {
      // Refund if something exploded
      cRec.character.gold += pending.wager;
      aRec.character.gold += pending.wager;
      store.putPlayer(cTok, cRec.character);
      store.putPlayer(aTok, aRec.character);
      res.status(500).json({ ok: false, error: "duel_start_failed" });
      return;
    }
    res.json({ ok: true, wager: pending.wager });
  }),
);

app.post(
  "/api/duel/decline",
  guard("POST /api/duel/decline", (req, res) => {
    const decliner = String(req.body?.decliner || "")
      .toLowerCase()
      .slice(0, 32);
    const challenger = String(req.body?.challenger || "")
      .toLowerCase()
      .slice(0, 32);
    const key = duelKey(challenger, decliner);
    const pending = pendingDuels.get(key);
    if (pending) {
      pendingDuels.delete(key);
      rt.broadcast({
        t: "duelDeclined",
        challenger: pending.challenger,
        defender: pending.defender,
        at: Date.now(),
      });
    }
    res.json({ ok: true });
  }),
);

// Render-only broadcast view for OBS browser source. Served before the
// static handler so /overlay (no extension) resolves cleanly. Subscribes
// to the same WS but never sends a `hello` — so it doesn't count as a
// player. The page does not import the playable client.
app.get(
  "/overlay",
  guard("GET /overlay", (_req, res) => {
    res.sendFile(path.join(ROOT, "client", "overlay.html"));
  }),
);

// Compact in-scene panel (720×420 native, designed for a corner spot on
// the main streaming scene). Auto-installed by sigmashake-obs/src/
// mmo-overlay-setup.ts.
app.get(
  "/overlay/panel",
  guard("GET /overlay/panel", (_req, res) => {
    res.sendFile(path.join(ROOT, "client", "overlay-panel.html"));
  }),
);

// Sigmacraft playtest interface — world map + interaction actions + a 2D
// side-scrolling zone pane. A standalone test surface for the Sigmacraft layer;
// drives the real welcome/intent/snapshot path (integrate-this).
app.get(
  "/sigmacraft",
  guard("GET /sigmacraft", (_req, res) => {
    res.sendFile(path.join(ROOT, "client", "sigmacraft-playtest.html"));
  }),
);

// Arena overlay — canvas-based "every chatter on stage" scene with one
// LPC avatar per active chatter, HP bars, and the auto-battle ticker.
// Designed for a full-screen OBS browser source (1920×1080); transparent
// background so it can sit on top of any base scene.
app.get(
  "/overlay/arena",
  guard("GET /overlay/arena", (_req, res) => {
    res.sendFile(path.join(ROOT, "client", "arena.html"));
  }),
);

// JSON snapshot of the arena roster — handy for diagnostics + a
// dev-tools "is my chatter showing up?" check.
app.get(
  "/api/arena",
  guard("GET /api/arena", (_req, res) => {
    res.json({ size: arena.size(), ...arena.snapshot() });
  }),
);

// ── Agent Realm + Oracle Bazaar ───────────────────────────────────────
// AI agents register for a bearer token, drive a character through
// cooldown-gated actions (agent-realm.js), and earn gold + task coins +
// oracle XP by answering inference HITs that Claude Code posts to the
// Oracle Bazaar (oracle-bazaar.js) — offloading inference onto the workers'
// own token budgets. Must register before the static catch-all below.
attachAgentRealm(app, { store, rt, guard });
// One-paste viewer onboarding: GET /play serves the curl|sh bootstrap (browser
// gets a landing page) so a viewer's agent registers + starts checking in to
// play + answer HITs in a single line.
attachPlayOnboard(app, { guard });
const oracle = attachOracleBazaar(app, {
  store,
  rt,
  guard,
  text: express.text,
  hmac: { sign: hmacSign, eq: timingSafeEq, key: MMO_HMAC_KEY },
});
superviseInterval("oracle.sweep", () => oracle.sweep(), 15_000);

// Gemma NPC proposal lane (integrate-this PR7) — its OWN supervised 15s loop,
// strictly OFF the 3s world tick. Proposes bounded controller state for one NPC
// per cycle (deterministic fallback by default; live Gemma env-gated). A slow or
// failing model call is contained here and can never enter the tick budget.
const npcPlanner = attachNpcPlanner({ store });
superviseInterval(
  "npc.plan",
  () => {
    npcPlanner.plan().catch((err) => console.error(`[npc.plan] ${err?.message || err}`));
  },
  15_000,
);

// Director / game-master (PR9) — ONE world-level brain proposing bounded public
// beats off the tick, paced (see DIRECTOR_BEAT_COOLDOWN_TICKS). Deterministic
// fallback by default; live Gemma deferred (DIRECTOR_LIVE). Its own supervised
// loop, NOT a second world timer (PSU power safety).
const director = attachDirector({ store });
superviseInterval(
  "sigmacraft.director",
  () => {
    director.propose().catch((err) => console.error(`[sigmacraft.director] ${err?.message || err}`));
  },
  30_000,
);

// ── Static ────────────────────────────────────────────────────────────
// client/ is the web root; /shared exposes the sim modules for browser
// ESM imports (the same files the server itself runs).
app.use(express.static(path.join(ROOT, "client")));
app.use("/shared", express.static(path.join(ROOT, "shared")));

// ── Supervised background loops ───────────────────────────────────────
superviseInterval("store.flush", () => store.flush(), STORE_FLUSH_MS);
superviseInterval("stats.broadcast", () => rt.broadcastStats(), STATS_BROADCAST_MS);

// THE persistent-world tick — the ONE world loop (master design §0.4 /
// §4.1). Advances faction membership + zone counters every 60s and
// broadcasts a `worldPulse`. PSU power safety: this is the only new
// background timer; all future world systems become sub-advancers of it.
// The market sweep rides this ONE world loop as a sub-advancer (master §4.1
// step 7) — expires listings, finalizes auctions, re-derives the gold gauge,
// toggles the treasury-mode brake. No second timer (PSU power safety).
// The loop now fires at WORLD_TICK_BASE_MS (≈3s) so the Sigmacraft fast lane
// feels alive; market + storyteller stay on their 60s cadence via legacyEvery.
startWorldTick({
  store,
  rt,
  superviseInterval,
  intervalMs: WORLD_TICK_BASE_MS,
  legacyEvery: LEGACY_TICK_EVERY,
  extraAdvancers: [(ctx) => market.sweep(ctx), (ctx) => storytellerLoop.advance(ctx)],
  fastAdvancers: [(ctx) => sigmacraft.advance(ctx)],
});

// Featured-arena rotator. Picks an "active" sigma (lastSeen within the
// recent window) and broadcasts a t:'featured' frame so the OBS overlay
// can pan to that chatter's character. Avoids repeating the same token
// twice in a row when more than one sigma is active. Silent when no one
// is active — the overlay stays on the last featured.
let lastFeaturedToken = null;
function pickFeaturedRecord() {
  const now = Date.now();
  const recent = store
    .allPlayers()
    .map((p) => ({ p, c: p.character }))
    .filter((x) => x.c && now - (x.c.lastSeen || 0) < FEATURED_RECENT_MS)
    .sort((a, b) => (b.c.lastSeen || 0) - (a.c.lastSeen || 0));
  if (!recent.length) return null;
  const pool = recent.slice(0, 8);
  let pick = pool[Math.floor(Math.random() * pool.length)];
  if (pool.length > 1 && pick.p.token === lastFeaturedToken) {
    pick = pool.find((x) => x.p.token !== lastFeaturedToken) || pick;
  }
  return pick;
}
superviseInterval(
  "featured.rotate",
  () => {
    const r = pickFeaturedRecord();
    if (!r) return;
    ensureStarterGear(r.c);
    const tok =
      Object.entries(store.allTwitchLinks()).find(([, t]) => t === r.p.token)?.[0] || null;
    lastFeaturedToken = r.p.token;
    const c = r.c;
    rt.broadcast({
      t: "featured",
      token: r.p.token,
      login: c.twitchLogin || tok || null,
      name: c.name,
      cosmetics: c.cosmetics || {},
      level: c.run?.level || 1,
      xp: c.run?.xp || 0,
      xpToNext: xpForLevel(c.run?.level || 1),
      depth: c.run?.depth || 0,
      zone: c.run?.zone || "town",
      hp: Math.round(c.run?.hp || 0),
      prestige: c.prestige || 0,
      gold: c.gold || 0,
      title: c.titles?.[c.titles.length - 1] || null,
      zoneName: ZONES.find((z) => z.id === (c.run?.zone || "town"))?.name || "Unknown",
      weapon: summarizeItem(c.run?.gear?.weapon),
      armor: summarizeItem(c.run?.gear?.armor),
      ring: summarizeItem(c.run?.gear?.ring),
      relic: summarizeItem(c.run?.gear?.relic),
      charm: summarizeItem(c.run?.gear?.charm),
      nextEnemy: peekNextEnemy(c),
      raid: raidPublic(currentRaid),
      at: Date.now(),
    });
  },
  FEATURED_ROTATE_MS,
);

// Arena auto-battle tick — runs every ARENA_TICK_MS (default 2.5s),
// resolves one exchange for a round-robin chatter, broadcasts every
// frame the tick produced. Also periodically broadcasts a full roster
// snapshot so a freshly-opened overlay catches up without waiting for
// per-chatter join frames.
let arenaSnapshotCursor = 0;
superviseInterval(
  "arena.tick",
  () => {
    const frames = arena.tick();
    for (const f of frames) rt.broadcast(f);
    arenaSnapshotCursor += 1;
    if (arenaSnapshotCursor >= 5) {
      arenaSnapshotCursor = 0;
      rt.broadcast({ t: "arenaRoster", ...arena.snapshot(), at: Date.now() });
    }
  },
  arena.tickIntervalMs(),
);

// Drop pool reaper. Expires un-grabbed agent-session drops on a 5s tick
// and broadcasts a single t:'dropExpire' per id so the overlay can fade
// them out. Cheap when the pool is empty (early-return inside reap()).
superviseInterval(
  "drops.reap",
  () => {
    const expired = drops.reap();
    for (const e of expired) rt.broadcast({ t: "dropExpire", id: e.id, at: e.at });
  },
  5_000,
);

// Ambient arena pulse — chatter-count + chat-volume driven.
// Tier picked from a blended score so a solo chatter can earn showers
// just by chatting actively. Boss raid still gates on chatter count
// alone (cinematic raids need a crowd, not one spammer).
if (ARENA_PULSE_MS > 0) {
  superviseInterval(
    "arena.pulse",
    () => {
      const n = arena.size();
      const recentPings = chatPingsInLast(ARENA_PULSE_VOLUME_WINDOW_MS);
      const baseScore = n + recentPings / ARENA_PULSE_VOLUME_DIVISOR;

      // Update momentum BEFORE the early-return so it decays during quiet
      // gaps even when the arena is empty.
      if (baseScore > 0) {
        pulseMomentum = Math.min(ARENA_PULSE_MOMENTUM_MAX, pulseMomentum + 0.5);
      } else {
        pulseMomentum = Math.max(0, pulseMomentum - 1);
      }
      if (baseScore <= 0) return;

      // Long-running streams gradually escalate. Bounded so a 24-hour
      // stream doesn't permanently boss-tier — caps around +1 score.
      const lifetimeBonus = Math.min(1, Math.log10(1 + lifetimePings / 50) / 2);
      const momentumMul = 1 + pulseMomentum * ARENA_PULSE_MOMENTUM_FACTOR;
      const score = (baseScore + lifetimeBonus) * momentumMul;

      const cachedViewers = lastViewers.youtube + lastViewers.twitch;
      let flavor;
      let intensity;
      if (n >= ARENA_PULSE_BOSS_AT) {
        // Boss only on a real crowd. Score from a lone spammer can't open it.
        flavor = "boss";
        intensity = 4;
      } else if (score >= 15) {
        flavor = "shower";
        intensity = 2.5 + Math.min(1.5, (score - 15) / 10);
      } else if (score >= 5) {
        flavor = "shower";
        intensity = 1.2 + (score - 5) / 10;
      } else if (score >= 2) {
        flavor = "xp_burst";
        intensity = 0.9 + (score - 2) / 3;
      } else {
        flavor = "xp_burst";
        intensity = 0.5 + score * 0.2;
      }
      firePulse({
        flavor,
        intensity,
        viewers: cachedViewers,
        announceFor: "the abyss",
        feedKind: "pulse",
        feedExtras: {
          chatters: n,
          recentPings,
          score: Math.round(score * 100) / 100,
          momentum: pulseMomentum,
          lifetimePings,
        },
        reason: "arena_pulse",
        bossReason: `arena_pulse:${n}`,
      });
    },
    ARENA_PULSE_MS,
  );
}

// Diagnostic snapshot of the pulse signal — useful for tuning thresholds
// from a shell without watching the feed.
app.get(
  "/api/arena/state",
  guard("GET /api/arena/state", (_req, res) => {
    res.json({
      chatters: arena.size(),
      recentPings: chatPingsInLast(ARENA_PULSE_VOLUME_WINDOW_MS),
      lifetimePings,
      momentum: pulseMomentum,
      pulseMs: ARENA_PULSE_MS,
      bossAt: ARENA_PULSE_BOSS_AT,
      volumeWindowMs: ARENA_PULSE_VOLUME_WINDOW_MS,
      volumeDivisor: ARENA_PULSE_VOLUME_DIVISOR,
      raid: raidPublic(currentRaid),
    });
  }),
);

// Frequent raid-state push so the overlay HP bar tracks live without
// needing a full featured frame. Cheap — single integer broadcast.
superviseInterval(
  "raid.tick",
  () => {
    if (!currentRaid) return;
    const now = Date.now();
    // Auto-reset poise after stagger window expires (covers the case where no
    // swing fires at the exact moment staggeredUntil elapses).
    if (currentRaid.staggeredUntil > 0 && now > currentRaid.staggeredUntil) {
      currentRaid.poise = currentRaid.maxPoise;
      currentRaid.staggeredUntil = 0;
    }

    // Project Ascendant Inc3: boss ailment tick — DoT pulses + TTL decay.
    // Runs every raid.tick (2.5s). Math.random fine here (server-only).
    if (currentRaid.bossAilments && currentRaid.bossAilments.size > 0) {
      for (const [id, a] of currentRaid.bossAilments) {
        const def = AILMENTS[id];
        if (!def) {
          currentRaid.bossAilments.delete(id);
          continue;
        }
        // DoT pulse — bleeding and burning deal damage each tick.
        if (def.dot && a.stacks > 0 && currentRaid.hp > 0) {
          // Base damage from the boss's max HP so it scales, not the applier's
          // attack (we don't have their sheet here). Each stack adds a pulse.
          const dotDmg = Math.max(1, Math.round(currentRaid.maxHp * def.dotFrac * 0.04 * a.stacks));
          currentRaid.hp = Math.max(0, currentRaid.hp - dotDmg);
          currentRaid.contributors.set(
            a.appliedBy,
            (currentRaid.contributors.get(a.appliedBy) || 0) + dotDmg,
          );
          rt.broadcast({
            t: "raidDot",
            ailment: id,
            appliedBy: a.appliedBy,
            dmg: dotDmg,
            hp: currentRaid.hp,
            maxHp: currentRaid.maxHp,
            at: now,
          });
          if (currentRaid.hp === 0) {
            endRaid(true, a.appliedBy);
            return;
          }
        }
        // TTL decay — one tick consumed per raid.tick interval.
        a.ttl -= 1;
        if (a.ttl <= 0) {
          currentRaid.bossAilments.delete(id);
        }
      }
    }

    rt.broadcast({
      t: "raidUpdate",
      hp: currentRaid.hp,
      maxHp: currentRaid.maxHp,
      poise: currentRaid.poise,
      maxPoise: currentRaid.maxPoise,
      staggered: currentRaid.staggeredUntil > now,
      enraged: currentRaid.enrageAt > 0 && now > currentRaid.enrageAt,
      contributors: currentRaid.contributors.size,
      topContributors: [...currentRaid.contributors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([login, dmg]) => ({ login, dmg })),
      bossAilments: currentRaid.bossAilments
        ? [...currentRaid.bossAilments.values()].map((a) => ({ id: a.id, stacks: a.stacks }))
        : [],
      at: now,
    });
  },
  2_500,
);

// D3 — Autonomous boss attacks. Fires on a periodic cadence while a raid
// is active, independent of player swings. Picks a live (not downed) engaged
// party member, or any arena member if none are engaged. Reuses
// arena.applyBossCounter so the existing client hit/recoil visuals play.
// Server-only Math.random() — never touches shared/ — determinism intact.
superviseInterval(
  "raid.boss_attack",
  () => {
    if (!currentRaid || currentRaid.hp <= 0) return;
    if (RAID_BOSS_ATTACK_MS <= 0) return;
    // Skip autonomous attack while boss is staggered.
    if (currentRaid.staggeredUntil > Date.now()) return;
    const bossDef = ENEMIES[currentRaid.boss_id];
    const baseAttack = Math.max(
      6,
      Math.round((bossDef?.attack || 10) * RAID_BOSS_ATTACK_DMG_SCALE),
    );
    let dmg = baseAttack + Math.round(Math.random() * baseAttack * 0.5);
    // Enrage: autonomous attack damage ×2.
    if (currentRaid.enrageAt > 0 && Date.now() > currentRaid.enrageAt) dmg = Math.round(dmg * 2);

    // Pick a target: prefer an engaged (actively fighting) member, else
    // fall back to any online arena chatter so the boss always has a target.
    const engaged = raidState.logins();
    const candidates = engaged.length > 0 ? engaged : arena.rosterLogins();
    if (candidates.length === 0) return;
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    const frames = arena.applyBossCounter(target, currentRaid.name, dmg, true);
    for (const f of frames) rt.broadcast(f);
    // Disengage if the autonomous attack downed this chatter.
    if (frames.some((f) => f.t === "arenaDown")) raidState.disengage(target);
  },
  RAID_BOSS_ATTACK_MS,
);

// D5 — Autonomous fighter attacks. Every RAID_FIGHTER_ATTACK_MS each
// engaged fighter fires one raid swing vs the boss using the existing
// fireRaidSwing path (same damage math, same raidHit broadcast, same
// boss counter-attack roll, same XP banking). This drains boss HP with
// ZERO chat input — chatters just have to be on the roster. Server-only
// Math.random() — never touches shared/ — determinism intact.
superviseInterval(
  "raid.fighter_attack",
  () => {
    if (RAID_FIGHTER_ATTACK_MS <= 0) return;
    if (!currentRaid || currentRaid.hp <= 0) return;
    // C: Auto-end on prolonged silence — hysteresis (start=60s, end=120s).
    if (currentRaid.reason !== "vfx_afk" && chatPingsInLast(RAID_QUIET_END_MS) === 0) {
      endRaid(false, "");
      return;
    }
    const fighters = raidState.logins();
    if (fighters.length === 0) return;
    // Revive any downed engaged fighters whose short raid-KO window has
    // elapsed before the swing round — keeps the party populated.
    const reviveFrames = arena.reviveEngaged(fighters);
    for (const f of reviveFrames) rt.broadcast(f);
    for (const login of fighters) {
      if (!currentRaid || currentRaid.hp <= 0) break; // raid may die mid-loop
      const r = fireRaidSwing(login, "auto");
      if (!r.ok) continue;
      if (r.raidDefeated) break;
    }
  },
  RAID_FIGHTER_ATTACK_MS,
);

// D4 — Auto-spawn timer. Periodically starts a raid while none is active,
// regardless of chatter count, so small streams still get boss encounters.
// Respects a minimum cooldown after the last raid ended so bosses don't
// chain back-to-back if one finishes within seconds of the timer firing.
superviseInterval(
  "raid.auto_spawn",
  () => {
    if (RAID_AUTO_SPAWN_MS <= 0) return;
    if (currentRaid) return; // one active raid at a time
    const now = Date.now();
    if (lastRaidEndedAt > 0 && now - lastRaidEndedAt < RAID_AUTO_SPAWN_COOLDOWN_MS) return;
    // C: Chat-activity gate — no boss without recent chat.
    if (chatPingsInLast(RAID_REQUIRE_CHAT_MS) === 0) return;
    const pool = [...SPAWNABLE_BOSSES];
    const boss_id = pool[Math.floor(Math.random() * pool.length)];
    startRaid(boss_id, "auto_spawn", "");
    store.pushFeed({
      kind: "boss",
      boss_id,
      name: ENEMIES[boss_id]?.name,
      reason: "auto_spawn",
      at: now,
    });
  },
  RAID_AUTO_SPAWN_MS,
);

// ── Graceful shutdown ─────────────────────────────────────────────────
onShutdown(() => rt.shutdown());
onShutdown(() => store.flush());
onShutdown(() => new Promise((resolve) => server.close(() => resolve())));
installShutdown();

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ███ SIGMA ABYSS — server up");
  console.log(`  play    http://${HOST}:${PORT}`);
  console.log(`  health  http://${HOST}:${PORT}/healthz`);
  console.log("  tunnel  npm run tunnel   (public URL for viewers)");
  console.log("");
});
