// SIGMA ABYSS — Twitch chat command dispatch (master design §5.1).
//
// chat-elixir's Chat.Mmo.Bridge parses `!cmd args` out of each line and
// adds `{cmd, args}` to the existing POST /api/chat-ping body. After the
// base ping work, server.js calls `dispatchCommand` here. The MMO is the
// source of truth; chat-elixir is a thin forwarder (invariant 8).
//
// Milestone 1 ships two verbs — `!join <faction>` and `!rep` — plus the
// shared faction core (`joinFaction`, `factionRepView`) reused by the
// dedicated HTTP endpoints. Per-login command cooldown keeps a spammer
// from hammering world-mutating verbs at thousands-of-chatters scale.

import {
  FACTION_ABYSSAL_PRESTIGE_GATE,
  FACTION_DEFECTOR_MS,
  FACTION_IDS,
  FACTION_JOIN_COOLDOWN_MS,
  factionById,
  factionRank,
  factionRankTitle,
} from "../shared/factions.js";
import { ensureQuests } from "../shared/quests.js";
import { SKILL_TALENTS } from "../shared/skill-talents.js";
import * as forge from "./forge.js";
import * as market from "./market.js";
import * as npcWorld from "./npc-world.js";
import * as onboarding from "./onboarding.js";
import * as retention from "./retention.js";
import * as voting from "./voting.js";
import { contributeToCrisis } from "./world-tick.js";

// Crisis contribution shared by the !pray/!rally/!gather/!escort/!delve/!fight
// verbs — only the verb matching the active crisis's contributeVerb counts.
function contributeVerb(login, verb, ctx) {
  const world = ctx.store.getWorldState();
  const ac = world?.crisis?.activeCrisis;
  if (!ac || ac.phase !== "active")
    return { handled: true, reply: `@${login} no crisis to answer right now.` };
  if (ac.contributeVerb !== verb)
    return {
      handled: true,
      reply: `@${login} that won't help ${ac.name} — try !${ac.contributeVerb}.`,
    };
  const r = contributeToCrisis(world, login, 1);
  if (r.ok) ctx.store.putWorldState(world);
  return {
    handled: true,
    result: r,
    reply: r.ok ? `@${login} +1 to ${r.crisis} (${r.total}/${r.target}).` : `@${login} ${r.error}.`,
  };
}

// Build the market-engine context from a chat dispatch ctx + a parsed body.
function marketCtx(login, ctx, body) {
  return {
    login,
    token: ctx.token,
    character: ctx.character,
    store: ctx.store,
    world: ctx.store.getWorldState(),
    market: ctx.store.getMarket(),
    rt: ctx.rt,
    body,
    now: ctx.now,
  };
}

// Per-login throttle for world-mutating chat verbs. Bounded LRU-ish map.
const COMMAND_COOLDOWN_MS = 3000;
const lastCmdAt = new Map();
const COOLDOWN_MAP_MAX = 5000;

function throttled(login, now) {
  const prev = lastCmdAt.get(login) || 0;
  if (now - prev < COMMAND_COOLDOWN_MS) return true;
  lastCmdAt.set(login, now);
  if (lastCmdAt.size > COOLDOWN_MAP_MAX) {
    // drop the oldest ~10% to keep the map bounded
    const drop = Math.ceil(COOLDOWN_MAP_MAX * 0.1);
    let i = 0;
    for (const k of lastCmdAt.keys()) {
      lastCmdAt.delete(k);
      if (++i >= drop) break;
    }
  }
  return false;
}

// Friendly aliases so chatters don't have to type the canonical id.
const FACTION_ALIASES = {
  iron: "iron_veil",
  veil: "iron_veil",
  ironveil: "iron_veil",
  iron_veil: "iron_veil",
  crimson: "crimson_pact",
  pact: "crimson_pact",
  blood: "crimson_pact",
  crimson_pact: "crimson_pact",
  void: "void_order",
  order: "void_order",
  void_order: "void_order",
  ember: "ember_court",
  court: "ember_court",
  merchant: "ember_court",
  ember_court: "ember_court",
  abyss: "abyssal_convergence",
  abyssal: "abyssal_convergence",
  convergence: "abyssal_convergence",
  chaos: "abyssal_convergence",
  abyssal_convergence: "abyssal_convergence",
};

export function resolveFactionId(raw) {
  if (!raw) return null;
  const key = String(raw)
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
  if (FACTION_IDS.includes(key)) return key;
  return FACTION_ALIASES[key] || null;
}

// ── Faction core — pure mutation of one character + a result object ────
// Used by both the chat dispatcher and POST /api/faction/join/:login.
export function joinFaction(character, factionId, now) {
  const f = factionById(factionId);
  if (!f) return { ok: false, error: "unknown_faction" };

  // Abyssal Convergence is the prestige-gated endgame faction (master §0.1).
  if (f.prestigeGate && (character.prestige | 0) < f.prestigeGate) {
    return { ok: false, error: "prestige_gate", need: FACTION_ABYSSAL_PRESTIGE_GATE };
  }

  if (character.faction === factionId) {
    const rep = character.factionRep?.[factionId] || 0;
    return {
      ok: false,
      error: "already_member",
      faction: factionId,
      rank: factionRank(rep),
      title: factionRankTitle(factionId, rep),
    };
  }

  const switching = !!character.faction;
  // First real `!join` for an auto-enrolled sigma is a FREE re-pick (they never
  // chose the starter faction) — no cooldown, no defector brand.
  const freePick = switching && character.factionAutoAssigned;
  if (switching && !freePick) {
    const since = now - (character.factionJoinedAt || 0);
    if (since < FACTION_JOIN_COOLDOWN_MS) {
      return { ok: false, error: "cooldown", retryInMs: FACTION_JOIN_COOLDOWN_MS - since };
    }
    // Defecting brands you a traitor for a window (full mechanical bite
    // lands in a later milestone; M1 records the timestamp + feed).
    character.factionDefectorUntil = now + FACTION_DEFECTOR_MS;
  }

  character.faction = factionId;
  character.factionAutoAssigned = false; // an explicit join is a real choice
  if (!character.factionRep || typeof character.factionRep !== "object") character.factionRep = {};
  // First join → start at 0; re-joining a faction you already have standing
  // with keeps that standing (kill-driven rep carries over). Master §0.2.
  if (!Number.isFinite(character.factionRep[factionId])) character.factionRep[factionId] = 0;
  character.factionJoinedAt = now;
  character.factionRank = factionRank(character.factionRep[factionId]);

  return {
    ok: true,
    switched: switching && !freePick,
    faction: factionId,
    factionName: f.name,
    rep: character.factionRep[factionId],
    rank: character.factionRank,
    title: factionRankTitle(factionId, character.factionRep[factionId]),
  };
}

// Read-only standing snapshot for GET /api/faction/rep/:login + `!rep`.
export function factionRepView(character) {
  const fid = character.faction || null;
  const rep = fid ? character.factionRep?.[fid] || 0 : 0;
  return {
    faction: fid,
    factionName: fid ? factionById(fid)?.name || null : null,
    rank: fid ? factionRank(rep) : 0,
    title: fid ? factionRankTitle(fid, rep) : null,
    rep: character.factionRep || {},
    repInFaction: rep,
    defector:
      (character.factionDefectorUntil || 0) >
      (Number.isFinite(character?._now) ? character._now : 0),
    defectorUntil: character.factionDefectorUntil || 0,
  };
}

// ── Chat dispatch ─────────────────────────────────────────────────────
// ctx = { token, character, store, rt, now }. Returns a small result the
// chat-ping handler echoes in its JSON (the Twitch bot formats `reply`).
// Returns { handled:false } for anything that isn't an M1 verb so the base
// ping behaviour is unaffected.
export function dispatchCommand(login, cmd, args, ctx) {
  const verb = String(cmd || "")
    .toLowerCase()
    .replace(/^!/, "");
  if (!verb) return { handled: false };
  const argv = Array.isArray(args)
    ? args.map((a) => String(a))
    : String(args || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
  const now = Number.isFinite(ctx?.now) ? ctx.now : 0;
  const { token, character, store, rt } = ctx || {};

  switch (verb) {
    case "join": {
      if (!character || !token)
        return { handled: true, reply: "no sigma found — chat once first." };
      if (throttled(login, now)) return { handled: true, throttled: true };
      const factionId = resolveFactionId(argv[0]);
      if (!factionId) {
        return {
          handled: true,
          reply: `unknown faction. pick one: ${FACTION_IDS.join(", ")}`,
        };
      }
      const res = joinFaction(character, factionId, now);
      if (!res.ok) {
        return { handled: true, reply: joinFailMessage(res, login), result: res };
      }
      store.putPlayer(token, character);
      const entry = store.pushFeed({
        kind: "faction_join",
        login,
        name: character.name,
        faction: res.faction,
        switched: res.switched,
        detail: `${character.name} ${res.switched ? "defected to" : "joined"} ${res.factionName}`,
      });
      if (rt && typeof rt.broadcast === "function") rt.broadcast({ t: "feed", entry });
      return {
        handled: true,
        result: res,
        reply: `@${login} ${res.switched ? "defected to" : "joined"} ${res.factionName} — ${res.title}.`,
      };
    }
    case "rep":
    case "faction": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      character._now = now;
      const view = factionRepView(character);
      delete character._now;
      if (!view.faction) {
        return {
          handled: true,
          result: view,
          reply: `@${login} you are unaligned. !join <faction> — ${FACTION_IDS.join(", ")}.`,
        };
      }
      return {
        handled: true,
        result: view,
        reply: `@${login} ${view.title} (rep ${view.repInFaction}/1000)${view.defector ? " — branded a traitor" : ""}.`,
      };
    }

    // ── Economy verbs (master §5.1 / 02-economy.md §4.5) ──────────────
    case "list": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const slot = argv[0];
      const isAuction = (argv[1] || "").toLowerCase() === "auction";
      const r = market.listItem(
        marketCtx(login, ctx, {
          slot,
          kind: isAuction ? "auction" : "directSale",
          price: isAuction ? Number(argv[2]) || 1 : Number(argv[1]),
        }),
      );
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} listed ${r.item?.name} for ${r.price}g (fee ${r.fee}g)${r.matched ? " — sold instantly!" : `, id ${r.listingId}`}.`
          : `@${login} list failed: ${r.error}.`,
      };
    }
    case "buy": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = market.buyListing(marketCtx(login, ctx, { listingId: argv[0] }));
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} bought ${r.item?.name} for ${r.goldSpent}g (tax ${r.taxPaid}g).`
          : `@${login} buy failed: ${r.error}.`,
      };
    }
    case "bid": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = market.bidListing(
        marketCtx(login, ctx, { listingId: argv[0], amount: Number(argv[1]) }),
      );
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} high bid: ${r.newHigh}g.`
          : `@${login} bid failed: ${r.error}${r.minNext ? ` (min ${r.minNext})` : ""}.`,
      };
    }
    case "offer": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = market.postOffer(
        marketCtx(login, ctx, { slot: argv[0], rarity: argv[1], price: Number(argv[2]) }),
      );
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} buy order posted${r.matched ? " — matched instantly!" : ""} (${r.orderId}).`
          : `@${login} offer failed: ${r.error}.`,
      };
    }
    case "unlist": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = market.unlist(marketCtx(login, ctx, { listingId: argv[0] }));
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} unlisted ${r.item?.name} (no fee refund).`
          : `@${login} unlist failed: ${r.error}.`,
      };
    }
    case "salvage": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const all = (argv[0] || "").toLowerCase() === "all";
      const r = market.salvage(marketCtx(login, ctx, all ? { all: true } : { slot: argv[0] }));
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} salvaged ${r.itemsDestroyed} item(s) → ${r.dustGained} rune dust (${r.runeDust} total).`
          : `@${login} salvage failed: ${r.error}.`,
      };
    }
    case "reroll": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = market.reroll(marketCtx(login, ctx, { slot: argv[0] }));
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} rerolled ${argv[0]} (${r.cost} dust, ${r.rerolls}× forged) → ${r.affix?.stat} ${r.affix?.value}.`
          : `@${login} reroll failed: ${r.error}.`,
      };
    }
    case "vault": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const v = character.vault || [];
      return {
        handled: true,
        result: {
          vault: v.length,
          capacity: character.vaultCapacity,
          shards: character.shards | 0,
          runeDust: character.runeDust | 0,
        },
        reply: `@${login} vault ${v.length}/${character.vaultCapacity || 20}, ${character.shards | 0} shards, ${character.runeDust | 0} dust.`,
      };
    }

    // ── Crafting / talents (master §M3) ──────────────────────────────
    case "craft": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = forge.craft({
        login,
        token: ctx.token,
        character,
        store: ctx.store,
        body: { recipe_id: argv[0] },
        now,
      });
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} forged ${r.item?.name} (${r.item?.rarity}, ${r.placed}).`
          : `@${login} craft failed: ${r.error}${r.code ? ` (need ${r.code})` : ""}.`,
      };
    }
    case "talent": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      // !talent <skill> <1|2|3> <a|b>
      const skillId = String(argv[0] || "").toLowerCase();
      const tier = Math.max(0, Math.min(2, (Number(argv[1]) || 1) - 1));
      const pick = (argv[2] || "a").toLowerCase() === "b" ? 1 : 0;
      const tal = SKILL_TALENTS[skillId]?.[tier]?.[pick];
      if (!tal)
        return { handled: true, reply: `@${login} no such talent — !talent <skill> <1-3> <a|b>.` };
      const r = forge.talentUnlock({
        login,
        token: ctx.token,
        character,
        store: ctx.store,
        body: { skill_id: skillId, tier, talent_id: tal.id },
        now,
      });
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} unlocked ${tal.name} (-${r.prestigeSpent} prestige).`
          : `@${login} talent failed: ${r.error}${r.needLevel ? ` (need ${skillId} ${r.needLevel})` : ""}${r.need ? ` (need ${r.need} prestige)` : ""}.`,
      };
    }

    // ── Narrative crisis verbs + quests (master §M5) ─────────────────
    case "pray":
    case "rally":
    case "gather":
    case "escort":
    case "delve":
    case "fight":
      // !fight ALSO fires the raid swing via the chat-ping raid path (canon
      // §5.4 dual-dispatch); here it only contributes to a 'fight' crisis.
      return contributeVerb(login, verb, ctx);
    case "quests":
    case "quest": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      ensureQuests(character);
      ctx.store.putPlayer(ctx.token, character);
      const active = (character.quests || []).filter((q) => q.status === "active");
      const top = active[0];
      return {
        handled: true,
        result: { active: active.length, questLevel: character.questLevel | 0 },
        reply: top
          ? `@${login} quest: ${top.name} (${top.objectives.map((o) => `${o.progress}/${o.target}`).join(", ")}) — QLvl ${character.questLevel | 0}.`
          : `@${login} no active quests.`,
      };
    }

    // ── Retention (master §M7) ───────────────────────────────────────
    case "daily": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      retention.ensureFreshObjectives(character, now);
      ctx.store.putPlayer(ctx.token, character);
      const d = (character.dailyObjectives || []).filter((o) => !o.claimed);
      return {
        handled: true,
        result: { daily: character.dailyObjectives },
        reply: d.length
          ? `@${login} today: ${d.map((o) => `${o.label} (${o.progress}/${o.target})`).join(" · ")}`
          : `@${login} all dailies claimed — back tomorrow.`,
      };
    }
    case "achievements":
    case "achs": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      retention.syncAchievements(character);
      ctx.store.putPlayer(ctx.token, character);
      return {
        handled: true,
        result: { score: character.achievements?.score | 0 },
        reply: `@${login} ${(character.achievements?.earned || []).length} achievements, score ${character.achievements?.score | 0}.`,
      };
    }

    // ── Chat voting (master §M8) ─────────────────────────────────────
    case "vote": {
      const r = voting.castVote(login, String(argv[0] || "").toLowerCase());
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `@${login} voted ${r.option} (${r.votes}).`
          : `@${login} ${r.error === "bad_option" ? `options: ${(r.options || []).join(", ")}` : r.error}.`,
      };
    }

    // ── NPC interaction (master §M6) ─────────────────────────────────
    case "greet":
    case "ask": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = npcWorld.handleNpcInteract(
        { login, token: ctx.token, character, store: ctx.store, body: { npc: argv[0] }, now },
        verb,
      );
      return {
        handled: true,
        result: r,
        reply: r.ok
          ? `${r.npc}: "${r.line}" (${r.disposition})`
          : `@${login} ${r.error === "unknown_npc" ? `unknown NPC — try ${(r.npcs || []).slice(0, 3).join(", ")}` : r.error}.`,
      };
    }

    // ── Navi's onboarding rite (the 3-question wizard) ───────────────
    // !os / !found / !agent answer Navi's questions. Field-driven, so any
    // order works and a half-done rite can be finished later. Not throttled
    // (benign, one-time) — a chatter answering all three in a burst should
    // sail through. Reply is Navi's voice; t:'naviSay' shows it on the overlay.
    case "os":
    case "found":
    case "agent": {
      if (!character) return { handled: true, reply: "no sigma found — chat once first." };
      const r = onboarding.recordAnswer(login, character, verb, argv.join(" "), now);
      ctx.store.putPlayer(ctx.token, character);
      if (rt && typeof rt.broadcast === "function") {
        rt.broadcast({
          t: "naviSay",
          login,
          text: r.say || r.reply || "",
          progress: r.progress || 0,
          total: r.total || 3,
          ok: r.ok !== false,
          done: !!r.done,
          at: now,
        });
        if (r.done && !r.already && r.reward) {
          const entry = ctx.store.pushFeed({
            kind: "onboarding_done",
            login,
            name: character.name,
            detail: `${character.name} finished Navi's rite (+${r.reward.gold}g${r.reward.title ? `, "${r.reward.title}"` : ""})`,
          });
          rt.broadcast({ t: "feed", entry });
        }
      }
      return { handled: true, result: r, reply: r.reply };
    }

    default:
      return { handled: false };
  }
}

function joinFailMessage(res, login) {
  switch (res.error) {
    case "already_member":
      return `@${login} already ${res.title}.`;
    case "prestige_gate":
      return `@${login} the Abyssal Convergence only takes the proven — ${res.need} prestige required.`;
    case "cooldown": {
      const days = Math.ceil(res.retryInMs / (24 * 3600 * 1000));
      return `@${login} you switched factions too recently — ~${days}d before you can re-pledge.`;
    }
    default:
      return `@${login} could not join that faction.`;
  }
}
