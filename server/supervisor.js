// SIGMA ABYSS — OTP-style supervision for a plain Node process.
//
// The brief asked for "the elixir OTP beam — fault tolerance, self-
// healing". We're on the mandated Node stack, so this brings the OTP
// *properties* across:
//
//   installGlobalGuards()  uncaughtException / unhandledRejection are
//                          logged and SWALLOWED — one bad async path
//                          never takes the server down.
//   guard(where, fn)       wrap a handler so a throw is contained to
//                          that one call (per-connection isolation).
//   superviseInterval()    a self-healing periodic loop — a throwing
//                          tick is logged and the loop keeps ticking.
//   onShutdown()/installShutdown()  graceful SIGTERM/SIGINT drain.
//
// Restart intensity mirrors OTP's max_restarts/max_seconds: too many
// faults in the window and we log LOUDLY (the process is genuinely
// degraded) — but still keep serving. On a live stream a server that
// half-works beats one that hard-crashes.

const CRASH_WINDOW_MS = 60_000;
const CRASH_MAX = 25;

let crashes = [];
const shutdownHooks = [];
let shuttingDown = false;

function recordFault(where, err) {
  const now = Date.now();
  crashes = crashes.filter((t) => now - t < CRASH_WINDOW_MS);
  crashes.push(now);
  const msg = err?.stack ? err.stack : String(err);
  if (crashes.length >= CRASH_MAX) {
    console.error(
      `[supervisor] !! ${crashes.length} faults in <60s at [${where}] — degraded but still serving:\n${msg}`,
    );
  } else {
    console.error(`[supervisor] contained fault at [${where}]: ${msg}`);
  }
}

export function installGlobalGuards() {
  process.on("uncaughtException", (err) => recordFault("uncaughtException", err));
  process.on("unhandledRejection", (reason) => recordFault("unhandledRejection", reason));
}

// Wrap a (sync) handler so an exception is contained, logged, and the
// caller simply gets `undefined` back instead of an unwound stack.
export function guard(where, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      recordFault(where, err);
      return undefined;
    }
  };
}

// A self-healing setInterval. Each tick is guarded; a throw is logged
// and the loop keeps running. Returns a stop() function.
export function superviseInterval(where, fn, ms) {
  const id = setInterval(() => {
    try {
      fn();
    } catch (err) {
      recordFault(where, err);
    }
  }, ms);
  if (id.unref) id.unref();
  return () => clearInterval(id);
}

export function onShutdown(fn) {
  shutdownHooks.push(fn);
}

export function installShutdown() {
  const drain = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[supervisor] ${sig} — draining…`);
    for (const fn of shutdownHooks) {
      try {
        await fn();
      } catch (e) {
        console.error(`[supervisor] shutdown hook failed: ${e.message}`);
      }
    }
    console.log("[supervisor] clean exit");
    process.exit(0);
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}

export function health() {
  const now = Date.now();
  const recentFaults = crashes.filter((t) => now - t < CRASH_WINDOW_MS).length;
  return { recentFaults, degraded: recentFaults >= CRASH_MAX };
}
