import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
}

const ROOT = join(import.meta.dir, "..", "..");

function readPkg(): PackageJson {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

describe("sigmashake-mmo dependencies", () => {
  test("no package-lock.json (npm banned monorepo-wide)", () => {
    expect(existsSync(join(ROOT, "package-lock.json"))).toBe(false);
  });
  test('no "latest" floating pins in runtime deps', () => {
    const pkg = readPkg();
    const floating = Object.entries(pkg.dependencies ?? {}).filter(([, v]) => v === "latest");
    expect(floating).toEqual([]);
  });
  test("package.json declares a name", () => {
    const pkg = readPkg();
    expect(typeof pkg.name).toBe("string");
    expect(String(pkg.name ?? "").length).toBeGreaterThan(0);
  });
});
