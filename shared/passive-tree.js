// SIGMA ABYSS — the Passive Tree (Project Ascendant Inc4).
//
// A connected ~100-node prototype of the Path-of-Exile-scale passive web
// (the full vision is the PoE 1,325-node graph; this is the playable seed).
// Eight CLASS START ZONES ring a shared interior so builds can cross into
// each other's territory; 5 build-defining KEYSTONES sit on the rim of the
// interior, each a strong mod with a real tradeoff.
//
// PURE + RNG-free (static data only) → dual-runtime safe (browser ESM + Node).
// No DOM, no Node built-ins, no Math.random — the passive layer is fully
// DETERMINISTIC. passiveMods() returns EXACT identity (×1 / +0) when the
// character has NO allocated passives, so derive() / resolveEncounter stay
// byte-identical for un-allocated characters and the same-seed→same-outcome
// determinism the smoke canary guards never shifts. This mirrors the
// talentMods / auraMods / setModsForBonuses exact-identity-when-empty pattern.
//
// ── The mods vocabulary ───────────────────────────────────────────────────
// A node's `mods` is a partial combat-sheet modifier; absent keys are
// identity (×1 for *Mul, +0 for *Add). derive() folds the aggregate in
// post-everything-else, multiplicatively for *Mul and additively for *Add —
// the exact composition style of the other modifier systems. Keys:
//   hpMul atkMul defMul speedMul dangerMul   (multiplicative, identity ×1)
//   critAdd critMultAdd dodgeAdd              (additive, identity +0)
//   lootQtyAdd lootRarityAdd                  (additive, identity +0)
//   spiritAdd                                 (additive flat spirit, +0)
// Keystones may carry the SAME keys plus a `keystone:true` marker and a
// `flag` (combat.js can read keystone flags later — for now flags are inert).

// ── Mod accumulator shape (every key at identity) ─────────────────────────
function zeroMods() {
  return {
    hpMul: 1,
    atkMul: 1,
    defMul: 1,
    speedMul: 1,
    dangerMul: 1,
    critAdd: 0,
    critMultAdd: 0,
    dodgeAdd: 0,
    lootQtyAdd: 0,
    lootRarityAdd: 0,
    spiritAdd: 0,
  };
}

// The frozen exact-identity object returned when no passives are allocated.
// Same firewall as talentMods/auraMods: x×1===x, x+0===x (IEEE 754) so
// derive() output is byte-identical for un-allocated characters.
export const PASSIVE_IDENTITY = Object.freeze(zeroMods());

// Multiplicative keys (composed ×) and additive keys (composed +).
const MUL_KEYS = ["hpMul", "atkMul", "defMul", "speedMul", "dangerMul"];
const ADD_KEYS = ["critAdd", "critMultAdd", "dodgeAdd", "lootQtyAdd", "lootRarityAdd", "spiritAdd"];

// Node-builder helpers. `n` = a normal passive; `k` = a keystone.
function n(id, name, kind, mods, adj, zone) {
  return { id, name, kind, mods: mods || {}, adj: adj || [], zone: zone || null };
}
function k(id, name, mods, flag, desc, adj) {
  return {
    id,
    name,
    kind: "keystone",
    mods: mods || {},
    flag: flag || null,
    desc: desc || "",
    adj: adj || [],
    keystone: true,
  };
}

// ── The eight class start zones ────────────────────────────────────────────
// Each maps to weapon families / the spec's archetypes and seeds toward the
// stat identity of that class. The `zone` value is the start-area key used by
// isAllocationConnected() as the BFS root anchor.
export const CLASS_START_ZONES = [
  {
    id: "warrior",
    name: "Warrior",
    entry: "warrior_start",
    flavor: "STR — greatsword/hammer line.",
  },
  { id: "ranger", name: "Ranger", entry: "ranger_start", flavor: "DEX — bow line." },
  { id: "mage", name: "Mage", entry: "mage_start", flavor: "INT — staff line." },
  { id: "monk", name: "Monk", entry: "monk_start", flavor: "DEX/INT — fists/wand line." },
  {
    id: "templar",
    name: "Templar",
    entry: "templar_start",
    flavor: "STR/INT — hammer/staff line.",
  },
  { id: "rogue", name: "Rogue", entry: "rogue_start", flavor: "DEX — dagger line." },
  { id: "duelist", name: "Duelist", entry: "duelist_start", flavor: "STR/DEX — sword/spear line." },
  { id: "warden", name: "Warden", entry: "warden_start", flavor: "VIT/STR — axe/survival line." },
];

export const CLASS_START_IDS = CLASS_START_ZONES.map((z) => z.id);

// Deterministic default class start zone from a character seed (mirrors
// factions.js starterFactionForSeed). Pure, no rng — a same-seed sigma always
// anchors to the same class. Players can re-pick later (the UI sets passiveStart).
export function starterClassForSeed(seed) {
  const s = seed >>> 0 || 1;
  return CLASS_START_IDS[s % CLASS_START_IDS.length];
}

// Build the adjacency-symmetric node list. Each class arm is:
//   <class>_start → <class>_a → <class>_b → <class>_c (then into a gateway)
// Gateways ring the shared interior; the interior holds the 5 keystones plus
// connective travel/attribute nodes so every arm can reach every keystone.
//
// adjacency is declared once per edge here and made symmetric programmatically
// at the bottom (neighborsOf is bidirectional).
const RAW_NODES = [
  // ── WARRIOR arm (STR) ──
  n(
    "warrior_start",
    "Warrior",
    "attribute",
    { hpMul: 1.05, atkMul: 1.02 },
    ["warrior_a"],
    "warrior",
  ),
  n(
    "warrior_a",
    "Brute Force",
    "offense",
    { atkMul: 1.06 },
    ["warrior_b", "warrior_side"],
    "warrior",
  ),
  n(
    "warrior_b",
    "Bloodied Edge",
    "offense",
    { atkMul: 1.08, critAdd: 0.02 },
    ["warrior_c"],
    "warrior",
  ),
  n("warrior_c", "Onslaught", "offense", { atkMul: 1.1 }, ["gw_north"], "warrior"),
  n("warrior_side", "Thick Hide", "defense", { hpMul: 1.06, defMul: 1.05 }, ["gw_nw"], "warrior"),

  // ── RANGER arm (DEX) ──
  n(
    "ranger_start",
    "Ranger",
    "attribute",
    { speedMul: 1.03, critAdd: 0.01 },
    ["ranger_a"],
    "ranger",
  ),
  n("ranger_a", "Keen Eye", "offense", { critAdd: 0.03 }, ["ranger_b", "ranger_side"], "ranger"),
  n(
    "ranger_b",
    "Fleet Foot",
    "utility",
    { speedMul: 1.06, dodgeAdd: 0.02 },
    ["ranger_c"],
    "ranger",
  ),
  n("ranger_c", "Marksmanship", "offense", { critAdd: 0.04, atkMul: 1.04 }, ["gw_ne"], "ranger"),
  n("ranger_side", "Evasive Roll", "defense", { dodgeAdd: 0.04 }, ["gw_north"], "ranger"),

  // ── MAGE arm (INT) ──
  n("mage_start", "Mage", "attribute", { spiritAdd: 8, critMultAdd: 0.04 }, ["mage_a"], "mage"),
  n("mage_a", "Arcane Mind", "utility", { spiritAdd: 12 }, ["mage_b", "mage_side"], "mage"),
  n("mage_b", "Overflow", "offense", { atkMul: 1.06, critMultAdd: 0.06 }, ["mage_c"], "mage"),
  n("mage_c", "Channeller", "offense", { atkMul: 1.08, spiritAdd: 10 }, ["gw_east"], "mage"),
  n("mage_side", "Mana Ward", "defense", { defMul: 1.08 }, ["gw_ne"], "mage"),

  // ── MONK arm (DEX/INT) ──
  n("monk_start", "Monk", "attribute", { speedMul: 1.03, spiritAdd: 6 }, ["monk_a"], "monk"),
  n(
    "monk_a",
    "Flowing Form",
    "utility",
    { speedMul: 1.05, dodgeAdd: 0.02 },
    ["monk_b", "monk_side"],
    "monk",
  ),
  n("monk_b", "Inner Fire", "offense", { atkMul: 1.06, critAdd: 0.02 }, ["monk_c"], "monk"),
  n("monk_c", "Harmony", "defense", { hpMul: 1.06, spiritAdd: 8 }, ["gw_se"], "monk"),
  n(
    "monk_side",
    "Pressure Points",
    "offense",
    { critAdd: 0.03, critMultAdd: 0.05 },
    ["gw_east"],
    "monk",
  ),

  // ── TEMPLAR arm (STR/INT) ──
  n(
    "templar_start",
    "Templar",
    "attribute",
    { hpMul: 1.04, spiritAdd: 6 },
    ["templar_a"],
    "templar",
  ),
  n(
    "templar_a",
    "Zeal",
    "offense",
    { atkMul: 1.05, defMul: 1.03 },
    ["templar_b", "templar_side"],
    "templar",
  ),
  n("templar_b", "Consecrate", "defense", { defMul: 1.08, hpMul: 1.04 }, ["templar_c"], "templar"),
  n("templar_c", "Sanctified", "utility", { defMul: 1.06, spiritAdd: 8 }, ["gw_south"], "templar"),
  n("templar_side", "Smite", "offense", { atkMul: 1.07, critAdd: 0.02 }, ["gw_se"], "templar"),

  // ── ROGUE arm (DEX) ──
  n("rogue_start", "Rogue", "attribute", { critAdd: 0.02, speedMul: 1.02 }, ["rogue_a"], "rogue"),
  n(
    "rogue_a",
    "Backstab",
    "offense",
    { critAdd: 0.03, critMultAdd: 0.08 },
    ["rogue_b", "rogue_side"],
    "rogue",
  ),
  n(
    "rogue_b",
    "Shadow Cloak",
    "defense",
    { dodgeAdd: 0.04, dangerMul: 0.96 },
    ["rogue_c"],
    "rogue",
  ),
  n("rogue_c", "Lethality", "offense", { critAdd: 0.04, atkMul: 1.04 }, ["gw_sw"], "rogue"),
  n(
    "rogue_side",
    "Pickpocket",
    "utility",
    { lootQtyAdd: 0.08, lootRarityAdd: 0.3 },
    ["gw_south"],
    "rogue",
  ),

  // ── DUELIST arm (STR/DEX) ──
  n(
    "duelist_start",
    "Duelist",
    "attribute",
    { atkMul: 1.03, speedMul: 1.02 },
    ["duelist_a"],
    "duelist",
  ),
  n(
    "duelist_a",
    "Riposte",
    "offense",
    { atkMul: 1.06, dodgeAdd: 0.02 },
    ["duelist_b", "duelist_side"],
    "duelist",
  ),
  n(
    "duelist_b",
    "Footwork",
    "utility",
    { speedMul: 1.06, dodgeAdd: 0.03 },
    ["duelist_c"],
    "duelist",
  ),
  n(
    "duelist_c",
    "Precision Strikes",
    "offense",
    { critAdd: 0.04, atkMul: 1.04 },
    ["gw_west"],
    "duelist",
  ),
  n("duelist_side", "Iron Stance", "defense", { hpMul: 1.06, defMul: 1.04 }, ["gw_sw"], "duelist"),

  // ── WARDEN arm (VIT/STR) ──
  n("warden_start", "Warden", "attribute", { hpMul: 1.06 }, ["warden_a"], "warden"),
  n(
    "warden_a",
    "Endurance",
    "defense",
    { hpMul: 1.08, defMul: 1.04 },
    ["warden_b", "warden_side"],
    "warden",
  ),
  n("warden_b", "Survivalist", "utility", { dangerMul: 0.93, hpMul: 1.04 }, ["warden_c"], "warden"),
  n("warden_c", "Bulwark", "defense", { defMul: 1.1, hpMul: 1.04 }, ["gw_nw"], "warden"),
  n("warden_side", "Bloodlust", "offense", { atkMul: 1.07 }, ["gw_west"], "warden"),

  // ── Gateways (the 8 entrances to the shared interior ring) ──
  n("gw_north", "North Gate", "attribute", { hpMul: 1.03, atkMul: 1.03 }, [
    "ring_n",
    "ring_nw",
    "ring_ne",
  ]),
  n("gw_ne", "Northeast Gate", "attribute", { critAdd: 0.02, speedMul: 1.02 }, [
    "ring_ne",
    "ring_n",
    "ring_e",
  ]),
  n("gw_east", "East Gate", "attribute", { spiritAdd: 8, critMultAdd: 0.04 }, [
    "ring_e",
    "ring_ne",
    "ring_se",
  ]),
  n("gw_se", "Southeast Gate", "attribute", { atkMul: 1.03, spiritAdd: 6 }, [
    "ring_se",
    "ring_e",
    "ring_s",
  ]),
  n("gw_south", "South Gate", "attribute", { defMul: 1.04, hpMul: 1.02 }, [
    "ring_s",
    "ring_se",
    "ring_sw",
  ]),
  n("gw_sw", "Southwest Gate", "attribute", { critAdd: 0.02, dodgeAdd: 0.02 }, [
    "ring_sw",
    "ring_s",
    "ring_w",
  ]),
  n("gw_west", "West Gate", "attribute", { atkMul: 1.03, speedMul: 1.02 }, [
    "ring_w",
    "ring_sw",
    "ring_nw",
  ]),
  n("gw_nw", "Northwest Gate", "attribute", { hpMul: 1.04, defMul: 1.03 }, [
    "ring_nw",
    "ring_w",
    "ring_n",
  ]),

  // ── Interior ring (connective travel + notable mid nodes) ──
  // The ring is a full cycle so any gateway can reach any keystone; each ring
  // node also reaches inward to a keystone hub.
  n("ring_n", "Vault of War", "offense", { atkMul: 1.05 }, ["ring_ne", "ring_nw", "hub_glass"]),
  n("ring_ne", "Vault of Precision", "offense", { critAdd: 0.03 }, [
    "ring_e",
    "hub_glass",
    "hub_iron",
  ]),
  n("ring_e", "Vault of the Mind", "utility", { spiritAdd: 10 }, [
    "ring_se",
    "hub_avatar",
    "hub_iron",
  ]),
  n("ring_se", "Vault of Flame", "offense", { atkMul: 1.05, critMultAdd: 0.05 }, [
    "ring_s",
    "hub_avatar",
  ]),
  n("ring_s", "Vault of the Pact", "defense", { hpMul: 1.05 }, [
    "ring_sw",
    "hub_blood",
    "hub_necro",
  ]),
  n("ring_sw", "Vault of Shadows", "utility", { dodgeAdd: 0.03, dangerMul: 0.96 }, [
    "ring_w",
    "hub_necro",
  ]),
  n("ring_w", "Vault of Iron", "defense", { defMul: 1.06 }, ["ring_nw", "hub_iron", "hub_blood"]),
  n("ring_nw", "Vault of Stone", "defense", { hpMul: 1.04, defMul: 1.04 }, ["ring_n", "hub_iron"]),

  // ── Keystone hubs (gate nodes adjacent to each keystone) + the keystones ──
  // Glass Cannon hub.
  n("hub_glass", "Reckless Approach", "offense", { atkMul: 1.06, critAdd: 0.02 }, [
    "ks_glass_cannon",
    "hub_iron",
  ]),
  k(
    "ks_glass_cannon",
    "Glass Cannon",
    // Reuses the `glass` legendary semantics (atk up hard, max life down hard).
    { atkMul: 2.0, hpMul: 0.5 },
    "glass",
    "+100% attack, -50% maximum HP. The damage is real; so is your funeral.",
    ["hub_glass"],
  ),

  // Avatar of Fire hub (ties to Inc-2 ailments — flag inert for now).
  n("hub_avatar", "Burning Path", "offense", { atkMul: 1.05, critMultAdd: 0.06 }, [
    "ks_avatar_of_fire",
    "ring_se",
  ]),
  k(
    "ks_avatar_of_fire",
    "Avatar of Fire",
    { atkMul: 1.25, critMultAdd: 0.15 },
    "avatar_of_fire",
    "+25% attack, +15% crit damage; all damage burns. Your hits convert to fire.",
    ["hub_avatar"],
  ),

  // Necromantic Bond hub (ties to Inc-7 summon reservations — flag inert).
  n("hub_necro", "Grave Pact", "utility", { hpMul: 1.04, spiritAdd: 12 }, [
    "ks_necromantic_bond",
    "ring_sw",
  ]),
  k(
    "ks_necromantic_bond",
    "Necromantic Bond",
    // Minions hit harder (modelled as flat spirit so minion reservations buff
    // more), your own swings hit softer.
    { atkMul: 0.7, spiritAdd: 40, hpMul: 1.1 },
    "necromantic_bond",
    "-30% your attack, +40 spirit, +10% HP. The dead fight for you; you do not.",
    ["hub_necro"],
  ),

  // Blood Magic hub (HP-cost tradeoff — spirit collapses into HP economy).
  k(
    "ks_blood_magic",
    "Blood Magic",
    // Spirit pool removed (modelled as a large negative spiritAdd, floored at 0
    // by derive), HP boosted to pay for it.
    { spiritAdd: -9999, hpMul: 1.35 },
    "blood_magic",
    "Spirit pool removed; +35% maximum HP. Reservations cost life, not spirit.",
    ["hub_blood"],
  ),
  n("hub_blood", "Sanguine Path", "defense", { hpMul: 1.08 }, [
    "ks_blood_magic",
    "ring_s",
    "ring_w",
  ]),

  // Iron Reflexes hub (dodge → defense conversion tradeoff).
  k(
    "ks_iron_reflexes",
    "Iron Reflexes",
    // Big defense, but evasion is sacrificed (large negative dodge, floored at
    // 0 by derive's dodge clamp).
    { defMul: 1.4, dodgeAdd: -1 },
    "iron_reflexes",
    "+40% defense; dodge chance removed. You do not dodge — you endure.",
    ["hub_iron"],
  ),
  n("hub_iron", "Unyielding", "defense", { defMul: 1.08, hpMul: 1.03 }, [
    "ks_iron_reflexes",
    "ring_nw",
    "ring_ne",
    "ring_w",
  ]),

  // ── Secondary arm tiers (extend each class arm with a small cluster so the
  // tree reaches the ~100-node prototype scale; each hangs off its arm's
  // mid/side node and stays inside its class zone). Small generic mods. ──
  // Warrior cluster.
  n(
    "warrior_d",
    "Crushing Blows",
    "offense",
    { atkMul: 1.06, critMultAdd: 0.05 },
    ["warrior_b"],
    "warrior",
  ),
  n(
    "warrior_e",
    "War Banner",
    "utility",
    { atkMul: 1.03, hpMul: 1.03 },
    ["warrior_side"],
    "warrior",
  ),
  n("warrior_f", "Battle Hardened", "defense", { hpMul: 1.06 }, ["warrior_side"], "warrior"),
  // Ranger cluster.
  n("ranger_d", "Far Shot", "offense", { atkMul: 1.05, critAdd: 0.02 }, ["ranger_a"], "ranger"),
  n(
    "ranger_e",
    "Camouflage",
    "utility",
    { dangerMul: 0.94, dodgeAdd: 0.02 },
    ["ranger_side"],
    "ranger",
  ),
  n("ranger_f", "Steady Aim", "offense", { critMultAdd: 0.06 }, ["ranger_b"], "ranger"),
  // Mage cluster.
  n("mage_d", "Deep Reserves", "utility", { spiritAdd: 14 }, ["mage_a"], "mage"),
  n("mage_e", "Spell Surge", "offense", { atkMul: 1.06 }, ["mage_b"], "mage"),
  n("mage_f", "Arcane Shield", "defense", { defMul: 1.06, spiritAdd: 6 }, ["mage_side"], "mage"),
  // Monk cluster.
  n("monk_d", "Iron Body", "defense", { hpMul: 1.06, defMul: 1.04 }, ["monk_a"], "monk"),
  n("monk_e", "Swift Palm", "offense", { speedMul: 1.04, atkMul: 1.03 }, ["monk_b"], "monk"),
  n("monk_f", "Meditation", "utility", { spiritAdd: 12 }, ["monk_side"], "monk"),
  // Templar cluster.
  n(
    "templar_d",
    "Faith's Reward",
    "utility",
    { spiritAdd: 10, hpMul: 1.03 },
    ["templar_a"],
    "templar",
  ),
  n(
    "templar_e",
    "Holy Fire",
    "offense",
    { atkMul: 1.06, critMultAdd: 0.05 },
    ["templar_side"],
    "templar",
  ),
  n("templar_f", "Aegis", "defense", { defMul: 1.08 }, ["templar_b"], "templar"),
  // Rogue cluster.
  n("rogue_d", "Vital Strike", "offense", { critMultAdd: 0.1 }, ["rogue_a"], "rogue"),
  n("rogue_e", "Smoke Bomb", "defense", { dodgeAdd: 0.03, dangerMul: 0.95 }, ["rogue_b"], "rogue"),
  n(
    "rogue_f",
    "Cutpurse",
    "utility",
    { lootRarityAdd: 0.4, lootQtyAdd: 0.06 },
    ["rogue_side"],
    "rogue",
  ),
  // Duelist cluster.
  n("duelist_d", "Counterstroke", "offense", { atkMul: 1.06 }, ["duelist_a"], "duelist"),
  n("duelist_e", "En Garde", "defense", { dodgeAdd: 0.03, defMul: 1.03 }, ["duelist_b"], "duelist"),
  n(
    "duelist_f",
    "Flèche",
    "offense",
    { speedMul: 1.05, critAdd: 0.02 },
    ["duelist_side"],
    "duelist",
  ),
  // Warden cluster.
  n("warden_d", "Stone Skin", "defense", { defMul: 1.08 }, ["warden_a"], "warden"),
  n("warden_e", "Pathfinder", "utility", { dangerMul: 0.9 }, ["warden_b"], "warden"),
  n(
    "warden_f",
    "Wild Strength",
    "offense",
    { atkMul: 1.06, hpMul: 1.03 },
    ["warden_side"],
    "warden",
  ),

  // ── Interior attribute clusters (small notable nodes hung off the ring to
  // thicken the shared interior and lift the count to the prototype scale).
  n("inner_might", "Inner Might", "attribute", { atkMul: 1.04, hpMul: 1.02 }, [
    "ring_n",
    "ring_ne",
  ]),
  n("inner_focus", "Inner Focus", "attribute", { critAdd: 0.02, spiritAdd: 6 }, [
    "ring_ne",
    "ring_e",
  ]),
  n("inner_clarity", "Inner Clarity", "attribute", { spiritAdd: 10 }, ["ring_e", "ring_se"]),
  n("inner_ember", "Inner Ember", "attribute", { atkMul: 1.03, critMultAdd: 0.04 }, [
    "ring_se",
    "ring_s",
  ]),
  n("inner_resolve", "Inner Resolve", "attribute", { hpMul: 1.04, defMul: 1.02 }, [
    "ring_s",
    "ring_sw",
  ]),
  n("inner_shadow", "Inner Shadow", "attribute", { dodgeAdd: 0.02, dangerMul: 0.97 }, [
    "ring_sw",
    "ring_w",
  ]),
  n("inner_iron", "Inner Iron", "attribute", { defMul: 1.05 }, ["ring_w", "ring_nw"]),
  n("inner_stone", "Inner Stone", "attribute", { hpMul: 1.03, defMul: 1.03 }, [
    "ring_nw",
    "ring_n",
  ]),
  n("core_vitality", "Core: Vitality", "attribute", { hpMul: 1.05 }, ["hub_iron", "hub_blood"]),
  n("core_power", "Core: Power", "attribute", { atkMul: 1.05 }, ["hub_glass", "ring_n"]),
  n("core_essence", "Core: Essence", "attribute", { spiritAdd: 14 }, ["hub_necro", "ring_e"]),
];

// ── Index + symmetric adjacency ────────────────────────────────────────────
const NODE_INDEX = (() => {
  const idx = {};
  for (const node of RAW_NODES) idx[node.id] = node;
  // Make adjacency symmetric: if A lists B, ensure B lists A. Declared edges
  // above are one-directional for brevity; the graph is undirected.
  for (const node of RAW_NODES) {
    for (const nb of node.adj) {
      const other = idx[nb];
      if (other && !other.adj.includes(node.id)) other.adj.push(node.id);
    }
  }
  // Freeze each node + its adjacency so the static tree can't be mutated by a
  // caller (the graph is shared data).
  for (const node of RAW_NODES) {
    node.adj = Object.freeze(node.adj.slice());
    Object.freeze(node.mods);
    Object.freeze(node);
  }
  return Object.freeze(idx);
})();

export const PASSIVE_NODES = RAW_NODES;
export const PASSIVE_NODE_IDS = Object.freeze(RAW_NODES.map((nd) => nd.id));
export const PASSIVE_NODE_COUNT = RAW_NODES.length;

// Keystone metadata, for the UI + validate.
export const KEYSTONE_IDS = Object.freeze(RAW_NODES.filter((nd) => nd.keystone).map((nd) => nd.id));

// Entry-node id for a class start zone (the BFS anchor). Falls back to the
// first class's entry for an unknown zone so callers never get null.
export function entryNodeFor(startZone) {
  const z = CLASS_START_ZONES.find((cz) => cz.id === startZone);
  return z ? z.entry : CLASS_START_ZONES[0].entry;
}

// ── Pure lookups ───────────────────────────────────────────────────────────
export function nodeById(id) {
  return NODE_INDEX[id] || null;
}

export function neighborsOf(id) {
  const node = NODE_INDEX[id];
  return node ? node.adj : [];
}

// ── Aggregation ────────────────────────────────────────────────────────────
// Aggregate the combat-sheet mods of every ALLOCATED node. Returns EXACT
// identity (×1 / +0) when `allocatedIds` is empty/null, so derive() output is
// byte-identical for un-allocated characters. Pure — no rng.
export function passiveMods(allocatedIds) {
  if (!Array.isArray(allocatedIds) || allocatedIds.length === 0) return PASSIVE_IDENTITY;
  const out = zeroMods();
  let any = false;
  const seen = new Set();
  for (const id of allocatedIds) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const node = NODE_INDEX[id];
    if (!node) continue;
    seen.add(id);
    any = true;
    const m = node.mods;
    for (const key of MUL_KEYS) if (m[key]) out[key] *= m[key];
    for (const key of ADD_KEYS) if (m[key]) out[key] += m[key];
  }
  return any ? out : PASSIVE_IDENTITY;
}

// Behavioural keystone flags active for an allocation (combat.js may read
// these later; inert for now). Empty object when no keystone allocated.
export function passiveFlags(allocatedIds) {
  const flags = {};
  if (!Array.isArray(allocatedIds)) return flags;
  for (const id of allocatedIds) {
    const node = NODE_INDEX[id];
    if (node?.flag) flags[node.flag] = true;
  }
  return flags;
}

// ── Connectivity ───────────────────────────────────────────────────────────
// Every allocated node must chain back to the class start zone's entry node
// through OTHER allocated nodes (PoE rule: no orphan/floating allocations).
// Returns true for an empty allocation (nothing to connect). Pure BFS over the
// static graph restricted to the allocated set.
export function isAllocationConnected(allocatedIds, startZone) {
  if (!Array.isArray(allocatedIds) || allocatedIds.length === 0) return true;
  const entry = entryNodeFor(startZone);
  // The allocation must include the entry (you start at your class node) for
  // anything else to legally connect. If the entry isn't allocated, the only
  // valid allocation is the empty one (handled above) — so this is false.
  const allocSet = new Set(allocatedIds.filter((id) => NODE_INDEX[id]));
  if (!allocSet.has(entry)) return false;
  // BFS from entry through allocated nodes only.
  const reached = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of NODE_INDEX[cur].adj) {
      if (allocSet.has(nb) && !reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }
  // Connected iff every allocated (known) node was reached from the entry.
  return reached.size === allocSet.size;
}

// Greedily drop the allocated nodes that DON'T chain back to the entry, keeping
// the connected component that contains the entry. Used by the trust boundary
// to coerce (rather than reject) a partly-disconnected allocation. Order of the
// returned list preserves the input order for the kept ids. Pure.
export function pruneToConnected(allocatedIds, startZone) {
  if (!Array.isArray(allocatedIds) || allocatedIds.length === 0) return [];
  const entry = entryNodeFor(startZone);
  const allocSet = new Set(allocatedIds.filter((id) => NODE_INDEX[id]));
  // Without the entry node allocated, nothing can legally connect → drop all.
  if (!allocSet.has(entry)) return [];
  const reached = new Set([entry]);
  const queue = [entry];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of NODE_INDEX[cur].adj) {
      if (allocSet.has(nb) && !reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }
  // Keep input order, dedupe, only reachable known ids.
  const seen = new Set();
  const out = [];
  for (const id of allocatedIds) {
    if (reached.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ── Points budget ──────────────────────────────────────────────────────────
// Available passive points are an ACCOUNT-side build-identity quantity (like
// reserved / skillTalents) — they DON'T cross the permadeath line. Source:
// the account's highestLevel (1 point per level ever reached) + a prestige
// trickle (1 point per 10 prestige). A fresh level-1 sigma gets exactly 1
// point (enough to allocate its class start node). Pure integer formula.
export const PASSIVE_POINTS_PER_LEVEL = 1;
export const PASSIVE_POINTS_PER_PRESTIGE = 0.1; // 1 point / 10 prestige

export function passivePointsFor(character) {
  if (!character || typeof character !== "object") return 1;
  const highest = Math.max(1, Math.floor(character.highestLevel || 1));
  const prestige = Math.max(0, Math.floor(character.prestige || 0));
  return Math.max(
    1,
    Math.floor(highest * PASSIVE_POINTS_PER_LEVEL + prestige * PASSIVE_POINTS_PER_PRESTIGE),
  );
}

// The static tree payload for the VCS graph UI (GET /api/passive-tree). Nodes
// carry their symmetric adjacency + mods; zones carry their entry anchors.
export function passiveTreePayload() {
  return {
    nodeCount: PASSIVE_NODE_COUNT,
    zones: CLASS_START_ZONES.map((z) => ({ ...z })),
    keystones: KEYSTONE_IDS.map((id) => {
      const nd = NODE_INDEX[id];
      return { id: nd.id, name: nd.name, mods: nd.mods, flag: nd.flag, desc: nd.desc };
    }),
    nodes: RAW_NODES.map((nd) => ({
      id: nd.id,
      name: nd.name,
      kind: nd.kind,
      mods: nd.mods,
      adj: nd.adj,
      zone: nd.zone || null,
      keystone: !!nd.keystone,
      ...(nd.flag ? { flag: nd.flag } : {}),
      ...(nd.desc ? { desc: nd.desc } : {}),
    })),
  };
}
