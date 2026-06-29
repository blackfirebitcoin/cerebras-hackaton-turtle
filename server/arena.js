// SIGMA ABYSS — arena roster + auto-battle ticker.
//
// The /overlay/arena scene paints every active chatter on stage at once,
// each with an HP bar and a foe. This module owns the in-memory roster
// and the periodic auto-battle tick that keeps the scene alive while chat
// is flowing — no one needs to type !fight, chatting is enough. The
// chat-ping endpoint or any twitch-action enrols/refreshes them; once a
// chatter goes quiet their foe holds its attack until they speak again,
// so monsters don't slug it out to an empty room.
//
// The arena HP is a SEPARATE meter from the playable character's run.hp
// — it's a transient "screen presence" pool so chatters who pop in for
// one message still see their sigma slug it out for a bit and then
// respawn. Persisting tiny chip damage to disk on every tick would beat
// up the store and pollute the real run state.
//
// Invariants:
//   - Roster keyed by twitch login (lowercased), matching twitchLinks.
//   - Reap chatters whose lastSeenAt is older than ROSTER_TTL_MS.
//   - Cap the roster at ROSTER_MAX so a raid-mob can't blow the canvas.
//   - Auto-battle is gated on recent chat: a foe only swings while its
//     chatter chatted within FIGHT_ACTIVE_MS. Idle chatters stand and
//     heal; the arena goes quiet when chat does.
//   - All side effects are broadcast-only — never mutate the persisted
//     character from inside the tick.

import { GEAR_SLOTS, RARITY_RANK } from "../shared/constants.js";
import { ENEMIES } from "../shared/enemies.js";
import { xpForLevel } from "../shared/progression.js";
import { derive } from "../shared/stats.js";
import { unlockedArts, WEAPON_FAMILIES } from "../shared/weapons.js";
import { zoneById } from "../shared/zones.js";
import * as raidState from "./raid-state.js";
import * as store from "./store.js";

const ROSTER_TTL_MS = Number(process.env.ARENA_TTL_MS) || 5 * 60_000;
const ROSTER_MAX = Number(process.env.ARENA_MAX) || 24;
const TICK_MS = Number(process.env.ARENA_TICK_MS) || 2_500;
// Non-engaged chatters regen ~4% of their maxHp every tick (2.5s) — by
// the time the camera comes back around they're topped off. Anyone
// `raidState.isEngaged()` is currently committed to the boss fight and
// must heal through potions or run away with !run.
const HEAL_PER_TICK = 0.04;
// Auto-battle is supplemental spectacle, not a heartbeat: the round-robin
// tick only swings on behalf of a chatter who has chatted within this
// window. Once their chat goes quiet the foe stops attacking (no "getting
// hit for no reason" while idle) — the sigma just stands on stage and
// heals until they speak again or get reaped. Explicit per-chat-line
// swings (swingFor) and raid counters are always chat-driven, so they
// bypass this gate. Generous enough to bridge the gaps between a chatter's
// messages; short enough that the arena visibly settles within a minute
// of chat dying down.
const FIGHT_ACTIVE_MS = Number(process.env.ARENA_FIGHT_ACTIVE_MS) || 45_000;
const DOWN_RESPAWN_MS = 5 * 60_000; // 5 minutes on the floor after a knockout (non-raid)
// During an active boss raid engaged fighters respawn much faster so the
// auto-battle stays populated. Boss counters are meant to be dramatic, not
// a permanent party-wipe that stalls the fight for 5 minutes.
const RAID_DOWN_RESPAWN_MS = Number(process.env.RAID_DOWN_RESPAWN_MS) || 12_000;
const ENEMY_HP_BASE = 60; // arena enemies are weaker than delve foes; for show

const roster = new Map(); // login -> ArenaEntry

// Internal cursor for round-robin auto-battle picks. Random pick has a
// long tail where one chatter can monopolize the camera; rotating keeps
// the screen feeling shared.
let rrCursor = 0;

function nowMs() {
  return Date.now();
}

// Sample (one of) zone enemies for this chatter. Falls back to the
// goblin_warrens roster — every chatter is at least visible chipping at
// a goblin even if they have no run yet.
function pickFoeForCharacter(character) {
  const run = character?.run;
  const zone = run?.zone && run.zone !== "town" ? zoneById(run.zone) : zoneById("goblin_warrens");
  const pool = zone?.enemies?.length ? zone.enemies : ["goblin"];
  const id = pool[Math.floor(Math.random() * pool.length)];
  const def = ENEMIES[id] || ENEMIES.goblin;
  // Scale enemy HP softly off zone tier so the abyss-ruins fight reads
  // tougher without making early-game arenas a one-shot.
  const tier = zone?.tier || 1;
  const maxHp = Math.round(ENEMY_HP_BASE * (0.8 + tier * 0.25));
  return {
    id,
    name: def.name,
    kind: def.kind,
    tag: def.tag,
    hue: def.hue,
    lpc: def.lpc || null,
    hp: maxHp,
    maxHp,
  };
}

function characterMaxHp(character) {
  const run = character?.run;
  if (!run) return 120;
  try {
    return derive(run, character).maxHp;
  } catch {
    return 120;
  }
}

function characterAttack(character) {
  const run = character?.run;
  if (!run) return 8;
  try {
    return Math.max(1, Math.round(derive(run, character).attack));
  } catch {
    return 8;
  }
}

// Pull the chatter's persisted character — used to compute their attack /
// max HP and to read cosmetics for the avatar render. Mints nothing here
// (mint happens upstream in resolveTwitchSigma).
function lookupCharacter(login) {
  const tok = store.getTokenByTwitch(login);
  if (!tok) return { token: null, character: null };
  const rec = store.getPlayer(tok);
  return { token: tok, character: rec?.character || null };
}

function weaponSummary(weapon) {
  if (!weapon) return null;
  const family = weapon.family || "fists";
  const fam = WEAPON_FAMILIES[family] || WEAPON_FAMILIES.fists;
  const plus = weapon.plus | 0;
  const arts = unlockedArts(family, plus);
  return {
    base: weapon.base || "Fists",
    name: weapon.name || "Weapon",
    rarity: weapon.rarity || "common",
    family,
    label: fam.label,
    color: fam.color,
    plus,
    arts: arts.map((a) => ({ id: a.id, name: a.name, plus: a.plus })),
  };
}

// Pure function of character.run.gear — no RNG, no shared/ mutation.
// Returns 0..4: common=0, uncommon=1, rare=2, epic=3, legendary/mythic/oneofone=4.
// Default 0 when character has no gear (exact-identity when absent — does NOT
// affect sim determinism; this is server/arena.js only).
export function gearAuraTier(character) {
  const gear = character?.run?.gear;
  if (!gear) return 0;
  let maxRank = 0;
  for (const slot of GEAR_SLOTS) {
    const item = gear[slot];
    if (!item) continue;
    const rank = RARITY_RANK[item.rarity] ?? 0;
    if (rank > maxRank) maxRank = rank;
  }
  // Clamp: common=0,uncommon=1,rare=2,epic=3; legendary/mythic/oneofone all → 4
  return Math.min(4, maxRank);
}

function publicEntry(e) {
  return {
    login: e.login,
    token: e.token,
    name: e.name,
    cosmetics: e.cosmetics || {},
    hp: e.hp,
    maxHp: e.maxHp,
    foe: e.foe
      ? {
          id: e.foe.id,
          name: e.foe.name,
          kind: e.foe.kind,
          tag: e.foe.tag,
          hue: e.foe.hue,
          lpc: e.foe.lpc,
          hp: e.foe.hp,
          maxHp: e.foe.maxHp,
        }
      : null,
    down: !!e.downUntil,
    level: e.level || 1,
    xp: e.xp || 0,
    xpToNext: e.xpToNext || xpForLevel(e.level || 1),
    zone: e.zone || "town",
    weapon: e.weapon || null,
    auraTier: e.auraTier ?? 0,
    // Inc5 — tactical position tag ("front"|"mid"|"back"). Default "mid" when absent.
    position: e.position || "mid",
  };
}

// Build an entry from a login + the persisted character. Idempotent —
// reuses the existing roster slot if one already exists for this login
// (just refreshes lastSeenAt + foe if missing).
function mintOrRefresh(login) {
  const key = String(login || "").toLowerCase();
  if (!key) return null;

  const existing = roster.get(key);
  const { token, character } = lookupCharacter(key);
  if (existing) {
    existing.lastSeenAt = nowMs();
    if (character) {
      // Keep cosmetics + maxHp synced if the chatter levelled / equipped.
      existing.name = character.name || existing.name;
      existing.cosmetics = character.cosmetics || existing.cosmetics;
      existing.level = character.run?.level || existing.level;
      existing.xp = character.run?.xp || 0;
      existing.xpToNext = xpForLevel(existing.level);
      existing.zone = character.run?.zone || existing.zone;
      existing.maxHp = characterMaxHp(character);
      existing.attack = characterAttack(character);
      existing.weapon = weaponSummary(character.run?.gear?.weapon);
      existing.auraTier = gearAuraTier(character);
      // Inc5: keep position synced from account (loadout choice may change between sessions).
      existing.position = character.position || "mid";
      if (existing.hp > existing.maxHp) existing.hp = existing.maxHp;
    }
    if (!existing.foe) existing.foe = pickFoeForCharacter(character);
    return existing;
  }

  // Cap the roster — drop the oldest if we're at the ceiling. The newest
  // chatter is more interesting than someone who fell silent.
  if (roster.size >= ROSTER_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of roster) {
      if (v.lastSeenAt < oldestAt) {
        oldestAt = v.lastSeenAt;
        oldestKey = k;
      }
    }
    if (oldestKey) roster.delete(oldestKey);
  }

  const maxHp = characterMaxHp(character);
  const level = character?.run?.level || 1;
  const entry = {
    login: key,
    token,
    name: character?.name || `Sigma_${key}`,
    cosmetics: character?.cosmetics || {},
    level,
    xp: character?.run?.xp || 0,
    xpToNext: xpForLevel(level),
    zone: character?.run?.zone || "town",
    hp: maxHp,
    maxHp,
    attack: characterAttack(character),
    weapon: weaponSummary(character?.run?.gear?.weapon),
    auraTier: gearAuraTier(character),
    // Inc5: tactical position from account (default "mid" for new/unknown chatters).
    position: character?.position || "mid",
    foe: pickFoeForCharacter(character),
    lastSeenAt: nowMs(),
    downUntil: 0,
  };
  roster.set(key, entry);
  return entry;
}

// Quietly drop chatters that haven't been seen in a while. Returns the
// list of expired logins so the caller can broadcast t:'arenaLeave'.
function reap() {
  const cutoff = nowMs() - ROSTER_TTL_MS;
  const expired = [];
  for (const [k, v] of roster) {
    if (v.lastSeenAt < cutoff) {
      expired.push(k);
      roster.delete(k);
    }
  }
  return expired;
}

function nextRoundRobin() {
  if (!roster.size) return null;
  const keys = [...roster.keys()];
  rrCursor = (rrCursor + 1) % keys.length;
  const k = keys[rrCursor];
  return roster.get(k) || null;
}

// Run one autobattle exchange. Mutates the entry in place and returns
// the broadcast frames the caller should send. Returns null if there's
// nothing to do this tick.
function fightOne(entry) {
  const now = nowMs();
  if (entry.downUntil && now < entry.downUntil) {
    return null; // still on the floor
  }
  if (entry.downUntil && now >= entry.downUntil) {
    // Respawn: full HP, fresh foe.
    entry.hp = entry.maxHp;
    entry.downUntil = 0;
    entry.foe = pickFoeForCharacter(lookupCharacter(entry.login).character);
    return [
      {
        t: "arenaRespawn",
        login: entry.login,
        hp: entry.hp,
        maxHp: entry.maxHp,
        foe: publicEntry(entry).foe,
        at: now,
      },
    ];
  }

  const frames = playerSwing(entry, { now });

  // Skip foe counter if the swing already downed the foe — keeps the
  // round-robin tick from "punishing" a chatter for landing a kill the
  // same instant.
  const swungKill = frames.some((f) => f.t === "arenaKill");
  if (!swungKill) {
    frames.push(...enemyCounter(entry, { now }));
  }
  return frames;
}

// One player swing. Returns the frames (arenaHit + optional arenaKill +
// arenaFoeSwap). Caller decides whether to follow with an enemyCounter.
// Returns [] if the entry is currently down/respawning — chat spam
// shouldn't poke a corpse.
function playerSwing(entry, { now = nowMs() } = {}) {
  if (entry.downUntil && now < entry.downUntil) return [];
  if (!entry.foe) {
    entry.foe = pickFoeForCharacter(lookupCharacter(entry.login).character);
  }
  const frames = [];

  // Player swings — drawn from a small variance window so the numbers
  // don't feel canned. Crit on a 1-in-12 to add pop.
  const crit = Math.random() < 1 / 12;
  let swing = Math.max(1, Math.round(entry.attack * (0.7 + Math.random() * 0.6) * (crit ? 2 : 1)));
  // Weapon-art flash: each chatter has a small chance to fire one of
  // their unlocked arts on a swing. Bigger damage + a named popup for
  // the overlay. Stream needs to SEE the class, not just read a chip.
  let art = null;
  const arts = entry.weapon?.arts || [];
  if (arts.length && Math.random() < 0.12 + (entry.weapon.plus | 0) * 0.025) {
    art = arts[Math.floor(Math.random() * arts.length)];
    swing = Math.round(swing * 1.8);
  }
  entry.foe.hp = Math.max(0, entry.foe.hp - swing);
  frames.push({
    t: "arenaHit",
    login: entry.login,
    side: "player",
    dmg: swing,
    crit,
    hp: entry.foe.hp,
    maxHp: entry.foe.maxHp,
    foeName: entry.foe.name,
    at: now,
    art: art ? { id: art.id, name: art.name } : null,
  });

  if (entry.foe.hp <= 0) {
    frames.push({
      t: "arenaKill",
      login: entry.login,
      foeId: entry.foe.id,
      foeName: entry.foe.name,
      at: now,
    });
    entry.foe = pickFoeForCharacter(lookupCharacter(entry.login).character);
    frames.push({
      t: "arenaFoeSwap",
      login: entry.login,
      foe: publicEntry(entry).foe,
      at: now,
    });
    // Tiny self-heal for the kill so a chatter on a streak doesn't grind
    // themselves down across multiple foes.
    entry.hp = Math.min(entry.maxHp, entry.hp + Math.round(entry.maxHp * 0.15));
  }
  return frames;
}

function enemyCounter(entry, { now = nowMs() } = {}) {
  if (entry.downUntil && now < entry.downUntil) return [];
  if (!entry.foe) return [];
  const frames = [];
  // Foe swings back. Damage scales gently off zone tier through the foe
  // maxHp we set at spawn; a tougher foe also hits harder.
  const foeDmg = Math.max(1, Math.round(entry.foe.maxHp * (0.06 + Math.random() * 0.06)));
  entry.hp = Math.max(0, entry.hp - foeDmg);
  frames.push({
    t: "arenaHit",
    login: entry.login,
    side: "enemy",
    dmg: foeDmg,
    crit: false,
    hp: entry.hp,
    maxHp: entry.maxHp,
    foeName: entry.foe.name,
    at: now,
  });
  if (entry.hp <= 0) {
    entry.downUntil = now + DOWN_RESPAWN_MS;
    frames.push({
      t: "arenaDown",
      login: entry.login,
      foeName: entry.foe.name,
      respawnInMs: DOWN_RESPAWN_MS,
      at: now,
    });
  }
  return frames;
}

// ── Public API ─────────────────────────────────────────────────────────

export function snapshot() {
  return {
    ttlMs: ROSTER_TTL_MS,
    chatters: [...roster.values()].map(publicEntry),
  };
}

export function size() {
  return roster.size;
}

export function rosterLogins() {
  return [...roster.keys()];
}

// Mark a chatter as active. `source` is just a tag for diagnostics. Returns
// the join frame the caller should broadcast — null if this login was
// already on the roster (still refreshed lastSeenAt, no broadcast needed).
export function pingChatter(login, _source) {
  const key = String(login || "").toLowerCase();
  if (!key) return null;
  const isNew = !roster.has(key);
  const entry = mintOrRefresh(key);
  if (!entry || !isNew) return null;
  return { t: "arenaJoin", chatter: publicEntry(entry), at: nowMs() };
}

// Force N player swings for a specific login — driven by /api/chat-ping
// so each chat line visibly chips the foe's HP bar. Capped at SWING_MAX
// so a spammer can't blow the broadcast budget in one POST. Foe counter
// is NOT applied here — that stays on the periodic tick so a chat burst
// doesn't immediately suicide the chatter on counter-attacks.
const SWING_MAX = 6;
export function swingFor(login, n = 1) {
  const key = String(login || "").toLowerCase();
  if (!key) return [];
  const entry = roster.get(key);
  if (!entry) return [];
  if (entry.downUntil && nowMs() < entry.downUntil) return [];
  const count = Math.max(1, Math.min(SWING_MAX, Number(n) || 1));
  const frames = [];
  const now = nowMs();
  for (let i = 0; i < count; i += 1) {
    const out = playerSwing(entry, { now });
    if (out.length) frames.push(...out);
  }
  return frames;
}

// One auto-battle step. Returns an array of broadcast frames. Always also
// returns an arenaLeave for any reaped chatters so the overlay can fade
// them out instead of just freezing their last sprite.
export function tick() {
  const frames = [];
  for (const login of reap()) {
    frames.push({ t: "arenaLeave", login, at: nowMs() });
  }
  // One chatter per tick — keeps the canvas readable and lets the eye
  // track damage popups. The whole roster cycles every TICK_MS * size().
  // Spectacle, not a heartbeat: only auto-swing for a chatter who's still
  // actively chatting. An idle chatter's foe holds its attack (they idle
  // on stage and heal below) until they speak again — so monsters stop
  // fighting when chat goes quiet instead of slugging it out to no one.
  const pick = nextRoundRobin();
  if (pick && nowMs() - pick.lastSeenAt < FIGHT_ACTIVE_MS) {
    const out = fightOne(pick);
    if (out) frames.push(...out);
  }
  // Passive heal for every other (non-downed, non-engaged) chatter so a
  // quiet roster recovers between camera rotations. Engaged raiders heal
  // through potions or by typing !run — sitting in chat won't save them.
  for (const e of roster.values()) {
    if (e === pick || e.downUntil) continue;
    if (raidState.isEngaged(e.login)) continue;
    if (e.hp < e.maxHp) {
      e.hp = Math.min(e.maxHp, e.hp + Math.max(1, Math.round(e.maxHp * HEAL_PER_TICK)));
    }
  }
  return frames;
}

// Boss counter-attack. Called from the raid loop in server.js after an
// engaged swing lands — the boss swings back at the chatter, draining
// their arena entry HP. Returns the frames the caller should broadcast
// (may include an arenaDown if the chatter is knocked out).
// `raidActive` — when true, KO duration uses RAID_DOWN_RESPAWN_MS (fast
// recovery) so a boss counter doesn't wipe the party for 5 minutes.
export function applyBossCounter(login, bossName, dmg, raidActive = false) {
  const key = String(login || "").toLowerCase();
  const entry = roster.get(key);
  if (!entry) return [];
  const now = nowMs();
  if (entry.downUntil && now < entry.downUntil) return [];
  const safeDmg = Math.max(1, Math.round(Number(dmg) || 1));
  entry.hp = Math.max(0, entry.hp - safeDmg);
  const frames = [
    {
      t: "arenaHit",
      login: entry.login,
      side: "enemy",
      dmg: safeDmg,
      crit: false,
      hp: entry.hp,
      maxHp: entry.maxHp,
      foeName: bossName || "Boss",
      bossCounter: true,
      at: now,
    },
  ];
  if (entry.hp <= 0) {
    const respawnMs = raidActive ? RAID_DOWN_RESPAWN_MS : DOWN_RESPAWN_MS;
    entry.downUntil = now + respawnMs;
    frames.push({
      t: "arenaDown",
      login: entry.login,
      foeName: bossName || "Boss",
      respawnInMs: respawnMs,
      at: now,
    });
  }
  return frames;
}

// Revive any downed engaged fighters whose RAID_DOWN_RESPAWN_MS has
// elapsed. Called at the top of the raid.fighter_attack tick so fighters
// are back on their feet before the next swing round — keeps the
// auto-battle populated with no chat input. Partial-HP revive (50%) so
// they feel fragile but functional; the boss counter will knock them down
// again if they don't survive. Returns broadcast frames for any revives.
export function reviveEngaged(engagedLogins) {
  const now = nowMs();
  const frames = [];
  for (const login of engagedLogins) {
    const key = String(login || "").toLowerCase();
    const entry = roster.get(key);
    if (!entry) continue;
    if (!entry.downUntil || now < entry.downUntil) continue;
    // Revive at 50% HP — they're alive but hurt.
    entry.hp = Math.max(1, Math.round(entry.maxHp * 0.5));
    entry.downUntil = 0;
    frames.push({
      t: "arenaRespawn",
      login: entry.login,
      hp: entry.hp,
      maxHp: entry.maxHp,
      foe: publicEntry(entry).foe,
      at: now,
    });
  }
  return frames;
}

// Read-only HP probe — used by the raid endpoint to gate engaged chatters
// (downed chatters can't swing, even if their chat is still flowing).
export function arenaHp(login) {
  const key = String(login || "").toLowerCase();
  const entry = roster.get(key);
  if (!entry) return null;
  return {
    hp: entry.hp,
    maxHp: entry.maxHp,
    downUntil: entry.downUntil || 0,
    down: !!entry.downUntil && nowMs() < entry.downUntil,
  };
}

// Bump lastSeenAt for an existing roster entry without minting a new one.
// Called by startRaid() for every auto-engaged fighter so the TTL reaper
// (reap() uses ROSTER_TTL_MS) can't evict them mid-raid — which would cause
// an arenaLeave + later arenaJoin = duplicate fighter on the client.
export function refreshLastSeen(login) {
  const key = String(login || "").toLowerCase();
  const entry = roster.get(key);
  if (entry) entry.lastSeenAt = nowMs();
}

export function tickIntervalMs() {
  return TICK_MS;
}
