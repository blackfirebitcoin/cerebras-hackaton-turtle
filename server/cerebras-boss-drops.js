// Gemma boss-drop forge (integrate-this Phase D). Wraps the deterministic
// forgeRaidDrop with an OPTIONAL, cache-primary Gemma enrichment via the shared
// Cerebras seam.
//
// CRITICAL (collaborator-plan correction #1): the LLM is NEVER on the kill path.
//   - forgeOrCached(bossId, lvl) is SYNCHRONOUS and instant. It returns the cached
//     enriched drop (re-scaled to the killer's ilvl) when one exists, else the
//     plain deterministic forge. It never awaits the model.
//   - warm(bossId, lvl, ctx) is async + fire-and-forget. It fills the per-boss
//     cache for the NEXT kill, only when BOSS_DROPS_LIVE=1 && the seam is available
//     && this boss isn't cached yet. Any failure is swallowed → the deterministic
//     drop simply keeps shipping (fallback-first).
//
// Cache-primary (correction #5): one generation per bossId, reused. The cached
// value is the RAW model reply; enrichBossDrop re-validates + clamps it onto a
// fresh ilvl-scaled skeleton on EVERY forge, so a stale reply can never bypass the
// trust boundary. Cache is in-memory only (regenerable) → no world.json writes.

import { forgeRaidDrop, RAID_BOSS_DROPS } from "../shared/loot.js";
import { enrichBossDrop } from "../shared/boss-drops.js";
import { createLlmClient } from "./llm.js";

function bossPrompt(base, bossId, context) {
  const affixStats = base.affixes.map((a) => a.stat).join(", ");
  const system =
    "You re-theme ONE fantasy raid-boss drop. Reply ONLY with compact JSON: " +
    '{"name": string<=60, "flavor": string<=160, "effect": string|null, ' +
    '"rarity": string, "affixes": [{"stat": string, "value": number}]}. ' +
    "Keep it evocative and short. You may rename, re-flavor, pick an effect from the " +
    "allowed list, lower (never raise) rarity, and nudge affix values. You may ONLY use " +
    "the affix stats already on the item. No prose, no markdown.";
  const user =
    `Boss ${bossId}. Item: ${base.name} (${base.slot}, ${base.base}), rarity ${base.rarity}, ` +
    `ilvl ${base.ilvl}, effect ${base.effect || "none"}. Affix stats you may tune: ${affixStats}. ` +
    `Allowed effects: bloodthirst, vampire, berserk, glass, juggernaut, midas, executioner, lucky_seven, thornmail, second_wind. ` +
    `Context: killer level ${context?.killerLevel ?? "?"}${context?.zone ? `, zone ${context.zone}` : ""}. ` +
    "Re-theme it into something memorable.";
  return { system, user };
}

export function createBossDropForge({
  env = process.env,
  llm = createLlmClient({ env }),
  forge = forgeRaidDrop,
} = {}) {
  const live = env.BOSS_DROPS_LIVE === "1";
  const cache = new Map(); // bossId -> raw model reply (re-validated by enrichBossDrop per forge)

  // SYNC + instant. On the kill path. Cached enrichment re-applied onto a fresh
  // ilvl-scaled base, else the deterministic drop. Never awaits the model.
  function forgeOrCached(bossId, killerLevel) {
    const base = forge(bossId, killerLevel);
    if (!base) return null;
    const reply = cache.get(bossId);
    return reply ? enrichBossDrop(base, reply) : base;
  }

  // ASYNC + fire-and-forget. Fills the cache for the NEXT kill. No-op unless live,
  // available, a real boss, and not already cached. Never throws to the caller.
  async function warm(bossId, killerLevel, context = {}) {
    if (!live || cache.has(bossId) || !RAID_BOSS_DROPS[bossId] || !llm.available()) return false;
    const base = forge(bossId, killerLevel);
    if (!base) return false;
    try {
      const { system, user } = bossPrompt(base, bossId, context);
      const reply = await llm.chat({ system, user, json: true, maxTokens: 320 });
      // Only cache if it actually enriches into a valid item (fail-closed).
      const enriched = enrichBossDrop(base, reply);
      if (enriched && enriched.source === "gemma") cache.set(bossId, reply);
      return true;
    } catch {
      return false; // provider failure → deterministic drop keeps shipping
    }
  }

  return { forgeOrCached, warm, _cacheSize: () => cache.size };
}
