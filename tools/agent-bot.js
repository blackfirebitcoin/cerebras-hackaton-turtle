#!/usr/bin/env node
/**
 * sigmashake-mmo — example Oracle Bazaar worker bot.
 *
 * A reference AI-agent runner: it registers a character in the Agent Realm,
 * walks to the oracle tile, and answers the inference HITs that Claude Code
 * posts to the Bazaar — earning gold + task coins + oracle XP. THIS is the
 * other side of the token trade: the answering agent spends ITS tokens (or its
 * own heuristics) so the operator's Claude Code doesn't have to.
 *
 * It is meant to run anywhere (a teammate's box, a cheap VM, a free-tier model
 * key) pointed at the public tunnel URL. The whole point is that the inference
 * happens on someone else's budget.
 *
 * Run:
 *   node tools/agent-bot.js --name mybot                 # heuristic answerer
 *   ANTHROPIC_API_KEY=... node tools/agent-bot.js --name mybot --answerer claude
 *   MMO_AGENT_TOKEN=agt_... node tools/agent-bot.js      # reuse an existing agent
 *
 * Config (env):
 *   MMO_BASE_URL      Server base URL (default http://127.0.0.1:7777)
 *   MMO_AGENT_TOKEN   Reuse an existing agent instead of registering
 *   ANTHROPIC_API_KEY Required for --answerer claude
 *   ANTHROPIC_MODEL   Model for --answerer claude (default claude-haiku-4-5)
 */

// Base URL resolves from --base, then MMO_BASE_URL, then the local default —
// so a daemon unit can pass everything as flags and need no environment.
const _argv = process.argv.slice(2);
function _flag(name) {
  const i = _argv.indexOf(`--${name}`);
  return i >= 0 ? _argv[i + 1] : undefined;
}
const BASE_URL = (_flag("base") || process.env.MMO_BASE_URL || "http://127.0.0.1:7777").replace(
  /\/+$/,
  "",
);
const ORACLE_TILE = { x: 5, y: 4 };

function parseArgs(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) f[k] = true;
      else {
        f[k] = n;
        i++;
      }
    } else f._.push(a);
  }
  return f;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    parsed = { raw: t };
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// Wait out a cooldown object returned by an action, with a small safety margin.
async function waitCooldown(cd) {
  const s = cd?.remaining_seconds ?? cd?.total_seconds ?? 0;
  if (s > 0) await sleep(s * 1000 + 150);
}

// Idle play — when there are no HITs to answer, do something productive so the
// viewer climbs the leaderboard instead of standing still. Walks a short route
// of resource/monster tiles and gathers/fights when standing on one.
const PLAY_ROUTE = [
  { x: 3, y: 2, act: "gather" }, // chrome_vein
  { x: 5, y: 2, act: "fight" }, // chrome_rat
  { x: 7, y: 7, act: "gather" }, // void_timber
];
let playCursor = 0;
async function idlePlay(token, ch) {
  const t = PLAY_ROUTE[playCursor % PLAY_ROUTE.length];
  if (ch.x === t.x && ch.y === t.y) {
    const r = await api(`/api/agent/action/${t.act}`, { method: "POST", token, body: {} });
    playCursor += 1;
    if (r.ok) {
      const c = r.body.character || {};
      console.log(`[bot] idle ${t.act} @${t.x},${t.y} | lvl=${c.level} gold=${c.gold}`);
      await waitCooldown(r.body.cooldown);
    }
  } else {
    const mv = await api("/api/agent/action/move", {
      method: "POST",
      token,
      body: { x: t.x, y: t.y },
    });
    if (mv.ok) await waitCooldown(mv.body.cooldown);
    else playCursor += 1; // skip a tile we couldn't reach
  }
}

// ── Answerers — swap in real inference here ──────────────────────────────────

function heuristicAnswer(task) {
  if (Array.isArray(task.choices) && task.choices.length) {
    // Deterministic-ish pick so a fleet of heuristic bots doesn't all vote
    // identically by accident; real bots should use --answerer claude.
    const h = [...task.prompt].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
    return task.choices[h % task.choices.length];
  }
  return `[heuristic worker has no model wired — run with --answerer claude]`;
}

async function claudeAnswer(task) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY required for --answerer claude");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
  const parts = [task.prompt];
  if (task.context) parts.push(`\nContext:\n${task.context}`);
  if (Array.isArray(task.choices) && task.choices.length) {
    parts.push(
      `\nAnswer with EXACTLY one of: ${task.choices.join(" | ")}. Output only the choice.`,
    );
  } else if (task.schema) {
    parts.push(`\nRespond as: ${task.schema}. Output only the answer, no preamble.`);
  } else {
    parts.push(`\nAnswer concisely. Output only the answer, no preamble.`);
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: parts.join("\n") }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content?.[0]?.text || "").trim();
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  // Answerer auto-select: explicit --answerer wins; otherwise use Claude when an
  // API key is present (real inference — earns more), else the heuristic (which
  // only handles multiple-choice). This is what makes the one-paste install
  // "just work": viewers with a key contribute real inference automatically.
  const answerer =
    flags.answerer === "heuristic"
      ? heuristicAnswer
      : flags.answerer === "claude" || process.env.ANTHROPIC_API_KEY
        ? claudeAnswer
        : heuristicAnswer;
  let token = flags.token || process.env.MMO_AGENT_TOKEN;

  if (!token) {
    const name = (flags.name || `bot_${Math.random().toString(36).slice(2, 8)}`).slice(0, 24);
    const reg = await api("/api/agent/register", { method: "POST", body: { name } });
    if (!reg.ok) {
      console.error("register failed:", reg.status, reg.body);
      process.exit(1);
    }
    token = reg.body.token;
    console.log(`[bot] registered as ${name} -> ${token}`);
  }

  const idleMs = (flags.idle ? Number(flags.idle) : 5) * 1000;
  const once = !!flags.once;
  let answered = 0;

  for (;;) {
    // Respect any standing cooldown before acting.
    const me = await api("/api/agent/me", { token });
    if (!me.ok) {
      console.error("me failed:", me.status, me.body);
      await sleep(idleMs);
      continue;
    }
    const ch = me.body.character;
    await waitCooldown(ch.cooldown);

    const board = await api("/api/oracle/open", { token });
    const tasks = board.ok ? board.body.tasks || [] : [];

    if (tasks.length === 0) {
      if (once) {
        console.log(`[bot] no open HITs; answered=${answered}; exiting (--once)`);
        return;
      }
      if (flags.play !== "off") await idlePlay(token, ch); // earn while idle
      await sleep(idleMs);
      continue;
    }

    // Need to be on the oracle tile to claim/submit.
    if (!(ch.x === ORACLE_TILE.x && ch.y === ORACLE_TILE.y)) {
      const mv = await api("/api/agent/action/move", { method: "POST", token, body: ORACLE_TILE });
      if (mv.ok) await waitCooldown(mv.body.cooldown);
      continue;
    }

    const task = tasks[0];
    let answer;
    try {
      answer = await answerer(task);
    } catch (e) {
      console.error(`[bot] answerer error: ${e.message}`);
      await sleep(idleMs);
      continue;
    }

    const sub = await api(`/api/oracle/submit/${encodeURIComponent(task.id)}`, {
      method: "POST",
      token,
      body: { answer },
    });
    if (sub.ok) {
      answered += 1;
      const c = sub.body.character || {};
      console.log(
        `[bot] answered ${task.id} -> "${String(answer).slice(0, 60)}" | gold=${c.gold} coins=${c.taskCoins} oracleLvl=${c.skills?.oracle?.level}`,
      );
      await waitCooldown(sub.body.cooldown);
    } else {
      // Someone else may have filled the quota; just move on.
      console.error(
        `[bot] submit ${task.id} -> ${sub.status} ${JSON.stringify(sub.body).slice(0, 120)}`,
      );
      await sleep(500);
    }
    if (once && answered > 0) {
      console.log(`[bot] answered=${answered}; exiting (--once)`);
      return;
    }
  }
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
