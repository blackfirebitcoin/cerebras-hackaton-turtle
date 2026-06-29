// SIGMA ABYSS — strict input validation. The server's trust boundary.
//
// Nothing from the wire is trusted. Validators COERCE + BOUND where it is
// safe to (clamp numbers into range, truncate strings, drop bad array
// items) and REJECT only when input can't be made sane (wrong type,
// unknown enum, non-JSON). A rejection throws ValidationError, which
// realtime.js catches per-message — one bad frame is dropped with an
// {t:'error'} reply, never a crash.

import { ACHIEVEMENT_IDS } from "../shared/achievements.js";
import { ADULTHOODS, CHILDHOODS } from "../shared/backstory.js";
import {
  AI_BOUNDS,
  AI_DEFAULTS,
  AI_TARGET_PRIORITY,
  BUILD_SETS,
  DEPTH_MAX,
  FEED_KINDS,
  GEAR_SLOTS,
  INVENTORY_MAX,
  LEVEL_MAX,
  NAME_MAX,
  POSTURES,
  POTION_MAX,
  RARITIES,
  SCHEMA_VERSION,
  SPIRIT_BASE,
  SPIRIT_PER_INT,
  START_STATS,
  STAT_KEYS,
  STAT_MAX,
  STAT_MIN,
} from "../shared/constants.js";
import { REAGENT_CODES } from "../shared/crafting.js";
import { DISEASE_IDS } from "../shared/diseases.js";
import { FACTION_IDS, FACTION_MAX_REP } from "../shared/factions.js";
import { SIGMACRAFT_INTENT_KINDS } from "../shared/sigmacraft.js";
import { BODY_PART_IDS } from "../shared/health.js";
import { INSPIRATION_IDS } from "../shared/inspirations.js";
import { SET_IDS } from "../shared/item-sets.js";
import { LORE_FLAVOR_MAX, VAULT_MAX_CAPACITY } from "../shared/market.js";
import { BREAK_IDS } from "../shared/mental-breaks.js";
import { NPC_IDS } from "../shared/npc-defs.js";
import {
  CLASS_START_IDS,
  PASSIVE_NODE_COUNT,
  passivePointsFor,
  pruneToConnected,
} from "../shared/passive-tree.js";
import { QUEST_MAX_ACTIVE, QUEST_TEMPLATE_IDS } from "../shared/quests.js";
import { TALENT_IDS } from "../shared/skill-talents.js";
import {
  RESERVABLE_SKILL_IDS,
  RESERVABLE_SKILLS,
  SKILL_IDS,
  SKILL_LEVEL_MAX,
} from "../shared/skills.js";
import { STORYTELLER_IDS } from "../shared/storyteller.js";
import { TRAIT_IDS } from "../shared/traits.js";
import { VS_TUNABLES, WEAPON_IDS } from "../shared/vampire-survivors.js";
import { FAMILY_IDS, WEAPON_PLUS_MAX } from "../shared/weapons.js";
import { ZONE_IDS } from "../shared/zones.js";

const CHILDHOOD_IDS = CHILDHOODS.map((c) => c.id);
const ADULTHOOD_IDS = ADULTHOODS.map((a) => a.id);
const WOUND_SEVERITIES = ["light", "serious", "scar", "lost"];

export class ValidationError extends Error {}
const fail = (m) => {
  throw new ValidationError(m);
};

// Code points scrubbed from untrusted strings: C0 controls, DEL, the
// zero-width + bidi marks, and the U+2028/U+2029 line separators. Built
// from numbers so this source file stays pure ASCII (U+2028/U+2029 are
// JS source line terminators — they must never appear literally here).
const STRIP_SET = (() => {
  const s = new Set();
  for (let i = 0x00; i <= 0x1f; i += 1) s.add(i);
  s.add(0x7f);
  for (let i = 0x200b; i <= 0x200f; i += 1) s.add(i);
  s.add(0x2028);
  s.add(0x2029);
  return s;
})();

function scrub(str) {
  let out = "";
  for (const ch of str) {
    if (!STRIP_SET.has(ch.codePointAt(0))) out += ch;
  }
  return out;
}

// ── Primitives ────────────────────────────────────────────────────────
export function vInt(x, min, max, dflt) {
  if (x === undefined || x === null || x === "") {
    if (dflt !== undefined) return dflt;
    fail("missing int");
  }
  const n = Math.trunc(Number(x));
  if (!Number.isFinite(n)) {
    if (dflt !== undefined) return dflt;
    fail("not a finite int");
  }
  return Math.min(max, Math.max(min, n));
}

export function vNum(x, min, max, dflt) {
  if (x === undefined || x === null || x === "") {
    if (dflt !== undefined) return dflt;
    fail("missing number");
  }
  const n = Number(x);
  if (!Number.isFinite(n)) {
    if (dflt !== undefined) return dflt;
    fail("not a finite number");
  }
  return Math.min(max, Math.max(min, n));
}

export function vStr(x, maxLen, dflt) {
  if (x === undefined || x === null) {
    if (dflt !== undefined) return dflt;
    fail("missing string");
  }
  if (typeof x !== "string") {
    if (dflt !== undefined) return dflt;
    fail("not a string");
  }
  // Strip control + zero-width + line-separator chars, then hard-cap length.
  return scrub(x).slice(0, maxLen);
}

export function vBool(x, dflt = false) {
  if (x === undefined || x === null) return dflt;
  return !!x;
}

export function vEnum(x, allowed, dflt) {
  if ((x === undefined || x === null) && dflt !== undefined) return dflt;
  if (!allowed.includes(x)) {
    if (dflt !== undefined) return dflt;
    fail(`bad enum value: ${String(x).slice(0, 24)}`);
  }
  return x;
}

// Drops items that fail their validator rather than rejecting the array.
export function vArr(x, itemFn, maxLen) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) fail("not an array");
  const out = [];
  for (const item of x.slice(0, maxLen)) {
    try {
      out.push(itemFn(item));
    } catch {
      /* drop the bad item */
    }
  }
  return out;
}

function asObj(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail("expected object");
  return x;
}

const TOKEN_RE = /^sig_[a-f0-9]{24}$/;
export function vToken(x) {
  if (typeof x !== "string" || !TOKEN_RE.test(x)) fail("bad token");
  return x;
}

// Sigmacraft bounded intent (integrate-this trust boundary). Rejects unknown
// kinds and, for `move`, unknown zone targets — shape only; the route applies
// the contextual unlock gate with the player's character. `nonce` is bounded and
// optional (used for idempotent de-dup).
export function vSigmacraftIntent(x) {
  const o = asObj(x);
  const kind = vEnum(o.kind, SIGMACRAFT_INTENT_KINDS); // throws on bad kind
  const nonce = vStr(o.nonce, 64, "");
  if (kind === "move") {
    return { kind, nonce, targetId: vEnum(o.targetId, ZONE_IDS) }; // throws on unknown zone
  }
  return { kind, nonce };
}

// ── Game shapes ───────────────────────────────────────────────────────
function vAffix(a) {
  const o = asObj(a);
  return {
    stat: vStr(o.stat, 16, ""),
    value: vNum(o.value, -1e6, 1e6, 0),
    kind: vStr(o.kind, 12, ""),
    pct: vBool(o.pct, false),
  };
}

function vItem(it) {
  const o = asObj(it);
  const slot = vEnum(o.slot, GEAR_SLOTS, "charm");
  const out = {
    id: vStr(o.id, 48, ""),
    slot,
    base: vStr(o.base, 24, ""),
    name: vStr(o.name, 60, "Relic"),
    rarity: vEnum(o.rarity, RARITIES, "common"),
    ilvl: vInt(o.ilvl, 1, 99999, 1),
    affixes: vArr(o.affixes, vAffix, 8),
    effect: o.effect == null ? null : vStr(o.effect, 24, null),
    power: vInt(o.power, 0, 1e7, 0),
    value: vInt(o.value, 0, 1e7, 0),
    flavor: o.flavor == null ? null : vStr(o.flavor, 120, null),
    raidDrop: o.raidDrop == null ? null : vStr(o.raidDrop, 24, null),
  };
  if (slot === "weapon") {
    out.family = vEnum(o.family, FAMILY_IDS, "sword");
    out.plus = vInt(o.plus, 0, WEAPON_PLUS_MAX, 0);
  }
  if (o.starter) out.starter = true;
  // Economy item additions (master §2.2). rerolls is the "Forged" counter;
  // loreStamp is optional provenance that travels with the item forever.
  out.rerolls = vInt(o.rerolls, 0, 1e6, 0);
  const stamp = vLoreStamp(o.loreStamp);
  if (stamp) out.loreStamp = stamp;
  // Binding + set membership (master §3.6). bound governs tradeability;
  // setId ties the item to a faction set for the derive() set-bonus stack.
  out.bound = vEnum(o.bound, ["unbound", "account", "faction"], "unbound");
  out.setId = o.setId == null ? null : vEnum(o.setId, SET_IDS, null);
  if (o.crafted) out.crafted = true;
  return out;
}

function vLoreStamp(s) {
  if (s == null || typeof s !== "object" || Array.isArray(s)) return null;
  return {
    seller: vStr(s.seller, 32, ""),
    title: vStr(s.title, 32, ""),
    rerolls: vInt(s.rerolls, 0, 1e6, 0),
    depthZone: vStr(s.depthZone, 24, ""),
    flavor: vStr(s.flavor, LORE_FLAVOR_MAX, ""),
    stampedAt: vInt(s.stampedAt, 0, 1e15, 0),
  };
}

function vEconomyStats(s) {
  const o = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  return {
    totalSold: vInt(o.totalSold, 0, 1e12, 0),
    totalBought: vInt(o.totalBought, 0, 1e12, 0),
    totalListingFees: vInt(o.totalListingFees, 0, 1e12, 0),
    totalTaxPaid: vInt(o.totalTaxPaid, 0, 1e12, 0),
    totalSalvaged: vInt(o.totalSalvaged, 0, 1e12, 0),
  };
}

// Crafting/talents/scars validators (master §3.3/§3.5/§3.7).
function vScar(s) {
  const o = asObj(s);
  return {
    stat: vEnum(o.stat, STAT_KEYS, STAT_KEYS[0]),
    amount: vInt(o.amount, -10, 0, -2),
    gainedAt: vInt(o.gainedAt, 0, 1e15, 0),
  };
}

function vSkillTalents(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const id of SKILL_IDS) {
    const arr = Array.isArray(o[id]) ? o[id] : null;
    if (!arr) continue;
    out[id] = [0, 1, 2].map((i) => (TALENT_IDS.includes(arr[i]) ? arr[i] : null));
  }
  return out;
}

function vReagents(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const code of REAGENT_CODES) {
    if (o[code] === undefined || o[code] === null) continue;
    out[code] = vInt(o[code], 0, 1e7, 0);
  }
  return out;
}

// Quests (master §M5). Unknown template ids / objective shapes are coerced.
function vObjective(x) {
  const o = asObj(x);
  return {
    kind: vStr(o.kind, 24, ""),
    target: vInt(o.target, 0, 1e9, 1),
    progress: vInt(o.progress, 0, 1e12, 0),
  };
}
function vQuest(x) {
  const o = asObj(x);
  return {
    templateId: vEnum(o.templateId, QUEST_TEMPLATE_IDS, QUEST_TEMPLATE_IDS[0]),
    name: vStr(o.name, 48, ""),
    objectives: vArr(o.objectives, vObjective, 6),
    status: vEnum(o.status, ["active", "completed", "failed"], "active"),
    startedAt: vInt(o.startedAt, 0, 1e15, 0),
  };
}

// Retention validators (master §M7).
function vReward(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  if (o.gold != null) out.gold = vInt(o.gold, 0, 1e9, 0);
  if (o.shards != null) out.shards = vInt(o.shards, 0, 1e6, 0);
  if (o.prestige != null) out.prestige = vInt(o.prestige, 0, 1e6, 0);
  if (o.questXp != null) out.questXp = vInt(o.questXp, 0, 1e6, 0);
  if (o.title != null) out.title = vStr(o.title, 32, "");
  return out;
}
function vObjectiveInstance(x) {
  const o = asObj(x);
  return {
    id: vStr(o.id, 32, ""),
    kind: vStr(o.kind, 24, ""),
    target: vInt(o.target, 0, 1e9, 1),
    progress: vInt(o.progress, 0, 1e12, 0),
    label: vStr(o.label, 64, ""),
    reward: vReward(o.reward),
    claimed: vBool(o.claimed, false),
    dayIndex: vInt(o.dayIndex, 0, 1e9, 0),
    weekIndex: vInt(o.weekIndex, 0, 1e9, 0),
  };
}
function vAchievements(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const earned = vArr(
    o.earned,
    (id) => vEnum(id, ACHIEVEMENT_IDS, null),
    ACHIEVEMENT_IDS.length,
  ).filter(Boolean);
  return { earned: [...new Set(earned)], score: vInt(o.score, 0, 1e7, 0) };
}
function vCountMap(x, cap) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (n >= cap) break;
    const key = vStr(k, 32, "");
    if (!key) continue;
    out[key] = vInt(o[k], 0, 1e12, 0);
    n += 1;
  }
  return out;
}
function vBestiary(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  return { kills: vCountMap(o.kills, 200), firstKilledAt: vCountMap(o.firstKilledAt, 200) };
}
function vMuseumEntry(x) {
  const o = asObj(x);
  return {
    name: vStr(o.name, 60, "Relic"),
    rarity: vEnum(o.rarity, RARITIES, "common"),
    power: vInt(o.power, 0, 1e7, 0),
    at: vInt(o.at, 0, 1e15, 0),
  };
}
function vSeason(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  return { points: vInt(o.points, 0, 1e9, 0), tier: vInt(o.tier, 0, 1000, 0) };
}

// NPC relationships (master §M6): a map of known-NPC standings. Only known npc
// ids survive; each value is coerced to {score,flags,lastSeenAt,episodes}.
function vNpcRelationships(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const id of NPC_IDS) {
    const r = o[id];
    if (!r || typeof r !== "object") continue;
    out[id] = {
      score: vInt(r.score, -100, 100, 0),
      flags: vArr(r.flags, (f) => vStr(f, 24, ""), 12).filter(Boolean),
      lastSeenAt: vInt(r.lastSeenAt, 0, 1e15, 0),
      episodes: vArr(
        r.episodes,
        (e) => ({
          kind: vStr(e?.kind, 24, ""),
          w: vInt(e?.w, -100, 100, 0),
          at: vInt(e?.at, 0, 1e15, 0),
        }),
        8,
      ),
    };
  }
  return out;
}

function vGear(g) {
  const o = g && typeof g === "object" && !Array.isArray(g) ? g : {};
  const out = {};
  for (const slot of GEAR_SLOTS) {
    out[slot] = o[slot] == null ? null : vItem(o[slot]);
  }
  return out;
}

function vStats(s) {
  const o = s && typeof s === "object" ? s : {};
  const out = {};
  for (const k of STAT_KEYS) out[k] = vInt(o[k], STAT_MIN, STAT_MAX, START_STATS[k]);
  return out;
}

function vAi(a) {
  const o = a && typeof a === "object" ? a : {};
  return {
    fleeHpFrac: vNum(
      o.fleeHpFrac,
      AI_BOUNDS.fleeHpFrac[0],
      AI_BOUNDS.fleeHpFrac[1],
      AI_DEFAULTS.fleeHpFrac,
    ),
    potionHpFrac: vNum(
      o.potionHpFrac,
      AI_BOUNDS.potionHpFrac[0],
      AI_BOUNDS.potionHpFrac[1],
      AI_DEFAULTS.potionHpFrac,
    ),
    retreatDanger: vNum(
      o.retreatDanger,
      AI_BOUNDS.retreatDanger[0],
      AI_BOUNDS.retreatDanger[1],
      AI_DEFAULTS.retreatDanger,
    ),
    retreatDepth: vInt(
      o.retreatDepth,
      AI_BOUNDS.retreatDepth[0],
      AI_BOUNDS.retreatDepth[1],
      AI_DEFAULTS.retreatDepth,
    ),
    targetPriority: vEnum(o.targetPriority, AI_TARGET_PRIORITY, AI_DEFAULTS.targetPriority),
    greedMode: vBool(o.greedMode, AI_DEFAULTS.greedMode),
    avoidElites: vBool(o.avoidElites, AI_DEFAULTS.avoidElites),
  };
}

function vDiseases(d) {
  const o = d && typeof d === "object" && !Array.isArray(d) ? d : {};
  const out = {};
  let n = 0;
  for (const id of Object.keys(o)) {
    if (n >= 5) break;
    if (!DISEASE_IDS.includes(id)) continue;
    const e = o[id] && typeof o[id] === "object" ? o[id] : {};
    out[id] = {
      severity: vNum(e.severity, 0, 1, 0),
      immunity: vNum(e.immunity, 0, 1, 0),
      ticks: vInt(e.ticks, 0, 1e6, 0),
    };
    n += 1;
  }
  return out;
}

function vInjuries(i) {
  const o = i && typeof i === "object" && !Array.isArray(i) ? i : {};
  const out = {};
  let n = 0;
  for (const partId of Object.keys(o)) {
    if (n >= BODY_PART_IDS.length) break;
    if (!BODY_PART_IDS.includes(partId)) continue;
    const slot = o[partId] && typeof o[partId] === "object" ? o[partId] : {};
    const parts = Array.isArray(slot.parts)
      ? slot.parts.slice(0, 4).map((w) => ({
          severity: vEnum(w?.severity, WOUND_SEVERITIES, "light"),
          ticksLeft: vNum(w?.ticksLeft, 0, 1e6, 0),
        }))
      : [];
    if (parts.length) out[partId] = { parts };
    n += 1;
  }
  return out;
}

function vActiveBreak(b) {
  if (!b || typeof b !== "object") return null;
  const id = vEnum(b.id, BREAK_IDS, null);
  if (!id) return null;
  return { id, ticksLeft: vInt(b.ticksLeft, 0, 20, 0) };
}

function vActiveInspiration(b) {
  if (!b || typeof b !== "object") return null;
  const id = vEnum(b.id, INSPIRATION_IDS, null);
  if (!id) return null;
  return { id, ticksLeft: vInt(b.ticksLeft, 0, 20, 0) };
}

// ── Vampire-Survivors layer validators ─────────────────────────────────
const WEAPON_ID_SET = new Set(WEAPON_IDS);

// A weapon loadout: known ids only, de-duped, capped to the slot count. Coerce,
// never reject (an unknown id is dropped, not 400'd).
function vWeapons(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (typeof x !== "string" || seen.has(x) || !WEAPON_ID_SET.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= VS_TUNABLES.maxWeaponSlots) break;
  }
  return out;
}

// A single weapon id or null (the active slot / last-lost weapon).
function vWeaponId(x) {
  return typeof x === "string" && WEAPON_ID_SET.has(x) ? x : null;
}

// In-flight XP gems (run-side combat state). Each is bounded hard; the cap
// matches VS_TUNABLES.gemMaxLive. Positions clamp to the arena bounds.
const GEM_BOUND = VS_TUNABLES.arenaRadius * 2;
function vGem(g) {
  const o = asObj(g);
  return {
    id: vStr(o.id, 24, "g"),
    x: vNum(o.x, -GEM_BOUND, GEM_BOUND, 0),
    y: vNum(o.y, -GEM_BOUND, GEM_BOUND, 0),
    value: vInt(o.value, 0, 1e7, 0),
  };
}
function vGems(arr) {
  return vArr(arr, vGem, VS_TUNABLES.gemMaxLive);
}

function vRun(r) {
  const o = asObj(r);
  return {
    alive: vBool(o.alive, true),
    level: vInt(o.level, 1, LEVEL_MAX, 1),
    xp: vNum(o.xp, 0, 1e12, 0),
    statPoints: vInt(o.statPoints, 0, 1e6, 0),
    stats: vStats(o.stats),
    hp: vNum(o.hp, 0, 1e7, 1),
    potions: vInt(o.potions, 0, POTION_MAX, 0),
    gear: vGear(o.gear),
    // Dual specialization (Inc6): the inactive set's gear loadout (run-side, so
    // permadeath erases both sets' gear). null when absent — a pre-Inc6 run
    // stays `gearB: null` (exact-identity; derive only reads the active `gear`).
    gearB: o.gearB == null ? null : vGear(o.gearB),
    inventory: vArr(o.inventory, vItem, INVENTORY_MAX),
    // Vampire-Survivors run-side combat state (transient). Empty for a pre-VS
    // run → exact-identity. gemSeq is the deterministic gem-id counter.
    gems: vGems(o.gems),
    gemSeq: vInt(o.gemSeq, 0, 1e9, 0),
    zone: vEnum(o.zone, ZONE_IDS, "town"),
    depth: vInt(o.depth, 0, DEPTH_MAX, 0),
    danger: vNum(o.danger, 0, 1, 0),
    ai: vAi(o.ai),
    rngSeed: vInt(o.rngSeed, 0, 0xffffffff, 1),
    rngState: vInt(o.rngState, 0, 0xffffffff, 1),
    kills: vInt(o.kills, 0, 1e9, 0),
    encounters: vInt(o.encounters, 0, 1e9, 0),
    startedAt: vInt(o.startedAt, 0, 1e15, 0),
    diseases: vDiseases(o.diseases),
    injuries: vInjuries(o.injuries),
    activeBreak: vActiveBreak(o.activeBreak),
    activeInspiration: vActiveInspiration(o.activeInspiration),
    eventsFired: vInt(o.eventsFired, 0, 1e6, 0),
    lastBreakTickIdx: vInt(o.lastBreakTickIdx, -1e9, 1e9, -9999),
    lastInspirationIdx: vInt(o.lastInspirationIdx, -1e9, 1e9, -9999),
  };
}

// Cosmetics is a loose map driven by the avatar system — bound it hard
// (key count, value types + lengths) without enumerating every key.
function vCosmetics(c) {
  const o = c && typeof c === "object" && !Array.isArray(c) ? c : {};
  const out = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (n >= 24) break;
    n += 1;
    const key = vStr(k, 24, "");
    if (!key) continue;
    const val = o[k];
    if (typeof val === "string") out[key] = vStr(val, 32, "");
    else if (typeof val === "boolean") out[key] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[key] = val;
    else if (Array.isArray(val)) out[key] = vArr(val, (x) => vStr(x, 24, ""), 16);
  }
  return out;
}

function vTraits(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr.slice(0, 5)) {
    if (typeof x !== "string") continue;
    if (!TRAIT_IDS.includes(x)) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function vBackstory(b) {
  const o = b && typeof b === "object" && !Array.isArray(b) ? b : {};
  return {
    childhood: vEnum(o.childhood, CHILDHOOD_IDS, CHILDHOOD_IDS[0]),
    adulthood: vEnum(o.adulthood, ADULTHOOD_IDS, ADULTHOOD_IDS[0]),
  };
}

function vSkills(s) {
  const o = s && typeof s === "object" && !Array.isArray(s) ? s : {};
  const out = {};
  for (const id of SKILL_IDS) {
    const e = o[id] && typeof o[id] === "object" ? o[id] : {};
    out[id] = {
      level: vInt(e.level, 0, SKILL_LEVEL_MAX, 0),
      xp: vInt(e.xp, 0, 1e9, 0),
      passion: vInt(e.passion, 0, 2, 0),
    };
  }
  return out;
}

const THOUGHT_ID_MAX = 32;
function vMoodThought(t) {
  const o = t && typeof t === "object" && !Array.isArray(t) ? t : {};
  const id = vStr(o.id, THOUGHT_ID_MAX, "");
  if (!id) throw new ValidationError("empty thought id");
  return {
    id,
    amount: vNum(o.amount, -200, 200, 0),
    ticksLeft: vNum(o.ticksLeft, 0, 1e6, 0),
  };
}

function vMood(m) {
  const o = m && typeof m === "object" && !Array.isArray(m) ? m : {};
  return {
    baseline: vNum(o.baseline, -200, 200, 50),
    value: vNum(o.value, 0, 100, 50),
    thoughts: vArr(o.thoughts, vMoodThought, 32),
    breakProgress: vNum(o.breakProgress, 0, 1000, 0),
    lastBreakTick: vInt(o.lastBreakTick, -1e9, 1e9, -9999),
  };
}

// Faction standing map: only known faction ids survive; every value is
// coerced into the 0..1000 rep domain (master §0.2). Unknown keys + bad
// values are silently dropped (never rejected) — same posture as the rest
// of the trust boundary.
function vFactionRep(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  const out = {};
  for (const id of FACTION_IDS) {
    if (o[id] === undefined || o[id] === null) continue;
    out[id] = vInt(o[id], 0, FACTION_MAX_REP, 0);
  }
  return out;
}

// Spirit reservation list (Project Ascendant Inc7).
// Coerce+bound: drop unknown ids, deduplicate, clamp total spiritCost to ≤
// the character's spirit pool. Over-reservation is unsalvageable in general
// but we can salvage it by dropping lowest-priority (last) entries until the
// cost fits — same posture as the rest of the boundary (prefer coerce over
// reject). The pool is computed from the run's effective int stat (mirrors
// stats.js derive() formula: SPIRIT_BASE + int * SPIRIT_PER_INT).
function vReserved(x, runStats) {
  if (!Array.isArray(x)) return [];
  // Compute the spirit pool from the run's int stat (clamped to stat bounds).
  const intStat = Math.min(
    STAT_MAX,
    Math.max(STAT_MIN, Math.round(runStats?.int || START_STATS.int)),
  );
  const pool = Math.round(SPIRIT_BASE + intStat * SPIRIT_PER_INT);
  // Filter to known ids, deduplicate.
  const seen = new Set();
  const valid = [];
  for (const id of x.slice(0, RESERVABLE_SKILL_IDS.length)) {
    if (typeof id !== "string") continue;
    if (!RESERVABLE_SKILL_IDS.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  // Clamp: drop from the end until total cost fits the pool.
  let cost = 0;
  const out = [];
  for (const id of valid) {
    const skillCost = RESERVABLE_SKILLS[id].spiritCost;
    if (cost + skillCost <= pool) {
      out.push(id);
      cost += skillCost;
    }
    // Drop this id — over-reservation: coerced away, not rejected.
  }
  return out;
}

// Passive tree allocation (Project Ascendant Inc4). Coerce+bound, never reject:
//   1. drop unknown node ids (not in the static tree),
//   2. drop disconnected/orphan allocations — prune to the connected component
//      that chains back to the class start zone's entry node (BFS through the
//      allocated set only); a node that doesn't chain to the start is silently
//      dropped,
//   3. cap the surviving count at the character's available passivePoints
//      (drop from the END — input order is build priority).
// `points` is derived from the account's highestLevel + prestige (same source
// the client reads), so an over-allocation past budget is trimmed, not rejected.
// Pure-data dependency on shared/passive-tree.js; no rng. Account-side build
// identity (survives permadeath) — like reserved / skillTalents — so it never
// crosses the run/account line.
function vPassives(x, startZone, points) {
  if (!Array.isArray(x)) return [];
  // Bound the raw list to the tree size before any work (a flood can't be
  // longer than the whole tree).
  const raw = [];
  const seen = new Set();
  for (const id of x.slice(0, PASSIVE_NODE_COUNT)) {
    if (typeof id !== "string") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    raw.push(id);
  }
  // Prune to the connected component anchored at the class start (drops unknown
  // ids AND orphan allocations). Preserves input order for kept ids.
  const connected = pruneToConnected(raw, startZone);
  // Cap to the points budget — keep the earliest (highest-priority) ids.
  const cap = Math.max(0, points | 0);
  return connected.slice(0, cap);
}

// Inactive build set (Project Ascendant Inc6 — dual specialization). Validates
// the SAME account-side build fields as Set A with the SAME sub-validators:
// passiveStart (vEnum), passives (vPassives — pruned to the connected component
// and capped to the SHARED points budget), reserved (vReserved — clamped to the
// SHARED spirit pool from the run's int stat), position (vEnum), skillTalents
// (vSkillTalents). The budget/pool are account/run-wide (shared across both
// sets), so the same `runStats`/`points` the active set used are passed in.
// Returns null when there is no second set (the exact-identity default for
// every pre-Inc6 character) — never rejects.
function vSetB(x, runStats, points) {
  if (x == null) return null;
  if (typeof x !== "object" || Array.isArray(x)) return null;
  const startB = vEnum(x.passiveStart, CLASS_START_IDS, CLASS_START_IDS[0]);
  return {
    passiveStart: startB,
    passives: vPassives(Array.isArray(x.passives) ? x.passives : [], startB, points),
    reserved: vReserved(Array.isArray(x.reserved) ? x.reserved : [], runStats),
    position: vEnum(x.position, ["front", "mid", "back"], "mid"),
    skillTalents: vSkillTalents(x.skillTalents),
  };
}

// Onboarding state — Navi's distress-call flag + the wizard quiz answers
// (OS / how-they-found-SigmaShake / coding-agent). All optional; a sigma
// minted before onboarding existed loads cleanly (every field coerces to its
// default). `naviCalledAt` gates the one-time hologram so it never re-fires.
function vOnboarding(x) {
  const o = x && typeof x === "object" && !Array.isArray(x) ? x : {};
  return {
    naviCalledAt: vNum(o.naviCalledAt, 0, 1e15, 0),
    os: o.os == null ? null : vStr(o.os, 24, "") || null,
    source: o.source == null ? null : vStr(o.source, 48, "") || null,
    agent: o.agent == null ? null : vStr(o.agent, 24, "") || null,
    step: vInt(o.step, 0, 16, 0),
    complete: vBool(o.complete, false),
  };
}

export function vCharacter(raw) {
  const o = asObj(raw);
  const c = {
    v: vInt(o.v, 1, 9999, SCHEMA_VERSION),
    name: vStr(o.name, NAME_MAX, "Sigma"),
    seed: vInt(o.seed, 1, 0xffffffff, 1),
    cosmetics: vCosmetics(o.cosmetics),
    prestige: vInt(o.prestige, 0, 1e9, 0),
    gold: vInt(o.gold, 0, 1e12, 0),
    titles: vArr(o.titles, (x) => vStr(x, 32, ""), 40).filter(Boolean),
    cosmeticsUnlocked: vArr(o.cosmeticsUnlocked, (x) => vStr(x, 32, ""), 80).filter(Boolean),
    lifetimeKills: vInt(o.lifetimeKills, 0, 1e12, 0),
    lifetimeRuns: vInt(o.lifetimeRuns, 0, 1e9, 0),
    bestDepth: vInt(o.bestDepth, 0, DEPTH_MAX, 0),
    bestLevel: vInt(o.bestLevel, 1, LEVEL_MAX, 1),
    highestLevel: vInt(o.highestLevel, 1, LEVEL_MAX, 1),
    bestStreak: vInt(o.bestStreak, 0, 1e7, 0),
    streak: vInt(o.streak, 0, 1e7, 0),
    bestItemPower: vInt(o.bestItemPower, 0, 1e9, 0),
    posture: vEnum(o.posture, POSTURES, "delve"),
    // RimWorld additions — account-side state.
    traits: vTraits(o.traits),
    backstory: vBackstory(o.backstory),
    storyteller: vEnum(o.storyteller, STORYTELLER_IDS, STORYTELLER_IDS[0]),
    skills: vSkills(o.skills),
    mood: vMood(o.mood),
    // Persistent-world faction allegiance (ACCOUNT-side, master §0.2).
    // A character saved before factions existed loads cleanly: every field
    // coerces to its default (no rejection).
    faction: vEnum(o.faction, FACTION_IDS, null),
    factionRep: vFactionRep(o.factionRep),
    factionRank: vInt(o.factionRank, 0, 6, 0),
    factionJoinedAt: vNum(o.factionJoinedAt, 0, 1e15, 0),
    factionDefectorUntil: vNum(o.factionDefectorUntil, 0, 1e15, 0),
    factionAutoAssigned: vBool(o.factionAutoAssigned, false),
    // Economy — ACCOUNT-side (master §2.2 [A2]). goldEscrowed is clamped to
    // gold after the literal (see below) so escrow can never exceed balance.
    shards: vInt(o.shards, 0, 1e6, 0),
    runeDust: vInt(o.runeDust, 0, 1e7, 0),
    vault: vArr(o.vault, vItem, VAULT_MAX_CAPACITY),
    vaultCapacity: vEnum(o.vaultCapacity, [20, 40], 20),
    marketSlots: vEnum(o.marketSlots, [1, 2, 3], 1),
    goldEscrowed: vInt(o.goldEscrowed, 0, 1e12, 0),
    activeListings: vArr(o.activeListings, (x) => vStr(x, 48, ""), 3).filter(Boolean),
    activeBuyOrders: vArr(o.activeBuyOrders, (x) => vStr(x, 48, ""), 5).filter(Boolean),
    economyStats: vEconomyStats(o.economyStats),
    // Crafting / talents / scars (master §3.3/§3.5/§3.7), all account-side.
    skillTalents: vSkillTalents(o.skillTalents),
    // Spirit reservations (Project Ascendant Inc7 — aura buffs). Account-side:
    // survives permadeath (player keeps their aura loadout across runs). Unknown
    // ids and over-reservation are coerced away (never rejected).
    reserved: vReserved(Array.isArray(o.reserved) ? o.reserved : [], o.run?.stats),
    // Project Ascendant Inc5 — tactical positioning. Account-side (build/loadout
    // choice; survives permadeath). Unknown values coerce to "mid".
    position: vEnum(o.position, ["front", "mid", "back"], "mid"),
    // Project Ascendant Inc4 — passive tree. `passiveStart` is the class start
    // zone (the BFS anchor for connectivity); unknown values coerce to the first
    // class. `passives` (the allocated node-id list) is validated AFTER the
    // literal so it can use the already-coerced highestLevel/prestige for the
    // points budget — see the c.passives assignment below. Account-side build
    // identity (survives permadeath); never crosses the run/account line.
    passiveStart: vEnum(o.passiveStart, CLASS_START_IDS, CLASS_START_IDS[0]),
    // Dual specialization (Inc6). `activeSet` is the active combat profile;
    // unknown values coerce to "A" (the single-loadout default). `setB` (the
    // inactive set's build fields) is validated AFTER the literal so it can use
    // the already-coerced highestLevel/prestige + run stats for the shared
    // points budget / spirit pool — see the c.setB assignment below. Account-
    // side build identity (survives permadeath); the gear half of each set is on
    // the run (gear / gearB) and does not cross the run/account line.
    activeSet: vEnum(o.activeSet, BUILD_SETS, "A"),
    // Vampire-Survivors loadout (account-side build identity — survives
    // permadeath, like passives). `weapons` is the chosen loadout (known ids,
    // de-duped, slot-capped); `activeWeapon` is reconciled to be one of
    // `weapons` AFTER the literal (see below). `lostWeapon`/`fainted` are
    // read-only feedback. All default empty → exact-identity for a pre-VS char.
    weapons: vWeapons(o.weapons),
    activeWeapon: vWeaponId(o.activeWeapon),
    lostWeapon: vWeaponId(o.lostWeapon),
    fainted: vInt(o.fainted, 0, 1e9, 0),
    reagents: vReagents(o.reagents),
    scars: vArr(o.scars, vScar, 5),
    lastWorldEventAt: vNum(o.lastWorldEventAt, 0, 1e15, 0),
    quests: vArr(o.quests, vQuest, QUEST_MAX_ACTIVE),
    questXp: vInt(o.questXp, 0, 1e9, 0),
    questLevel: vInt(o.questLevel, 0, 50, 0),
    npcRelationships: vNpcRelationships(o.npcRelationships),
    // Retention (master §M7).
    dailyObjectives: vArr(o.dailyObjectives, vObjectiveInstance, 6),
    dailyDayIndex: vInt(o.dailyDayIndex, 0, 1e9, 0),
    weeklyBounties: vArr(o.weeklyBounties, vObjectiveInstance, 6),
    weeklyWeekIndex: vInt(o.weeklyWeekIndex, 0, 1e9, 0),
    achievements: vAchievements(o.achievements),
    bestiary: vBestiary(o.bestiary),
    museum: vArr(o.museum, vMuseumEntry, 20),
    season: vSeason(o.season),
    activeTitle: o.activeTitle == null ? null : vStr(o.activeTitle, 32, null),
    run: vRun(o.run),
    onboarding: vOnboarding(o.onboarding),
    lastSeen: vInt(o.lastSeen, 0, 1e15, Date.now()),
    createdAt: vInt(o.createdAt, 0, 1e15, Date.now()),
  };
  c.name = c.name.trim() || "Sigma";
  // Escrow can never exceed the balance it's drawn from (master §9.3).
  c.goldEscrowed = Math.min(c.goldEscrowed, c.gold);
  // Passive tree (Inc4): validate the allocation against the now-known points
  // budget (highestLevel + prestige) and start zone. Drops unknown/orphan ids
  // and caps to budget — coerce, never reject.
  const passiveBudget = passivePointsFor({ highestLevel: c.highestLevel, prestige: c.prestige });
  c.passives = vPassives(
    Array.isArray(o.passives) ? o.passives : [],
    c.passiveStart,
    passiveBudget,
  );
  // Dual specialization (Inc6): validate the inactive set against the SHARED
  // budget/pool (both sets draw from the same account points + run spirit). null
  // for every single-loadout character → exact-identity. Coerce, never reject.
  c.setB = vSetB(o.setB, c.run.stats, passiveBudget);
  // Vampire-Survivors: the active weapon must be one of the carried weapons.
  // Coerce a stale/absent active slot to the first weapon (or null when the
  // loadout is empty) so the faint mechanic always has a well-defined target.
  if (c.activeWeapon && !c.weapons.includes(c.activeWeapon)) c.activeWeapon = null;
  if (!c.activeWeapon && c.weapons.length) c.activeWeapon = c.weapons[0];
  return c;
}

export function vFeedEvent(raw) {
  const o = asObj(raw);
  return {
    kind: vEnum(o.kind, FEED_KINDS, "milestone"),
    name: vStr(o.name, NAME_MAX, "Sigma").trim() || "Sigma",
    detail: vStr(o.detail, 140, ""),
  };
}

const TWITCH_LOGIN_RE = /^[a-z0-9_]{1,32}$/;
function vTwitchLogin(x) {
  if (x == null) return null;
  if (typeof x !== "string") return null;
  const lowered = scrub(x).trim().toLowerCase();
  return TWITCH_LOGIN_RE.test(lowered) ? lowered : null;
}

export function vHello(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    token: o.token == null ? null : vToken(o.token),
    name: o.name == null ? null : vStr(o.name, NAME_MAX, "").trim() || null,
    twitch: vTwitchLogin(o.twitch),
  };
}

// ── Top-level dispatcher ──────────────────────────────────────────────
// `buf` is a string or Buffer; the WS layer has already enforced the
// byte cap before this runs.
export function parseMessage(buf) {
  let raw;
  try {
    raw = JSON.parse(typeof buf === "string" ? buf : buf.toString("utf8"));
  } catch {
    fail("not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("message must be an object");
  const t = vStr(raw.t, 16, "");
  switch (t) {
    case "hello":
      return { t, data: vHello(raw) };
    case "save":
      return { t, data: { character: vCharacter(raw.character) } };
    case "event":
      return { t, data: { event: vFeedEvent(raw.event) } };
    case "ping":
      return { t, data: {} };
    default:
      fail(`unknown message type: ${t.slice(0, 16)}`);
  }
}
