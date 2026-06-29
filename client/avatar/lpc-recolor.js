// SIGMA ABYSS — LPC palette recolouring.
//
// LPC body / hair / cloth layers ship in ONE reference colour and are recoloured
// by swapping a 6-shade ramp. We don't need to know the reference colour: we
// extract whatever distinct opaque colours a layer actually contains, rank them
// by luminance, and map rank i → the target ramp's i-th shade. Crisp,
// deterministic, and the result is cached forever by the renderer.
//
// Ramps lifted verbatim from vendor/lpc-generator/palette_definitions/*_ulpc.json
// (dark → light, 6 shades each).

export const RAMPS = {
  body: {
    light: ["#271920", "#99423c", "#cc8665", "#E4A47C", "#F9D5BA", "#FAECE7"],
    amber: ["#281716", "#9E3E37", "#D28144", "#EA9F54", "#FDD082", "#FBE7A4"],
    olive: ["#271920", "#442725", "#7F4C31", "#AE6B3F", "#D38B59", "#E4A47C"],
    taupe: ["#271920", "#503734", "#785946", "#936849", "#BA8454", "#C7935F"],
    bronze: ["#1A1213", "#442725", "#644133", "#7F4C31", "#AE6B3F", "#D38B59"],
    brown: ["#120E10", "#412B29", "#5F4539", "#76513A", "#9C663E", "#B8773F"],
    black: ["#000000", "#1A1213", "#2E1F1C", "#442725", "#603429", "#7F4C31"],
    green: ["#140C09", "#09320B", "#19541D", "#228236", "#39AA4E", "#53BF71"],
    pale_green: ["#271920", "#314829", "#456238", "#5F874D", "#86B278", "#ADCCA6"],
    bright_green: ["#02280E", "#06410E", "#255E1D", "#5B8F11", "#75AE23", "#99D248"],
    dark_green: ["#011708", "#02280E", "#06410E", "#255E1D", "#508A48", "#509E59"],
    zombie: ["#281820", "#6B5C40", "#928364", "#A79778", "#C5B38F", "#DBCBAB"],
    zombie_green: ["#101925", "#074337", "#4A7A69", "#839F6E", "#D4D887", "#F2F0C4"],
  },
  hair: {
    orange: ["#260D14", "#6A1108", "#A42600", "#BF4000", "#E55600", "#FF8A00"],
    ash: ["#2D061B", "#642442", "#935065", "#C18F8A", "#EDDF95", "#FFF1C1"],
    platinum: ["#1C0E06", "#7D5D5D", "#A87D52", "#C0AB81", "#EDDF95", "#F6F6F3"],
    white: ["#1D1D21", "#484E57", "#8B9498", "#B8BBBC", "#D8DCDC", "#FFFFFF"],
    gray: ["#0E0E0E", "#292929", "#4B4B4B", "#777777", "#AAAAAA", "#D9D9D9"],
    blonde: ["#331313", "#552B15", "#AC5D1F", "#E09E2B", "#FCCF56", "#FFE67D"],
    sandy: ["#1C0E06", "#633E2C", "#99622D", "#BF9D5A", "#EDDC7E", "#F6F6C2"],
    strawberry: ["#300700", "#6A2800", "#9C5900", "#CCA000", "#FAF080", "#F6F6C2"],
    gold: ["#5C0D00", "#902900", "#E47100", "#FFA913", "#FFE453", "#EEFE7E"],
    ginger: ["#300500", "#6A1A00", "#9C3B01", "#CC6901", "#FAA301", "#FFE01E"],
    carrot: ["#5A1500", "#8A2000", "#AC2800", "#EC673E", "#F68764", "#FFB39C"],
    redhead: ["#260D14", "#3E111A", "#73171E", "#9E1F1F", "#C7341B", "#E74716"],
    red: ["#300000", "#870000", "#A40712", "#CB0000", "#E21414", "#F1583A"],
    light_brown: ["#1A0E04", "#301B07", "#60350F", "#7D4513", "#AE682A", "#C88D58"],
    chestnut: ["#200C0D", "#3A130E", "#63200B", "#81310A", "#B6550E", "#D28102"],
    dark_brown: ["#050100", "#160701", "#290E02", "#421603", "#5F1F04", "#792806"],
    dark_gray: ["#000000", "#0E0E0E", "#1B1B1B", "#3B3B3B", "#7C7C7C", "#C1C1C1"],
    black: ["#000000", "#080A0A", "#101414", "#1C2222", "#31313E", "#4A5057"],
    raven: ["#010107", "#040B18", "#061421", "#071F2A", "#0D384D", "#1A5369"],
    rose: ["#30051F", "#6A1E4B", "#9C4373", "#CC789D", "#FABBC6", "#FAE1E5"],
    pink: ["#330410", "#71043A", "#B60A68", "#E941AA", "#E976C4", "#EA95D5"],
    purple: ["#13112D", "#2B225A", "#402E82", "#7141B2", "#A966DD", "#D085ED"],
    violet: ["#1E032E", "#30035C", "#380392", "#3C07D8", "#5662F3", "#5792F2"],
    navy: ["#180716", "#20102B", "#281E41", "#322D6A", "#3C49AD", "#466AC9"],
    blue: ["#000027", "#00005E", "#000091", "#0041B4", "#0074CB", "#1E85EF"],
    green: ["#000400", "#001400", "#002D00", "#005000", "#007C00", "#00A700"],
  },
  cloth: {
    brown: ["#1d131e", "#411E05", "#4B2B13", "#62351C", "#744B30", "#996B4A"],
    leather: ["#2b1c1d", "#311210", "#4B2B13", "#704325", "#75502D", "#9A6F37"],
    walnut: ["#1d0f0e", "#3e2613", "#62351c", "#744b30", "#996b4a", "#a17c50"],
    yellow: ["#301723", "#5F2F25", "#BA5B23", "#D99431", "#F3C03F", "#FFE360"],
    tan: ["#3e2613", "#684415", "#986A20", "#B78C41", "#B7996A", "#CFC587"],
    orange: ["#301723", "#5F1D1B", "#9C3F23", "#D75B1A", "#EF7E19", "#FFA749"],
    rose: ["#1d131e", "#301723", "#562323", "#77372B", "#8A3D28", "#B05F3C"],
    maroon: ["#1d131e", "#400B1F", "#551C22", "#682121", "#832121", "#AE424A"],
    red: ["#1d131e", "#400B1F", "#651117", "#82171C", "#AB1E1E", "#CD2429"],
    pink: ["#1d131e", "#54242E", "#6C3536", "#AE424A", "#C36072", "#E08080"],
    lavender: ["#13112d", "#2B225A", "#402E82", "#7141B2", "#A966DD", "#D085ED"],
    purple: ["#180716", "#13112D", "#261044", "#411357", "#621E78", "#813089"],
    blue: ["#180716", "#281E41", "#322D6A", "#3C49AD", "#466AC9", "#61A0EF"],
    navy: ["#180716", "#20102B", "#281E41", "#322D6A", "#3C49AD", "#466AC9"],
    teal: ["#180716", "#1B2B47", "#0E4E72", "#156C99", "#0098B2", "#00CFDF"],
    bluegray: ["#11150b", "#0B2B28", "#2E403A", "#315B49", "#557E85", "#79979D"],
    forest: ["#09131d", "#07391D", "#0B1F25", "#0B2B28", "#134507", "#1B5502"],
    green: ["#101820", "#192832", "#0B5C2F", "#214437", "#2F8136", "#64A42C"],
    white: ["#281820", "#4D4A5D", "#958080", "#C4B59F", "#E5E6C7", "#FFFFFF"],
    sky: ["#1a0d18", "#313148", "#586B90", "#9FBBCB", "#C6EEFD", "#FFFFFF"],
    slate: ["#1d131e", "#31313E", "#4A5057", "#818B8B", "#B3AFA1", "#E5E6C7"],
    gray: ["#0e0e18", "#201E2B", "#373340", "#585561", "#797580", "#A2A0A4"],
    black: ["#000000", "#101414", "#1C2222", "#22282A", "#2A3034", "#4A5057"],
    charcoal: ["#000000", "#130D14", "#1C2222", "#2A3034", "#4A5057", "#6E7675"],
  },
};

function hexToRgb(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Pre-resolve every ramp to rgb triples + the "key" shade (index 4, the bright
// main tone) used for free-colour → ramp-name matching.
const RGB_RAMPS = {};
const KEY_SHADE = {};
for (const [mat, ramps] of Object.entries(RAMPS)) {
  RGB_RAMPS[mat] = {};
  KEY_SHADE[mat] = {};
  for (const [name, hexes] of Object.entries(ramps)) {
    RGB_RAMPS[mat][name] = hexes.map(hexToRgb);
    KEY_SHADE[mat][name] = hexToRgb(hexes[4] || hexes[hexes.length - 1]);
  }
}

// Closest ramp NAME in a material to a free-form hex colour.
export function nearestRampName(hex, material, restrict) {
  const want = hexToRgb(hex || "#888888");
  const names = restrict?.length ? restrict : Object.keys(KEY_SHADE[material] || {});
  let best = names[0];
  let bestD = Infinity;
  for (const name of names) {
    const k = KEY_SHADE[material]?.[name];
    if (!k) continue;
    const d = (k[0] - want[0]) ** 2 + (k[1] - want[1]) ** 2 + (k[2] - want[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Recolour a loaded sheet by ramp swap. Returns a NEW canvas; `src` is untouched.
// `material` ∈ RAMPS, `rampName` ∈ RAMPS[material]. Unknown → src returned as-is.
export function recolorCanvas(src, material, rampName) {
  const target = RGB_RAMPS[material]?.[rampName];
  if (!target) return src;

  const w = src.width;
  const h = src.height;
  const out = makeCanvas(w, h);
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(src, 0, 0);
  const img = octx.getImageData(0, 0, w, h);
  const px = img.data;

  // Pass 1 — collect the distinct fully-opaque colours = the source ramp.
  const seen = new Map(); // packed rgb → true
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 250) continue;
    const packed = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    seen.set(packed, true);
  }
  const srcRamp = [...seen.keys()]
    .map((p) => [(p >> 16) & 255, (p >> 8) & 255, p & 255])
    .sort((a, b) => luma(...a) - luma(...b));
  if (!srcRamp.length) return src;

  const S = srcRamp.length;
  const T = target.length;
  // rank i → target shade (proportional remap so any ramp length works)
  const rankTarget = srcRamp.map(
    (_, i) => target[S === 1 ? T - 1 : Math.round((i * (T - 1)) / (S - 1))],
  );
  // exact-colour fast path
  const exact = new Map();
  for (let i = 0; i < S; i += 1) {
    const [r, g, b] = srcRamp[i];
    exact.set((r << 16) | (g << 8) | b, rankTarget[i]);
  }

  // Pass 2 — rewrite. Exact ramp colours map directly; AA edge pixels snap to
  // the nearest ramp entry. Alpha is preserved throughout.
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;
    const packed = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    let t = exact.get(packed);
    if (!t) {
      let bestD = Infinity;
      let bestI = 0;
      for (let k = 0; k < S; k += 1) {
        const c = srcRamp[k];
        const d = (c[0] - px[i]) ** 2 + (c[1] - px[i + 1]) ** 2 + (c[2] - px[i + 2]) ** 2;
        if (d < bestD) {
          bestD = d;
          bestI = k;
        }
      }
      t = rankTarget[bestI];
    }
    px[i] = t[0];
    px[i + 1] = t[1];
    px[i + 2] = t[2];
  }
  octx.putImageData(img, 0, 0);
  return out;
}
