// SIGMA ABYSS — Agent Realm.
//
// A server-authoritative, ArtifactsMMO-inspired play surface for AI agents.
// An agent registers for a bearer token, then drives one character through
// cooldown-gated HTTP actions: move / fight / gather / rest / craft. Every
// action returns a `cooldown` the agent MUST wait out before its next action —
// the core pacing + anti-abuse mechanic (ArtifactsMMO's defining loop).
//
// This is deliberately decoupled from the browser sigma (client-authoritative,
// permadeath delve). Agents are forgiving — a lost fight respawns you in town
// with no progress wiped — because the realm exists to *incentivise* agents to
// stick around and answer Oracle Bazaar inference HITs (oracle-bazaar.js),
// which is where the real value (cheap inference) is produced.
//
// Determinism: every roll goes through makeRng() seeded from the character's
// persisted rngState (same contract as shared/), so an action's outcome is a
// pure function of state — replayable and test-stable.

import crypto from "node:crypto";
import {
  AGENT_MONSTERS,
  AGENT_RECIPES,
  AGENT_RESOURCES,
  contentAt,
  inBounds,
  manhattan,
  worldSnapshot,
} from "../shared/agent-world.js";
import {
  AGENT_BASE_HP,
  AGENT_COOLDOWN,
  AGENT_COOLDOWN_MAX_S,
  AGENT_COOLDOWN_PER_TILE,
  AGENT_HP_PER_LEVEL,
  AGENT_INVENTORY_MAX,
  AGENT_NAME_MAX,
  AGENT_SKILLS,
  AGENT_START,
  AGENT_TOKEN_PREFIX,
} from "../shared/constants.js";
import { makeRng } from "../shared/rng.js";
import { projectSigmacraftSnapshot } from "../shared/sigmacraft.js";
import { enqueueSigmacraftIntent } from "./sigmacraft.js";
import { vSigmacraftIntent } from "./validate.js";

// ── Character model ────────────────────────────────────────────────────────

function freshSkills() {
  const s = {};
  for (const k of AGENT_SKILLS) s[k] = { level: 1, xp: 0 };
  return s;
}

export function freshAgentCharacter(name, seed) {
  return {
    name,
    x: AGENT_START.x,
    y: AGENT_START.y,
    level: 1,
    xp: 0,
    hp: AGENT_BASE_HP,
    maxHp: AGENT_BASE_HP,
    gold: 0,
    taskCoins: 0,
    skills: freshSkills(),
    inventory: {}, // code -> quantity
    cooldownExpires: 0, // epoch ms
    rngState: seed >>> 0 || 1,
    reputation: 0,
    lifetime: { kills: 0, gathers: 0, crafts: 0, answers: 0, deaths: 0 },
    createdAt: Date.now(),
    seenAt: Date.now(),
  };
}

// XP→level on the same shape as the sigma curve but agent-local + gentler.
function xpForLevel(n) {
  return Math.round(40 * 1.14 ** (n - 1));
}

function addCharXp(ch, amount) {
  ch.xp += amount;
  let leveled = 0;
  while (ch.xp >= xpForLevel(ch.level)) {
    ch.xp -= xpForLevel(ch.level);
    ch.level += 1;
    leveled += 1;
  }
  if (leveled) {
    ch.maxHp = AGENT_BASE_HP + (ch.level - 1) * AGENT_HP_PER_LEVEL;
    ch.hp = ch.maxHp; // ding heals
  }
  return leveled;
}

function addSkillXp(ch, skill, amount) {
  const s = ch.skills[skill];
  if (!s) return 0;
  s.xp += amount;
  let leveled = 0;
  while (s.xp >= xpForLevel(s.level)) {
    s.xp -= xpForLevel(s.level);
    s.level += 1;
    leveled += 1;
  }
  return leveled;
}

function invAdd(ch, code, qty) {
  if (!code || qty <= 0) return;
  ch.inventory[code] = (ch.inventory[code] || 0) + qty;
}

function invCount(ch) {
  return Object.keys(ch.inventory).length;
}

// ── Cooldown ────────────────────────────────────────────────────────────────

export function cooldownRemaining(ch) {
  return Math.max(0, (ch.cooldownExpires - Date.now()) / 1000);
}

function cooldownObject(ch, seconds) {
  const total = Math.min(AGENT_COOLDOWN_MAX_S, Math.max(0, Math.round(seconds)));
  const now = Date.now();
  ch.cooldownExpires = now + total * 1000;
  return {
    total_seconds: total,
    remaining_seconds: total,
    started_at: new Date(now).toISOString(),
    expiration: new Date(ch.cooldownExpires).toISOString(),
  };
}

// Public, sanitised view (never leak rngState / internal cooldown epoch raw).
export function publicAgent(ch) {
  return {
    name: ch.name,
    x: ch.x,
    y: ch.y,
    level: ch.level,
    xp: ch.xp,
    xpToLevel: xpForLevel(ch.level),
    hp: Math.round(ch.hp),
    maxHp: ch.maxHp,
    gold: ch.gold,
    taskCoins: ch.taskCoins,
    reputation: ch.reputation,
    skills: ch.skills,
    inventory: ch.inventory,
    cooldown: { remaining_seconds: Math.round(cooldownRemaining(ch) * 10) / 10 },
    tile: contentAt(ch.x, ch.y),
    lifetime: ch.lifetime,
  };
}

// ── Auth ──────────────────────────────────────────────────────────────────

function bearerOf(req) {
  const h = String(req.get?.("authorization") || req.headers?.authorization || "");
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

// Resolve { token, ch } from the request bearer token, or null. Refreshes
// seenAt as a side effect when found.
export function authAgent(store, req) {
  const token = bearerOf(req);
  if (!token) return null;
  const ch = store.getAgent(token);
  if (!ch) return null;
  ch.seenAt = Date.now();
  return { token, ch };
}

// ── Reward hook (used by oracle-bazaar.js) ──────────────────────────────────

export function grantReward(ch, { gold = 0, coins = 0, xp = 0, skill = "oracle" } = {}) {
  ch.gold += Math.max(0, Math.round(gold));
  ch.taskCoins += Math.max(0, Math.round(coins));
  const charLevels = xp > 0 ? addCharXp(ch, Math.round(xp)) : 0;
  const skillLevels = xp > 0 ? addSkillXp(ch, skill, Math.round(xp)) : 0;
  return { charLevels, skillLevels, gold: ch.gold, taskCoins: ch.taskCoins };
}

export function isOnOracleTile(ch) {
  const c = contentAt(ch.x, ch.y);
  return !!c && c.type === "oracle";
}

export function applyOracleCooldown(ch) {
  return cooldownObject(ch, AGENT_COOLDOWN.oracle);
}

// ── Combat (deterministic) ──────────────────────────────────────────────────

function charPower(ch) {
  return 6 + (ch.level - 1) * 2;
}

function resolveFight(ch, mon) {
  const rng = makeRng(ch.rngState);
  let mhp = mon.hp;
  let log = 0;
  const power = charPower(ch);
  for (let round = 0; round < 60 && mhp > 0 && ch.hp > 0; round += 1) {
    const myDmg = Math.max(1, Math.round(power * (0.85 + rng.next() * 0.45)));
    mhp -= myDmg;
    if (mhp <= 0) break;
    const monDmg = Math.max(1, Math.round(mon.attack * (0.8 + rng.next() * 0.5)));
    ch.hp = Math.max(0, ch.hp - monDmg);
    log += 1;
  }
  ch.rngState = rng.state >>> 0;
  const won = mhp <= 0 && ch.hp > 0;
  return { won, rounds: log, monsterHpLeft: Math.max(0, Math.round(mhp)) };
}

// ── Route registration ──────────────────────────────────────────────────────

export function attachAgentRealm(app, { store, rt, guard }) {
  const NAME_RE = /^[a-zA-Z0-9_-]{2,24}$/;

  // Register a new agent → bearer token. Idempotent by name is intentionally
  // NOT offered: each register mints a fresh independent agent (a runner can
  // hold the token). Name collisions are allowed (display only).
  app.post(
    "/api/agent/register",
    guard("POST /api/agent/register", (req, res) => {
      const name = String(req.body?.name || "").slice(0, AGENT_NAME_MAX);
      if (!NAME_RE.test(name)) {
        res.status(400).json({ error: "name must match [A-Za-z0-9_-]{2,24}" });
        return;
      }
      const token = `${AGENT_TOKEN_PREFIX}${crypto.randomBytes(18).toString("hex")}`;
      const seed = crypto.createHash("sha1").update(token).digest().readUInt32BE(0) >>> 0 || 1;
      const ch = freshAgentCharacter(name, seed);
      store.putAgent(token, ch);
      if (rt?.broadcast) rt.broadcast({ t: "agentJoin", name, at: Date.now() });
      res.json({ ok: true, token, character: publicAgent(ch) });
    }),
  );

  // Static world map — no auth (it never changes); agents fetch once to plan.
  app.get(
    "/api/agent/world",
    guard("GET /api/agent/world", (_req, res) => {
      // PR6: agents read the Sigmacraft overworld alongside the combat world. The
      // anonymous projection (validActions:[]) + the static map is enough for an
      // agent to plan a move; the agent's own tile comes from GET /api/agent/me.
      const world = store.getWorldState();
      res.json({
        ...worldSnapshot(),
        sigmacraft: projectSigmacraftSnapshot(world, null, {}),
        sigmacraftMap: world?.sigmacraft?.map || null,
      });
    }),
  );

  // Authenticated character snapshot.
  app.get(
    "/api/agent/me",
    guard("GET /api/agent/me", (req, res) => {
      const a = authAgent(store, req);
      if (!a) {
        res.status(401).json({ error: "missing or invalid agent token" });
        return;
      }
      store.putAgent(a.token, a.ch);
      // PR6: the agent's own Sigmacraft tile (actorPlaces keyed by its agt_ token).
      res.json({
        ok: true,
        character: publicAgent(a.ch),
        sigmacraft: projectSigmacraftSnapshot(store.getWorldState(), null, { token: a.token }),
      });
    }),
  );

  // Unified action dispatch. Cooldown is enforced up front for every action.
  app.post(
    "/api/agent/action/:kind",
    guard("POST /api/agent/action", (req, res) => {
      const a = authAgent(store, req);
      if (!a) {
        res.status(401).json({ error: "missing or invalid agent token" });
        return;
      }
      const { token, ch } = a;
      const kind = String(req.params.kind || "");

      const remaining = cooldownRemaining(ch);
      if (remaining > 0) {
        res.status(429).json({
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        });
        return;
      }

      const finish = (extra, cooldown) => {
        store.putAgent(token, ch);
        res.json({ ok: true, cooldown, character: publicAgent(ch), ...extra });
      };

      switch (kind) {
        case "move": {
          const x = Math.trunc(Number(req.body?.x));
          const y = Math.trunc(Number(req.body?.y));
          if (!inBounds(x, y)) {
            res.status(400).json({ error: "destination out of bounds" });
            return;
          }
          const dist = manhattan(ch.x, ch.y, x, y);
          if (dist === 0) {
            res.status(400).json({ error: "already on that tile" });
            return;
          }
          ch.x = x;
          ch.y = y;
          finish(
            { moved: { x, y }, tile: contentAt(x, y) },
            cooldownObject(ch, AGENT_COOLDOWN.move + dist * AGENT_COOLDOWN_PER_TILE),
          );
          return;
        }

        case "fight": {
          const c = contentAt(ch.x, ch.y);
          if (!c || c.type !== "monster") {
            res.status(400).json({ error: "no monster on this tile" });
            return;
          }
          const mon = AGENT_MONSTERS[c.code];
          if (!mon) {
            res.status(500).json({ error: "unknown monster" });
            return;
          }
          const result = resolveFight(ch, mon);
          if (result.won) {
            ch.lifetime.kills += 1;
            const levels = addCharXp(ch, mon.xp);
            ch.gold += mon.gold;
            invAdd(ch, mon.drop, 1);
            finish(
              {
                fight: { result: "win", monster: mon.code, rounds: result.rounds },
                rewards: { xp: mon.xp, gold: mon.gold, drop: mon.drop, levels },
              },
              cooldownObject(ch, AGENT_COOLDOWN.fight),
            );
          } else {
            // Forgiving death: respawn in town at 1 HP, no progress lost.
            ch.lifetime.deaths += 1;
            ch.hp = 1;
            ch.x = AGENT_START.x;
            ch.y = AGENT_START.y;
            finish(
              {
                fight: { result: "loss", monster: mon.code, rounds: result.rounds },
                respawned: true,
              },
              cooldownObject(ch, AGENT_COOLDOWN.fight),
            );
          }
          return;
        }

        case "gather": {
          const c = contentAt(ch.x, ch.y);
          if (!c || c.type !== "resource") {
            res.status(400).json({ error: "no resource on this tile" });
            return;
          }
          const r = AGENT_RESOURCES[c.code];
          if (!r) {
            res.status(500).json({ error: "unknown resource" });
            return;
          }
          if ((ch.skills[r.skill]?.level || 1) < r.level) {
            res.status(400).json({ error: `${r.skill} level ${r.level} required` });
            return;
          }
          if (invCount(ch) >= AGENT_INVENTORY_MAX && !ch.inventory[r.drop]) {
            res.status(400).json({ error: "inventory full" });
            return;
          }
          ch.lifetime.gathers += 1;
          invAdd(ch, r.drop, 1);
          const levels = addSkillXp(ch, r.skill, r.xp);
          finish(
            {
              gather: { resource: r.code, drop: r.drop },
              rewards: { skill: r.skill, xp: r.xp, levels },
            },
            cooldownObject(ch, AGENT_COOLDOWN.gather),
          );
          return;
        }

        case "rest": {
          const before = Math.round(ch.hp);
          ch.hp = ch.maxHp;
          finish({ rest: { healed: ch.maxHp - before } }, cooldownObject(ch, AGENT_COOLDOWN.rest));
          return;
        }

        case "craft": {
          const code = String(req.body?.code || "");
          const qty = Math.max(1, Math.min(100, Math.trunc(Number(req.body?.qty) || 1)));
          const recipe = AGENT_RECIPES[code];
          if (!recipe) {
            res.status(400).json({ error: "unknown recipe" });
            return;
          }
          const c = contentAt(ch.x, ch.y);
          if (!c || c.type !== "workshop" || c.code !== recipe.station) {
            res.status(400).json({ error: `must be on the ${recipe.station} workshop tile` });
            return;
          }
          if ((ch.skills[recipe.skill]?.level || 1) < recipe.level) {
            res.status(400).json({ error: `${recipe.skill} level ${recipe.level} required` });
            return;
          }
          for (const [ing, need] of Object.entries(recipe.ingredients)) {
            if ((ch.inventory[ing] || 0) < need * qty) {
              res.status(400).json({ error: `need ${need * qty}x ${ing}` });
              return;
            }
          }
          for (const [ing, need] of Object.entries(recipe.ingredients)) {
            ch.inventory[ing] -= need * qty;
            if (ch.inventory[ing] <= 0) delete ch.inventory[ing];
          }
          invAdd(ch, code, qty);
          ch.lifetime.crafts += qty;
          const levels = addSkillXp(ch, recipe.skill, recipe.xp * qty);
          finish(
            { craft: { code, qty }, rewards: { skill: recipe.skill, xp: recipe.xp * qty, levels } },
            cooldownObject(ch, AGENT_COOLDOWN.craft),
          );
          return;
        }

        // PR6: an agent submits a Sigmacraft overworld intent (move/rest/talk).
        // Reuses the exact player trust boundary + enqueue path; bearer auth +
        // cooldown are already enforced above. The intent is resolved by the 3s
        // world tick (tile existence/adjacency re-checked there).
        case "sigmacraft": {
          let intent;
          try {
            intent = vSigmacraftIntent(req.body?.intent ?? req.body);
          } catch (err) {
            res.status(400).json({ error: err?.message || "bad sigmacraft intent" });
            return;
          }
          const world = store.getWorldState();
          const result = enqueueSigmacraftIntent(world, token, intent);
          store.putWorldState(world);
          if (result.status === "rejected") {
            res.status(409).json({ error: result.reason || "rejected" });
            return;
          }
          finish({ sigmacraft: result }, cooldownObject(ch, AGENT_COOLDOWN.sigmacraft ?? AGENT_COOLDOWN.move));
          return;
        }

        default:
          res.status(400).json({ error: `unknown action; valid: move|fight|gather|rest|craft|sigmacraft` });
      }
    }),
  );
}
