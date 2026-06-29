import { createHmac } from "node:crypto";

// VCS account bridge (integrate-this PR3), ported into the SIGMA ABYSS runtime
// from the standalone slice's server/vcs-client.js. Leaf module: imports only
// node:crypto, never store.js/validate.js (callers pass `store`), so it stays
// unit-testable with a fake store + recorded fixtures.
//
// Key facts this encodes (see docs/design/vcs-bridge-integration.md in the slice):
//   - Durable identity is the TWITCH LOGIN, not a client-asserted account id.
//     vcsAccountId is DERIVED server-side from the login, so a client can never
//     be tricked into adopting an arbitrary account id.
//   - Response bodies are OWNED BY THE PRIVATE VCS/chat-elixir backend. We treat
//     them as opaque safe snapshots — never re-model loadout/inventory fields,
//     only carry the raw blob plus a version.
//   - The live VcsClient (whoami/me/combat-sigma/catalog) is ported for fixture
//     coverage; it is NOT wired into the live welcome path because the real VCS
//     backend is private and unreachable from here.

const DEFAULT_VCS_BASE_URL = "https://vcs.sigmashake.com";
const VCS_ACCOUNT_PREFIX = "vcs_acct_";
const HMAC_REPLAY_WINDOW_SECONDS = 30;
const MAX_VCS_BODY_BYTES = 128 * 1024;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

// Twitch logins are case-insensitive; normalize so identity is stable.
export function normalizeTwitchLogin(login) {
  return String(login || "")
    .trim()
    .toLowerCase();
}

// Deterministic, collision-resistant account id derived from the Twitch login.
// Stable across restarts; never accepted from the client.
export function deriveVcsAccountId(login, env = process.env) {
  const normalized = normalizeTwitchLogin(login);
  if (!normalized) {
    throw new Error("deriveVcsAccountId requires a non-empty twitch login");
  }
  const salt = env.SIGMACRAFT_VCS_ACCOUNT_SALT || "sigmacraft-vcs-account-v1";
  const digest = createHmac("sha256", salt).update(normalized).digest("hex");
  return `${VCS_ACCOUNT_PREFIX}${digest.slice(0, 24)}`;
}

export function resolveVcsClientConfig(env = process.env, overrides = {}) {
  return {
    baseUrl: trimTrailingSlash(
      overrides.baseUrl || env.SIGMACRAFT_VCS_BASE_URL || DEFAULT_VCS_BASE_URL,
    ),
    hmacKey: overrides.hmacKey || env.SIGMACRAFT_VCS_HMAC_KEY || env.VCS_HMAC_KEY || "",
    // Viewer session cookie (set by accounts.sigmashake.com Twitch OAuth). The
    // runtime does not mint this; it is provided when bridging a linked viewer.
    sessionCookie: overrides.sessionCookie || "",
    requestTimeoutMs: Number(overrides.requestTimeoutMs || env.SIGMACRAFT_VCS_TIMEOUT_MS || 8000),
  };
}

// X-Vcs-Signature: HMAC-SHA-256 over "timestamp:<unix>", matching the streamer
// bridge handshake in sigmashake-vcs src/routes/bridge.ts.
export function buildBridgeAuthHeaders(hmacKey, nowMs) {
  if (!hmacKey) return {};
  const ts = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", hmacKey).update(`timestamp:${ts}`).digest("hex");
  return {
    "X-Vcs-Timestamp": String(ts),
    "X-Vcs-Signature": signature,
  };
}

export function isFreshBridgeTimestamp(tsSeconds, nowMs) {
  return Math.abs(nowMs / 1000 - Number(tsSeconds)) <= HMAC_REPLAY_WINDOW_SECONDS;
}

// Wrap any bridged response as an opaque safe snapshot. We deliberately do NOT
// interpret loadout/inventory fields — only carry them verbatim plus a version.
export function toOpaqueSnapshot(body, snapshotVersion) {
  return {
    schema: "vcs.snapshot.opaque.v1",
    ok: body?.ok !== false,
    snapshotVersion: Number.isInteger(snapshotVersion) ? snapshotVersion : 0,
    raw: body && typeof body === "object" ? body : {},
  };
}

// The MMO store keeps only the FORWARD twitch login -> token map; resolve the
// reverse by scanning. Callers that already know the login (realtime hello has
// the verified parsed.data.twitch) pass it as knownLogin to skip the scan.
function reverseLookupLogin(store, token) {
  if (!token || typeof store?.allTwitchLinks !== "function") return null;
  // token -> login is one-to-many (the map is keyed by login). Resolve a
  // verified identity ONLY when it is unambiguous: if two distinct logins are
  // bound to the same token, return null (treat as anonymous) rather than mint a
  // nondeterministic, insertion-order-dependent identity.
  let found = null;
  for (const [login, t] of Object.entries(store.allTwitchLinks())) {
    if (t !== token) continue;
    if (found && found !== login) return null; // ambiguous -> no verified identity
    found = login;
  }
  return found;
}

// Resolve a token's VCS account POINTER. Identity is the Twitch login; the
// account id is derived server-side (never asserted by the client). Anonymous
// tokens (no twitch link) return a null, unverified pointer.
export function vcsAccountForToken(store, token, knownLogin = null) {
  const login = normalizeTwitchLogin(knownLogin || reverseLookupLogin(store, token));
  if (!login) {
    return {
      vcsAccountId: null,
      twitchLogin: null,
      snapshotVersion: 0,
      identitySource: "anonymous",
      verified: false,
    };
  }
  const stored = typeof store?.getVcsAccount === "function" ? store.getVcsAccount(token) : null;
  return {
    vcsAccountId: deriveVcsAccountId(login),
    twitchLogin: login,
    snapshotVersion: Number.isInteger(stored?.snapshotVersion) ? stored.snapshotVersion : 0,
    identitySource: "twitch",
    verified: true,
  };
}

export class VcsClient {
  constructor(options = {}) {
    const { env = process.env, fetchImpl, now, ...overrides } = options;
    this.config = resolveVcsClientConfig(env, overrides);
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.now = now || (() => Date.now());
    if (typeof this.fetchImpl !== "function") {
      throw new Error("VcsClient requires a fetch implementation");
    }
  }

  async request(method, path, { viewer = false } = {}) {
    const headers = { Accept: "application/json" };
    if (viewer && this.config.sessionCookie) {
      headers.Cookie = this.config.sessionCookie;
    }
    Object.assign(headers, buildBridgeAuthHeaders(this.config.hmacKey, this.now()));

    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, { method, headers });
    const text = await res.text();
    if (text.length > MAX_VCS_BODY_BYTES) {
      throw new Error(`vcs response exceeds ${MAX_VCS_BODY_BYTES} bytes`);
    }
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("vcs response was not valid JSON");
    }
    return { status: res.status, body };
  }

  // Auth-only probe. Call FIRST to separate "not signed in" (401) from
  // "streamer offline" (bridge_offline only affects /me + mutations).
  async whoami() {
    const { status, body } = await this.request("GET", "/api/v1/vcs/whoami", { viewer: true });
    if (status === 401 || body?.ok === false) {
      return { ok: false, error: body?.error || "unauthenticated", status };
    }
    const login = normalizeTwitchLogin(body.login || body.twitch_login);
    return {
      ok: true,
      status,
      login,
      display: body.display || body.twitch_display || "",
      vcsAccountId: login ? deriveVcsAccountId(login) : null,
    };
  }

  // Viewer loadout/profile snapshot. Treated as opaque.
  async me(snapshotVersion = 0) {
    const { status, body } = await this.request("GET", "/api/v1/vcs/me", { viewer: true });
    if (status >= 400 || body?.ok === false) {
      return { ok: false, error: body?.error || `vcs_me_failed_${status}`, status };
    }
    return { ok: true, status, snapshot: toOpaqueSnapshot(body, snapshotVersion + 1) };
  }

  // Project Ascendant full sigma summary; proxies to MMO /api/sigma/:login.
  async combatSigma(snapshotVersion = 0) {
    const { status, body } = await this.request("GET", "/api/v1/vcs/combat-sigma", { viewer: true });
    if (status >= 400 || body?.ok === false) {
      return { ok: false, error: body?.error || `vcs_combat_sigma_failed_${status}`, status };
    }
    return { ok: true, status, snapshot: toOpaqueSnapshot(body, snapshotVersion + 1) };
  }

  // Public catalog; no auth.
  async catalog() {
    const { status, body } = await this.request("GET", "/api/v1/vcs/catalog");
    if (status >= 400) return { ok: false, error: `vcs_catalog_failed_${status}`, status };
    return { ok: true, status, snapshot: toOpaqueSnapshot(body, 1) };
  }
}
