// Boot-time secret loader. Reads KEY=VALUE lines from ~/.sigmashake/mmo.env (the
// same out-of-repo file the CLI/MCP already use for MMO_HMAC_KEY) and injects any
// key NOT already set in the environment. This lets Phase D run live "out of the
// box" — the operator drops CEREBRAS_API_KEY / CEREBRAS_MODEL / *_LIVE flags into
// that file once and every process picks them up — WITHOUT putting a secret in any
// tracked source file (the public mirror stays clean; gitleaks stays green).
//
// Real env vars always win, so CI / prod / `FOO=bar node ...` overrides the file.
// Importing this module has the side effect of populating process.env; import it
// FIRST in an entrypoint. Values are never logged.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadEnvFile(file = path.join(os.homedir(), ".sigmashake", "mmo.env")) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0; // no file → nothing to load (the common case)
  }
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // real env wins
    let value = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }
  return loaded;
}

// Side-effect on import: load the default secret file once at startup.
loadEnvFile();
