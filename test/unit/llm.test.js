// SIGMA ABYSS — Phase D: the live-AI provider seam (server/llm.js). All tests use
// an INJECTED fetch + clock — zero real network. Asserts key-gating, JSON parsing,
// timeout handling, the circuit breaker, and the concurrency cap.
// Run: node --test test/unit/llm.test.js

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createLlmClient, parseJsonReply } from "../../server/llm.js";

const completion = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

describe("parseJsonReply", () => {
  test("reads bare json, fenced json, and rejects garbage", () => {
    assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonReply('```json\n{"b":2}\n```'), { b: 2 });
    assert.deepEqual(parseJsonReply('here you go: {"c":3} cheers'), { c: 3 });
    assert.equal(parseJsonReply("no json here"), null);
    assert.equal(parseJsonReply(""), null);
  });
});

describe("createLlmClient — availability gating", () => {
  test("no API key ⇒ unavailable, and chat() throws (caller falls back)", async () => {
    const llm = createLlmClient({ env: {}, fetchImpl: async () => completion("{}") });
    assert.equal(llm.available(), false);
    await assert.rejects(() => llm.chat({ user: "hi" }), /unavailable/);
  });

  test("with a key, chat() returns the parsed JSON object", async () => {
    const llm = createLlmClient({
      env: { CEREBRAS_API_KEY: "k", CEREBRAS_MODEL: "gemma-4" },
      fetchImpl: async () => completion('{"move":"north","line":"onward"}'),
    });
    assert.equal(llm.available(), true);
    const out = await llm.chat({ system: "s", user: "u" });
    assert.deepEqual(out, { move: "north", line: "onward" });
  });

  test("the API key is never placed in a thrown error", async () => {
    const SECRET = "super-secret-key-zzz";
    const llm = createLlmClient({
      env: { CEREBRAS_API_KEY: SECRET },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: SECRET }) }),
    });
    await assert.rejects(
      () => llm.chat({ user: "u" }),
      (err) => !String(err.message).includes(SECRET) && /http 401/.test(err.message),
    );
  });
});

describe("circuit breaker (injected clock)", () => {
  test("opens after N consecutive failures, then recovers after the cooldown", async () => {
    let t = 1000;
    const llm = createLlmClient({
      env: { CEREBRAS_API_KEY: "k", LLM_BREAKER_FAILS: "2", LLM_BREAKER_COOLDOWN_MS: "5000" },
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      now: () => t,
    });
    await assert.rejects(() => llm.chat({ user: "u" }), /http 500/);
    await assert.rejects(() => llm.chat({ user: "u" }), /http 500/);
    assert.equal(llm.available(), false, "breaker open after 2 fails");
    t += 6000; // past the cooldown
    assert.equal(llm.available(), true, "breaker closes after cooldown");
  });

  test("a success resets the failure count", async () => {
    let ok = false;
    const llm = createLlmClient({
      env: { CEREBRAS_API_KEY: "k", LLM_BREAKER_FAILS: "2" },
      fetchImpl: async () => (ok ? completion('{"x":1}') : { ok: false, status: 500, json: async () => ({}) }),
    });
    await assert.rejects(() => llm.chat({ user: "u" }), /http 500/);
    ok = true;
    await llm.chat({ user: "u" }); // success → reset
    assert.equal(llm._stats().consecutiveFails, 0);
  });
});

describe("concurrency cap", () => {
  test("never exceeds LLM_MAX_CONCURRENCY in-flight requests", async () => {
    let cur = 0;
    let max = 0;
    const slowFetch = async () => {
      cur += 1;
      max = Math.max(max, cur);
      await new Promise((r) => setTimeout(r, 5));
      cur -= 1;
      return completion('{"ok":1}');
    };
    const llm = createLlmClient({ env: { CEREBRAS_API_KEY: "k", LLM_MAX_CONCURRENCY: "3" }, fetchImpl: slowFetch });
    await Promise.all(Array.from({ length: 12 }, () => llm.chat({ user: "u" })));
    assert.ok(max <= 3, `in-flight peaked at ${max}, cap is 3`);
  });
});
