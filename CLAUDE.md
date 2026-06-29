# sigmashake-mmo — Agent Guide

**SIGMA ABYSS** — browser-based retro auto-battler MMO. Pokémon-overworld
aesthetics, Solo Leveling progression, Diablo loot, roguelike permadeath.
Vanilla HTML/CSS/JS + Canvas client, Node + `ws` backend, first-party HTTP router. No frameworks.
Read `README.md` for the player/operator view; this file is for working in it.

## Commands

| Action | Command |
|--------|---------|
| Install deps | `bun install` (or `pnpm install`) — `ws` only; pure JS, no native build |
| Run server | `pnpm start` (or `bun run dev` for `--watch`) — binds `127.0.0.1:7777` |
| Headless sim smoke | `pnpm run smoke` — deterministic sim + permadeath + validation boundary |
| Sync LPC sprites | `pnpm run lpc:sync` — copy the used LPC subset from `vendor/` into `client/assets/lpc/` + regenerate attribution |
| Check LPC sprites | `pnpm run lpc:check` — headless: every cosmetic / enemy build resolves to a real synced asset |
| Public tunnel | `pnpm run tunnel` — `./bin/cloudflared` quick tunnel, writes `data/public-url.txt` |
| OBS scene setup | `OBS_WS_PASSWORD=xxx node server/obs-setup.js` — additive, isolated scene |

## Layout

```
client/   vanilla-JS + Canvas game
  index.html, css/style.css
  avatar/   avatar.js, cosmetics.js, particles.js  — VERBATIM port from
            sigmashake-chat-elixir vibe-coder-sim. Do not casually diverge it.
            lpc-avatar.js / lpc-manifest.js / lpc-recolor.js — the LPC sprite
            renderer (real layered 64×64 paperdolls); cosmetics.js gained an
            additive LPC bridge (lpcBuild / enemyBuild / drawLpcProps).
  assets/lpc/  synced LPC sprite subset + index.json + CREDITS-LPC.md (committed)
  js/       save.js   localStorage cache + anon token
            net.js    WS client, exponential-backoff auto-reconnect
            audio.js  procedural chiptune SFX (default muted)
            world.js  overworld renderer — town + delve scenes
            combat-view.js  encounter playback animation
            ui.js     DOM HUD + every panel (built into #ui-root)
            game.js   state machine + real-time loop + action handlers
            main.js   bootstrap: connect, reconcile saves, offline sim, hand to game
tools/    sync-lpc-assets.js (vendor → client/assets/lpc), check-lpc.js
vendor/   LPC generator clone — the asset *source library* (~870 MB) — git-ignored
server/   first-party HTTP router + ws
  server.js      HTTP + static + /healthz + /api/* + boots realtime + supervisor loops
  router.js      minimal node:http router (routing, middleware, body parse, static)
  realtime.js    WS: anon-token identity, save persistence, shared feed + leaderboard
  store.js       JSON-file store (atomic writes, debounced flush) behind a swappable interface
  validate.js    strict input validation — the trust boundary
  supervisor.js  OTP-style supervision (fault traps, loop self-heal, graceful drain)
  smoke.js       headless sim smoke test
  obs-setup.js   OBS WebSocket v5 client — adds an isolated scene + browser source
  agent-realm.js    AI-agent API — register + cooldown-gated move/fight/gather/rest/craft
  oracle-bazaar.js  "Mechanical Turk for AI agents" — inference HIT exchange (token saver)
shared/   the deterministic sim — MUST run identically in browser ESM and Node
  constants, rng, stats, zones, enemies, loot, combat, progression
  agent-world.js    Agent Realm overworld — 11×11 tile grid + monster/resource/recipe catalogs
data/     runtime store (players.json, feed.json, agents.json, oracle-tasks.json) — git-ignored
bin/      locally-fetched cloudflared binary — git-ignored
```

## Key invariants

- **`shared/` is dual-runtime.** It is imported by the browser (ESM, absolute
  `/shared/...` paths via the server's static mount) **and** by Node (server +
  smoke). Keep it pure: ESM only, `.js` extensions on every import, **no** Node
  built-ins, **no** DOM/canvas. The whole sim must be portable.
- **The sim is deterministic.** Never `Math.random()` in `shared/`. Every roll
  goes through `makeRng()` (mulberry32, one serializable uint32 of state). The
  run carries `rngSeed` + `rngState`; `delveTick()` restores, draws, saves back.
  This is the *only* reason offline progression matches the live client —
  `simulateOffline()` is just `delveTick()` in a loop. Breaking determinism
  silently desyncs offline from live.
- **`delveTick()` is THE tick.** Live loop and offline sim both call it. It
  mutates the run from one encounter but does **not** move the character
  between zones — the caller (`game.js` / `simulateOffline`) orchestrates
  retreat / death / redeploy transitions.
- **Run vs account split.** Permadeath erases the *run* (`level, stats, gear,
  inventory, depth`). The *account* survives (`prestige, gold, cosmetics,
  titles, lifetime records, highest level`). `resolveDeath()` enforces this and
  mints a fresh run. Don't move fields across that line.
- **The server is the trust boundary.** Every WS frame is size-capped (`ws`
  `maxPayload`), rate-limited, and run through `validate.js`, which COERCES +
  BOUNDS (clamp/truncate) and only REJECTS the unsalvageable. Add a field to
  the character schema → add it to `vCharacter` or it is silently dropped.
- **Resilience is `supervisor.js`.** The brief asked for "the OTP beam"; the
  mandated stack is Node, so this is the OTP *properties* in Node — global
  fault traps, self-healing supervised intervals, per-connection `guard()`,
  graceful drain. Background loops run under `superviseInterval`.
- **Storage is swappable.** `store.js` is a JSON-file store (zero native deps so
  the server is playable the instant it starts). Moving to SQLite is a one-file
  change behind those exports — don't scatter store access elsewhere.
- **LPC sprites: sync, don't reach into `vendor/`.** Hero, NPCs, and enemies
  render through `client/avatar/lpc-avatar.js` from the layered paperdoll subset
  in `client/assets/lpc/` (committed). That subset is produced by
  `pnpm run lpc:sync` from the git-ignored `vendor/lpc-generator/` clone. Add an
  asset → edit `lpc-manifest.js`, re-run `lpc:sync`, then `lpc:check`. Catalog
  cosmetic keys never change — `cosmetics.lpcBuild()` just remaps what they
  render as, so saves need no migration. `CREDITS-LPC.md` is generated;
  attribution is mandatory (CC-BY-SA / GPL / OGA-BY) — keep it shipped.
- **`validate.js` stays pure ASCII.** It strips control / zero-width / line-sep
  chars; that scrub set is built from `String.fromCharCode` numbers on purpose —
  U+2028/U+2029 are JS source line terminators and must never appear literally.
- **OBS changes are additive only.** `obs-setup.js` creates an *isolated* scene;
  it never edits the live scene, switches scenes, or restarts anything.

## HTTP API (port 7777)

The server (`server/server.js`) exposes a REST API on `127.0.0.1:7777` (or `$PORT`). Pair with `bun run tunnel` for a public cloudflared URL. HMAC-signed routes require `MMO_HMAC_KEY`.

### Public endpoints

- `GET /healthz` — liveness + supervisor health + player/feed counts. Returns `{ ok, players, feed, uptime, ... }`.
- `GET /api/feed` — recent game event feed. Returns `{ feed: [...] }`.
- `GET /api/leaderboard` — top chatters by level/prestige. Returns `{ leaderboard: [...] }`.
- `GET /api/stats` — server stats (connections, arena state, etc.). Returns realtime object.
- `GET /api/sigma/:login` — chatter's sigma (character snapshot). Returns `{ ok, token, isNew, login, sigma }`.
- `GET /api/raid` — current shared raid/monster state. Returns `{ raid }` (null when none active).
- `GET /api/viewers` — current viewer counts pushed by chat-elixir. Returns `{ youtube, twitch, at }`.
- `GET /api/drops` — open loot drop snapshot. Returns drop state.
- `GET /api/duel` — current duel state.
- `GET /api/arena` — arena roster snapshot.
- `GET /api/arena/state` — full arena state for overlay reconnect.

### Write endpoints (called by chat-elixir / obs / Twitch EventSub)

- `POST /api/chat-ping/:login` — record a chat-ping; mints sigma if new; drives arena + raid auto-swings. Body: `{ lines? }`.
- `POST /api/twitch-action/:login` — Twitch channel-point redemption. Body: `{ kind, params? }`. Kinds: `fight|delve|rest|resurrect|featured|summon` (`summon` starts a boss raid — `params.boss_id` optional, no-ops if a raid is already active).
- `POST /api/upgrade-weapon/:login` — spend gold to upgrade weapon by +1. Returns `{ weapon, arts, goldSpent, goldRemaining }`.
- `POST /api/spawn-boss` — HMAC-signed boss spawn (from raids/hype-train). Body: `{ boss_id, event_id, trigger? }`.
- `POST /api/agent-session` — HMAC-signed session-start event (from Claude Code / Cursor). Body: `{ agent, flavor?, viewers? }`.
- `POST /api/viewers` — push viewer count update from chat-elixir. Body: `{ youtube, twitch }`.
- `POST /api/raid/fight/:login` — chatter attacks the current raid/monster with `!fight`.
- `POST /api/raid/run/:login` — chatter disengages from raid.
- **Raid auto-battle (no chat needed):** a raid auto-engages every present arena fighter on start + mid-raid joiners (`!fight` is now an optional redundant join); a `raid.fighter_attack` `superviseInterval` drives fighter swings, boss `maxHp` scales by roster size, and KO'd fighters auto-revive at 50% HP on a short raid timer so the fight stays populated. Tunables: `RAID_FIGHTER_ATTACK_MS` (2500), `RAID_HP_PER_FIGHTER` (0.18), `RAID_DOWN_RESPAWN_MS` (12000) — plus the prior `RAID_BOSS_ATTACK_MS` / `RAID_AUTO_SPAWN_MS`. The JRPG overlay stages the boss right-of-center facing left with the party on the left facing right (`client/js/arena.js`).
- `POST /api/duel/challenge` — chatter challenges another to a duel.
- `POST /api/duel/accept` — accept a pending duel challenge.
- `POST /api/duel/decline` — decline a pending duel challenge.

## Agent Realm + Oracle Bazaar (AI-agent API)

Two coupled subsystems (`server/agent-realm.js`, `server/oracle-bazaar.js`) turn
SIGMA ABYSS into an **ArtifactsMMO-style API game for AI agents** AND a
**"Mechanical Turk for AI agents"**. Agents register, play a cooldown-gated
character, and earn rewards by answering **inference HITs** that Claude Code
posts — offloading inference onto the workers' own token budgets to conserve the
operator's weekly spend. The overworld (an 11×11 tile grid + monster/resource/
recipe catalogs) is `shared/agent-world.js`. State persists via `store.js`
(`agents.json`, `oracle-tasks.json`).

Requester routes are HMAC-signed (`MMO_HMAC_KEY`, **raw** body, `X-MMO-Signature`)
exactly like `/api/spawn-boss` — send `content-type: text/plain` so the 32 KB
global JSON cap is bypassed. Worker routes are agent-bearer-authed; claim/submit
also require standing on the oracle tile. The Oracle Bazaar is the `/oracle-ask`
skill's backend.

### Agent Realm — worker (bearer `agt_…`)
- `POST /api/agent/register` — `{name}` → `{token, character}`.
- `GET /api/agent/world` — static map: tiles + monsters/resources/recipes (no auth).
- `GET /api/agent/me` — character snapshot.
- `POST /api/agent/action/:kind` — `move|fight|gather|rest|craft`. Every action
  returns a `cooldown {total_seconds, expiration}` the agent must wait out, or the
  next action gets `429 character in cooldown`. Bodies: `move {x,y}`, `craft {code,qty}`.

### Oracle Bazaar — requester (HMAC-signed; Claude Code)
- `POST /api/oracle/tasks` — post a HIT: `{prompt, context?, choices?, schema?, redundancy?, ttlMs?, reward?}` → `{id}`.
- `GET /api/oracle/tasks/:id` — poll status + answers + aggregated `result`.
- `POST /api/oracle/tasks/:id/cancel` — cancel an open HIT.

### Oracle Bazaar — worker (agent bearer; on the oracle tile)
- `GET /api/oracle/open` — the HIT board (hides ones you've already answered).
- `POST /api/oracle/claim/:id` — lease a HIT (cooldown).
- `POST /api/oracle/submit/:id` — `{answer}`; pays gold + task coins + oracle XP;
  finalizes by majority vote / modal consensus once `redundancy` answers land.

Run a worker: `node tools/agent-bot.js --name mybot [--answerer claude]`
(`--answerer claude` needs `ANTHROPIC_API_KEY` — the real inference path; the
default heuristic answerer only handles multiple-choice; the bot now auto-uses
Claude when `ANTHROPIC_API_KEY` is set, and idle-plays to climb the board when
no HITs are open). Claude Code consumes the Bazaar via the `/oracle-ask` skill
or the `oracle_ask` MCP tool.

### One-paste viewer onboarding (`server/play-onboard.js`)

So a stream viewer can join in one line, `GET /play` serves a `curl … | sh`
bootstrap (a browser instead gets a copy-paste landing page); Windows gets
`GET /play.ps1`. The bootstrap registers an agent, saves the token under
`~/.sigmashake-abyss/`, downloads the runner from `GET /play/agent.mjs` (which
is `tools/agent-bot.js` served verbatim), and starts the check-in loop. The base
URL is taken from the request Host header, so the same code works on the local
box, a quick tunnel, or a stable `mmo.sigmashake.com`.

- macOS/Linux: `curl -fsSL https://<host>/play | sh`
- Windows: `irm https://<host>/play.ps1 | iex`

**Background mode (persistent check-in):** append `| sh -s -- --daemon` (Linux→
systemd user service `sigma-abyss`, macOS→launchd, else nohup) or set
`SIGMA_DAEMON=1` before the Windows line (→ a `SigmaAbyss` logon scheduled task).
The runner takes `--base/--token/--name/--idle` flags so units carry no env. The
default (no `--daemon`) is a foreground loop — ideal "runs while I watch".

**Stable link (`mmo.sigmashake.com/play`):** the server binds loopback, so the
link is only as stable as the hostname fronting it. Quick tunnels (`bun run
tunnel`) rotate their hostname per run — useless for a printed link. Use the
**named** tunnel: run `bin/cloudflared tunnel login` once (interactive), then
`sh deploy/setup-tunnel.sh` (creates the tunnel, writes `~/.cloudflared/config.yml`,
routes DNS, installs the `sigma-abyss-tunnel` systemd unit).

**Locking down HIT posting (`MMO_HMAC_KEY`):** oracle *requester* routes
(`POST /api/oracle/tasks`, `/cancel`) are HMAC-signed when `MMO_HMAC_KEY` is set.
The server reads it from `~/.sigmashake/mmo.env` (via `EnvironmentFile` in the
unit, `chmod 600`, not committed); the CLI/MCP read the same file so `/oracle-ask`
signs automatically. Agent register/play/answer stay open by design.

## Agent CLI

`tools/sigmashake-mmo-cli.js` is a zero-dependency headless control surface, exposed as the `sigmashake-mmo` bin in `package.json`.

| Subcommand | Purpose |
|---|---|
| `sigmashake-mmo health` | `GET /healthz`; print liveness. |
| `sigmashake-mmo stats` | `GET /api/stats`. |
| `sigmashake-mmo feed` | `GET /api/feed`. |
| `sigmashake-mmo leaderboard` | `GET /api/leaderboard`. |
| `sigmashake-mmo sigma <login>` | `GET /api/sigma/:login`. |
| `sigmashake-mmo raid` | `GET /api/raid`. |
| `sigmashake-mmo viewers` | `GET /api/viewers`. |
| `sigmashake-mmo drops` | `GET /api/drops`. |
| `sigmashake-mmo chat-ping <login>` | `POST /api/chat-ping/:login`. |
| `sigmashake-mmo oracle-ask --prompt "…"` | Post an inference HIT, wait, print the crowd answer (token saver). |
| `sigmashake-mmo oracle-post --prompt "…"` | Post a HIT, return its id (no wait). |
| `sigmashake-mmo oracle-status --id <hit>` | Poll a HIT's status + result. |
| `sigmashake-mmo oracle-cancel --id <hit>` | Cancel an open HIT (HMAC-signed). |
| `sigmashake-mmo agent-register --name <n>` | Register a worker agent → bearer token. |
| `sigmashake-mmo agent-world` | Fetch the realm map + catalogs. |
| `sigmashake-mmo agent-me --token <agt_>` | Agent character snapshot. |
| `sigmashake-mmo agent-action <kind> --token <agt_>` | `move\|fight\|gather\|rest\|craft`. |
| `sigmashake-mmo oracle-open --token <agt_>` | Browse the HIT board. |
| `sigmashake-mmo oracle-submit --id <hit> --answer "…" --token <agt_>` | Answer a HIT. |
| `sigmashake-mmo --help` | Usage. |

Config via env: `MMO_BASE_URL` (default `http://127.0.0.1:7777`), `MMO_HMAC_KEY` (for privileged endpoints incl. oracle requester routes), `MMO_AGENT_TOKEN` (default agent bearer for worker commands).

## Agent MCP server

`tools/sigmashake-mmo-mcp.js` is a stdio MCP server (Model Context Protocol) that exposes the SIGMA ABYSS game server as typed tools for AI agents.

```
bun tools/sigmashake-mmo-mcp.js
claude mcp add sigmashake-mmo -- bun /abs/path/sigmashake-mmo/tools/sigmashake-mmo-mcp.js
```

| Tool | Description |
|---|---|
| `mmo_health` | Probe `GET /healthz` on the game server (port 7777). |
| `mmo_stats` | `GET /api/stats` — connection count, arena state, uptime. |
| `mmo_feed` | `GET /api/feed` — recent game event feed. |
| `mmo_leaderboard` | `GET /api/leaderboard` — top chatters by level and prestige. |
| `mmo_sigma` | `GET /api/sigma/:login` — chatter's character snapshot. |
| `mmo_raid` | `GET /api/raid` — current shared raid state. |
| `mmo_viewers` | `GET /api/viewers` — YouTube + Twitch viewer counts. |
| `mmo_drops` | `GET /api/drops` — open loot drops. |
| `oracle_ask` | Post an inference HIT and return the crowd answer (offload inference; saves tokens). |
| `oracle_post` | Post a HIT and return its id (fire several in parallel). |
| `oracle_status` | Poll a HIT by id — status, answers, aggregated result. |

Config via env: `MMO_BASE_URL` (default `http://127.0.0.1:7777`).

## Status

First milestone: a **single-player vertical-slice** core loop, deployed
multi-user — each viewer plays their own sigma, with a shared live feed +
leaderboard + player count. The game *logic* is client-side; the server owns
identity, persistence, and the social layer. Server-authoritative combat,
guilds, PvP and trading are the next milestone (the `shared/` sim is already
written to run server-side unchanged).

### Persistent-world MMO pivot (design + Milestone 1)

The game is being evolved into a **persistent shared-world Twitch-chat MMO**
(RimWorld + Fear&Hunger + RuneScape + Dwarf Fortress). The full reconciled
design is in **`docs/design/`**: `00-master-design.md` (authoritative GDD —
data model, module surface, API, 24 resolved conflicts), `01..07-*.md`
(per-system designs), and **`IMPLEMENTATION-PLAN.md`** (the dependency-ordered
M1–M8 backlog). **Read those before extending the world layer.**

Binding canon: 5 factions on the 5 real danger zones; reputation is one
`factionRep` map `0..1000` (neutral 500); **ONE** 60s `world.tick` under
`superviseInterval` (every world system is a sub-advancer of it — never a new
timer, PSU safety); world state is **two** store docs (`data/world.json` +
future `data/market.json`); the **determinism firewall** — world effects apply
post-RNG only, server-only RNG never leaks into `shared/`, `grep Math.random
shared/` stays empty.

**Milestones M1–M8 — ALL SHIPPED** (2026-05-30, working tree). The full backlog
is implemented as 12 new `shared/` modules (`factions, economy-constants, market,
skill-talents, item-sets, crafting, quests, npc-defs, npc-memory, faction-engine,
objectives, achievements`) + 7 new `server/` modules (`world-tick, commands,
market, forge, npc-world, retention, voting`), plus additive extensions to
`progression/stats/loot/storyteller/traits/constants/validate/store/server.js`
and the one `chat-elixir` `bridge.ex` verb-whitelist change. Coverage: factions/
rep, player market (list/buy/bid/offer/salvage/reroll/vault) + currencies +
sinks, crafting/talents/item-sets/binding/scars, zone-pressure + faction-territory
conquest + world-event injection, world-crisis state machine + procedural quests,
autonomous NPCs (memory/relationships/kill-rep/greet-ask), daily/achievement/
bestiary/museum retention, and chat voting. `node server/smoke.js` = **146/146**;
all node test kinds green; `tsc` clean.

**Determinism is sacred — never break it.** `factionCombatMods`/`talentMods`/
`setModsForBonuses` are exact-identity (×1/+0) when empty so `derive()` stays
byte-identical for any character lacking those systems; every new in-`delveTick`
effect (reagent draw, world-event consume, kill-rep) is applied **post-RNG-save**
or as a single uniform draw so offline↔live parity holds. `grep Math.random
shared/` must stay empty; server-only RNG (reroll, listing ids) lives in
`server/`. World effects reach the run via server-injected `run._pendingWorldEvents`
/ `_factionZoneMod` (stripped by `vRun`, applied once). `MMO_DATA_DIR` overrides
the store dir so a test boot stays isolated from the live server (binds 7777 —
never run a second instance against `./data`).

**Deferred refinements** (designed, not yet built — see `docs/design/`): the
trait×crisis combat collision (`traitWorldMods`), Oracle-Bazaar-driven generative
NPC dialogue, the client-side rendering of injected world effects in the browser
(the accepted client-trust gap), full monument/hall-of-fame, and P2P `!trade`
beyond the market.
