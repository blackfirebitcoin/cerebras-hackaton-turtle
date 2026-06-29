# SIGMA ABYSS — Implementation Plan (Dependency-Ordered, Milestone-Based)

> Companion to `00-master-design.md`. This is the buildable backlog. Each task
> names exact target files, dependencies, whether it touches **deterministic
> `shared/`** code, and a risk rating. Invariant risks are called out explicitly.
> Milestone 1 is a thin-but-real **vertical slice** that proves the new direction
> end-to-end **without breaking the existing single-player game or `pnpm run
> smoke`**.

## Guiding constraints (non-negotiable)

- **Never regress `pnpm run smoke`.** It is the determinism canary. Every PR runs
  it. Any `shared/` change that alters a deterministic outcome for an existing
  seed is a bug, not a feature.
- **`grep -r "Math.random" shared/` must stay empty.** CI gate.
- **One world loop** under `superviseInterval` (PSU power safety). Do not add
  parallel timers beyond the sanctioned 5s `globalChallenge.flush`.
- **Additive only.** New `shared/` files; new `server/` files; existing files get
  *appended* exports/fields, never rewritten signatures. `derive(run, character)`
  and `delveTick(character)` signatures stay fixed (character already carries the
  new account fields).
- **Validator-first.** No new character/world field ships without its
  `validate.js` validator in the same task, or it is silently dropped.

---

## Milestone overview

| M | Theme | Proves | Gate |
|---|---|---|---|
| **M1** | **Vertical slice: persistent world + factions + 2 chat commands** | The whole new direction end-to-end: a `world.json` ticking under supervisor, a faction you join in chat that survives permadeath and changes combat, persisted + validated + tested, single-player game and smoke untouched. | smoke green; new world smoke green; existing game playable |
| M2 | Economy foundation | Player market, salvage, vault, prestige shards — the gold sinks. | M1 |
| M3 | Crafting + skill talents + item sets + binding | Build identity + scarcity loop. | M1 |
| M4 | World simulation depth | Zone pressure, faction territory conquest, world-event queue → delveTick injection. | M1 |
| M5 | Narrative engine | World crises, trait×crisis collisions, unified quests, narrative triggers. | M4 |
| M6 | NPC intelligence | NPC schedules/memory/relationships, Oracle-driven dialogue, faction-tagged kills. | M4, M5 |
| M7 | Retention loops | Daily/weekly/season/achievements/collections/community events. | M2, M5 |
| M8 | Twitch command surface completion | Full verb vocabulary, voting, gather, raid-lead, collective challenges, overlay frames. | M2–M7 |

---

## MILESTONE 1 — THE VERTICAL SLICE (build this first, in order)

**Scope name:** *Persistent Abyss: Factions Slice.*

**Rationale.** The riskiest unknowns are (a) a shared world document ticking under
the supervisor without breaking the deterministic per-player sim, (b) account-side
faction state surviving permadeath and flowing into `derive()` deterministically,
and (c) the chat→HTTP→store→validate→broadcast loop for a *world-mutating* verb.
M1 builds exactly those, end-to-end, and nothing else — a real spike that all
later milestones extend. It deliberately ships **only 2 chat verbs** (`!join`,
`!rep`) and the **single merged `shared/factions.js`** (canon §0.6) so the central
5-way faction conflict is resolved in code before any agent's downstream work is
built on a wrong faction set.

**M1 vertical-slice modules:** `shared/factions.js`, `server/world-tick.js`,
`server/store.js` (world doc), `server/validate.js` (faction validators),
`shared/progression.js` + `shared/stats.js` (faction fields + `derive` stacking).
**M1 endpoints:** `POST /api/faction/join/:login`, `GET /api/faction/rep/:login`,
`GET /api/world`, chat `!join`/`!rep` via the bridge.

### M1 tasks (ordered)

1. **m1-constants** — add canon faction constants + `WORLD_TICK_MS` + `FEED_KINDS`
   union to `shared/constants.js`. Pure data, additive.
2. **m1-factions-module** — write the single merged `shared/factions.js`
   (catalog, `factionRank`, `factionCombatMods`, `isRival`, deterministic
   `pickFactionRaider`). The conflict-resolving keystone.
3. **m1-progression-fields** — add `faction/factionRep/factionRank/factionJoinedAt/
   factionDefectorUntil` to `freshCharacter`; ensure `resolveDeath` passes them
   through unchanged (account-side). **Touches deterministic shared/.**
4. **m1-derive-stacking** — stack `factionCombatMods(...)` in `stats.js:derive`
   after `skillCombatMods`. **Touches deterministic shared/** — must not change
   output when `faction===null` (back-compat test).
5. **m1-validate** — `vFactionRep`, faction field coercion in `vCharacter`;
   `vRun` strips any `_`-prefixed world ephemerals. Trust boundary.
6. **m1-store-world** — `getWorldState/putWorldState/initWorldState/notifyZoneEvent`
   in `server/store.js`; load/self-heal `data/world.json`; init 5 faction objects.
7. **m1-world-tick** — `server/world-tick.js` single `worldTick(rt)` + `startWorldTick`;
   mount under `superviseInterval('world.tick', …, 60_000)` in `server.js`;
   broadcast `worldPulse`. M1 tick only bumps `epoch`, decays nothing yet, and
   updates `factions[].memberCount`. PSU-safe single loop.
8. **m1-faction-endpoints** — `POST /api/faction/join/:login` (cooldown, defector,
   memberCount), `GET /api/faction/rep/:login`, `GET /api/world` snapshot. All under
   `guard()`, validated, `getPlayer→mutate→putPlayer`, feed `faction_join`.
9. **m1-bridge** — `lib/chat/mmo/bridge.ex` parses `!cmd args` → `{cmd,args}` in the
   chat-ping body. **Do not run `mix test`** (OTP-28 box rule); verify with
   `mix compile` / grep. The one chat-elixir change for the whole project.
10. **m1-commands-dispatch** — minimal `server/commands.js` dispatching `!join`/`!rep`
    after base ping; per-login cooldown map.
11. **m1-smoke** — extend `server/smoke.js`: (a) faction join → rep → permadeath →
    faction persists; (b) `derive` faction mod non-zero at rep 300; (c) world tick
    runs <50ms and persists; (d) existing deterministic run unchanged. **The M1 exit
    gate.**

### M1 invariant-risk checklist (must verify before M1 merges)

- [ ] `derive(run, character)` with `faction===null` returns **byte-identical**
      sheets to pre-change (back-compat; existing smoke seeds unchanged).
- [ ] `simulateOffline` parity holds (faction mods are pure account-state, no RNG).
- [ ] `grep -r Math.random shared/` empty.
- [ ] `world.tick` is the only new `superviseInterval`; <50ms/tick.
- [ ] `data/world.json` is git-ignored (it is runtime store).
- [ ] `vRun` strips world ephemerals; faction fields coerce-with-defaults (a
      character saved before M1 loads cleanly, gets defaults, no rejection).

---

## MILESTONE 2 — Economy foundation ([A2])

Depends on M1 (faction fields exist; `data/world.json` + store pattern exist).
Adds `data/market.json` (the only second store doc), Prestige Shards / Rune Dust,
vault, salvage, reroll (server-side RNG), and the market listing/buy/bid/offer flow
+ the 60s market sweep folded into `world.tick`.

Key invariant risks: reroll RNG **server-only** (`server/market.js`, never
`shared/`); `goldEscrowed` clamp; circulation gauge is approximate (6h re-derive);
shard mint added to the `resolveDeath` **server wrapper**, not pure `resolveDeath`.

---

## MILESTONE 3 — Crafting, talents, sets, binding ([A1])

Depends on M1. Deterministic `shared/` heavy. Crafting threads run RNG
(`executeCraft(run,char,id,rng)` → server saves `run.rngState`). Talents/sets
stack in `derive` (back-compat when empty). Binding rules + reagent drop extend
`loot.js` (reagent roll uses the run rng → deterministic). Scars apply in
`freshRun` **before** backstory deltas, clamped to `STAT_MIN=1`.

Highest determinism risk in the project — every change here must keep smoke green.

---

## MILESTONE 4 — World simulation depth ([A6], [A7]-tagging)

Depends on M1. Fills in the `world.tick` sub-advancers: zone pressure (from batched
`notifyZoneEvent`), faction territory conquest (`pickFactionRaider`,
`zoneScores`→`conquestOwner`), world-event queue generation + **server-side
injection** into `run._pendingWorldEvents` at save-read, consumed once in
`delveTick` via the existing storyteller-effect block. `enemies.js` faction
tagging (additive). `applyWorldEvent` lives in `storyteller.js` (one effect path).

Invariant risks: world events applied post-RNG only (no `rngState` touch);
`_pendingWorldEvents` stripped by `vRun`; conquest mod via `run._factionZoneMod`
passed to `derive` as data (stats.js imports no store).

---

## MILESTONE 5 — Narrative engine ([A3])

Depends on M4 (world tick + world-event injection exist). World crises
(`WORLD_EVENTS` in `storyteller.js`, crisis SM in `world-tick.js`), `!fight`/`!pray`
/`!gather`/`!rally`/`!vote` contribution endpoints (throttled), `traitWorldMods`
in `derive`, narrative triggers, **unified `shared/quests.js`** (merging [A3]+[A7]
templates), `character.quests`/`questXp`/`questLevel`. `!fight` dual-dispatch
(raid + crisis) per canon §5.4.

---

## MILESTONE 6 — NPC intelligence ([A7])

Depends on M4 (zones/factions/world tick) + M5 (unified quests). `npc-defs.js`,
`npc-memory.js`, `faction-engine.js` (`applyKillRep` in `delveTick` post-encounter,
deterministic-safe, account-side). NPC schedules/memory ticked **inside
`world.tick`** (no separate loop). Oracle-driven dialogue reuses
`oracle-bazaar.js` with a new `tags` field + finalize hook. `npc/greet|ask|quest`
endpoints.

---

## MILESTONE 7 — Retention loops ([A4])

Depends on M2 (economy rewards) + M5 (narrative/quest reward plumbing).
`objectives.js`/`achievements.js`/`seasons.js` + `server/retention.js`. Daily/weekly
/season/achievements/bestiary/museum/monuments/hall-of-fame/global-challenge/world-
event. All sweeps folded into `world.tick` except the sanctioned 5s
`globalChallenge.flush`. `autoMuseumEnshrined` in the `resolveDeath` server wrapper.
`premiumUnlocked=false` hardwired.

---

## MILESTONE 8 — Twitch surface completion ([A5])

Depends on M2–M7. Full command vocabulary, voting architecture (in-memory
accumulator + `VOTE_EFFECTS` registry), `!gather`/`!craft`/`!trade` crowd
mechanics, prestige-gated `!raid` leader, collective challenges, and all additive
OBS overlay frames. Final scale/latency pass (smoke harness at 500–1000 simulated
chatters; event-loop lag <20ms).

---

## Global invariant-risk register (applies across milestones)

1. **Determinism desync (highest).** Any `shared/` edit that changes an existing
   seed's run output silently breaks offline↔live parity. Mitigation: smoke runs on
   every task; back-compat assertions for `derive`/`delveTick`; world effects only
   applied post-RNG; reroll/listing-ID/`Date.now()` RNG **server-only**.
2. **RUN/ACCOUNT line violation.** A persistent field accidentally placed in
   `run.*` is destroyed every death. Mitigation: §2 master-doc audit; `vRun` strips
   all `_`-prefixed and unknown run fields.
3. **Silent field drop.** New field without a `validate.js` validator vanishes.
   Mitigation: validator-first rule; round-trip serialization test per field.
4. **PSU power safety.** Multiple background loops co-spiking. Mitigation: ONE
   `world.tick`; no concurrent heavy `cargo`/test bursts; never run `bun run
   test:all` uncapped on this box.
5. **`FEED_KINDS`/`shared/factions.js` merge regressions.** Five agents touched
   each. Mitigation: single union (master §5.3) / single module (master §0.6)
   landed in M1 before downstream work.
6. **chat-elixir OTP-28 hang.** Never `mix test` from a subagent. Verify the bridge
   change with `mix compile`/grep; main agent runs tests synchronously when asked.
7. **World.json atomic-write growth.** Mitigation: `market.json` split out; graves
   + price-history as bounded rings; world doc target <5MB at 1000 players.
8. **Client-trust gap on `run._worldEffect`.** Client-applied, server-injected.
   Acceptable under current client-authoritative architecture; not used for
   leaderboard-affecting values. Closes if `delveTick` ever moves server-side.

---

## Definition of done (per milestone)

- `pnpm run smoke` green (determinism preserved).
- `pnpm run lpc:check` green if any cosmetic/enemy added.
- Every new field validated + round-trips through `vCharacter`/world validators.
- `grep -r Math.random shared/` empty.
- New endpoints under `guard()` + validated; respond <50ms at target load.
- Existing single-player game still playable (manual + smoke).
- The milestone's success criteria from its source agent doc pass.
