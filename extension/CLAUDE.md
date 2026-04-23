# Extension Subsystem

Compiled TS → JS lives in `extension/services/`, `extension/bin/`, `extension/hooks/`, `extension/types/`. Source in `extension/src/`. Tests in `extension/tests/` via `node --test`. Rebuild with `npx tsc` from `extension/`.

## Trap Doors

- `src/bin/council-publish.ts` — every `execFileSync('gh', …)` call must pass a `timeout` option; no-timeout calls block indefinitely on network hang; four prior "silent-failure hardening" passes missed this class because the existing tests mocked `gh` to respond instantly. New `gh` call sites must thread through `PublishOptions.ghTimeoutMs` or a per-call default, AND the test suite must cover the hang path with `__hang__` / `auth: 'hang'` / `hangOnCall` sentinels.
- `src/services/scope-resolver.ts` — every `spawnSync('rg' | 'grep', …)` call in `findImporters` must pass a `timeout` option (default `FIND_IMPORTERS_TIMEOUT_MS = 30_000`). A wedged ripgrep/grep (FIFO under repoRoot, stuck FUSE mount, catastrophic regex backtracking) would otherwise stall scope resolution indefinitely with no log signal. New tool-invocation sites in this file must thread `timeoutMs` through `computeOneHop({ findImportersTimeoutMs })` AND the test suite must cover the hang path with a fake tool script on `PATH` (see `scope-one-hop-hang-guard.test.js`).
