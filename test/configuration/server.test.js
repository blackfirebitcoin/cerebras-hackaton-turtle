// test/configuration/server.test.js — sigmashake-mmo

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

describe("configuration: server setup", () => {
  test("server.js exists", () => {
    assert.ok(existsSync(join(ROOT, "server/server.js")));
  });

  test("shared/ directory exists (deterministic sim)", () => {
    assert.ok(existsSync(join(ROOT, "shared")));
  });

  test("required shared modules exist", () => {
    const modules = [
      "constants.js",
      "stats.js",
      "zones.js",
      "enemies.js",
      "loot.js",
      "progression.js",
      "rng.js",
    ];
    for (const m of modules) {
      assert.ok(existsSync(join(ROOT, "shared", m)), `Missing: shared/${m}`);
    }
  });

  test("client directory exists", () => {
    assert.ok(existsSync(join(ROOT, "client")));
  });

  test("ws is the sole runtime dependency; HTTP layer is first-party", () => {
    assert.ok("ws" in (pkg.dependencies ?? {}));
    assert.equal("express" in (pkg.dependencies ?? {}), false);
    assert.ok(existsSync(join(ROOT, "server/router.js")));
  });

  test("package type is module", () => {
    assert.strictEqual(pkg.type, "module");
  });

  test("node engine is >=18", () => {
    assert.ok(pkg.engines?.node);
    const version = parseInt(pkg.engines.node.replace(/[^\d]/g, ""), 10);
    assert.ok(version >= 18);
  });
});
