// SAST: scan committed source for obvious credential patterns. Mirrors the
// workspace certification's security_secrets signal but operates on
// server/, shared/, and client/.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["'][a-zA-Z0-9_-]{16,}["']/i,
  /password\s*=\s*["'][^"']{8,}["']/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\s]{64,}\n-----END/,
];

function collectJs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".") || entry === "vendor") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectJs(full));
    else if (full.endsWith(".js") && !full.endsWith(".test.js")) out.push(full);
  }
  return out;
}

describe("sigmashake-mmo sast", () => {
  const files = [];
  for (const dir of ["server", "shared", "client", "tools"]) {
    const p = join(ROOT, dir);
    if (existsSync(p)) files.push(...collectJs(p));
  }

  test("no hardcoded credentials in JS sources", () => {
    const violations = [];
    for (const f of files) {
      const c = readFileSync(f, "utf8");
      for (const p of SECRET_PATTERNS) if (p.test(c)) violations.push(`${f}: ${p}`);
    }
    assert.deepEqual(violations, []);
  });

  test("no AWS access key strings", () => {
    const v = [];
    for (const f of files) {
      const c = readFileSync(f, "utf8");
      if (/\bAKIA[0-9A-Z]{16}\b/.test(c)) v.push(f);
    }
    assert.deepEqual(v, []);
  });
});
