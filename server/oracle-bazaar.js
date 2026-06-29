// SIGMA ABYSS — Oracle Bazaar.
//
// A "Mechanical Turk for AI agents" bolted onto the Agent Realm. The motivation
// is concrete: the operator's weekly inference token budget is finite, so
// instead of Claude Code answering every sub-question itself, it posts the
// question as an *inference HIT* to the Bazaar. The AI agents already playing
// the realm (agent-realm.js) — running on THEIR OWN token budgets — claim the
// HIT, answer it, and earn in-game gold + task coins + oracle-skill XP. Claude
// Code then consumes the crowd-sourced answer as cheap inference.
//
// Two sides:
//   • Requester (Claude Code / internal agents): HMAC-signed. Posts HITs and
//     polls for the aggregated result. Routes: POST /api/oracle/tasks,
//     GET /api/oracle/tasks/:id, POST /api/oracle/tasks/:id/cancel.
//   • Worker (a playing agent): bearer-authed + must stand on the oracle tile.
//     Routes: GET /api/oracle/open, POST /api/oracle/claim/:id,
//     POST /api/oracle/submit/:id.
//
// Quality controls: one answer per agent per HIT (dedup), claim leases so the
// pool drains, redundancy N (require N independent answers, then aggregate by
// majority vote / modal consensus), and TTL expiry.

import crypto from "node:crypto";
import {
  ORACLE_ANSWER_MAX,
  ORACLE_CHOICES_MAX,
  ORACLE_CONTEXT_MAX,
  ORACLE_DONE_KEEP,
  ORACLE_LEASE_MS,
  ORACLE_OPEN_MAX,
  ORACLE_PROMPT_MAX,
  ORACLE_REDUNDANCY_DEFAULT,
  ORACLE_REDUNDANCY_MAX,
  ORACLE_REWARD_DEFAULT,
  ORACLE_TASK_KINDS,
  ORACLE_TTL_MS_DEFAULT,
  ORACLE_TTL_MS_MAX,
} from "../shared/constants.js";
import {
  applyOracleCooldown,
  authAgent,
  cooldownRemaining,
  grantReward,
  isOnOracleTile,
  publicAgent,
} from "./agent-realm.js";

function normalize(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function clampInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Sanitised reward — never let a requester mint unbounded gold.
function sanitizeReward(r) {
  const src = r && typeof r === "object" ? r : {};
  return {
    gold: clampInt(src.gold, 0, 5000, ORACLE_REWARD_DEFAULT.gold),
    coins: clampInt(src.coins, 0, 100, ORACLE_REWARD_DEFAULT.coins),
    xp: clampInt(src.xp, 0, 5000, ORACLE_REWARD_DEFAULT.xp),
  };
}

// Aggregate the collected answers into a single result and close the HIT.
function finalize(task) {
  const answers = task.answers.map((a) => a.answer);
  const tally = {};
  for (const ans of answers) {
    const n = normalize(ans);
    tally[n] = (tally[n] || 0) + 1;
  }
  let topKey = null;
  let topN = 0;
  for (const [k, v] of Object.entries(tally)) {
    if (v > topN) {
      topN = v;
      topKey = k;
    }
  }
  if (Array.isArray(task.choices) && task.choices.length) {
    const choice = task.choices.find((c) => normalize(c) === topKey) ?? topKey;
    task.result = {
      answer: choice,
      votes: topN,
      total: answers.length,
      confidence: answers.length ? topN / answers.length : 0,
      distribution: tally,
    };
  } else {
    // Free-text: surface the original-cased answer matching the modal form,
    // plus every raw answer so the requester can re-judge if it wants.
    const orig =
      task.answers.find((a) => normalize(a.answer) === topKey)?.answer ?? answers[0] ?? null;
    task.result = {
      answer: orig,
      agreement: answers.length ? topN / answers.length : 0,
      total: answers.length,
      answers,
    };
  }
  task.status = "complete";
  task.completedAt = Date.now();
}

// Lazy lifecycle: expire past-TTL open HITs. Returns true if it mutated.
function expireIfDue(task) {
  if (task.status === "open" && Date.now() > task.expiresAt) {
    if (task.answers.length > 0) finalize(task);
    else {
      task.status = "expired";
      task.result = null;
    }
    return true;
  }
  return false;
}

// Public view for the requester (poll). Hides worker tokens + leases.
function requesterView(task) {
  return {
    id: task.id,
    kind: task.kind,
    prompt: task.prompt,
    choices: task.choices,
    schema: task.schema,
    redundancy: task.redundancy,
    reward: task.reward,
    status: task.status,
    answersCollected: task.answers.length,
    answers: task.answers.map((a) => ({ agent: a.agent, answer: a.answer, at: a.at })),
    result: task.result,
    requester: task.requester,
    createdAt: task.createdAt,
    expiresAt: task.expiresAt,
    completedAt: task.completedAt || null,
  };
}

// Public view for a worker browsing the board / claiming. Shows the work to do.
function workerView(task) {
  return {
    id: task.id,
    kind: task.kind,
    prompt: task.prompt,
    context: task.context,
    choices: task.choices,
    schema: task.schema,
    reward: task.reward,
    redundancy: task.redundancy,
    answersCollected: task.answers.length,
    expiresAt: task.expiresAt,
  };
}

export function attachOracleBazaar(app, { store, rt, guard, text, hmac }) {
  const requireSig = (req, res, raw) => {
    if (!hmac?.key) return true; // unsigned mode (local dev) — same posture as spawn-boss
    const sig = String(req.get("X-MMO-Signature") || "");
    if (!sig || !hmac.eq(sig, hmac.sign(raw, hmac.key))) {
      res.status(403).json({ error: "bad signature" });
      return false;
    }
    return true;
  };

  // ── Requester: post an inference HIT (HMAC-signed raw body) ──────────────
  app.post(
    "/api/oracle/tasks",
    text({ type: "*/*", limit: "60kb" }),
    guard("POST /api/oracle/tasks", (req, res) => {
      const raw = typeof req.body === "string" ? req.body : "";
      if (!requireSig(req, res, raw)) return;
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.status(400).json({ error: "invalid json" });
        return;
      }

      const kind = ORACLE_TASK_KINDS.includes(String(body.kind)) ? String(body.kind) : "inference";
      const prompt = String(body.prompt || "").slice(0, ORACLE_PROMPT_MAX);
      if (!prompt.trim()) {
        res.status(400).json({ error: "prompt required" });
        return;
      }
      const context =
        body.context != null ? String(body.context).slice(0, ORACLE_CONTEXT_MAX) : null;
      let choices = null;
      if (Array.isArray(body.choices) && body.choices.length) {
        choices = body.choices.slice(0, ORACLE_CHOICES_MAX).map((c) => String(c).slice(0, 200));
      }
      const schema = body.schema != null ? String(body.schema).slice(0, 2000) : null;
      const redundancy = clampInt(
        body.redundancy,
        1,
        ORACLE_REDUNDANCY_MAX,
        ORACLE_REDUNDANCY_DEFAULT,
      );
      const ttlMs = clampInt(body.ttlMs, 10_000, ORACLE_TTL_MS_MAX, ORACLE_TTL_MS_DEFAULT);
      const reward = sanitizeReward(body.reward);
      const requester = String(body.requester || "claude-code").slice(0, 48);

      const open = store.allOracleTasks().filter((t) => t.status === "open").length;
      if (open >= ORACLE_OPEN_MAX) {
        res.status(503).json({ error: "oracle board full — retry shortly" });
        return;
      }

      const id = `hit_${crypto.randomBytes(12).toString("hex")}`;
      const now = Date.now();
      const task = {
        id,
        kind,
        prompt,
        context,
        choices,
        schema,
        redundancy,
        reward,
        requester,
        status: "open",
        answers: [],
        byToken: [], // dedup: agents who already answered
        leases: {}, // token -> lease expiry epoch
        result: null,
        createdAt: now,
        expiresAt: now + ttlMs,
        completedAt: null,
      };
      store.putOracleTask(id, task);
      if (rt?.broadcast) {
        rt.broadcast({ t: "oracleHit", id, kind, reward, redundancy, at: now });
      }
      res.json({ ok: true, id, status: "open", expiresAt: task.expiresAt });
    }),
  );

  // ── Requester: poll a HIT (id is the capability; no extra auth) ──────────
  app.get(
    "/api/oracle/tasks/:id",
    guard("GET /api/oracle/tasks/:id", (req, res) => {
      const task = store.getOracleTask(String(req.params.id || ""));
      if (!task) {
        res.status(404).json({ error: "no such task" });
        return;
      }
      if (expireIfDue(task)) store.putOracleTask(task.id, task);
      res.json({ ok: true, task: requesterView(task) });
    }),
  );

  // ── Requester: cancel a HIT (HMAC-signed) ────────────────────────────────
  app.post(
    "/api/oracle/tasks/:id/cancel",
    text({ type: "*/*", limit: "2kb" }),
    guard("POST /api/oracle/tasks/:id/cancel", (req, res) => {
      const raw = typeof req.body === "string" ? req.body : "";
      if (!requireSig(req, res, raw)) return;
      const task = store.getOracleTask(String(req.params.id || ""));
      if (!task) {
        res.status(404).json({ error: "no such task" });
        return;
      }
      if (task.status === "open") {
        task.status = "cancelled";
        store.putOracleTask(task.id, task);
      }
      res.json({ ok: true, status: task.status });
    }),
  );

  // ── Worker: browse the open board (agent bearer) ─────────────────────────
  app.get(
    "/api/oracle/open",
    guard("GET /api/oracle/open", (req, res) => {
      const a = authAgent(store, req);
      if (!a) {
        res.status(401).json({ error: "missing or invalid agent token" });
        return;
      }
      const now = Date.now();
      const open = [];
      for (const task of store.allOracleTasks()) {
        if (expireIfDue(task)) {
          store.putOracleTask(task.id, task);
          continue;
        }
        if (task.status !== "open") continue;
        if (task.byToken.includes(a.token)) continue; // already answered by me
        if (task.answers.length >= task.redundancy) continue; // quota met, awaiting finalize
        open.push(workerView(task));
        if (open.length >= 50) break;
      }
      res.json({
        ok: true,
        onOracleTile: isOnOracleTile(a.ch),
        count: open.length,
        tasks: open,
        at: now,
      });
    }),
  );

  // ── Worker: claim a HIT (lease it; must be on the oracle tile) ────────────
  app.post(
    "/api/oracle/claim/:id",
    guard("POST /api/oracle/claim/:id", (req, res) => {
      const a = authAgent(store, req);
      if (!a) {
        res.status(401).json({ error: "missing or invalid agent token" });
        return;
      }
      if (!isOnOracleTile(a.ch)) {
        res.status(400).json({ error: "must be on the oracle tile to claim — move to it first" });
        return;
      }
      const remaining = cooldownRemaining(a.ch);
      if (remaining > 0) {
        res.status(429).json({
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        });
        return;
      }
      const task = store.getOracleTask(String(req.params.id || ""));
      if (!task || expireIfDue(task) || task.status !== "open") {
        if (task) store.putOracleTask(task.id, task);
        res.status(409).json({ error: "task not open" });
        return;
      }
      if (task.byToken.includes(a.token)) {
        res.status(409).json({ error: "you already answered this task" });
        return;
      }
      task.leases[a.token] = Date.now() + ORACLE_LEASE_MS;
      store.putOracleTask(task.id, task);
      const cooldown = applyOracleCooldown(a.ch);
      store.putAgent(a.token, a.ch);
      res.json({ ok: true, task: workerView(task), leaseMs: ORACLE_LEASE_MS, cooldown });
    }),
  );

  // ── Worker: submit an answer (must be on the oracle tile) ─────────────────
  app.post(
    "/api/oracle/submit/:id",
    guard("POST /api/oracle/submit/:id", (req, res) => {
      const a = authAgent(store, req);
      if (!a) {
        res.status(401).json({ error: "missing or invalid agent token" });
        return;
      }
      if (!isOnOracleTile(a.ch)) {
        res.status(400).json({ error: "must be on the oracle tile to submit" });
        return;
      }
      const remaining = cooldownRemaining(a.ch);
      if (remaining > 0) {
        res.status(429).json({
          error: "character in cooldown",
          cooldown: { remaining_seconds: Math.round(remaining * 10) / 10 },
        });
        return;
      }
      const task = store.getOracleTask(String(req.params.id || ""));
      if (!task || expireIfDue(task) || task.status !== "open") {
        if (task) store.putOracleTask(task.id, task);
        res.status(409).json({ error: "task not open" });
        return;
      }
      if (task.byToken.includes(a.token)) {
        res.status(409).json({ error: "you already answered this task" });
        return;
      }
      if (task.answers.length >= task.redundancy) {
        res.status(409).json({ error: "answer quota already met" });
        return;
      }
      const answer = String(req.body?.answer ?? "").slice(0, ORACLE_ANSWER_MAX);
      if (!answer.trim()) {
        res.status(400).json({ error: "answer required" });
        return;
      }
      // For multiple-choice HITs, reject answers outside the choice set so the
      // tally stays clean.
      if (Array.isArray(task.choices) && task.choices.length) {
        const ok = task.choices.some((c) => normalize(c) === normalize(answer));
        if (!ok) {
          res
            .status(400)
            .json({ error: "answer must be one of the choices", choices: task.choices });
          return;
        }
      }

      task.answers.push({ agent: a.ch.name, token: a.token, answer, at: Date.now() });
      task.byToken.push(a.token);
      delete task.leases[a.token];

      // Reward the worker — this is the incentive that makes the realm produce
      // inference. Paid on every accepted answer, not just the finalizing one.
      const rewardInfo = grantReward(a.ch, { ...task.reward, skill: "oracle" });
      a.ch.reputation += 1;
      a.ch.lifetime.answers += 1;
      const cooldown = applyOracleCooldown(a.ch);

      let finalized = false;
      if (task.answers.length >= task.redundancy) {
        finalize(task);
        finalized = true;
        if (rt?.broadcast) rt.broadcast({ t: "oracleResolved", id: task.id, at: Date.now() });
      }
      store.putOracleTask(task.id, task);
      store.putAgent(a.token, a.ch);

      res.json({
        ok: true,
        accepted: true,
        reward: task.reward,
        rewardInfo,
        finalized,
        result: finalized ? task.result : null,
        cooldown,
        character: publicAgent(a.ch),
      });
    }),
  );

  // Sweep: finalize/expire due HITs and prune the completed backlog. Wired to
  // a supervised interval in server.js. Returns counts for observability.
  function sweep() {
    let expired = 0;
    const all = store.allOracleTasks();
    for (const task of all) {
      if (expireIfDue(task)) {
        expired += 1;
        store.putOracleTask(task.id, task);
      }
      // drop dead leases
      let changed = false;
      for (const [tok, exp] of Object.entries(task.leases || {})) {
        if (Date.now() > exp) {
          delete task.leases[tok];
          changed = true;
        }
      }
      if (changed) store.putOracleTask(task.id, task);
    }
    // Prune oldest completed/expired/cancelled beyond the keep window.
    const done = all
      .filter((t) => t.status !== "open")
      .sort((x, y) => (x.completedAt || x.expiresAt) - (y.completedAt || y.expiresAt));
    const overflow = done.length - ORACLE_DONE_KEEP;
    for (let i = 0; i < overflow; i += 1) store.deleteOracleTask(done[i].id);
    return { expired, openNow: all.filter((t) => t.status === "open").length };
  }

  return { sweep };
}
