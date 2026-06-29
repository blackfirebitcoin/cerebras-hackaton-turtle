// SIGMA ABYSS — first-party HTTP router.
//
// Replaces Express with the minimum surface server.js actually used:
// method + path routing with `:param` capture, global / per-route / mounted
// middleware, JSON and raw-text body parsing, static file serving, and the
// `req`/`res` helpers (`req.params`/`req.get`/`req.body`,
// `res.status`/`res.json`/`res.set`/`res.sendFile`).
//
// It is deliberately Express-SHAPED — the default export is callable to
// build an `app` and carries `.json`/`.text`/`.static` — so swapping it in
// is a one-line import change with identical call sites and no diff to the
// ~40 route registrations.
//
// Fault tolerance is the same OTP-in-Node ethos as supervisor.js: every
// request is guaranteed exactly one response. A handler that throws, a
// malformed body, a missing file, an oversize payload — each degrades to a
// clean status code instead of a hung socket or a downed process.

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

// Hard ceiling on a buffered request body — process protection against an
// OOM upload. The per-parser `limit` options (json 32kb, text 16/8kb) are
// stricter still and are rejected first for the routes that set them.
const MAX_BODY = 64 * 1024;
const VCS_EMBED_ORIGINS = new Set([
  "https://vcs.sigmashake.com",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
]);

const MIME = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
};

function mimeFor(file) {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] || "application/octet-stream";
}

// "32kb" → 32768, "2mb" → 2097152, 4096 → 4096. Anything unparseable falls
// back, so a typo in an option can never silently disable the limit.
function parseLimit(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
    if (match) {
      const units = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
      return Math.round(Number(match[1]) * units[(match[2] || "b").toLowerCase()]);
    }
  }
  return fallback;
}

// Write a JSON status response — but only once. A second write (a handler
// that already answered, a vanished file mid-send) is swallowed rather
// than throwing a "write after end".
function sendStatus(res, code, message) {
  if (res.writableEnded) return;
  res.statusCode = code;
  if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

// Match a request's path segments against a route's. Returns the captured
// `:param` map, or null when the route does not match.
function matchRoute(routeParts, reqParts) {
  if (routeParts.length !== reqParts.length) return null;
  const params = {};
  for (let i = 0; i < routeParts.length; i += 1) {
    const part = routeParts[i];
    if (part.startsWith(":")) params[part.slice(1)] = decodeSeg(reqParts[i]);
    else if (part !== reqParts[i]) return null;
  }
  return params;
}

// Buffer the whole request body, bailing the moment it crosses MAX_BODY so
// a hostile upload can neither exhaust memory nor stall the loop.
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      if (err) rejectBody(err);
      else resolveBody(buf);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        finish(Object.assign(new Error("payload too large"), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (err) => finish(err));
  });
}

function prepareRequest(req, body) {
  const pathname = (req.url || "/").split("?")[0] || "/";
  req.path = pathname;
  req.parts = splitPath(pathname);
  req.params = {};
  req.rawBody = body;
  req.body = {};
  req.get = function get(name) {
    return this.headers[String(name).toLowerCase()];
  };
}

function setLocalNetworkAccessHeaders(req, res) {
  if (res.headersSent) return;
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-MMO-Signature, X-MMO-Timestamp",
  );

  const origin = String(req.headers.origin || "");
  if (VCS_EMBED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

function isLocalNetworkAccessPreflight(req) {
  return (
    req.method === "OPTIONS" &&
    String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true"
  );
}

function prepareResponse(req, res) {
  setLocalNetworkAccessHeaders(req, res);
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.set = function set(name, value) {
    if (!this.headersSent) this.setHeader(name, value);
    return this;
  };
  res.json = function json(payload) {
    if (this.writableEnded) return this;
    if (!this.headersSent) this.setHeader("Content-Type", "application/json; charset=utf-8");
    this.end(JSON.stringify(payload));
    return this;
  };
  res.sendFile = function sendFile(absPath) {
    if (this.writableEnded) return this;
    try {
      const buf = readFileSync(absPath);
      if (!this.headersSent) this.setHeader("Content-Type", mimeFor(absPath));
      this.end(buf);
    } catch {
      sendStatus(this, 404, "not found");
    }
    return this;
  };
}

// ── Middleware factories (Express-compatible signatures) ─────────────────

// Parse an `application/json` body into `req.body`. Malformed JSON degrades
// to an empty object: every handler validates its own inputs, so a bad
// payload becomes a clean 4xx rather than an unhandled SyntaxError.
export function json(options = {}) {
  const limit = parseLimit(options.limit, 100 * 1024);
  return async function jsonBody(req, res) {
    if (req.method === "GET" || req.method === "HEAD") return;
    const type = String(req.headers["content-type"] || "");
    if (!type.includes("application/json") || req.rawBody.length === 0) return;
    if (req.rawBody.length > limit) {
      sendStatus(res, 413, "payload too large");
      return;
    }
    try {
      req.body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      req.body = {};
    }
  };
}

// Expose the raw body as a string on `req.body`. server.js only ever asks
// for `type: "*/*"` (every content-type is text), which is the sole
// behaviour implemented — the `type` option is otherwise ignored.
export function text(options = {}) {
  const limit = parseLimit(options.limit, 100 * 1024);
  return async function textBody(req, res) {
    if (req.method === "GET" || req.method === "HEAD") return;
    if (req.rawBody.length > limit) {
      sendStatus(res, 413, "payload too large");
      return;
    }
    req.body = req.rawBody.toString("utf8");
  };
}

// Serve files from `root`. Path traversal is rejected two ways — explicit
// `..`/`.` segments and a resolved-path-escapes-root check — because this
// server is the trust boundary (see CLAUDE.md). A miss simply returns so
// the next layer (a second static mount, or the 404) runs.
export function staticDir(root) {
  const base = resolve(root);
  return async function serveStatic(req, res) {
    if (req.method !== "GET") return;
    const segments = splitPath(req.path).map(decodeSeg);
    if (segments.some((s) => s === ".." || s === "." || s.includes("\0"))) return;
    let target = resolve(segments.length ? join(base, ...segments) : base);
    if (target !== base && !target.startsWith(base + sep)) return;
    let info;
    try {
      info = await stat(target);
    } catch {
      return;
    }
    if (info.isDirectory()) {
      target = join(target, "index.html");
      try {
        info = await stat(target);
      } catch {
        return;
      }
    }
    if (!info.isFile()) return;
    try {
      const buf = await readFile(target);
      if (!res.headersSent) res.setHeader("Content-Type", mimeFor(target));
      res.end(buf);
    } catch {
      // File vanished between stat and read — fall through to the 404.
    }
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────

// Run one layer's handler stack in order. Each entry either ends the
// response, calls next(), or resolves a promise (json/text/static signal
// "continue" that way). A synchronous handler that does none of those had
// its throw swallowed upstream by guard() — we stop, and dispatch turns
// the silent route into a 500 rather than a hung request.
async function runStack(stack, req, res) {
  for (const fn of stack) {
    if (res.writableEnded) return;
    let nextCalled = false;
    let failure;
    const next = (err) => {
      nextCalled = true;
      if (err) failure = err;
    };
    let result;
    let threw = false;
    try {
      result = fn(req, res, next);
    } catch (err) {
      failure = err;
      threw = true;
    }
    const isPromise = !threw && result != null && typeof result.then === "function";
    if (isPromise) {
      try {
        await result;
      } catch (err) {
        failure = err;
      }
    }
    if (failure) throw failure;
    if (res.writableEnded) return;
    if (isPromise || nextCalled) continue;
    return;
  }
}

function mountMatches(pathname, mount) {
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

async function dispatch(req, res, layers) {
  prepareResponse(req, res);
  if (isLocalNetworkAccessPreflight(req)) {
    res.statusCode = 204;
    res.end();
    return;
  }
  const method = req.method || "GET";
  let body = Buffer.alloc(0);
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await readBody(req);
    } catch (err) {
      if (err?.tooLarge) sendStatus(res, 413, "payload too large");
      else sendStatus(res, 400, "bad request");
      return;
    }
  }
  prepareRequest(req, body);

  for (const layer of layers) {
    if (res.writableEnded) return;
    if (layer.type === "route") {
      if (layer.method !== method) continue;
      const params = matchRoute(layer.parts, req.parts);
      if (params === null) continue;
      req.params = params;
      await runStack(layer.stack, req, res);
      // A matched route is terminal. If its handler answered nothing, the
      // throw was contained by guard() — report it instead of 404-ing.
      if (!res.writableEnded) sendStatus(res, 500, "no response from handler");
      return;
    }
    if (layer.mount) {
      if (!mountMatches(req.path, layer.mount)) continue;
      // Hand the middleware a view of `req` with the mount prefix stripped
      // (so `express.static` mounted at /shared resolves shared/<rest>),
      // without mutating the shared request object.
      const scoped = Object.create(req, {
        path: {
          value: req.path.slice(layer.mount.length) || "/",
          enumerable: true,
          writable: true,
          configurable: true,
        },
      });
      await runStack([layer.fn], scoped, res);
    } else {
      await runStack([layer.fn], req, res);
    }
  }
  if (!res.writableEnded) sendStatus(res, 404, "not found");
}

// ── App factory ──────────────────────────────────────────────────────────

function createApp() {
  const layers = [];

  const app = (req, res) => {
    dispatch(req, res, layers).catch((err) => {
      if (!res.writableEnded) sendStatus(res, 500, "internal error");
      console.error(`[router] dispatch fault: ${err?.stack ? err.stack : err}`);
    });
  };

  // x-powered-by is never set, so disabling it is a no-op kept for parity.
  app.disable = () => app;

  app.use = (a, b) => {
    if (typeof a === "function") {
      layers.push({ type: "use", mount: null, fn: a });
    } else if (typeof a === "string" && typeof b === "function") {
      const mount = a.length > 1 && a.endsWith("/") ? a.slice(0, -1) : a;
      layers.push({ type: "use", mount, fn: b });
    }
    return app;
  };

  const addRoute = (method, routePath, handlers) => {
    layers.push({ type: "route", method, parts: splitPath(routePath), stack: handlers });
  };
  app.get = (routePath, ...handlers) => {
    addRoute("GET", routePath, handlers);
    return app;
  };
  app.post = (routePath, ...handlers) => {
    addRoute("POST", routePath, handlers);
    return app;
  };

  return app;
}

function express() {
  return createApp();
}
express.json = json;
express.text = text;
express.static = staticDir;

export default express;
