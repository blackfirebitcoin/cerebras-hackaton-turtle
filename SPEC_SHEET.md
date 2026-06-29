# Sigma Shake MMO Spec Sheet

Last reviewed: 2026-06-28

This sheet is for collaborators adding features to **SIGMA ABYSS**, the Sigma
Shake MMO. It summarizes the current implementation, stable contracts, extension
points, and safety gates. For operator-facing setup, read `README.md`; for
agent-facing project rules, read `CLAUDE.md`; for system design depth, read
`docs/design/00-master-design.md`.

## Product Summary

SIGMA ABYSS is a browser-based retro auto-battler MMO:

- Pokemon Red/Blue-style overworld presentation.
- Solo Leveling progression curve.
- Diablo-style loot.
- Roguelike permadeath.
- Persistent shared-world systems layered over deterministic individual runs.
- OBS-friendly overlays and Twitch/YouTube chat integration.
- Agent Realm and Oracle Bazaar APIs for AI agents.

Each viewer has their own sigma. The sigma can delve, loot, die, bank gains,
join factions, trade, craft, answer quests, fight raids, duel, and participate
in shared world events. The browser client renders and runs the live loop; the
server owns identity, persistence, social/world state, API routing, chat-triggered
actions, and supervised background loops.

## Runtime Stack

- Runtime: Node.js 18+.
- Package manager: Bun or pnpm.
- Server: `node:http`, first-party Express-like router in `server/router.js`,
  and `ws` for WebSockets.
- Client: vanilla HTML/CSS/JavaScript + Canvas. No frontend framework.
- Simulation: dual-runtime ESM modules in `shared/`, imported by both browser
  and Node.
- Persistence: JSON-file store in `server/store.js` with debounced atomic
  writes and corrupt-file quarantine.
- Default bind: `127.0.0.1:7777`.
- Public access: Cloudflare quick tunnel or named tunnel.

## Directory Map

- `client/` - browser game, overlays, CSS, Canvas views, avatar renderer.
- `client/avatar/` - 24x32 layered LPC cosmetic renderer and related helpers.
- `client/js/` - main client state machine, networking, world/combat views,
  overlays, audio, UI, local save helpers.
- `server/` - HTTP server, route handlers, WebSocket layer, persistence,
  validation, raids, arena, world tick, market, forge, NPCs, onboarding,
  Agent Realm, Oracle Bazaar, OBS setup.
- `shared/` - deterministic simulation and catalogs used in browser and Node.
- `tools/` - CLI, MCP server, agent bot, LPC asset sync/check tools.
- `docs/design/` - persistent-world design and implementation plan.
- `data/` - runtime JSON store; not source of truth for code changes.
- `deploy/` - systemd units and tunnel setup.
- `test/` - unit, API, component, chaos, load, soak, stress, regression, SAST,
  DAST, penetration, failover, and dependency tests.

## Architectural Model

```text
Browser client
  -> WebSocket hello/save/event frames
  -> server/realtime.js
  -> server/store.js JSON documents

Chat / OBS / operator tools
  -> HTTP API routes in server/server.js
  -> validated mutation helpers
  -> shared simulation and server-only world systems

Shared deterministic sim
  -> shared/progression.js, combat.js, stats.js, rng.js, loot.js, zones.js, etc.
  -> imported by browser and server

Background loops
  -> supervisor.js superviseInterval
  -> world tick, flush, stats broadcast, raid/arena/storyteller loops
```

The original milestone was a multi-user vertical slice where each viewer played
their own sigma with shared feed and leaderboard. The current project also has
the persistent-world M1-M8 systems shipped: factions, reputation, economy,
market, crafting, talents, item sets, scars, zone pressure, faction territory,
world events, world crisis state, procedural quests, NPC memory, retention,
achievements, bestiary, museum, voting, raids, arena, and Oracle Bazaar.

## Core Invariants

- `shared/` must remain dual-runtime ESM. No Node built-ins, no DOM, no Canvas,
  no browser-only APIs, and explicit `.js` imports.
- Determinism is sacred. Do not use `Math.random()` in `shared/`. Use
  `makeRng()` and serialized RNG state.
- `delveTick(character)` is the single encounter tick used by live play and
  offline simulation.
- `simulateOffline(character, elapsedMs)` replays the same tick logic used live.
- `resolveDeath(character, deathInfo)` enforces the run/account split.
- Run data dies on permadeath: level, stats, gear, inventory, depth, HP, current
  delve state.
- Account data survives permadeath: prestige, gold, cosmetics, titles, lifetime
  records, faction/account systems, collections, retention data.
- Server wire inputs must pass through `server/validate.js`.
- Store access must stay behind `server/store.js`; do not scatter direct file IO.
- World systems run under one supervised world tick, `WORLD_TICK_MS = 60000`.
- OBS setup must remain additive; it creates isolated scenes/sources and does not
  edit or switch the live scene.

## Persistence Contract

`server/store.js` keeps in-memory state authoritative while the process runs and
flushes dirty documents to JSON with atomic rename.

Documents:

- `players.json` - token to character record.
- `feed.json` - capped shared event feed.
- `twitch-links.json` - Twitch login to anonymous player token.
- `agents.json` - Agent Realm bearer token to agent character.
- `oracle-tasks.json` - Oracle Bazaar tasks.
- `world.json` - shared world document.
- `market.json` - listings and buy orders.

Operational rules:

- Use `MMO_DATA_DIR` for isolated test or secondary instances.
- Corrupt JSON files are renamed aside and replaced with fresh state.
- Store writes are debounced; callers mutate through exported helpers and let the
  flush loop persist.
- Tests must not boot against live `./data` unless explicitly intended.

## Identity Model

Browser players:

- Start anonymous.
- Receive a `sig_<24 hex>` token through WebSocket `hello`.
- Browser saves token in local storage via `client/js/save.js`.
- Server persists character state by token.

Twitch/chat identity:

- Channel-point and chat-driven routes key by Twitch login.
- `store.getTokenByTwitch(login)` and `store.linkTwitch(login, token)` bridge a
  Twitch login to the internal anonymous token.
- Do not accept arbitrary player tokens from chat-triggered endpoints.

Agent Realm identity:

- Agents register through `POST /api/agent/register`.
- Server issues `agt_*` bearer tokens.
- Agent actions require bearer auth and cooldown compliance.

Privileged requester identity:

- HMAC-signed routes use `MMO_HMAC_KEY`.
- Signature verification is over the raw body for privileged endpoints such as
  boss spawn, agent-session events, and Oracle requester routes.

## HTTP Surface

### Core Public Reads

- `GET /healthz`
- `GET /api/feed`
- `GET /api/leaderboard`
- `GET /api/stats`
- `GET /api/sigma/:login`
- `GET /api/sigma/:login/loadout`
- `GET /api/passive-tree`
- `GET /api/weapon-catalog`
- `GET /api/world`
- `GET /api/faction/:id`
- `GET /api/faction/rep/:login`
- `GET /api/market`
- `GET /api/market/price/:slot/:rarity`
- `GET /api/vault/:login`
- `GET /api/economy`
- `GET /api/recipes/:login`
- `GET /api/talents/:login`
- `GET /api/sigma/:login/quests`
- `GET /api/daily/:login`
- `GET /api/achievements/:login`
- `GET /api/bestiary/:login`
- `GET /api/museum/:login`
- `GET /api/vote`
- `GET /api/world/npc/:id`
- `GET /api/drops`
- `GET /api/viewers`
- `GET /api/raid`
- `GET /api/duel`
- `GET /api/arena`
- `GET /api/arena/state`

### Player And Chat Writes

- `POST /api/chat-ping/:login`
- `POST /api/twitch-action/:login`
- `POST /api/faction/join/:login`
- `POST /api/market/list/:login`
- `POST /api/market/buy/:login`
- `POST /api/market/bid/:login`
- `POST /api/market/offer/:login`
- `POST /api/market/unlist/:login`
- `POST /api/salvage/:login`
- `POST /api/reroll/:login`
- `POST /api/vault/expand/:login`
- `POST /api/craft/:login`
- `POST /api/talent/unlock/:login`
- `POST /api/talent/respec/:login`
- `POST /api/scars/cleanse/:login`
- `POST /api/world/contribute/:login`
- `POST /api/daily-chest/:login`
- `POST /api/equip-title/:login`
- `POST /api/vote/:login`
- `POST /api/npc/greet/:login`
- `POST /api/npc/ask/:login`
- `POST /api/sigma/:login/swap-set`
- `POST /api/sigma/:login/passives`
- `POST /api/sigma/:login/weapons`
- `POST /api/sigma/:login/reserve`
- `POST /api/sigma/:login/position`
- `POST /api/sigma/:login/equip`
- `POST /api/upgrade-weapon/:login`
- `POST /api/drops/claim/:id`
- `POST /api/raid/fight/:login`
- `POST /api/raid/run/:login`
- `POST /api/duel/challenge`
- `POST /api/duel/accept`
- `POST /api/duel/decline`

### Privileged Writes

- `POST /api/spawn-boss` - HMAC-signed.
- `POST /api/agent-session` - HMAC-signed.
- `POST /api/viewers` - pushed by chat/overlay integration.
- `POST /api/vote/open`
- `POST /api/vote/close`

### Overlay And Static Views

- `GET /`
- `GET /overlay`
- `GET /overlay/panel`
- `GET /overlay/arena`
- static `client/`
- static `/shared`

### Agent Realm

- `POST /api/agent/register`
- `GET /api/agent/world`
- `GET /api/agent/me`
- `POST /api/agent/action/:kind`

Agent action kinds:

- `move`
- `fight`
- `gather`
- `rest`
- `craft`

All actions return or enforce cooldowns. A second action during cooldown should
return a cooldown error, not mutate state.

### Oracle Bazaar

Requester routes:

- `POST /api/oracle/tasks`
- `GET /api/oracle/tasks/:id`
- `POST /api/oracle/tasks/:id/cancel`

Worker routes:

- `GET /api/oracle/open`
- `POST /api/oracle/claim/:id`
- `POST /api/oracle/submit/:id`

Requester writes are HMAC-signed when `MMO_HMAC_KEY` is set. Worker routes use
agent bearer tokens and require appropriate Agent Realm position where enforced.

### One-Paste Agent Onboarding

- `GET /play`
- `GET /play.sh`
- `GET /play.ps1`
- `GET /play/agent.mjs`

These routes generate copy-paste bootstraps for viewers to run AI agents against
the Agent Realm and Oracle Bazaar.

## WebSocket Contract

Implemented in `server/realtime.js`.

Inbound messages:

- `ping` - returns `pong`.
- `hello` - establishes anonymous token, optional Twitch claim, and returns
  character/feed/leaderboard/arena/drops/raid state.
- `save` - validates and persists character state, throttled by
  `SAVE_MIN_INTERVAL_MS`.
- `event` - validates and broadcasts feed events.

Outbound messages include:

- `welcome`
- `saved`
- `feed`
- `stats`
- `error`
- `pong`

Safety rules:

- WebSocket `maxPayload` caps inbound frame size.
- Per-connection rate limit is enforced by `WS_RATE`.
- All frames are parsed through `parseMessage()`.
- A bad message returns `{t:"error"}` and must not crash the process.
- The live-delve server path should not advance a run while the same token is
  actively owned by a browser WebSocket, or RNG state can fork.

## Shared Simulation Contracts

Key modules:

- `shared/rng.js` - seeded RNG and seed mixing.
- `shared/constants.js` - schema, tuning, limits, slots, timers, bounds.
- `shared/progression.js` - character creation, deploy/retreat/bank, delve tick,
  death resolution, offline simulation, XP, loadout set swapping.
- `shared/combat.js` - encounter resolution.
- `shared/stats.js` - derived stats, build selection, gear mods, damage math.
- `shared/loot.js` - item generation and raid drops.
- `shared/zones.js` and `shared/enemies.js` - playable zone/enemy catalogs.
- `shared/factions.js` and `shared/faction-engine.js` - faction catalog, rep,
  combat/world modifiers.
- `shared/market.js`, `shared/crafting.js`, `shared/item-sets.js`,
  `shared/skill-talents.js` - economy and build extension systems.
- `shared/quests.js`, `shared/objectives.js`, `shared/achievements.js` - quest
  and retention loops.
- `shared/agent-world.js` - Agent Realm map/catalog.
- `shared/vampire-survivors.js`, `shared/passive-tree.js`, `shared/weapons.js` -
  VCS/build/weapon contracts.

When adding shared simulation features:

- Add constants and validators together.
- Preserve absent-field exact identity. Existing characters with no new field
  should produce byte-compatible `derive()`/`delveTick()` behavior.
- Keep server-only randomness in `server/`.
- Apply injected world effects after RNG state is saved or as a single
  accounted-for RNG draw.
- Add regression coverage for offline/live parity when the feature touches
  `delveTick`, `derive`, loot, enemies, or death.

## Persistent World Contract

Authoritative design: `docs/design/00-master-design.md`.

Binding canon:

- Five factions map to the five danger zones.
- Reputation is a `factionRep` map in `0..1000`, neutral baseline 500.
- Joined faction lives on `character.faction`.
- One world tick runs at `WORLD_TICK_MS = 60000`.
- World state is stored in `world.json`; market state is stored in `market.json`.
- World effects reach runs through server-injected transient fields such as
  `_pendingWorldEvents` and `_factionZoneMod`.
- Validators strip or bound untrusted run/account/world inputs.

Primary server modules:

- `server/world-tick.js`
- `server/commands.js`
- `server/market.js`
- `server/forge.js`
- `server/npc-world.js`
- `server/retention.js`
- `server/voting.js`
- `server/storyteller-loop.js`

Do not add new background timers for world subsystems unless there is a strong
operational reason. Prefer adding a sub-advancer under the existing supervised
world tick.

## Frontend Contract

Primary files:

- `client/index.html` - playable game shell.
- `client/js/main.js` - bootstrap.
- `client/js/game.js` - client state machine and live loop.
- `client/js/net.js` - WebSocket client and reconnect.
- `client/js/save.js` - local storage token/save helpers.
- `client/js/ui.js` - DOM HUD and panels.
- `client/js/world.js` - overworld rendering.
- `client/js/combat-view.js` - encounter animation.
- `client/js/overlay.js`, `client/js/arena.js` - stream overlays.
- `client/avatar/*` - layered LPC avatar renderer.

Rules:

- Browser code may import from `/shared/...`; keep those modules browser-safe.
- Client-rendered state must be treated as untrusted by the server.
- If adding a UI panel for a server feature, wire it through validated HTTP or
  WebSocket contracts rather than mutating persisted shapes directly.
- Keep the game playable with no build step.

## Extension Recipes

### Add a new player/account field

Touch points:

- `shared/progression.js` for default creation or death carryover.
- `server/validate.js` for persistence validation.
- `client/js/*` if the field is displayed or edited.
- Relevant tests under `test/unit` and `test/regression`.

Checklist:

- Decide whether the field belongs to run, account, world, market, agent, or
  oracle state.
- Ensure permadeath behavior is explicit.
- Ensure absent-field behavior is compatible with existing saves.

### Add a new gear slot, item family, affix, or loot behavior

Touch points:

- `shared/constants.js`
- `shared/loot.js`
- `shared/stats.js`
- `shared/validate.js` equivalent: `server/validate.js`
- `client/js/ui.js` and rendering views.
- `test/unit` and shared-contract tests.

Checklist:

- Preserve `derive()` identity for old characters.
- Keep inventory bounds intact.
- Add deterministic regression tests for item generation or combat math.

### Add a new HTTP endpoint

Touch points:

- `server/server.js` or a focused attached module.
- `server/validate.js` for all wire inputs.
- `tools/sigmashake-mmo-cli.js` if operators/agents need it.
- `tools/sigmashake-mmo-mcp.js` if AI agents need it as a tool.
- `test/api/routes.test.js` or focused unit tests.

Checklist:

- Use `guard()` around the handler.
- Bound body size.
- Authenticate privileged writes with HMAC or bearer auth as appropriate.
- Return structured JSON errors.

### Add an Agent Realm action

Touch points:

- `shared/agent-world.js` for catalogs/map semantics if needed.
- `server/agent-realm.js` for action validation and mutation.
- `shared/constants.js` for cooldown tuning.
- `tools/agent-bot.js`, CLI, MCP if agents should use it.

Checklist:

- Enforce cooldown.
- Keep action results deterministic or explicitly server-random only.
- Persist through `store.putAgent()`.

### Add an Oracle Bazaar feature

Touch points:

- `server/oracle-bazaar.js`
- `shared/constants.js` for prompt/answer/redundancy/TTL bounds.
- CLI/MCP tools if requesters or workers need the feature.
- `tools/agent-bot.js` if worker behavior changes.

Checklist:

- Requester writes use HMAC where required.
- Worker routes use agent bearer tokens.
- Prompt/context/answer sizes stay bounded.
- Completed task retention stays capped.

### Add a world subsystem

Touch points:

- `docs/design/00-master-design.md` for canon changes.
- A focused `shared/` module for pure catalogs/math.
- A focused `server/` module for mutations.
- `server/world-tick.js` as a sub-advancer if periodic.
- `server/store.js` only if a new persisted document is unavoidable.
- `server/validate.js` for all persisted fields.

Checklist:

- Prefer `world.json` sections or `market.json`; avoid new files.
- Do not add another timer when the 60s world tick can own it.
- Keep server-only RNG out of `shared/`.
- Add tests for world tick mutation and validation.

### Add LPC/avatar assets

Touch points:

- `client/avatar/lpc-manifest.js`
- `tools/sync-lpc-assets.js`
- `client/assets/lpc/`
- generated attribution docs.

Checklist:

- Sync from the git-ignored LPC vendor source.
- Run `pnpm run lpc:sync`.
- Run `pnpm run lpc:check`.
- Keep attribution shipped.

## Tools And Headless Surfaces

CLI: `tools/sigmashake-mmo-cli.js`.

Important commands:

- `health`
- `stats`
- `feed`
- `leaderboard`
- `sigma <login>`
- `raid`
- `viewers`
- `drops`
- `weapon-catalog`
- `weapons`
- `chat-ping <login>`
- `oracle-ask`
- `oracle-post`
- `oracle-status`
- `oracle-cancel`
- `agent-register`
- `agent-world`
- `agent-me`
- `agent-action`
- `oracle-open`
- `oracle-claim`
- `oracle-submit`

MCP: `tools/sigmashake-mmo-mcp.js`.

Current tools include:

- `mmo_health`
- `mmo_stats`
- `mmo_feed`
- `mmo_leaderboard`
- `mmo_sigma`
- `mmo_raid`
- `mmo_viewers`
- `mmo_drops`
- `mmo_weapon_catalog`
- `mmo_weapons`
- `oracle_ask`
- `oracle_post`
- `oracle_status`

Config:

- `MMO_BASE_URL`, default `http://127.0.0.1:7777`.
- `MMO_HMAC_KEY` for privileged requester routes.
- `MMO_AGENT_TOKEN` for agent worker routes.

## Local Development

Install:

```sh
bun install
```

Run:

```sh
pnpm start
# or
bun run dev
```

Open:

```text
http://127.0.0.1:7777
```

Public tunnel:

```sh
pnpm run tunnel
```

OBS scene setup:

```sh
OBS_WS_PASSWORD=<password> node server/obs-setup.js
```

## Public Collaboration Mirror

The public `sigmashake-mmo` repository is an allowlisted mirror of this
subtree. Publish only source, tests, public docs, and local development
contracts.

Never mirror:

- `data/` runtime state, player/session records, tunnel output, feed history,
  market state, or oracle task payloads.
- OBS WebSocket passwords, OAuth/API secrets, agent bearer tokens, HMAC secret
  values, Cloudflare credentials, or local operator paths.
- Private on-call, privacy, customer, SLO, and postmortem documents unless a
  public-safe version is intentionally written.

Mirror checks:

```sh
bash -n scripts/publish-mmo-mirror.sh
pnpm run mirror:public:evidence
pnpm run test:sast
pnpm run test:regression
```

After those checks pass from a clean committed tree, append the required
evidence lines and run the confirm path:

```sh
bash scripts/publish-mmo-mirror.sh --confirm --evidence /tmp/mmo-mirror-evidence.env
```

GitHub visibility is external to the mirror script:

```sh
gh repo edit sigmashakeinc/sigmashake-mmo --visibility public
```

## Verification

Fast core checks:

```sh
pnpm run smoke
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:api
```

Asset checks:

```sh
pnpm run lpc:check
```

Broader package scripts:

```sh
pnpm run test:component
pnpm run test:chaos
pnpm run test:regression
pnpm run test:load
pnpm run test:stress
pnpm run test:spike
pnpm run test:soak
pnpm run test:scalability
pnpm run test:sast
pnpm run test:dependencies
pnpm run test:failover
pnpm run test:dast
pnpm run test:pen
```

Minimum PR gate depends on changed surface:

- Shared simulation: smoke, unit, regression, typecheck.
- API route: API tests plus relevant unit tests.
- WebSocket/realtime/store: component or integration boot tests plus chaos/failover
  when behavior changes.
- Assets/avatar: `lpc:check` plus UI smoke.
- Oracle/Agent Realm: focused unit/API tests and CLI/MCP smoke where applicable.

## Security And Safety

- Treat every browser and WebSocket input as hostile.
- Keep validation centralized in `server/validate.js`.
- Use HMAC for privileged server-to-server writes.
- Keep agent bearer tokens out of logs and browser code.
- Bound all request bodies and text fields.
- Do not expose the loopback server directly to the LAN unless intentionally
  fronted and reviewed.
- Use Cloudflare tunnel or a controlled reverse proxy for public access.
- Keep OBS setup additive.
- Keep tests isolated with `MMO_DATA_DIR`.
- Keep `data/`, `bin/`, tunnel credentials, and local env files out of git.

## Collaborator PR Checklist

- State which extension recipe your change follows.
- Identify every touched contract: shared sim, HTTP, WebSocket, store, client,
  Agent Realm, Oracle Bazaar, CLI/MCP, assets, OBS, or design docs.
- Preserve deterministic shared simulation.
- Add or update validators for every persisted or wire-visible field.
- Add tests for the changed contract.
- Update CLI/MCP if agents or operators need the new endpoint.
- Update design docs if the world canon changes.
- Run the relevant verification gate before handoff.
