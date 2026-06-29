// test/regression/shared-contracts.test.js — sigmashake-mmo
// Snapshots: shared constants and schema that must not drift without intent.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const require = createRequire(import.meta.url);

const {
  SCHEMA_VERSION,
  START_STATS,
  STAT_KEYS,
  LEVEL_MAX,
  XP_BASE,
  XP_GROWTH,
  INVENTORY_MAX,
} = require(join(ROOT, "shared/constants.js"));

describe("regression: SIGMA ABYSS shared constants", () => {
  test("SCHEMA_VERSION is a positive integer", () => {
    assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0);
  });

  test("STAT_KEYS contains expected stats", () => {
    const required = ["str", "agi", "vit", "int"];
    for (const key of required) {
      assert.ok(STAT_KEYS.includes(key), `Missing stat key: ${key}`);
    }
  });

  test("LEVEL_MAX is positive", () => {
    assert.ok(LEVEL_MAX > 0);
  });

  test("XP_BASE is positive", () => {
    assert.ok(XP_BASE > 0);
  });

  test("XP_GROWTH is > 1 (exponential curve)", () => {
    assert.ok(XP_GROWTH > 1);
  });

  test("INVENTORY_MAX is positive", () => {
    assert.ok(INVENTORY_MAX > 0);
  });

  test("START_STATS has all STAT_KEYS", () => {
    for (const key of STAT_KEYS) {
      assert.ok(key in START_STATS, `Missing start stat: ${key}`);
    }
  });
});

describe("regression: package.json contract", () => {
  test("worker name is sigmashake-mmo", () => {
    const pkg = require(join(ROOT, "package.json"));
    assert.strictEqual(pkg.name, "sigmashake-mmo");
  });

  test("server entry is server/server.js", () => {
    const pkg = require(join(ROOT, "package.json"));
    assert.strictEqual(pkg.scripts?.start, "node server/server.js");
  });

  test("public mirror scripts stay discoverable", () => {
    const pkg = require(join(ROOT, "package.json"));
    assert.strictEqual(pkg.scripts?.["mirror:public"], "bash scripts/publish-mmo-mirror.sh");
    assert.strictEqual(
      pkg.scripts?.["mirror:public:evidence"],
      "bash scripts/publish-mmo-mirror.sh --write-evidence /tmp/mmo-mirror-evidence.env",
    );
  });
});

describe("regression: public mirror contract", () => {
  const scriptPath = join(ROOT, "scripts/publish-mmo-mirror.sh");

  test("mirror script exists and is allowlist-only", () => {
    assert.ok(existsSync(scriptPath));
    const script = readFileSync(scriptPath, "utf8");
    assert.match(script, /Allowlist-only public copy/);
    assert.match(script, /"client"/);
    assert.match(script, /"server"/);
    assert.match(script, /"shared"/);
    assert.match(script, /"integrations"/);
    assert.match(script, /"test"/);
  });

  test("mirror excludes runtime data and requires fail-closed scanning", () => {
    const script = readFileSync(scriptPath, "utf8");
    assert.match(script, /--exclude='data\/'/);
    assert.match(script, /gitleaks is required/);
    assert.match(script, /MMO_HMAC_KEY/);
    assert.match(script, /OBS_WS_PASSWORD/);
    assert.match(script, /public-url/);
  });

  test("public collaboration docs exist", () => {
    for (const rel of ["AGENTS.md", "SPEC_SHEET.md", "integrations/README.md", "integrations/contracts/README.md"]) {
      assert.ok(existsSync(join(ROOT, rel)), `missing ${rel}`);
    }
  });
});
