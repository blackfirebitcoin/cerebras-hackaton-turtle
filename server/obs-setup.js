// SIGMA ABYSS — OBS scene setup.
//
// Adds the game to OBS as an ISOLATED scene + browser source. It never
// touches your live scene: it creates a fresh scene called "SIGMA ABYSS"
// and drops a 1920x1080 browser source into it. Switch to that scene
// when you want to feature the game; your current layout is untouched.
// Re-running it is safe — it just updates the source URL in place.
//
//   OBS_WS_URL       default ws://127.0.0.1:4455
//   OBS_WS_PASSWORD  your OBS WebSocket password
//                    (OBS ▸ Tools ▸ WebSocket Server Settings)
//   GAME_URL         what the browser source points at. Defaults to the
//                    public tunnel URL in data/public-url.txt if present,
//                    otherwise http://127.0.0.1:7777
//
// Usage:  OBS_WS_PASSWORD=xxxx node server/obs-setup.js
//
// Zero deps — WebSocket + crypto are Node 22 built-ins.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultGameUrl() {
  if (process.env.GAME_URL) return process.env.GAME_URL;
  try {
    const f = path.join(__dirname, "..", "data", "public-url.txt");
    const u = fs.readFileSync(f, "utf8").trim();
    if (u) return u;
  } catch {
    /* no tunnel file — fall through */
  }
  return "http://127.0.0.1:7777";
}

const OBS_WS_URL = process.env.OBS_WS_URL || "ws://127.0.0.1:4455";
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || "";
const GAME_URL = defaultGameUrl();
const SCENE = "SIGMA ABYSS";
const SOURCE = "Sigma Abyss Game";

const sha256b64 = (s) => createHash("sha256").update(s).digest("base64");

function main() {
  let ws;
  try {
    ws = new WebSocket(OBS_WS_URL);
  } catch {
    bail(`could not open ${OBS_WS_URL}`);
    return;
  }
  let reqId = 0;
  const pending = new Map();

  const request = (requestType, requestData = {}) => {
    reqId += 1;
    const requestId = `r${reqId}`;
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          reject(new Error(`${requestType} timed out`));
        }
      }, 5000);
    });
  };

  ws.onerror = () => bail(`could not reach OBS at ${OBS_WS_URL}`);

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.op === 0) {
      // Hello → Identify
      const d = { rpcVersion: 1 };
      const auth = msg.d.authentication;
      if (auth) {
        if (!OBS_WS_PASSWORD) {
          bail("OBS requires a WebSocket password but OBS_WS_PASSWORD is not set");
          return;
        }
        d.authentication = sha256b64(sha256b64(OBS_WS_PASSWORD + auth.salt) + auth.challenge);
      }
      ws.send(JSON.stringify({ op: 1, d }));
    } else if (msg.op === 2) {
      // Identified → do the (purely additive) work
      try {
        await setup(request);
        ws.close();
        process.exit(0);
      } catch (e) {
        console.error(`\n  setup failed: ${e.message}\n`);
        process.exit(1);
      }
    } else if (msg.op === 7) {
      const p = pending.get(msg.d.requestId);
      if (!p) return;
      pending.delete(msg.d.requestId);
      if (msg.d.requestStatus?.result) p.resolve(msg.d.responseData || {});
      else p.reject(new Error(msg.d.requestStatus?.comment || "request rejected"));
    }
  };
}

async function setup(request) {
  console.log("");
  console.log("  SIGMA ABYSS  ->  OBS");
  console.log(`  browser source url: ${GAME_URL}`);

  // 1. Isolated scene — additive, never touches the live scene.
  const scenes = await request("GetSceneList");
  if (!(scenes.scenes || []).some((s) => s.sceneName === SCENE)) {
    await request("CreateScene", { sceneName: SCENE });
    console.log(`  + created isolated scene "${SCENE}"`);
  } else {
    console.log(`  . scene "${SCENE}" already exists`);
  }

  // 2. Browser source — create, or update the URL in place.
  const inputs = await request("GetInputList");
  if ((inputs.inputs || []).some((i) => i.inputName === SOURCE)) {
    await request("SetInputSettings", {
      inputName: SOURCE,
      inputSettings: { url: GAME_URL, width: 1920, height: 1080 },
      overlay: true,
    });
    console.log(`  . updated browser source "${SOURCE}" -> ${GAME_URL}`);
  } else {
    await request("CreateInput", {
      sceneName: SCENE,
      inputName: SOURCE,
      inputKind: "browser_source",
      inputSettings: { url: GAME_URL, width: 1920, height: 1080, reroute_audio: false },
    });
    console.log(`  + added browser source "${SOURCE}" to "${SCENE}"`);
  }

  console.log("");
  console.log("  done — your live scene is untouched.");
  console.log(`  switch to the "${SCENE}" scene in OBS when you want to feature the game.`);
  console.log("");
}

function bail(reason) {
  console.error(`\n  ${reason}`);
  console.error("  -> open OBS, then Tools > WebSocket Server Settings > Enable WebSocket server");
  console.error("  -> re-run:  OBS_WS_PASSWORD=<your password> node server/obs-setup.js\n");
  process.exit(1);
}

main();
