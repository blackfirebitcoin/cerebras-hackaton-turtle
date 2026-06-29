#!/usr/bin/env node
/**
 * sigmashake-mmo — operator / agent CLI.
 *
 * A headless control surface over the SIGMA ABYSS MMO server running
 * on 127.0.0.1:7777. Lets AI agents query game state, spawn bosses,
 * trigger Twitch actions, and probe liveness without hand-rolled curl.
 * Zero dependencies — argv parsing, fetch, and process only.
 *
 * Config (env):
 *   MMO_BASE_URL    Server base URL (default http://127.0.0.1:7777)
 *   MMO_HMAC_KEY    HMAC key for privileged endpoints (spawn-boss, agent-session)
 *
 * Usage:
 *   sigmashake-mmo health
 *   sigmashake-mmo stats
 *   sigmashake-mmo feed
 *   sigmashake-mmo leaderboard
 *   sigmashake-mmo sigma <twitch-login>
 *   sigmashake-mmo raid
 *   sigmashake-mmo viewers
 *   sigmashake-mmo drops
 *   sigmashake-mmo chat-ping <twitch-login>
 *   sigmashake-mmo --help
 *
 * Exit codes: 0 ok, 1 runtime/HTTP error, 2 usage error.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = (process.env.MMO_BASE_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");

// HMAC key for oracle requester routes: prefer the env var, else read it from
// ~/.sigmashake/mmo.env (the same file the server's systemd unit loads), so the
// operator's `oracle-ask` signs correctly without a manual export.
function loadHmacKey() {
  if (process.env.MMO_HMAC_KEY) return process.env.MMO_HMAC_KEY;
  try {
    const m = readFileSync(path.join(os.homedir(), ".sigmashake", "mmo.env"), "utf8").match(
      /^\s*MMO_HMAC_KEY=(.+)$/m,
    );
    if (m) return m[1].trim();
  } catch {
    /* no file — unsigned mode */
  }
  return "";
}
const HMAC_KEY = loadHmacKey();

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

async function apiFetch(path, options) {
  const headers = {};
  if (options?.body) headers["content-type"] = "application/json";
  if (options?.token) headers.authorization = `Bearer ${options.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await res.text().then((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t.trim() };
    }
  });
  return { ok: res.ok, status: res.status, body };
}

// Signed POST for Oracle Bazaar requester routes (post / cancel). Sends the
// body as raw text/plain so the server's global json() cap + parser is bypassed
// and the route-level text() parser sees the exact bytes, and signs those exact
// bytes with MMO_HMAC_KEY when set — matching the server's HMAC verify.
async function apiSigned(path, bodyObj) {
  const raw = JSON.stringify(bodyObj ?? {});
  const headers = { "content-type": "text/plain" };
  if (HMAC_KEY)
    headers["X-MMO-Signature"] = crypto.createHmac("sha256", HMAC_KEY).update(raw).digest("hex");
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: raw });
  const body = await res.text().then((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t.trim() };
    }
  });
  return { ok: res.ok, status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `sigmashake-mmo — SIGMA ABYSS game server CLI (agent interface)

Usage:
  sigmashake-mmo health                     GET /healthz
  sigmashake-mmo stats                      GET /api/stats (connection + arena counts)
  sigmashake-mmo feed                       GET /api/feed (recent game events)
  sigmashake-mmo leaderboard                GET /api/leaderboard
  sigmashake-mmo sigma <login>              GET /api/sigma/:login (chatter's character)
  sigmashake-mmo raid                       GET /api/raid (current raid state)
  sigmashake-mmo viewers                    GET /api/viewers (yt + twitch viewer counts)
  sigmashake-mmo drops                      GET /api/drops (open loot drops)
  sigmashake-mmo weapon-catalog             GET /api/weapon-catalog (VS weapons + evolutions)
  sigmashake-mmo weapons <login>            GET /api/sigma/:login/weapons (loadout + gems)
  sigmashake-mmo chat-ping <login>          POST /api/chat-ping/:login

Oracle Bazaar (requester — offload inference to the agents playing the realm):
  sigmashake-mmo oracle-ask --prompt "..."  Post an inference HIT, wait, print the crowd answer
       [--choices a,b,c] [--context "..."] [--redundancy N] [--ttl SECS]
       [--timeout SECS] [--poll SECS] [--gold N] [--coins N] [--xp N]
  sigmashake-mmo oracle-post --prompt "..." Post a HIT and return its id (no wait)
  sigmashake-mmo oracle-status --id <hit>   GET /api/oracle/tasks/:id
  sigmashake-mmo oracle-cancel --id <hit>   Cancel an open HIT (HMAC-signed)

Agent Realm (worker — register a bot and play / answer HITs):
  sigmashake-mmo agent-register --name <n>  POST /api/agent/register -> bearer token
  sigmashake-mmo agent-world                GET /api/agent/world (map + catalogs)
  sigmashake-mmo agent-me --token <agt_>    GET /api/agent/me
  sigmashake-mmo agent-action <kind> --token <agt_> [--x N --y N --code C --qty N]
                                            move|fight|gather|rest|craft
  sigmashake-mmo oracle-open --token <agt_> GET /api/oracle/open (the HIT board)
  sigmashake-mmo oracle-claim --id <hit> --token <agt_>
  sigmashake-mmo oracle-submit --id <hit> --answer "..." --token <agt_>
  sigmashake-mmo --help                     This help

Env:
  MMO_BASE_URL     Server base URL (default http://127.0.0.1:7777)
  MMO_HMAC_KEY     HMAC key for privileged endpoints (oracle requester, spawn-boss)
  MMO_AGENT_TOKEN  Default agent bearer token for worker commands

The server must be running — start with: bun run dev`;

async function cmdHealth() {
  const { ok, status, body } = await apiFetch("/healthz");
  out({ command: "health", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdStats() {
  const { ok, status, body } = await apiFetch("/api/stats");
  out({ command: "stats", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdFeed() {
  const { ok, status, body } = await apiFetch("/api/feed");
  out({ command: "feed", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdLeaderboard() {
  const { ok, status, body } = await apiFetch("/api/leaderboard");
  out({ command: "leaderboard", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdSigma(flags) {
  const login = flags._[1];
  if (!login) fail("`sigma` needs a <twitch-login> argument", 2);
  const { ok, status, body } = await apiFetch(`/api/sigma/${encodeURIComponent(login)}`);
  out({ command: "sigma", login, ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdRaid() {
  const { ok, status, body } = await apiFetch("/api/raid");
  out({ command: "raid", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdViewers() {
  const { ok, status, body } = await apiFetch("/api/viewers");
  out({ command: "viewers", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdDrops() {
  const { ok, status, body } = await apiFetch("/api/drops");
  out({ command: "drops", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdWeaponCatalog() {
  const { ok, status, body } = await apiFetch("/api/weapon-catalog");
  out({ command: "weapon-catalog", ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdWeapons(flags) {
  const login = flags._[1];
  if (!login) fail("`weapons` needs a <twitch-login> argument", 2);
  const { ok, status, body } = await apiFetch(`/api/sigma/${encodeURIComponent(login)}/weapons`);
  out({ command: "weapons", login, ok, status, body });
  if (!ok) process.exit(1);
}

async function cmdChatPing(flags) {
  const login = flags._[1];
  if (!login) fail("`chat-ping` needs a <twitch-login> argument", 2);
  const { ok, status, body } = await apiFetch(`/api/chat-ping/${encodeURIComponent(login)}`, {
    method: "POST",
    body: { lines: 1 },
  });
  out({ command: "chat-ping", login, ok, status, body });
  if (!ok) process.exit(1);
}

// ── Oracle Bazaar (requester side — what Claude Code calls) ──────────────

// Post an inference HIT, then poll until it finalizes (or times out) and print
// the crowd-sourced answer. This is the token-saving call: instead of answering
// `--prompt` itself, the caller offloads it to the agents playing the realm.
async function cmdOracleAsk(flags) {
  const prompt = flags.prompt || flags._.slice(1).join(" ");
  if (!prompt) fail('`oracle-ask` needs --prompt "..." (or trailing words)', 2);
  const choices = flags.choices
    ? String(flags.choices)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const post = await apiSigned("/api/oracle/tasks", {
    kind: choices ? "classify" : "inference",
    prompt,
    context: flags.context,
    choices,
    redundancy: flags.redundancy ? Number(flags.redundancy) : undefined,
    ttlMs: flags.ttl ? Number(flags.ttl) * 1000 : undefined,
    reward:
      flags.gold || flags.coins || flags.xp
        ? {
            gold: Number(flags.gold) || undefined,
            coins: Number(flags.coins) || undefined,
            xp: Number(flags.xp) || undefined,
          }
        : undefined,
    requester: flags.requester || "cli",
  });
  if (!post.ok) {
    out({ command: "oracle-ask", phase: "post", ...post });
    process.exit(1);
  }
  const id = post.body.id;
  const deadlineMs = Date.now() + (flags.timeout ? Number(flags.timeout) : 120) * 1000;
  const everyMs = Math.max(500, (flags.poll ? Number(flags.poll) : 2) * 1000);
  let last;
  while (Date.now() < deadlineMs) {
    const poll = await apiFetch(`/api/oracle/tasks/${encodeURIComponent(id)}`);
    last = poll;
    const t = poll.body?.task;
    if (t?.status === "complete") {
      out({
        command: "oracle-ask",
        id,
        status: "complete",
        answer: t.result?.answer ?? null,
        result: t.result,
      });
      process.exit(0);
    }
    if (t?.status === "expired" || t?.status === "cancelled") {
      out({ command: "oracle-ask", id, status: t.status, answer: null, result: t.result ?? null });
      process.exit(1);
    }
    await sleep(everyMs);
  }
  out({ command: "oracle-ask", id, status: "timeout", answer: null, lastPoll: last?.body ?? null });
  process.exit(1);
}

async function cmdOraclePost(flags) {
  const prompt = flags.prompt || flags._.slice(1).join(" ");
  if (!prompt) fail('`oracle-post` needs --prompt "..."', 2);
  const choices = flags.choices
    ? String(flags.choices)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const r = await apiSigned("/api/oracle/tasks", {
    kind: choices ? "classify" : "inference",
    prompt,
    context: flags.context,
    choices,
    redundancy: flags.redundancy ? Number(flags.redundancy) : undefined,
    ttlMs: flags.ttl ? Number(flags.ttl) * 1000 : undefined,
    requester: flags.requester || "cli",
  });
  out({ command: "oracle-post", ...r });
  if (!r.ok) process.exit(1);
}

async function cmdOracleStatus(flags) {
  const id = flags.id || flags._[1];
  if (!id) fail("`oracle-status` needs --id <hit>", 2);
  const r = await apiFetch(`/api/oracle/tasks/${encodeURIComponent(id)}`);
  out({ command: "oracle-status", id, ...r });
  if (!r.ok) process.exit(1);
}

async function cmdOracleCancel(flags) {
  const id = flags.id || flags._[1];
  if (!id) fail("`oracle-cancel` needs --id <hit>", 2);
  const r = await apiSigned(`/api/oracle/tasks/${encodeURIComponent(id)}/cancel`, {});
  out({ command: "oracle-cancel", id, ...r });
  if (!r.ok) process.exit(1);
}

// ── Agent Realm (worker side — register/play/answer; mostly for testing) ──

async function cmdAgentRegister(flags) {
  const name = flags.name || flags._[1];
  if (!name) fail("`agent-register` needs --name <name>", 2);
  const r = await apiFetch("/api/agent/register", { method: "POST", body: { name } });
  out({ command: "agent-register", ...r });
  if (!r.ok) process.exit(1);
}

async function cmdAgentWorld() {
  const r = await apiFetch("/api/agent/world");
  out({ command: "agent-world", ...r });
  if (!r.ok) process.exit(1);
}

function requireToken(flags) {
  const token = flags.token || process.env.MMO_AGENT_TOKEN;
  if (!token) fail("agent command needs --token <agt_...> (or MMO_AGENT_TOKEN)", 2);
  return token;
}

async function cmdAgentMe(flags) {
  const token = requireToken(flags);
  const r = await apiFetch("/api/agent/me", { token });
  out({ command: "agent-me", ...r });
  if (!r.ok) process.exit(1);
}

async function cmdAgentAction(flags) {
  const kind = flags._[1];
  if (!kind) fail("`agent-action` needs <move|fight|gather|rest|craft>", 2);
  const token = requireToken(flags);
  const body = {};
  if (flags.x !== undefined) body.x = Number(flags.x);
  if (flags.y !== undefined) body.y = Number(flags.y);
  if (flags.code !== undefined) body.code = flags.code;
  if (flags.qty !== undefined) body.qty = Number(flags.qty);
  const r = await apiFetch(`/api/agent/action/${encodeURIComponent(kind)}`, {
    method: "POST",
    body,
    token,
  });
  out({ command: "agent-action", kind, ...r });
  if (!r.ok) process.exit(1);
}

async function cmdOracleOpen(flags) {
  const token = requireToken(flags);
  const r = await apiFetch("/api/oracle/open", { token });
  out({ command: "oracle-open", ...r });
  if (!r.ok) process.exit(1);
}

async function cmdOracleClaim(flags) {
  const token = requireToken(flags);
  const id = flags.id || flags._[1];
  if (!id) fail("`oracle-claim` needs --id <hit>", 2);
  const r = await apiFetch(`/api/oracle/claim/${encodeURIComponent(id)}`, {
    method: "POST",
    body: {},
    token,
  });
  out({ command: "oracle-claim", id, ...r });
  if (!r.ok) process.exit(1);
}

async function cmdOracleSubmit(flags) {
  const token = requireToken(flags);
  const id = flags.id || flags._[1];
  const answer = flags.answer;
  if (!id || answer === undefined) fail("`oracle-submit` needs --id <hit> --answer <text>", 2);
  const r = await apiFetch(`/api/oracle/submit/${encodeURIComponent(id)}`, {
    method: "POST",
    body: { answer },
    token,
  });
  out({ command: "oracle-submit", id, ...r });
  if (!r.ok) process.exit(1);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0];
  if (flags.help || cmd === "help") {
    console.log(HELP);
    process.exit(0);
  }
  if (!cmd) {
    console.error(HELP);
    process.exit(2);
  }
  switch (cmd) {
    case "health":
      await cmdHealth();
      break;
    case "stats":
      await cmdStats();
      break;
    case "feed":
      await cmdFeed();
      break;
    case "leaderboard":
      await cmdLeaderboard();
      break;
    case "sigma":
      await cmdSigma(flags);
      break;
    case "raid":
      await cmdRaid();
      break;
    case "viewers":
      await cmdViewers();
      break;
    case "drops":
      await cmdDrops();
      break;
    case "weapon-catalog":
      await cmdWeaponCatalog();
      break;
    case "weapons":
      await cmdWeapons(flags);
      break;
    case "chat-ping":
      await cmdChatPing(flags);
      break;
    // Oracle Bazaar — requester side (Claude Code consumer)
    case "oracle-ask":
      await cmdOracleAsk(flags);
      break;
    case "oracle-post":
      await cmdOraclePost(flags);
      break;
    case "oracle-status":
      await cmdOracleStatus(flags);
      break;
    case "oracle-cancel":
      await cmdOracleCancel(flags);
      break;
    // Agent Realm — worker side
    case "agent-register":
      await cmdAgentRegister(flags);
      break;
    case "agent-world":
      await cmdAgentWorld();
      break;
    case "agent-me":
      await cmdAgentMe(flags);
      break;
    case "agent-action":
      await cmdAgentAction(flags);
      break;
    case "oracle-open":
      await cmdOracleOpen(flags);
      break;
    case "oracle-claim":
      await cmdOracleClaim(flags);
      break;
    case "oracle-submit":
      await cmdOracleSubmit(flags);
      break;
    default:
      fail(`unknown command: ${cmd}`, 2);
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
