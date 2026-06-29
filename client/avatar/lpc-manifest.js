// SIGMA ABYSS — LPC asset catalog.
//
// The bridge between the game and the Universal LPC Spritesheet assets
// (github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator).
//
// Pure data + pure helpers. Imported by BOTH:
//   • tools/sync-lpc-assets.js (Node) — resolves `srcDir` + `layout` against
//     vendor/lpc-generator/spritesheets/ and copies a NORMALISED subset into
//     client/assets/lpc/<id>/<anim>[.fg|.bg].png
//   • client/avatar/lpc-avatar.js (browser) — reads `z`, `recolor`, `parts`
//     to composite + palette-recolour at draw time.
//
// The sync step is what keeps the renderer simple: upstream LPC nests assets a
// dozen different ways; after sync, every asset is just
//   /assets/lpc/<id>/<anim>.png              (single layer)
//   /assets/lpc/<id>/<anim>.fg.png + .bg.png (two-layer — wings, some hair)

export const FRAME = 64; // every LPC frame is 64×64
export const LPC_BASE = "/assets/lpc"; // served from client/assets/lpc/

// Direction → row index in every 4-row LPC sheet.
export const DIR_ROW = { up: 0, left: 1, down: 2, right: 3 };

// The animations the game actually uses + their frame counts.
// `rows: 1` marks a south-only sheet (LPC `hurt`).
export const ANIMS = {
  idle: { frames: 2, rows: 4, fps: 2.5 },
  walk: { frames: 9, rows: 4, fps: 9 },
  slash: { frames: 6, rows: 4, fps: 13 },
  thrust: { frames: 8, rows: 4, fps: 14 },
  hurt: { frames: 6, rows: 1, fps: 10 },
  sit: { frames: 3, rows: 4, fps: 2 },
  spellcast: { frames: 7, rows: 4, fps: 11 },
};
export const ALL_ANIMS = Object.keys(ANIMS);

// The body type the human paperdoll layers are sliced for. LPC layers are cut
// per body type; the hero + NPCs share one so every modular layer lines up.
export const BODY_TYPE = "male";
export const BODY_TYPE_DRESS = "female"; // dresses only ship a female cut

// `layout` tells the sync script how to find source PNGs under spritesheets/:
//   flat              srcDir/<anim>.png
//   monster           srcDir/<anim>/<leaf>.png       (leaf = `leaf` field, or basename of srcDir)
//   variant           srcDir/<anim>/<variant>.png
//   bodytype          srcDir/<bodytype>/<anim>.png
//   bodytype-variant  srcDir/<bodytype>/<anim>/<variant>.png
//   fgbg              srcDir/{fg,bg}/<anim>.png
//   fgbg-variant      srcDir/{fg,bg}/<anim>/<variant>.png
//   weapon            srcDir/<anim>/<leaf>.png  (fg) + srcDir/behind/<anim>/<leaf>.png (bg)
// The resolver lives in the sync script; the renderer only needs `parts`.

export const ASSETS = {
  // ── bodies (LPC bodies are HEADLESS — a head layer goes on top) ─────
  body_human: { srcDir: "body/bodies/male", layout: "flat", z: 20, recolor: "body" },
  body_human_female: { srcDir: "body/bodies/female", layout: "flat", z: 20, recolor: "body" },
  body_skeleton: {
    srcDir: "body/bodies/skeleton",
    layout: "monster",
    z: 20,
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  body_zombie: {
    srcDir: "body/bodies/zombie",
    layout: "monster",
    z: 20,
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },

  // ── heads + eyes (without these, characters render headless) ───────
  head_human: { srcDir: "head/heads/human/male", layout: "flat", z: 90, recolor: "body" },
  head_human_female: { srcDir: "head/heads/human/female", layout: "flat", z: 90, recolor: "body" },
  head_skeleton: {
    srcDir: "head/heads/skeleton/adult",
    layout: "monster",
    leaf: "skeleton",
    z: 90,
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  head_zombie: {
    srcDir: "head/heads/zombie/adult",
    layout: "flat",
    z: 90,
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  eyes_human: { srcDir: "eyes/human/adult/neutral", layout: "variant", z: 95, variant: "brown" },

  // ── hair (palette-recoloured to the chatter's hair colour) ─────────
  hair_plain: { srcDir: "hair/plain/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_long: { srcDir: "hair/long/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_bob: { srcDir: "hair/bob/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_spiked: { srcDir: "hair/spiked/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_afro: { srcDir: "hair/afro/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_ponytail: {
    srcDir: "hair/ponytail/adult",
    layout: "fgbg",
    z: 130,
    zBack: 12,
    recolor: "hair",
    parts: ["fg", "bg"],
  },
  hair_pixie: { srcDir: "hair/pixie/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_idol: { srcDir: "hair/idol/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_lob: { srcDir: "hair/lob/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_swoop: { srcDir: "hair/swoop/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_curly: { srcDir: "hair/curly_short/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_bedhead: { srcDir: "hair/bedhead/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_curtains: { srcDir: "hair/curtains/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_buzzcut: { srcDir: "hair/buzzcut/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_halfup: { srcDir: "hair/half_up/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_braid: {
    srcDir: "hair/braid/adult",
    layout: "fgbg",
    z: 130,
    zBack: 12,
    recolor: "hair",
    parts: ["fg", "bg"],
  },
  hair_bunches: {
    srcDir: "hair/bunches/adult",
    layout: "fgbg",
    z: 130,
    zBack: 12,
    recolor: "hair",
    parts: ["fg", "bg"],
  },
  hair_wavy: {
    srcDir: "hair/wavy/adult",
    layout: "fgbg",
    z: 130,
    zBack: 12,
    recolor: "hair",
    parts: ["fg", "bg"],
  },
  hair_cornrows: { srcDir: "hair/cornrows/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_dreads: { srcDir: "hair/dreadlocks_short/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_dreadslong: {
    srcDir: "hair/dreadlocks_long/adult",
    layout: "flat",
    z: 130,
    recolor: "hair",
  },
  hair_halfmessy: { srcDir: "hair/halfmessy/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_bangs: { srcDir: "hair/bangs/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_longhawk: { srcDir: "hair/longhawk/adult", layout: "flat", z: 130, recolor: "hair" },
  hair_balding: { srcDir: "hair/balding/adult", layout: "flat", z: 130, recolor: "hair" },

  // ── facial hair (recolour to hair colour; sit below hair layer) ────
  beard_5oclock: { srcDir: "beards/beard/5oclock_shadow", layout: "flat", z: 105, recolor: "hair" },
  beard_basic: { srcDir: "beards/beard/basic", layout: "flat", z: 105, recolor: "hair" },
  beard_medium: { srcDir: "beards/beard/medium", layout: "flat", z: 105, recolor: "hair" },
  beard_trimmed: { srcDir: "beards/beard/trimmed", layout: "flat", z: 105, recolor: "hair" },
  mustache_basic: { srcDir: "beards/mustache/basic", layout: "flat", z: 105, recolor: "hair" },
  mustache_handlebar: {
    srcDir: "beards/mustache/handlebar",
    layout: "flat",
    z: 105,
    recolor: "hair",
  },
  mustache_walrus: { srcDir: "beards/mustache/walrus", layout: "flat", z: 105, recolor: "hair" },

  // ── eyebrows (recolour to hair colour; just above eyes) ────────────
  eyebrows_thick: { srcDir: "eyes/eyebrows/thick/adult", layout: "flat", z: 100, recolor: "hair" },
  eyebrows_thin: { srcDir: "eyes/eyebrows/thin/adult", layout: "flat", z: 100, recolor: "hair" },

  // ── face accessories (above hair so they sit on the face) ──────────
  glasses_clear: {
    srcDir: "facial/glasses/glasses/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },
  glasses_sun: {
    srcDir: "facial/glasses/sunglasses/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },
  glasses_shades: {
    srcDir: "facial/glasses/shades/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },
  glasses_nerd: {
    srcDir: "facial/glasses/nerd/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },
  glasses_round: {
    srcDir: "facial/glasses/round/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },
  glasses_monocle: {
    srcDir: "facial/monocle/left/adult",
    layout: "variant",
    z: 145,
    variant: "brass",
  },
  glasses_eyepatch: {
    srcDir: "facial/patches/eyepatch/left/adult",
    layout: "variant",
    z: 145,
    variant: "black",
  },

  // ── more hats (variant-coloured pre-baked) ─────────────────────────
  hat_hood: { srcDir: "hat/cloth/hood/adult", layout: "variant", z: 140, variant: "brown" },
  hat_santa: { srcDir: "hat/holiday/santa/adult", layout: "variant", z: 140, variant: "red" },
  hat_pirate: { srcDir: "hat/pirate/bandana/adult", layout: "variant", z: 140, variant: "red" },
  hat_headband: { srcDir: "hat/headband/thick/adult", layout: "variant", z: 140, variant: "red" },
  hat_visor: { srcDir: "hat/visor/round/adult", layout: "flat", z: 140 },

  // ── shirt-style replacements (override shirt_basic via shirt_style) ─
  shirt_shortsleeve: {
    srcDir: "torso/clothes/shortsleeve/shortsleeve",
    layout: "bodytype",
    z: 80,
    recolor: "cloth",
  },
  shirt_sleeveless: {
    srcDir: "torso/clothes/sleeveless/sleeveless",
    layout: "bodytype-variant",
    z: 80,
    variant: "black",
  },
  shirt_vest: { srcDir: "torso/clothes/vest", layout: "bodytype-variant", z: 80, variant: "black" },

  // ── pants-style replacements (override pants_basic via pants_style) ─
  pants_shorts: { srcDir: "legs/shorts/shorts", layout: "bodytype", z: 70, recolor: "cloth" },
  pants_shortshorts: {
    srcDir: "legs/shorts/short_shorts",
    layout: "bodytype",
    z: 70,
    recolor: "cloth",
  },
  pants_leggings: { srcDir: "legs/leggings", layout: "bodytype", z: 70, recolor: "cloth" },
  pants_pantaloons: { srcDir: "legs/pantaloons", layout: "bodytype", z: 70, recolor: "cloth" },
  pants_formal: { srcDir: "legs/formal", layout: "bodytype", z: 70, recolor: "cloth" },

  // ── shoe replacements (override shoes_basic via shoes_style) ──────
  shoes_boots: { srcDir: "feet/boots/basic", layout: "bodytype", z: 60, recolor: null },
  shoes_sandals: { srcDir: "feet/sandals", layout: "bodytype", z: 60, recolor: null },
  shoes_slippers: { srcDir: "feet/slippers", layout: "bodytype", z: 60, recolor: null },

  // ── skirts (alternate pants_style choices on a male body) ──────────
  pants_skirt: { srcDir: "legs/skirts/plain", layout: "bodytype", z: 70, recolor: "cloth" },
  pants_legionskirt: { srcDir: "legs/skirts/legion", layout: "bodytype", z: 70, recolor: "cloth" },

  // ── jackets (sit over shirt; pre-coloured variants) ────────────────
  jacket_collared: {
    srcDir: "torso/jacket/collared",
    layout: "bodytype-variant",
    z: 85,
    parts: ["_"],
    variant: "black",
  },
  jacket_frock: {
    srcDir: "torso/jacket/frock",
    layout: "bodytype-variant",
    z: 85,
    parts: ["_"],
    variant: "black",
  },
  jacket_trench: {
    srcDir: "torso/jacket/trench",
    layout: "bodytype-variant",
    z: 85,
    parts: ["_"],
    variant: "gray",
  },
  jacket_tabard: {
    srcDir: "torso/jacket/tabard",
    layout: "bodytype-variant",
    z: 85,
    parts: ["_"],
    variant: "black",
  },
  jacket_santa: { srcDir: "torso/jacket/santa", layout: "bodytype", z: 85, recolor: null },

  // ── shoulders (bodytype, no recolour — pre-coloured) ───────────────
  shoulders_pauldrons: { srcDir: "shoulders/pauldrons", layout: "bodytype", z: 88, recolor: null },
  shoulders_bauldron: { srcDir: "shoulders/bauldron", layout: "bodytype", z: 88, recolor: null },
  shoulders_epaulets: { srcDir: "shoulders/epaulets", layout: "bodytype", z: 88, recolor: null },
  shoulders_mantal: { srcDir: "shoulders/mantal", layout: "bodytype", z: 88, recolor: null },

  // ── arm accessories ─────────────────────────────────────────────────
  bracers_basic: { srcDir: "arms/bracers", layout: "bodytype", z: 86, recolor: null },

  // ── neck pieces (sit just above shirt) ──────────────────────────────
  neck_chain: { srcDir: "neck/necklace/simple", layout: "bodytype", z: 96, recolor: null },
  neck_beaded: { srcDir: "neck/necklace/beaded_large", layout: "bodytype", z: 96, recolor: null },
  neck_cross: { srcDir: "neck/amulet/cross", layout: "bodytype", z: 96, recolor: null },
  neck_star: { srcDir: "neck/amulet/star", layout: "bodytype", z: 96, recolor: null },
  neck_scarf: { srcDir: "neck/scarf", layout: "variant", z: 96, variant: "red" },

  // ── backpack (sits behind the body — z below cape_solid_behind) ────
  backpack_basic: {
    srcDir: "backpack/backpack",
    layout: "bodytype-variant",
    z: 8,
    parts: ["_"],
    variant: "brown",
  },

  // ── more hats (helmets + magic + holiday + pirate variants) ────────
  hat_elf: { srcDir: "hat/holiday/elf/adult", layout: "flat", z: 140, recolor: null },
  hat_helmviking: {
    srcDir: "hat/helmet/barbarian_viking/adult",
    layout: "flat",
    z: 140,
    recolor: null,
  },
  hat_helmbarbarian: {
    srcDir: "hat/helmet/barbarian/adult",
    layout: "flat",
    z: 140,
    recolor: null,
  },
  hat_helmmorion: { srcDir: "hat/helmet/morion/adult", layout: "flat", z: 140, recolor: null },
  hat_helmkettle: { srcDir: "hat/helmet/kettle/adult", layout: "flat", z: 140, recolor: null },
  hat_helmlegion: { srcDir: "hat/helmet/legion/adult", layout: "flat", z: 140, recolor: null },
  hat_helmnorman: { srcDir: "hat/helmet/norman/adult", layout: "flat", z: 140, recolor: null },
  hat_helmarmet: { srcDir: "hat/helmet/armet/adult", layout: "flat", z: 140, recolor: null },
  hat_magicceles: {
    srcDir: "hat/magic/celestial/adult",
    layout: "variant",
    z: 140,
    variant: "blue",
  },
  hat_magiclarge: { srcDir: "hat/magic/large/adult", layout: "variant", z: 140, variant: "brown" },

  // ── base clothing (always-on; palette-recoloured to chatter colours) ─
  shirt_basic: {
    srcDir: "torso/clothes/longsleeve/longsleeve",
    layout: "bodytype",
    z: 80,
    recolor: "cloth",
  },
  pants_basic: { srcDir: "legs/pants", layout: "bodytype", z: 70, recolor: "cloth" },
  shoes_basic: { srcDir: "feet/shoes/basic", layout: "bodytype", z: 60, recolor: null },

  // ── headwear (pre-coloured LPC variants) ───────────────────────────
  hat_cap: { srcDir: "hat/cloth/leather_cap/adult", layout: "variant", z: 140, variant: "leather" },
  hat_beanie: { srcDir: "hat/cloth/bandana/adult", layout: "variant", z: 140, variant: "red" },
  hat_tophat: { srcDir: "hat/formal/tophat/adult", layout: "variant", z: 140, variant: "black" },
  hat_bowler: { srcDir: "hat/formal/bowler/adult", layout: "variant", z: 140, variant: "brown" },
  hat_wizard: { srcDir: "hat/magic/wizard/base/adult", layout: "variant", z: 140, variant: "blue" },
  hat_crown: { srcDir: "hat/formal/crown/adult", layout: "variant", z: 140, variant: "gold" },
  hat_crown_moon: {
    srcDir: "hat/formal/crown/adult",
    layout: "variant",
    z: 140,
    variant: "silver",
  },
  hat_tiara: { srcDir: "hat/formal/tiara/adult", layout: "variant", z: 140, variant: "silver" },
  hat_tiara_rose: { srcDir: "hat/formal/tiara/adult", layout: "variant", z: 140, variant: "rose" },

  // ── wings / capes (two-layer fg+bg; pre-coloured variants) ─────────
  wings_feathered: {
    srcDir: "body/wings/feathered/adult",
    layout: "fgbg-variant",
    z: 150,
    zBack: 5,
    parts: ["fg", "bg"],
    variant: "white",
  },
  wings_bat: {
    srcDir: "body/wings/bat/adult",
    layout: "fgbg-variant",
    z: 150,
    zBack: 5,
    parts: ["fg", "bg"],
    variant: "black",
  },
  wings_monarch: {
    srcDir: "body/wings/monarch/base",
    layout: "fgbg-variant",
    z: 150,
    zBack: 5,
    parts: ["fg", "bg"],
    variant: "gold",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  wings_pixie: {
    srcDir: "body/wings/pixie/solid",
    layout: "fgbg-variant",
    z: 150,
    zBack: 5,
    parts: ["fg", "bg"],
    variant: "green",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  cape_solid: {
    srcDir: "cape/solid_behind",
    layout: "variant",
    z: 5,
    variant: "purple",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  cape_silk: {
    srcDir: "cape/solid_behind",
    layout: "variant",
    z: 5,
    variant: "white",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  cape_warlord: {
    srcDir: "cape/solid_behind",
    layout: "variant",
    z: 5,
    variant: "red",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },
  cape_dragonhide: {
    srcDir: "cape/solid_behind",
    layout: "variant",
    z: 5,
    variant: "forest",
    anims: ["walk", "slash", "thrust", "hurt", "spellcast"],
  },

  // ── held weapons (animate with the body slash/thrust frames) ───────
  // The melee blade layer. `weapon/sword/dagger` is the one LPC weapon
  // variant that still ships the NORMALISED 4-row grids that overlay the
  // synced bodies frame-for-frame (slash 6f, thrust 8f, walk 9f, hurt 6f×1)
  // — longsword/katana/bow only ship the expanded 8-row "universal" sheets
  // which would desync. So this one sheet is the universal in-hand blade;
  // cosmetics.lpcBuild() recolours it per weapon family/rarity so a Brawler,
  // a Swordsman, a Warbreaker and a Crusher read differently. fg sits in
  // front of the torso (z 98 — above clothes, below hair); the `behind/`
  // cut (bg) sits behind the body (zBack 15) for left/up facings.
  weapon_blade: {
    srcDir: "weapon/sword/dagger",
    leaf: "dagger",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt"],
  },
  // A full-length longsword — bigger, clearly visible blade for the sword /
  // greatsword families. Its attack frames live in `attack_slash`/
  // `attack_thrust` folders (and the behind-cut in <attackFolder>/behind/),
  // so `animDir` aliases the body anim names to the vendor folder names.
  weapon_longsword: {
    srcDir: "weapon/sword/longsword",
    leaf: "longsword",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk", "slash", "thrust", "hurt"],
    animDir: { slash: "attack_slash", thrust: "attack_thrust" },
  },
  // A heavy war axe for the hammer (crusher) family. The vendor sheet ships
  // walk/attack_slash/hurt + behind cuts only — there is no thrust folder, so
  // `thrust` is omitted (the body still thrusts; the axe just isn't redrawn).
  weapon_axe: {
    srcDir: "weapon/blunt/waraxe",
    leaf: "waraxe",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk", "slash", "hurt"],
    animDir: { slash: "attack_slash" },
  },
  // A glowing rune-etched blade for the arcane `runeblade` cosmetic. Same
  // vendor structure as the longsword (attack_slash only — no thrust folder),
  // but the leaf is the glow VARIANT name (`blue`) rather than the weapon name.
  // cosmetics.lpcBuild() recolours it toward arcane purple for the runeblade.
  weapon_glowsword: {
    srcDir: "weapon/sword/glowsword",
    leaf: "blue",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk", "slash", "hurt"],
    animDir: { slash: "attack_slash" },
  },
  // ── off-hand shields (single body-overlay layer — no fg/bg cut) ────
  // LPC ships shields under shield/<type>/[<bodytype>/]<anim>/<variant>.png as
  // one flat layer. z 97 sits just under a held blade (z 98) so a sword reads
  // in front of the shield arm. The round shield backs the `shield_buckler`
  // cosmetic; the kite shield backs `shield_kite`.
  shield_round: {
    srcDir: "shield/round",
    layout: "variant",
    z: 97,
    variant: "silver",
    recolor: null,
    anims: ["walk", "slash", "thrust"],
  },
  shield_kite: {
    srcDir: "shield/kite",
    layout: "bodytype-variant",
    z: 97,
    variant: "kite_gray",
    recolor: null,
    anims: ["walk", "slash", "thrust"],
  },
  // A glowing arcane staff for the `staff` (Sorcerer) family — e.g. a looted
  // Hexblade. magic/simple nests part-first (foreground/<anim>/simple.png), so
  // the weapon resolver's part-first candidates pick it up. No slash folder, so
  // the body's slash falls back to the staff's thrust frame.
  weapon_staff: {
    srcDir: "weapon/magic/simple",
    leaf: "simple",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk", "thrust", "hurt"],
  },
  // A wooden bow for the `bow` (Marksman) family — e.g. a looted Coilgun. The
  // vendor sheet ships only walk (foreground.png/background.png) + a universal
  // sheet; walk is the one normalised cut, so other anims fall back to it.
  weapon_bow: {
    srcDir: "weapon/ranged/bow/normal",
    layout: "weapon",
    z: 98,
    zBack: 15,
    parts: ["fg", "bg"],
    recolor: null,
    anims: ["walk"],
  },

  // ── dresses (replace shirt+pants; female cut; pre-coloured variants) ─
  // Each catalog gown is its own {cut × colour} so the eight dresses read
  // as visually distinct — they all used to render the one rose slit cut.
  dress_minigown_pastel: {
    srcDir: "dress/slit",
    layout: "bodytype-variant",
    z: 82,
    variant: "pink",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_uniform_school: {
    srcDir: "dress/bodice",
    layout: "bodytype-variant",
    z: 82,
    variant: "navy",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_fairy_dew: {
    srcDir: "dress/slit",
    layout: "bodytype-variant",
    z: 82,
    variant: "green",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_ballgown_mint: {
    srcDir: "dress/sash",
    layout: "bodytype-variant",
    z: 82,
    variant: "forest",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_pastelgoth: {
    srcDir: "dress/bodice",
    layout: "bodytype-variant",
    z: 82,
    variant: "charcoal",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_ballgown_rose: {
    srcDir: "dress/sash",
    layout: "bodytype-variant",
    z: 82,
    variant: "rose",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_princess_gold: {
    srcDir: "dress/sash",
    layout: "bodytype-variant",
    z: 82,
    variant: "orange",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
  dress_cyber_neon: {
    srcDir: "dress/slit",
    layout: "bodytype-variant",
    z: 82,
    variant: "navy",
    bodytype: "female",
    anims: ["walk", "idle", "slash", "thrust", "hurt", "spellcast"],
  },
};

// Representative hex per LPC variant name — used to pick the closest variant
// when a game cosmetic carries a free-form colour instead of a catalog choice.
export const VARIANT_HEX = {
  black: "#1b1b1b",
  charcoal: "#36363f",
  gray: "#8b9498",
  white: "#e8e8e8",
  brown: "#76513a",
  tan: "#c7935f",
  leather: "#8a5a2b",
  walnut: "#5f4539",
  red: "#cb1f1f",
  maroon: "#7a1f2b",
  rose: "#cc789d",
  pink: "#e941aa",
  orange: "#e07a1f",
  yellow: "#e6c020",
  gold: "#d4af37",
  brass: "#b08d3c",
  bronze: "#cd7f32",
  copper: "#b87333",
  silver: "#c0c0c0",
  iron: "#9aa0a6",
  steel: "#8d9aa6",
  green: "#39aa4e",
  forest: "#1e5a2a",
  teal: "#16a085",
  blue: "#3a78c8",
  bluegray: "#6b7f9e",
  navy: "#2c3550",
  sky: "#7fc6e6",
  purple: "#7141b2",
  lavender: "#b9a8d8",
  slate: "#5a6470",
  ceramic: "#d8cfc0",
};

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Closest LPC variant name to a free colour, restricted to `available` if given.
export function nearestVariant(hex, available) {
  const want = hexToRgb(hex);
  const pool = available?.length
    ? available.filter((v) => VARIANT_HEX[v])
    : Object.keys(VARIANT_HEX);
  if (!want || !pool.length) return available?.[0] || "white";
  let best = pool[0];
  let bestD = Infinity;
  for (const name of pool) {
    const c = hexToRgb(VARIANT_HEX[name]);
    if (!c) continue;
    const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

// Frame layout for an animation: { frames, rows, fps }. Unknown → walk.
export function animSpec(anim) {
  return ANIMS[anim] || ANIMS.walk;
}
