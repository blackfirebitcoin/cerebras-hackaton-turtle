// Gemma boss-drop ENRICHMENT — the pure trust boundary for model-generated loot
// (integrate-this Phase D, collaborator plan + corrections). The server forges the
// deterministic, guaranteed raid drop FIRST (shared/loot.js forgeRaidDrop); this
// module only lets Gemma vary NAME / FLAVOR / EFFECT / affix-VALUES *onto that
// skeleton*, within hard clamped bands. It NEVER invents slot/base/structure and
// NEVER upgrades rarity above the boss's — so a hallucinated drop can't break item
// power math or the economy. Pure: no Date/Math.random/network (safe to import in
// both runtimes); the network call lives in server/cerebras-boss-drops.js.

import { RARITIES, RARITY_RANK } from "./constants.js";
import { EFFECT_IDS, itemPower, sellValue } from "./loot.js";

export const BOSS_DROP_NAME_MAX = 60;
export const BOSS_DROP_FLAVOR_MAX = 160;
// Gemma may nudge an affix to between 0.5x and 1.25x of its deterministic value —
// enough to feel hand-rolled, never enough to power-creep past the tuned drop.
export const AFFIX_VALUE_MIN_MUL = 0.5;
export const AFFIX_VALUE_MAX_MUL = 1.25;

// Drop control + zero-width code points (no regex literal → no invisible chars in
// source), then trim + cap. Keeps model strings safe for the feed/inventory.
function cleanStr(x, max) {
  if (typeof x !== "string") return "";
  let out = "";
  for (const ch of x) {
    const c = ch.codePointAt(0);
    if (c < 0x20) continue; // C0 control
    if (c >= 0x200b && c <= 0x200d) continue; // zero-width space/joiners
    if (c === 0xfeff) continue; // zero-width no-break / BOM
    out += ch;
  }
  return out.trim().slice(0, max);
}

// Apply a validated, clamped Gemma enrichment onto a deterministic forged drop.
// Returns a structurally-identical item (same slot/base/ilvl/affix-stats) with only
// name/flavor/effect/affix-values varied, plus recomputed power/value. Returns the
// untouched base when `raw` contributes nothing usable. Pure + total (never throws).
export function enrichBossDrop(base, raw) {
  if (!base || typeof base !== "object" || !Array.isArray(base.affixes)) return base || null;
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...base, affixes: base.affixes.map((a) => ({ ...a })) };

  const name = cleanStr(r.name, BOSS_DROP_NAME_MAX);
  if (name) out.name = name;
  const flavor = cleanStr(r.flavor, BOSS_DROP_FLAVOR_MAX);
  if (flavor) out.flavor = flavor;

  // Effect only from the known pool; never strip a boss's effect via a null/garbage.
  if (typeof r.effect === "string" && EFFECT_IDS.includes(r.effect)) out.effect = r.effect;

  // Rarity may be re-themed DOWN or equal, never UP past the boss's deterministic tier.
  if (
    typeof r.rarity === "string" &&
    RARITIES.includes(r.rarity) &&
    RARITY_RANK[r.rarity] <= (RARITY_RANK[base.rarity] ?? 0)
  ) {
    out.rarity = r.rarity;
  }

  // Affix values: match a proposed value to an existing base affix by stat and clamp
  // to a band of the deterministic value. NEW stats are ignored (no invented power).
  if (Array.isArray(r.affixes)) {
    const proposedByStat = new Map();
    for (const a of r.affixes) {
      if (a && typeof a.stat === "string" && typeof a.value === "number" && Number.isFinite(a.value)) {
        proposedByStat.set(a.stat, a.value);
      }
    }
    out.affixes = out.affixes.map((a) => {
      const proposed = proposedByStat.get(a.stat);
      if (proposed === undefined) return a;
      const lo = a.value * AFFIX_VALUE_MIN_MUL;
      const hi = a.value * AFFIX_VALUE_MAX_MUL;
      const clamped = Math.min(Math.max(proposed, Math.min(lo, hi)), Math.max(lo, hi));
      return { ...a, value: a.pct ? Math.round(clamped * 1000) / 1000 : Math.round(clamped) };
    });
  }

  out.power = itemPower(out);
  out.value = sellValue(out) * 2; // raid drops vendor for double (matches forgeRaidDrop)
  out.source = "gemma";
  return out;
}
