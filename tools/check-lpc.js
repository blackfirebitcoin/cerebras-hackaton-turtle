// SIGMA ABYSS — LPC integration check.  `node tools/check-lpc.js`
//
// Headless cross-check of the LPC sprite layer: every asset id and palette
// ramp referenced by cosmetics.lpcBuild() / cosmetics.enemyBuild() must resolve
// to a real synced asset in client/assets/lpc/index.json. Catches manifest
// drift and typos without needing a browser. Exits non-zero on any miss.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRESS_CONFIG,
  enemyBuild,
  HEAD_CONFIG,
  lpcBuild,
  WINGS_CONFIG,
} from "../client/avatar/cosmetics.js";
import { RAMPS } from "../client/avatar/lpc-recolor.js";
import { ENEMIES } from "../shared/enemies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "client/assets/lpc/index.json");
if (!fs.existsSync(INDEX_PATH)) {
  console.error(
    "✗ client/assets/lpc/index.json missing — run `node tools/sync-lpc-assets.js` first",
  );
  process.exit(1);
}
const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));

let fail = 0;
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  fail += 1;
};
const ok = (m) => console.log(`  ok   ${m}`);

function checkLayers(label, layers) {
  if (!layers?.length) {
    bad(`${label}: empty build`);
    return;
  }
  for (const l of layers) {
    if (!index[l.assetId]) {
      bad(`${label}: unknown asset "${l.assetId}"`);
      continue;
    }
    if (l.recolor) {
      const ramps = RAMPS[l.recolor.material];
      if (!ramps) bad(`${label}: unknown recolor material "${l.recolor.material}"`);
      else if (!ramps[l.recolor.ramp])
        bad(`${label}: unknown ${l.recolor.material} ramp "${l.recolor.ramp}"`);
    }
  }
}

// 1 — hero builds across the full cosmetic surface
const sample = (cos) => ({ seed: 12345, cosmetics: cos });
checkLayers("hero/default", lpcBuild(sample({})));
checkLayers(
  "hero/explicit-colours",
  lpcBuild(
    sample({
      hat_style: "wizard",
      hair_style: "afro",
      c_hair: "#cc6633",
      c_skin: "#5a3a26",
      c_shirt: "#3498db",
      c_pants: "#2c3e50",
    }),
  ),
);
for (const head of Object.keys(HEAD_CONFIG))
  checkLayers(`hero/head:${head}`, lpcBuild(sample({ head })));
for (const wings of Object.keys(WINGS_CONFIG))
  checkLayers(`hero/wings:${wings}`, lpcBuild(sample({ wings })));
for (const dress of Object.keys(DRESS_CONFIG))
  checkLayers(`hero/dress:${dress}`, lpcBuild(sample({ dress })));
for (const hs of ["cap", "beanie", "tophat", "cowboy", "wizard", "bare"]) {
  checkLayers(`hero/hat:${hs}`, lpcBuild(sample({ hat_style: hs })));
}
for (const hr of ["short", "long", "bob", "ponytail", "spiky", "afro"]) {
  checkLayers(`hero/hair:${hr}`, lpcBuild(sample({ hair_style: hr })));
}
const combos =
  Object.keys(HEAD_CONFIG).length +
  Object.keys(WINGS_CONFIG).length +
  Object.keys(DRESS_CONFIG).length +
  14;
ok(`hero builds resolve across ${combos} cosmetic combinations`);

// 2 — every enemy in the bestiary
for (const [id, def] of Object.entries(ENEMIES)) {
  const b = enemyBuild(def.lpc);
  if (!b) {
    bad(`enemy/${id}: enemyBuild returned null (missing lpc spec?)`);
    continue;
  }
  checkLayers(`enemy/${id}`, b.layers);
}
ok(`all ${Object.keys(ENEMIES).length} enemy builds resolve`);

// 3 — index.json sanity
for (const [id, meta] of Object.entries(index)) {
  if (!meta.anims?.length) bad(`index: asset "${id}" shipped zero animations`);
}
ok(`index.json: ${Object.keys(index).length} assets, every one with animations`);

console.log(`\n  ${fail ? `${fail} FAILED` : "all LPC integration checks passed"}\n`);
process.exit(fail ? 1 : 0);
