# sigmashake-mmo — Operations Runbook

Audience: on-call engineer for `sigmashake-mmo`. Every section is written to be readable cold.

## Quick triage

| Signal | First thing to check |
|---|---|
| Cert score dropped below silver | `curl http://127.0.0.1:5599/api/json/workspace/certify/text?slug=sigmashake-mmo` |
| Deploys failing | `bash shared/agent-config/scripts/deploy-guarded.sh --check` |
| Test sentinels stale | `bun shared/agent-config/scripts/refresh-workspace-sentinels.ts --project sigmashake-mmo` |
| Service health unknown | check the `/api/health` probe (or the language-native health command) |

## Sentinels & cert posture

Sentinel files at the project root drive the workspace cert scanner. They are mtime-sensitive — the cert scanner treats anything older than 7 days as "warn".

| File | Producer | Refresh trigger |
|---|---|---|
| `.last-test-result` | `bun run test` (or `mix test` / `cargo test`) | every test run |
| `.last-typecheck-result` | `bun run typecheck` | every typecheck |
| `.last-lint-result` | `bun run lint` | every lint |
| `.last-format-result` | `bun run format` / `bun run fix` | every format |
| `.last-audit-result` | `bun audit --prod` | nightly cron + manual |
| `.last-build-result` | `bun run build` | every CI / pre-deploy |
| `.last-deploy-result` | `bun run deploy` via deploy-guarded.sh | every deploy |

If a sentinel is missing, the cert scanner records that dimension as `unknown` (score 50) instead of `ok` (score 100). To force a fresh recompute, touch the file with the right body:

```bash
printf 'ok\n' > .last-deploy-result
```

## Failure mode: deploy gate refuses

**Symptom.** `bun run deploy` aborts with `working tree diverges from origin/main`.

**Cause.** The deploy gate (`deploy-guarded.sh`) is enforcing the rule that we ship from `origin/main`, not a local branch. Local commits aren't pushed, or you're on a non-main branch.

**Fix.**
1. `git status` to inspect divergence.
2. Either push the local commits to `origin/main` and re-run, OR
3. Set `SSG_DEPLOY_STRICT=0 bun run deploy` for a one-off (audited — only do this with a paper trail).

## Failure mode: tests pass locally, fail in CI

**Symptom.** `.last-test-result` is `ok` after a manual run but the CI report shows failures.

**Cause.** Test environment drift — usually a missing secret, a different bun/node version, or test ordering sensitivity.

**Fix.**
1. `bun --version` matches CI's pinned version.
2. `bun run typecheck` clean (most CI failures are stale types).
3. Re-run with `bun test --bail` to find the first failure.
4. If the failure references a missing secret, check the CI secret store + vault.

## Failure mode: audit (dependency CVE) reports high/critical

**Symptom.** `bun audit` reports high or critical severity advisories.

**Cause.** A transitive dependency picked up a new CVE since the last `bun update`.

**Fix.**
1. `bun audit --json` to see the affected package + advisory IDs.
2. `bun update <pkg>` if a patched version exists.
3. If no patch exists within the CVE-response SLA (`docs/cve-response-sla.md`), evaluate forking, vendoring, or removing the dependency.
4. Re-record the sentinel: `bun audit && printf 'ok\n' > .last-audit-result`.

## Failure mode: sentinel goes stale (> 7 days)

**Symptom.** Cert score drops without any code change; cert text shows `warn — stale` on a sentinel.

**Cause.** The nightly `sigmashake-workspace-sentinels.timer` didn't fire (laptop asleep, service disabled) or the refresh skipped this kind.

**Fix.**
1. `systemctl --user status sigmashake-workspace-sentinels.timer` — should be `active (waiting)`.
2. Re-run manually: `bun shared/agent-config/scripts/refresh-workspace-sentinels.ts --project sigmashake-mmo --force`.
3. Verify mtime of `.last-*-result` is within the last hour.

## Failure mode: workspace cert scanner missed the service

**Symptom.** `sigmashake-mmo` is absent from the certify response.

**Cause.** `workspace-projects.discoverProjects()` couldn't find the service — usually a missing `package.json` / `mix.exs` / `Cargo.toml` at the project root, or the slug doesn't match the `sigmashake-*` / `super-saiyan-*` glob.

**Fix.**
1. `ls sigmashake-mmo/package.json sigmashake-mmo/mix.exs sigmashake-mmo/Cargo.toml` — at least one must exist.
2. Confirm the directory name matches the slug.
3. If still missing, check `workspace-projects.ts` filters — the cert scanner uses the same discovery as the workspace UI.

## Failure mode: build artifact freshness shows missing

**Symptom.** Cert dim `build_fresh` reports `missing — no build artifact found`.

**Cause.** The expected build outputs (`dist/`, `_build/`, `target/`, etc.) don't exist or the sentinel is missing.

**Fix.**
1. Run the project's build: `bun run build` / `mix compile` / `cargo build --release`.
2. If the build emits to a non-standard path, add the path to `workspace-certify.ts` `artifacts` list OR write `printf 'ok\n' > .last-build-result` after a successful run.

## Common operations

### Refresh all sentinels for this service

```bash
bun shared/agent-config/scripts/refresh-workspace-sentinels.ts --project sigmashake-mmo --force
```

### Check current cert score

```bash
curl -s 'http://127.0.0.1:5599/api/json/workspace/certify?slug=sigmashake-mmo' | jq '.reports["sigmashake-mmo"] | {score, level, dimensions: [.dimensions[] | {id, score}]}'
```

### See the worst signal across all services

```bash
curl -s 'http://127.0.0.1:5599/api/json/workspace/certify/text' | head -80
```
