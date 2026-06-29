// SIGMA ABYSS — VCS account bridge welcome integration (integrate-this PR3).
//
// Boots the REAL server.js and drives a WebSocket hello, asserting the welcome
// frame carries a server-derived vcsAccount pointer for a Twitch-linked viewer,
// an anonymous one otherwise, and NO durable account state (loadout/inventory/
// profile) anywhere in the frame.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { deriveVcsAccountId } from "../../server/vcs-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const PORT = 17783;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

let child = null;

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server failed to come up");
}

// One hello -> welcome round trip.
function hello(data) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("welcome timeout"));
    }, 6000);
    // hello fields are read from the top level of the frame (see vHello).
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", ...data })));
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.t === "welcome") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

before(async () => {
  child = spawn(process.execPath, ["server/server.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForHealth();
});

after(async () => {
  if (!child) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 3000);
  });
});

describe("welcome vcsAccount (PR3)", () => {
  test("a Twitch-claimed hello derives a verified vcsAccount pointer", async () => {
    const welcome = await hello({ twitch: "pagewarden" });
    assert.ok(welcome.vcsAccount, "welcome must carry vcsAccount");
    assert.equal(welcome.vcsAccount.verified, true);
    assert.equal(welcome.vcsAccount.identitySource, "twitch");
    assert.equal(welcome.vcsAccount.twitchLogin, "pagewarden");
    assert.equal(welcome.vcsAccount.vcsAccountId, deriveVcsAccountId("pagewarden"));
  });

  test("vcsAccount carries pointers only — no durable account state leaks", () => {
    // The pointer shape is fixed; assert no backend-owned fields rode along.
    const keys = ["vcsAccountId", "twitchLogin", "snapshotVersion", "identitySource", "verified"];
    return hello({ twitch: "pagewarden" }).then((welcome) => {
      assert.deepEqual(Object.keys(welcome.vcsAccount).sort(), [...keys].sort());
      for (const banned of ["loadout", "inventory", "profile", "raw"]) {
        assert.equal(banned in welcome.vcsAccount, false, `vcsAccount must not contain ${banned}`);
      }
    });
  });

  test("an anonymous hello yields a null, unverified vcsAccount", async () => {
    const welcome = await hello({});
    assert.equal(welcome.vcsAccount.verified, false);
    assert.equal(welcome.vcsAccount.vcsAccountId, null);
    assert.equal(welcome.vcsAccount.identitySource, "anonymous");
  });
});
