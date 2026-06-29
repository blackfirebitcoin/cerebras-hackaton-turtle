// Dependency audit: validate package.json pinning and lockfile presence.
// Mirrors the workspace certification's security_audit signal.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const require = createRequire(import.meta.url);
const pkg = require(join(ROOT, "package.json"));

describe("sigmashake-mmo dependencies", () => {
  test("no package-lock.json (npm banned monorepo-wide)", () => {
    assert.equal(existsSync(join(ROOT, "package-lock.json")), false);
  });

  test('no "latest" floating pins in runtime deps', () => {
    const floating = Object.entries(pkg.dependencies ?? {}).filter(([, v]) => v === "latest");
    assert.deepEqual(floating, []);
  });

  test("package.json declares a name", () => {
    assert.equal(typeof pkg.name, "string");
    assert.ok(pkg.name.length > 0);
  });

  test("bun lockfile present (bun.lock or bun.lockb)", () => {
    const hasBunLock = existsSync(join(ROOT, "bun.lock")) || existsSync(join(ROOT, "bun.lockb"));
    const hasPnpmLock = existsSync(join(ROOT, "pnpm-lock.yaml"));
    assert.ok(hasBunLock || hasPnpmLock, "either bun.lock(b) or pnpm-lock.yaml must exist");
  });
});
