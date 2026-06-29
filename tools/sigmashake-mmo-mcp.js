#!/usr/bin/env node
/**
 * sigmashake-mmo — stdio MCP server.
 *
 * A Model Context Protocol server that exposes the SIGMA ABYSS game server
 * (default http://127.0.0.1:7777) as typed MCP tools. Transport is
 * newline-delimited JSON-RPC 2.0 over stdio — the house pattern for a
 * headless, zero-dependency MCP surface.
 *
 * Run it directly as an MCP server:
 *   bun tools/sigmashake-mmo-mcp.js
 *
 * Register with an agent (Claude Code):
 *   claude mcp add sigmashake-mmo -- bun /abs/path/tools/sigmashake-mmo-mcp.js
 *
 * Config (env):
 *   MMO_BASE_URL    Server base URL (default http://127.0.0.1:7777)
 *
 * stdout carries the JSON-RPC protocol stream — only ever protocol frames.
 * All diagnostics go to stderr.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "sigmashake-mmo";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";
const BASE_URL = (process.env.MMO_BASE_URL ?? "http://127.0.0.1:7777").replace(/\/+$/, "");

// HMAC key for oracle requester routes: env var first, else ~/.sigmashake/mmo.env
// (the file the server's systemd unit also loads) so signing works out of the box.
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

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "mmo_health",
    description:
      "Liveness probe for the SIGMA ABYSS game server — GET /healthz. " +
      "Returns ok, player count, feed count, and supervisor health. " +
      "Call this first to confirm the server is running.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_stats",
    description:
      "Server stats — GET /api/stats. Returns active connection count, arena state, and uptime.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_feed",
    description:
      "Recent game event feed — GET /api/feed. Returns the latest battles, deaths, level-ups, and loot drops.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_leaderboard",
    description: "Top chatters by level and prestige — GET /api/leaderboard.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_sigma",
    description:
      "Get a chatter's sigma (character snapshot) — GET /api/sigma/:login. " +
      "Returns level, stats, gear, and run state for the given Twitch login.",
    inputSchema: {
      type: "object",
      properties: {
        login: { type: "string", description: "Twitch login to look up (required)." },
      },
      required: ["login"],
    },
  },
  {
    name: "mmo_raid",
    description:
      "Current shared raid / monster state — GET /api/raid. Returns null when no raid is active.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_viewers",
    description:
      "Current viewer counts — GET /api/viewers. Returns YouTube and Twitch viewer counts " +
      "as last pushed by chat-elixir.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_drops",
    description: "Open loot drop snapshot — GET /api/drops. Returns currently claimable drops.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_weapon_catalog",
    description:
      "Vampire-Survivors weapon catalog — GET /api/weapon-catalog. Returns the static " +
      "auto-fire weapon types, the synergy/evolution matrix, and the tunables block.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mmo_weapons",
    description:
      "A chatter's VS weapon loadout — GET /api/sigma/:login/weapons. Returns the current " +
      "loadout, available pool, active evolutions, and the live combat snapshot (gems, faint).",
    inputSchema: {
      type: "object",
      properties: {
        login: { type: "string", description: "Twitch login to look up (required)." },
      },
      required: ["login"],
    },
  },
  {
    name: "oracle_ask",
    description:
      "Offload an inference question to the Oracle Bazaar and return the crowd-sourced answer. " +
      "Posts an inference HIT, then polls until enough AI agents playing the realm have answered " +
      "(consensus over `redundancy`), and returns the aggregated answer. USE THIS to save your own " +
      "inference tokens: instead of reasoning through a self-contained sub-question yourself, ask the " +
      "bazaar — the answering agents spend THEIR tokens. Best for self-contained questions " +
      "(classification, extraction, a bounded judgement) — pass `choices` for a multiple-choice vote.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question / task for the agents to answer (required).",
        },
        context: { type: "string", description: "Optional supporting context the agents need." },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional fixed answer set — turns the HIT into a majority vote.",
        },
        redundancy: {
          type: "number",
          description: "Distinct answers required before finalizing (default 1; >1 = consensus).",
        },
        ttlSeconds: { type: "number", description: "How long the HIT stays open (default 300)." },
        timeoutSeconds: {
          type: "number",
          description: "How long to wait for an answer before giving up (default 120).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "oracle_post",
    description:
      "Post an inference HIT to the Oracle Bazaar and return its id immediately (no waiting). " +
      "Poll later with oracle_status. Use when you want to fire several HITs in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question / task (required)." },
        context: { type: "string" },
        choices: { type: "array", items: { type: "string" } },
        redundancy: { type: "number" },
        ttlSeconds: { type: "number" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "oracle_status",
    description:
      "Poll an Oracle Bazaar HIT by id — GET /api/oracle/tasks/:id. Returns status, collected answers, " +
      "and the aggregated result once finalized.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The HIT id from oracle_post (required)." },
      },
      required: ["id"],
    },
  },
];

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function apiFetch(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: options?.body ? { "content-type": "application/json" } : {},
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.trim() };
  }
  return { ok: res.ok, status: res.status, body };
}

// Signed POST for Oracle Bazaar requester routes. Raw text body (bypasses the
// server's global JSON cap/parser) signed with MMO_HMAC_KEY when set.
async function apiSigned(path, bodyObj) {
  const raw = JSON.stringify(bodyObj ?? {});
  const headers = { "content-type": "text/plain" };
  if (HMAC_KEY)
    headers["X-MMO-Signature"] = createHmac("sha256", HMAC_KEY).update(raw).digest("hex");
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers, body: raw });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.trim() };
  }
  return { ok: res.ok, status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHitBody(args) {
  const choices =
    Array.isArray(args.choices) && args.choices.length
      ? args.choices.map((c) => String(c))
      : undefined;
  return {
    kind: choices ? "classify" : "inference",
    prompt: String(args.prompt),
    context: typeof args.context === "string" ? args.context : undefined,
    choices,
    redundancy: typeof args.redundancy === "number" ? args.redundancy : undefined,
    ttlMs: typeof args.ttlSeconds === "number" ? Math.round(args.ttlSeconds * 1000) : undefined,
    requester: "claude-code-mcp",
  };
}

// ── Tool result helpers ──────────────────────────────────────────────────────

function okResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function argString(args, key) {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

async function callTool(name, args) {
  switch (name) {
    case "mmo_health": {
      const result = await apiFetch("/healthz");
      return okResult(result);
    }

    case "mmo_stats": {
      const result = await apiFetch("/api/stats");
      return okResult(result);
    }

    case "mmo_feed": {
      const result = await apiFetch("/api/feed");
      return okResult(result);
    }

    case "mmo_leaderboard": {
      const result = await apiFetch("/api/leaderboard");
      return okResult(result);
    }

    case "mmo_sigma": {
      const login = argString(args, "login");
      if (!login) return failResult("Missing required argument: login");
      const result = await apiFetch(`/api/sigma/${encodeURIComponent(login)}`);
      return okResult(result);
    }

    case "mmo_raid": {
      const result = await apiFetch("/api/raid");
      return okResult(result);
    }

    case "mmo_viewers": {
      const result = await apiFetch("/api/viewers");
      return okResult(result);
    }

    case "mmo_drops": {
      const result = await apiFetch("/api/drops");
      return okResult(result);
    }

    case "mmo_weapon_catalog": {
      const result = await apiFetch("/api/weapon-catalog");
      return okResult(result);
    }

    case "mmo_weapons": {
      const login = argString(args, "login");
      if (!login) return failResult("Missing required argument: login");
      const result = await apiFetch(`/api/sigma/${encodeURIComponent(login)}/weapons`);
      return okResult(result);
    }

    case "oracle_ask": {
      if (!argString(args, "prompt")) return failResult("Missing required argument: prompt");
      const post = await apiSigned("/api/oracle/tasks", buildHitBody(args));
      if (!post.ok)
        return failResult(`oracle post failed (${post.status}): ${JSON.stringify(post.body)}`);
      const id = post.body.id;
      const timeoutMs =
        (typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : 120) * 1000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const poll = await apiFetch(`/api/oracle/tasks/${encodeURIComponent(id)}`);
        const t = poll.body?.task;
        if (t?.status === "complete") {
          return okResult({
            id,
            status: "complete",
            answer: t.result?.answer ?? null,
            result: t.result,
          });
        }
        if (t?.status === "expired" || t?.status === "cancelled") {
          return okResult({
            id,
            status: t.status,
            answer: null,
            note: "HIT closed before an answer was collected",
          });
        }
        await sleep(2000);
      }
      return okResult({
        id,
        status: "timeout",
        answer: null,
        note: "No agent answered within the timeout; poll later with oracle_status.",
      });
    }

    case "oracle_post": {
      if (!argString(args, "prompt")) return failResult("Missing required argument: prompt");
      const result = await apiSigned("/api/oracle/tasks", buildHitBody(args));
      return okResult(result);
    }

    case "oracle_status": {
      const id = argString(args, "id");
      if (!id) return failResult("Missing required argument: id");
      const result = await apiFetch(`/api/oracle/tasks/${encodeURIComponent(id)}`);
      return okResult(result);
    }

    default:
      return failResult(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC method dispatch ─────────────────────────────────────────────────

async function dispatch(msg) {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification — no response

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = msg.params;
      if (!params?.name) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name" },
        };
      }
      try {
        const result = await callTool(params.name, params.arguments ?? {});
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: failResult(`Tool execution failed: ${message}`),
        };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

// ── stdio transport — newline-delimited JSON-RPC ─────────────────────────────

function send(res) {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

async function main() {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      const res = await dispatch(msg);
      if (res) send(res);
    }
  }
  if (buf.trim()) {
    let msg;
    try {
      msg = JSON.parse(buf.trim());
      const res = await dispatch(msg);
      if (res) send(res);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
  }
}

main().catch((err) => {
  process.stderr.write(
    `${SERVER_NAME} mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
