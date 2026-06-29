// Sigmacraft live-AI provider seam (integrate-this Phase D). ONE OpenAI-compatible
// client for ALL live Gemma calls — the off-tick NPC planner, the Director, and
// (later) the boss-drop generator share it, so "which provider/model" is a single
// env contract, not a fork per consumer.
//
// Provider: Cerebras API (Gemma 4). Cerebras Cloud is OpenAI-compatible:
//   POST {base}/chat/completions  with  Authorization: Bearer ${CEREBRAS_API_KEY}
//
// HARD RULES:
//   - The API key is env-only. It is NEVER committed and NEVER logged (errors are
//     scrubbed). available() is false without it ⇒ callers use deterministic fallback.
//   - This is NEVER called on the 3s tick. Only off-tick loops call chat(), and only
//     when their live flag is set. Default everywhere is the deterministic fallback.
//   - A concurrency cap bounds the 200-agent fan-out; a circuit breaker trips to
//     fallback after repeated failures so a provider outage can't stall the realm.
//
// Env:
//   CEREBRAS_API_KEY   required for live calls (absent ⇒ available() false)
//   CEREBRAS_BASE_URL  default https://api.cerebras.ai/v1
//   CEREBRAS_MODEL     exact Cerebras Gemma-4 model id (default placeholder "gemma-4")
//   LLM_MAX_CONCURRENCY  default 4
//   LLM_TIMEOUT_MS       default 8000
//   LLM_BREAKER_FAILS    consecutive failures that open the breaker (default 4)
//   LLM_BREAKER_COOLDOWN_MS  how long the breaker stays open (default 30000)

const DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
const DEFAULT_MODEL = "gemma-4"; // operator overrides with the exact Cerebras id

// Tiny FIFO semaphore — caps in-flight requests without a dependency.
function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    get inFlight() {
      return active;
    },
  };
}

// Pull the assistant text out of an OpenAI-compatible chat completion.
function extractContent(json) {
  const msg = json?.choices?.[0]?.message;
  if (typeof msg?.content === "string") return msg.content;
  // Some providers return content as an array of parts.
  if (Array.isArray(msg?.content)) {
    return msg.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  }
  return "";
}

// Best-effort JSON extraction from a model reply (handles bare JSON or a fenced
// ```json block). Returns null on failure — callers hard-fallback, never throw to
// the tick.
export function parseJsonReply(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createLlmClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const apiKey = env.CEREBRAS_API_KEY || "";
  const baseUrl = (env.CEREBRAS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = env.CEREBRAS_MODEL || DEFAULT_MODEL;
  const maxConcurrency = Math.max(1, Number(env.LLM_MAX_CONCURRENCY) || 4);
  const timeoutMs = Math.max(1000, Number(env.LLM_TIMEOUT_MS) || 8000);
  const breakerFails = Math.max(1, Number(env.LLM_BREAKER_FAILS) || 4);
  const breakerCooldownMs = Math.max(1000, Number(env.LLM_BREAKER_COOLDOWN_MS) || 30000);

  const sem = createSemaphore(maxConcurrency);
  let consecutiveFails = 0;
  let openUntil = 0; // breaker: while now() < openUntil, available() is false

  const breakerOpen = () => now() < openUntil;
  function recordFailure() {
    consecutiveFails += 1;
    if (consecutiveFails >= breakerFails) openUntil = now() + breakerCooldownMs;
  }
  function recordSuccess() {
    consecutiveFails = 0;
    openUntil = 0;
  }

  // Live calls are possible only with a key AND a closed breaker.
  function available() {
    return Boolean(apiKey) && !breakerOpen();
  }

  // One structured chat turn. Returns the parsed JSON object (json:true, default) or
  // raw text. Throws on transport/timeout/HTTP error — callers MUST catch and fall
  // back. The key is never put in the error.
  async function chat({ system, user, json = true, maxTokens = 512, temperature = 0.7 } = {}) {
    if (!available()) throw new Error("llm unavailable (no key or breaker open)");
    return sem.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const messages = [];
        if (system) messages.push({ role: "system", content: String(system) });
        messages.push({ role: "user", content: String(user || "") });
        const body = {
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        };
        let res;
        try {
          res = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          recordFailure();
          throw new Error(`llm request failed: ${err?.name === "AbortError" ? "timeout" : "network"}`);
        }
        if (!res.ok) {
          recordFailure();
          throw new Error(`llm http ${res.status}`); // status only — no body/key leak
        }
        const data = await res.json().catch(() => null);
        const content = extractContent(data);
        recordSuccess();
        if (!json) return content;
        const parsed = parseJsonReply(content);
        if (!parsed) throw new Error("llm returned unparseable json");
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    });
  }

  return {
    available,
    chat,
    get model() {
      return model;
    },
    // test/diagnostic surface — never includes the key
    _stats() {
      return { consecutiveFails, breakerOpen: breakerOpen(), inFlight: sem.inFlight, hasKey: Boolean(apiKey) };
    },
  };
}
