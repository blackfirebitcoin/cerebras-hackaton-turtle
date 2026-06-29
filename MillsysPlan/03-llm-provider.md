# Phase 3: LLM Provider Seam

## Goal
Single OpenAI-compatible provider abstraction in `server/llm.js` used by both boss drop enricher and NPC planner.

## Files to Create

### New: `server/circuit-breaker.js`
```js
// Simple circuit breaker for LLM calls

export function createCircuitBreaker({ failureThreshold = 5, resetMs = 60000 } = {}) {
  let failures = 0;
  let lastFailure = 0;
  let open = false;

  return {
    isOpen: () => {
      if (open && Date.now() - lastFailure > resetMs) {
        open = false;
        failures = 0;
      }
      return open;
    },
    recordSuccess: () => { failures = 0; open = false; },
    recordFailure: () => {
      failures++;
      lastFailure = Date.now();
      if (failures >= failureThreshold) open = true;
    }
  };
}
```

### New: `server/llm.js`
```js
// SIGMA ABYSS — single LLM provider seam
// Env-driven: local vLLM or Cerebras or any OpenAI-compatible endpoint

import { createCircuitBreaker } from "./circuit-breaker.js";

const breaker = createCircuitBreaker({ failureThreshold: 5, resetMs: 60000 });

// Semaphore for concurrency control
function createSemaphore(max) {
  let current = 0;
  const queue = [];
  
  return {
    withLock: async (fn) => {
      if (current < max) {
        current++;
        try { return await fn(); }
        finally {
          current--;
          if (queue.length) queue.shift()();
        }
      } else {
        return new Promise((resolve, reject) => {
          queue.push(() => {
            current++;
            fn().then(resolve, reject).finally(() => {
              current--;
              if (queue.length) queue.shift()();
            });
          });
        });
      }
    }
  };
}

const semaphore = createSemaphore(Number(process.env.LLM_MAX_CONCURRENCY) || 2);

const BASE_URL = process.env.LLM_BASE_URL || "http://localhost:18000/v1";
const MODEL = process.env.LLM_MODEL || "gemma-2-27b-it";
const API_KEY = process.env.LLM_API_KEY;
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS) || 15000;

export async function chat(messages, options = {}) {
  if (breaker.isOpen()) throw new Error("LLM circuit open");
  
  return semaphore.withLock(async () => {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: options.temp ?? 0.7,
        max_tokens: options.maxTokens ?? 1024,
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(TIMEOUT)
    });
    
    if (!res.ok) {
      const err = await res.text();
      breaker.recordFailure();
      throw new Error(`LLM ${res.status}: ${err}`);
    }
    
    const data = await res.json();
    breaker.recordSuccess();
    return JSON.parse(data.choices[0].message.content);
  });
}

// Health check
export async function checkHealth() {
  try {
    await chat([{ role: "user", content: "ping" }], { maxTokens: 5, temp: 0 });
    return { ok: true, model: MODEL, baseUrl: BASE_URL };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:18000/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `gemma-2-27b-it` | Model name (gemma4 32b mapped here) |
| `LLM_API_KEY` | *(empty)* | Optional auth |
| `LLM_MAX_CONCURRENCY` | `2` | Parallel requests cap |
| `LLM_TIMEOUT_MS` | `15000` | Request timeout |

## Usage

```js
import { chat } from "./llm.js";

const result = await chat([
  { role: "system", content: "You are a PoE item generator." },
  { role: "user", content: "Generate a boss drop..." }
], { temp: 0.8, maxTokens: 1500 });
```

## Circuit Breaker Behavior
- Opens after 5 consecutive failures
- Auto-resets after 60 seconds
- Fast-fails all calls while open (returns deterministic fallback)