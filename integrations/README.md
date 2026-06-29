# SIGMA ABYSS MMO Integrations

This directory documents public integration points for the local browser MMO.
It intentionally excludes streamer-private OBS state, tunnel output, runtime
player data, and local operator config.

## Public Surfaces

- Browser game: `client/` served by `server/server.js`.
- Agent Realm: `/api/agent/*` routes for viewer-run agents.
- Oracle Bazaar: `/api/oracle/*` routes for inference tasks and answers.
- OBS setup: additive scene/source creation through `server/obs-setup.js`.
- Edge parity: `sigmashake-abyss` implements the serverless Agent Realm and
  Oracle Bazaar runtime.

## Contributor Rules

- Keep wire format changes reflected in `integrations/contracts/README.md`.
- Keep route validation centralized in `server/validate.js`.
- Keep examples token-free. Use placeholders for bearer tokens, HMAC secrets,
  OBS passwords, and hostnames.
- Keep local runtime data in `data/`; it is never part of the public mirror.
