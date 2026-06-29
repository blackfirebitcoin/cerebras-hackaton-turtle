// SIGMA ABYSS — LPC asset sync.  `node tools/sync-lpc-assets.js`
//
// Reads client/avatar/lpc-manifest.js, resolves every asset against the
// upstream clone in vendor/lpc-generator/spritesheets/, and copies a
// NORMALISED subset into client/assets/lpc/<id>/<anim>[.fg|.bg].png.
//
// Also writes:
//   client/assets/lpc/index.json     — what actually landed (the renderer reads this)
//   client/assets/lpc/CREDITS-LPC.md — mandatory attribution for every used asset
//
// The upstream clone (vendor/) is git-ignored; the synced subset under
// client/assets/lpc/ IS committed. Re-run this whenever the manifest changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { ALL_ANIMS, ANIMS, ASSETS, BODY_TYPE, FRAME } from "../client/avatar/lpc-manifest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPRITES = path.join(ROOT, "vendor/lpc-generator/spritesheets");
const CREDITS_CSV = path.join(ROOT, "vendor/lpc-generator/CREDITS.csv");
const DEST = path.join(ROOT, "client/assets/lpc");

if (!fs.existsSync(SPRITES)) {
  console.error(`✗ ${SPRITES} not found — clone the LPC generator first:`);
  console.error(
    "  git clone --depth 1 https://github.com/liberatedpixelcup/" +
      "Universal-LPC-Spritesheet-Character-Generator.git vendor/lpc-generator",
  );
  process.exit(1);
}

// ── source resolution ─────────────────────────────────────────────────
// Each layout yields an ordered list of candidate source paths (relative to
// spritesheets/); the first that exists on disk wins. Variant layouts fall
// back to `base`, then to whatever single PNG is in the frame directory.

function variantCandidates(dir, variant) {
  // dir is absolute, holds <variant>.png files
  const want = [`${variant}.png`, "base.png", "base_brown.png"];
  for (const w of want) {
    if (fs.existsSync(path.join(dir, w))) return path.join(dir, w);
  }
  if (fs.existsSync(dir)) {
    const png = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort()[0];
    if (png) return path.join(dir, png);
  }
  return null;
}

function resolveSource(asset, anim, part) {
  const s = (rel) => path.join(SPRITES, rel);
  const dir = asset.srcDir;
  const bt = asset.bodytype || BODY_TYPE;
  const variant = asset.variant || "base";

  switch (asset.layout) {
    case "flat":
      return [s(`${dir}/${anim}.png`)];
    case "monster": {
      const leaf = asset.leaf || dir.split("/").pop();
      return [s(`${dir}/${anim}/${leaf}.png`)];
    }
    case "bodytype":
      return [s(`${dir}/${bt}/${anim}.png`)];
    case "variant":
      return [variantCandidates(s(`${dir}/${anim}`), variant), s(`${dir}/${anim}.png`)];
    case "bodytype-variant":
      return [variantCandidates(s(`${dir}/${bt}/${anim}`), variant), s(`${dir}/${bt}/${anim}.png`)];
    case "fgbg":
      return [s(`${dir}/${part}/${anim}.png`)];
    case "fgbg-variant":
      return [variantCandidates(s(`${dir}/${part}/${anim}`), variant)];
    case "weapon": {
      // Held-weapon layer. Upstream nests each weapon as
      //   <dir>/<anim>/<leaf>.png            (in-front-of-body, the "fg")
      //   <dir>/behind/<anim>/<leaf>.png     (behind-the-body cut, the "bg")
      // with a few older variants using foreground.png/background.png or a
      // universal_behind/ folder. Try the known shapes in order; the first
      // that exists wins. `anim` here is the BODY anim (walk/slash/thrust/
      // hurt) and the weapon sheets are authored on the same 4-row grid, so
      // the blade tracks the hand frame-for-frame.
      //
      // Some weapons (longsword, waraxe) name their attack folders
      // `attack_slash`/`attack_thrust` instead of `slash`/`thrust`, and stash
      // the behind-cut as <attackFolder>/behind/<leaf>.png. `asset.animDir`
      // is an optional per-asset alias map ({ slash:'attack_slash', ... });
      // the vendor folder for an anim is `asset.animDir?.[anim] || anim`, so
      // assets without animDir resolve exactly as before.
      // A few weapons (magic staves) nest PART-FIRST instead of anim-first:
      //   <dir>/foreground/<anim>/<leaf>.png  +  <dir>/background/<anim>/<leaf>.png
      // so each in-front/behind cut is its own extra candidate below.
      const leaf = asset.leaf || dir.split("/").pop();
      const aliasAnim = asset.animDir?.[anim] || anim;
      if (part === "bg") {
        return [
          s(`${dir}/${aliasAnim}/behind/${leaf}.png`),
          s(`${dir}/behind/${anim}/${leaf}.png`),
          s(`${dir}/universal_behind/${anim}/${leaf}.png`),
          s(`${dir}/${anim}/background.png`),
          s(`${dir}/background/${aliasAnim}/${leaf}.png`),
        ];
      }
      return [
        s(`${dir}/${aliasAnim}/${leaf}.png`),
        s(`${dir}/${anim}/foreground.png`),
        s(`${dir}/foreground/${aliasAnim}/${leaf}.png`),
      ];
    }
    default:
      return [];
  }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ── weapon-sheet normalisation ────────────────────────────────────────
// A few weapon sheets (longsword/waraxe attack_slash/attack_thrust) ship the
// attack frames at an INTEGER multiple of the normalised 64px grid (e.g. the
// longsword slash is 1152×768 = 3× the 384×256 = 6f×4rows grid). The renderer
// slices every sheet with a hardcoded 64px stride (lpc-avatar.js compositeFrame
// → drawImage(sheet, frame*FRAME, row*FRAME, FRAME, FRAME, …)), so an upscaled
// sheet would draw garbage. Detect the clean integer factor and nearest-neighbour
// downsample back to 1× so the weapon overlays the body frame-for-frame. Sheets
// already on the normalised grid (the dagger, walk/hurt cuts) are copied verbatim.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngHeader(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  };
}

// Decode an 8-bit RGBA (colour type 6) non-interlaced PNG → { width, height,
// data:Uint8ClampedArray }. Returns null for any other shape (the caller then
// copies the file verbatim — palette/greyscale sheets never need downscaling).
function decodeRgba8(buf) {
  const hdr = readPngHeader(buf);
  if (!hdr || hdr.bitDepth !== 8 || hdr.colorType !== 6 || hdr.interlace !== 0) return null;
  const { width, height } = hdr;
  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === "IEND") break;
  }
  if (!idat.length) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const o = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? out[o + x - 4] : 0; // byte to the left (bpp=4)
      const b = y > 0 ? out[o - stride + x] : 0; // byte above
      const c = x >= 4 && y > 0 ? out[o - stride + x - 4] : 0; // upper-left
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

// Nearest-neighbour downsample (take every `factor`-th pixel). Exact for pixel
// art whose source is an integer upscale of the target grid.
function downscale(img, factor) {
  const w = img.width / factor;
  const h = img.height / factor;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const si = (y * factor * img.width + x * factor) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = img.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Encode an 8-bit RGBA image → a minimal (IHDR/IDAT/IEND) non-interlaced PNG.
// Filter type 0 (none) on every scanline keeps it simple and lossless.
function encodeRgba8(img) {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// Copy a weapon frame sheet, downscaling to the normalised 64px grid first when
// the source is a clean integer upscale of it. Falls back to a verbatim copy for
// anything already normalised or not decodable as RGBA8 (e.g. palette sheets).
function copyWeaponFrame(src, dest, anim) {
  const buf = fs.readFileSync(src);
  const hdr = readPngHeader(buf);
  const spec = ANIMS[anim];
  if (hdr && spec) {
    const gw = spec.frames * FRAME;
    const gh = spec.rows * FRAME;
    const fx = hdr.width / gw;
    const fy = hdr.height / gh;
    if (fx > 1 && fx === fy && Number.isInteger(fx)) {
      const img = decodeRgba8(buf);
      if (img) {
        fs.writeFileSync(dest, encodeRgba8(downscale(img, fx)));
        return;
      }
      console.warn(`  ⚠ ${path.basename(src)} is ${fx}× the grid but not RGBA8 — copied raw`);
    }
  }
  fs.copyFileSync(src, dest);
}

// ── copy pass ─────────────────────────────────────────────────────────
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const index = {};
const usedDirs = new Set(); // source dirs that contributed — drives credits
const misses = [];
let copied = 0;

for (const [id, asset] of Object.entries(ASSETS)) {
  const anims = asset.anims || ALL_ANIMS;
  const parts = asset.parts || ["_"];
  const outDir = path.join(DEST, id);
  fs.mkdirSync(outDir, { recursive: true });

  const gotAnims = new Set();
  for (const anim of anims) {
    for (const part of parts) {
      const src = firstExisting(resolveSource(asset, anim, part));
      if (!src) {
        misses.push(`${id}/${anim}${part === "_" ? "" : `.${part}`}`);
        continue;
      }
      const suffix = part === "_" ? "" : `.${part}`;
      const dest = path.join(outDir, `${anim}${suffix}.png`);
      if (asset.layout === "weapon") copyWeaponFrame(src, dest, anim);
      else fs.copyFileSync(src, dest);
      usedDirs.add(path.relative(SPRITES, path.dirname(src)));
      gotAnims.add(anim);
      copied += 1;
    }
  }
  index[id] = {
    anims: [...gotAnims],
    parts,
    z: asset.z,
    zBack: asset.zBack ?? null,
    recolor: asset.recolor ?? null,
  };
}

fs.writeFileSync(path.join(DEST, "index.json"), JSON.stringify(index, null, 2));

// ── attribution ───────────────────────────────────────────────────────
// CREDITS.csv: filename,notes,authors,licenses,urls — fields quoted, the
// authors/licenses/urls fields are themselves comma-joined lists.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

function dirMatchesUsed(rowDir) {
  for (const used of usedDirs) {
    if (rowDir === used || rowDir.startsWith(`${used}/`) || used.startsWith(`${rowDir}/`)) {
      return true;
    }
  }
  return false;
}

const authors = new Set();
const licenses = new Set();
const urls = new Set();
let creditRows = 0;

if (fs.existsSync(CREDITS_CSV)) {
  const lines = fs.readFileSync(CREDITS_CSV, "utf8").split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const [filename, , authorsRaw, licensesRaw, urlsRaw] = parseCsvLine(lines[i]);
    if (!filename) continue;
    if (!dirMatchesUsed(path.dirname(filename))) continue;
    creditRows += 1;
    for (const a of (authorsRaw || "").split(",")) {
      if (a.trim()) authors.add(a.trim());
    }
    for (const l of (licensesRaw || "").split(",")) {
      if (l.trim()) licenses.add(l.trim());
    }
    for (const u of (urlsRaw || "").split(",")) {
      if (u.trim()) urls.add(u.trim());
    }
  }
}

const credits = `# SIGMA ABYSS — LPC Asset Attribution

The character, NPC, and enemy sprites in SIGMA ABYSS are built from the
**Universal LPC Spritesheet** collection (the Liberated Pixel Cup project).
These assets are used under their original licenses and **attribution is
required**. This file is generated by \`tools/sync-lpc-assets.js\` from the
upstream \`CREDITS.csv\` and covers every asset bundled in \`client/assets/lpc/\`.

Source: https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator

## Licenses

${
  [...licenses]
    .sort()
    .map((l) => `- ${l}`)
    .join("\n") || "- (none resolved)"
}

All bundled assets are distributed under one or more of the above licenses.
Where CC-BY-SA / GPL apply, the share-alike / copyleft terms are honored.

## Authors

${
  [...authors]
    .sort()
    .map((a) => `- ${a}`)
    .join("\n") || "- (none resolved)"
}

## Source collections

${
  [...urls]
    .sort()
    .map((u) => `- ${u}`)
    .join("\n") || "- (none resolved)"
}

---
_Generated from ${creditRows} CREDITS.csv rows across ${usedDirs.size} asset directories._
`;
fs.writeFileSync(path.join(DEST, "CREDITS-LPC.md"), credits);

// ── report ────────────────────────────────────────────────────────────
console.log(
  `✓ synced ${copied} PNGs across ${Object.keys(ASSETS).length} assets → client/assets/lpc/`,
);
console.log(`✓ ${authors.size} authors, ${licenses.size} licenses → CREDITS-LPC.md`);
console.log(`✓ index.json written (${Object.keys(index).length} assets)`);
if (misses.length) {
  console.log(
    `\n⚠ ${misses.length} unresolved (asset/anim — may be expected, e.g. skeleton has no idle/sit):`,
  );
  for (const m of misses) console.log(`   - ${m}`);
}
const empty = Object.entries(index).filter(([, v]) => !v.anims.length);
if (empty.length) {
  console.log(
    `\n✗ ${empty.length} assets resolved ZERO files — fix srcDir/layout in lpc-manifest.js:`,
  );
  for (const [id] of empty) console.log(`   - ${id}: ${JSON.stringify(ASSETS[id])}`);
  process.exitCode = 1;
}
