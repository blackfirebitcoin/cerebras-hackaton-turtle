# MillsysPlan: Gemma Boss Drops + Agentic NPCs

## Overview
Implementation plan for integrating Gemma (via Cerebras/local vLLM) to generate boss drops and power autonomous NPC behaviors in SIGMA ABYSS.

## Architecture Principles (from Collaborator Corrections)

1. **Never put LLM on kill path** - `endRaid()` awards deterministic drop instantly, enrichment runs async off-tick
2. **Pure shared schema** - `shared/boss-drops.js` has zero network/Date/Math.random, only validation + clamping
3. **Single provider seam** - `server/llm.js` env-driven (local vLLM or Cerebras), used by both enricher + NPC planner
4. **Validate through validate.js patterns** - `vEnum`, `vInt`, `vArr` drop bad affixes, clamp to `AFFIX_POOL` bands
5. **Cache-per-boss×class×tier** - 7-day TTL, regeneration on cooldown, fail-closed re-validation on load

## Rollout Phases

| Phase | Files | Description |
|-------|-------|-------------|
| 1 | `shared/item-bases.js`, `shared/constants.js`, `shared/loot.js` | Item base system (PoE-style explicit bases) |
| 2 | `shared/boss-drops.js` | Boss drop schema, clamping, validator |
| 3 | `server/llm.js`, `server/circuit-breaker.js` | Single LLM provider seam |
| 4 | `server/boss-drop-enricher.js` | Off-tick enrichment job + cache |
| 5 | `server/server.js` | Wire `endRaid()` → deterministic drop + enqueue enrichment |
| 6 | `server/sigmacraft-npc-agents.js` | NPC live Gemma via `llm.js` |
| 7 | `server/validate.js` | Re-validation on load (fail-closed) |

## Environment Variables

```bash
LLM_BASE_URL=http://localhost:18000/v1     # or https://api.cerebras.ai/v1
LLM_MODEL=gemma-2-27b-it                   # gemma                  # Gemma4 32b mapped to available
LLM_API_KEY=                                # optional
LLM_MAX_CONCURRENCY=2
LLM_TIMEOUT_MS=15000

NPC_PLANNER_LIVE=1                          # enables live Gemma for NPCs
```

## Key Files

- [Phase 1: Item Base System](./01-item-base-system.md)
- [Phase 2: Boss Drop Schema](./02-boss-drop-schema.md)
- [Phase 3: LLM Provider Seam](./03-llm-provider.md)
- [Phase 4: Enrichment Job](./04-enrichment-job.md)
- [Phase 5: Raid Integration](./05-raid-integration.md)
- [Phase 6: NPC Agentic Behavior](./06-npc-agentic.md)
- [Phase 7: Re-validation](./07-revalidation.md)