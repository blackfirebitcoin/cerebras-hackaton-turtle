// SIGMA ABYSS — global mob-difficulty tier.
//
// The arena foe pool starts narrow (goblins, skeletons) and widens as the
// world kill counter climbs. Difficulty is a single global integer so the
// stream as a whole ramps up together rather than per-chatter — the
// streamer asked for "start small, get harder as more mobs are defeated."
//
// Pure data + helpers, ESM-only — runnable from both Node (server) and
// the browser (the overlay HUD reads MOB_TIERS to label the current tier).

// Cumulative kill thresholds. Lowest tier first; first entry must have
// threshold 0 so a fresh world always resolves. Each tier inherits the
// previous tier's pool, so the pool monotonically grows.
//
// `eliteChance` is the per-spawn probability the foe is drawn from the
// `elites` pool instead of `normals`. Boss spawns stay gated on raid
// triggers (channel-point redemptions, hype-train fanout) — the global
// tier doesn't drop bosses into the idle arena.
//
// `hpMult` scales the arena enemy HP_BASE so a tier-6 goblin still feels
// chunkier than a tier-0 one — without renaming the foe.
export const MOB_TIERS = [
  {
    tier: 0,
    name: "Stirring",
    threshold: 0,
    normals: ["goblin", "skeleton"],
    elites: [],
    eliteChance: 0,
    hpMult: 1.0,
  },
  {
    tier: 1,
    name: "Restless",
    threshold: 10,
    normals: ["goblin", "skeleton", "goblin_thief", "wolf", "boar"],
    elites: [],
    eliteChance: 0,
    hpMult: 1.15,
  },
  {
    tier: 2,
    name: "Hunting",
    threshold: 30,
    normals: ["goblin_thief", "skeleton", "wolf", "boar", "bandit", "imp"],
    elites: [],
    eliteChance: 0,
    hpMult: 1.3,
  },
  {
    tier: 3,
    name: "Bloodied",
    threshold: 60,
    normals: ["wolf", "bandit", "imp", "rogue_wizard", "cursed_biker", "troll"],
    elites: ["cursed_gambler"],
    eliteChance: 0.05,
    hpMult: 1.5,
  },
  {
    tier: 4,
    name: "Raging",
    threshold: 120,
    normals: [
      "bandit",
      "rogue_wizard",
      "cursed_biker",
      "corrupted_knight",
      "troll",
      "abyss_crawler",
    ],
    elites: ["cursed_gambler", "ogre", "werewolf"],
    eliteChance: 0.08,
    hpMult: 1.75,
  },
  {
    tier: 5,
    name: "Apocalypse",
    threshold: 250,
    normals: ["cursed_biker", "corrupted_knight", "abyss_crawler", "rogue_wizard", "troll"],
    elites: ["cursed_gambler", "ogre", "werewolf", "bone_colossus", "infernal_champion"],
    eliteChance: 0.12,
    hpMult: 2.0,
  },
  {
    tier: 6,
    name: "Hollow",
    threshold: 500,
    normals: ["corrupted_knight", "abyss_crawler", "cursed_biker"],
    elites: [
      "cursed_gambler",
      "ogre",
      "werewolf",
      "bone_colossus",
      "infernal_champion",
      "abyss_hunter",
    ],
    eliteChance: 0.18,
    hpMult: 2.4,
  },
];

export function tierForKills(kills) {
  const k = Math.max(0, Number(kills) || 0);
  let active = MOB_TIERS[0];
  for (const t of MOB_TIERS) {
    if (k >= t.threshold) active = t;
    else break;
  }
  return active;
}

// Kill count remaining until the next tier unlocks. null when already at
// the top tier (so the HUD can render "MAX").
export function killsToNextTier(kills) {
  const k = Math.max(0, Number(kills) || 0);
  for (const t of MOB_TIERS) {
    if (k < t.threshold) return t.threshold - k;
  }
  return null;
}

// Pick a mob id from a tier. `rngFloat` is an optional [0,1) source so
// callers can keep the arena's deterministic story when they have an
// rng; defaults to Math.random for the live arena (where the camera
// rotates anyway and the determinism contract doesn't hold).
export function pickMobFromTier(tier, rngFloat) {
  const rnd = typeof rngFloat === "function" ? rngFloat : Math.random;
  const useElite = tier.elites.length && rnd() < tier.eliteChance;
  const pool = useElite ? tier.elites : tier.normals;
  if (!pool.length) return "goblin";
  return pool[Math.floor(rnd() * pool.length)];
}
