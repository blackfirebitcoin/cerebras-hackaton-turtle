# sigmashake-mmo Agent Guide

This is the public collaboration guide for SIGMA ABYSS, the local browser MMO
and OBS overlay runtime. Start with `README.md`, then use this file as the
working checklist for code changes.

## Collaboration Contract

- Keep public contributors inside `sigmashake-mmo/` unless the change is
  explicitly about the edge realm contract with `sigmashake-abyss`.
- Publish source, tests, public contracts, and local development docs. Do not
  publish live runtime data, streamer-local secrets, private OBS credentials,
  viewer PII, real tunnel output, or operator machine paths.
- The public mirror is allowlist-only. If a new file should be public, add it
  to `scripts/publish-mmo-mirror.sh` and keep the fail-closed scan green.
- Runtime state in `data/` is never public. It may contain player records,
  Twitch login mappings, public tunnel output, feed history, market state, and
  oracle task material.
- Secrets live outside the repo. Never commit an `MMO_HMAC_KEY`, OBS WebSocket
  password, Cloudflare token, OAuth secret, session cookie, or API key value.
- If you change the Agent Realm or Oracle Bazaar client contract, update
  `tools/`, `CLAUDE.md`, public docs, and the edge parity notes for
  `sigmashake-abyss`.

## Local Setup

```sh
pnpm install
pnpm start
```

Open `http://127.0.0.1:7777`.

For AI-agent routes, run a local agent:

```sh
node tools/agent-bot.js --name public-dev-agent
```

## Public Mirror

Dry-run the sanitized mirror:

```sh
bash scripts/publish-mmo-mirror.sh --write-evidence /tmp/mmo-mirror-evidence.env
```

The dry run stages a clean allowlisted tree, applies mirror-only scrubs, runs a
fail-closed secret/private-path scan, and prints the exact file list. It does
not push.

Confirming a publish requires release evidence from the same source commit and
prints the operator commands for the external mirror step:

```sh
bash scripts/publish-mmo-mirror.sh --confirm --evidence /tmp/mmo-mirror-evidence.env
```

GitHub repository visibility is a separate external setting. After the mirror is
published and reviewed, an operator can make the target repo public with:

```sh
gh repo edit sigmashakeinc/sigmashake-mmo --visibility public
```

## Required Gates

For docs or mirror changes:

```sh
bash -n scripts/publish-mmo-mirror.sh
pnpm run test:sast
pnpm run test:regression
```

For runtime changes, also run the affected targeted test and `pnpm run smoke`.

## Design Rules

- `shared/` stays deterministic and dual-runtime. Do not use `Math.random()` in
  shared simulation code.
- All server wire input passes through `server/validate.js`.
- Store access stays behind `server/store.js`.
- OBS setup must remain additive: create isolated scenes/sources, never mutate
  or switch a live scene.
- The local MMO and `sigmashake-abyss` edge realm share Agent Realm and Oracle
  Bazaar concepts. Keep public docs explicit about which runtime owns which
  behavior.
