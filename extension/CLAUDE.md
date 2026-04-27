# Extension Subsystem

Compiled TS → JS lives in `extension/services/`, `extension/bin/`, `extension/hooks/`, `extension/types/`. Source in `extension/src/`. Tests in `extension/tests/` via `node --test`. Rebuild with `npx tsc` from `extension/`.

## Trap Doors

- `src/bin/council-publish.ts` — INVARIANT: every `execFileSync('gh', …)` passes `timeout`, threaded via `PublishOptions.ghTimeoutMs`. BREAKS: network hang stalls publish indefinitely. ENFORCE: hang-path tests using `__hang__` / `auth: 'hang'` / `hangOnCall` sentinels.
- `src/services/scope-resolver.ts` — INVARIANT: every `spawnSync('rg'|'grep', …)` in `findImporters` passes `timeout` (default `FIND_IMPORTERS_TIMEOUT_MS = 30_000`), threaded via `computeOneHop({ findImportersTimeoutMs })`. BREAKS: wedged rg/grep stalls scope resolution silently. ENFORCE: `scope-one-hop-hang-guard.test.js`.
- `src/bin/plumbus-frame-analyzer.ts` — INVARIANT: every `spawnSync('bun', …)` in `parseDotViaBun` passes `timeout` (default `BUN_TIMEOUT_MS = 30_000`). BREAKS: wedged bun stalls generative-audit pipeline silently. ENFORCE: `plumbus-frame-analyzer-hang-guard.test.js`.
- `src/services/pickle-utils.ts` — INVARIANT: macOS `osascript` shell-outs route through `displayMacNotification` (default `NOTIFICATION_TIMEOUT_MS = 5_000`); never call `spawnSync('osascript', …)` directly. BREAKS: wedged Notification Center blocks `process.exit`, leaks cancel markers, hangs tmux pane. ENFORCE: `notification-hang-guard.test.js` via `spawnSyncFn` seam.
- `src/bin/microverse-runner.ts` — INVARIANT: auto-commit rescue stages tracked + untracked files via the shared staging helper, honoring `docs/`/`prds/` exclusions. BREAKS: `git add -u`-only drops new test files and first-time `CLAUDE.md`, then misclassifies as stall. ENFORCE: untracked-file path in `microverse.test.js`.
- `src/bin/council-publish.ts` (directive/stack parity) — INVARIANT: every non-trunk branch in `council-stack.json` has a matching `directive.branches` entry; missing entry → `outcome: 'failed'`, no body file, no `.published` marker. BREAKS: silent "empty findings" comments hide dropped fan-out shards. ENFORCE: `stack branch absent from directive` test in `council-publish.test.js`.
- `src/bin/pipeline-runner.ts` — INVARIANT: scoped anatomy/szechuan phases pass `scope.json` into `init-microverse` so `microverse.json.allowed_paths` survives setup. BREAKS: repo-wide gate failures get treated as in-scope. ENFORCE: `anatomy-park-scope.test.js` and `szechuan-scope.test.js`.
