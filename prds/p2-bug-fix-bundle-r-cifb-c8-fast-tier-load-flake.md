---
title: "R-CIFB — c=8 fast-tier load-starvation flake (chronic CI red)"
finding: 115
priority: P2
status: open
created: 2026-06-15
source_incident: "CI chronically RED ≥12 runs back to 2026-06-12; surfaced once R-FBMB #114 unmasked the ENOBUFS"
schema_neutral: true
---

# R-CIFB — c=8 fast-tier load-starvation flake

## Problem

CI on `main` has been chronically RED for ≥12 runs (back to 2026-06-12). The ENOBUFS bug (R-FBMB #114) masked it for two days; once fixed, `test:fast:budget` (5× `node bin/test-runner.js --tier fast --test-concurrency=8`, `--fail-budget=2`) reliably reports `FAIL_BUDGET_EXCEEDED failures=3 budget=2` on CI runners.

It is NOT a deterministic break:
- A single isolated `test:fast` pass at c=8 on a fast 8-core Mac is CLEAN (6427/6430, 0 fail).
- Under the full release gate's concurrent load (or on weaker CI runners), individual timing/subprocess-sensitive tests get **starved** past their internal deadlines and fail timeout-shaped.

## Root cause (REVISED 2026-06-15 after CI-log analysis — the c=8-flake theory was WRONG)

The stability-gate run (27584934193) artifact (`test-fast-pass-1.log`) showed **48 fail + 36 cancelled in a single CI run** — far too many for a load flake, and many are pure-logic tests. The actual error breakdown is **deterministic CI-environment-gap failures, NOT c=8 starvation**:

| Bucket | Count | Cause |
|---|---|---|
| `Cannot find module '~/.claude/pickle-rick/extension/bin/init-microverse.js'` (MODULE_NOT_FOUND) | **61** | DOMINANT. `tests/anatomy-park-scope.test.js` + `tests/szechuan-scope.test.js` hardcoded `EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick')` (the **deployed** root) and passed it to `setupAnatomyPark`/`setupSzechuanSauce`, which spawn `<root>/extension/bin/init-microverse.js`. The deployed root exists on a dev machine (install.sh run) but **CI never runs install.sh** → absent → MODULE_NOT_FOUND. |
| `claude --version exceeded probe timeout` | 4 | Tests probe for the `claude` CLI binary, absent on CI runners. |
| `ENOENT … microverse.json` | 6 | anatomy-park scope fixtures, same family as the init-microverse failures. |
| AssertionErrors | a few | downstream of the above (subprocess failed → assertion on its output fails). |

This is why **local passes** (dev has the deployed extension + `claude` CLI) but **CI fails deterministically** (it has neither). It also explains the chronic redness: a swath of fast-tier tests have a hidden dependency on the deployed runtime. The earlier `guardRereadBackoffMs R-CCR-9` 10s-deadline observation is a REAL but MINOR secondary c=8 flake (1/6430 locally), not the chronic-red driver.

## Fix progress (multi-cause — bigger than first scoped)

The chronic CI red has THREE independent causes, not one:

**Cause 1 — deployed-extension dependency (deterministic, the dominant bucket):**
- Per-test EXTENSION_ROOT params: 4 test files passed the DEPLOYED root to `setupAnatomyPark`/`setupSzechuanSauce` → fixed to repo-root: `anatomy-park-scope.test.js` + `szechuan-scope.test.js` (7cb5c7fd), `scope-backcompat.test.js` + `pipeline-runner-design-safe.test.js` (8b04f48a).
- **SYSTEMIC source (the persistent 46):** `getExtensionRoot()` (`src/services/pickle-utils.ts`) returns `CANONICAL_EXTENSION_ROOT = ~/.claude/pickle-rick` whenever `EXTENSION_DIR` is unset — which it is on CI (no install.sh). Many spawn sites resolve `init-microverse.js` through this, NOT the test param. **✅ FIXED b052f49a: set `EXTENSION_DIR=${{ github.workspace }}` in `ci.yml` + `stability-gate.yml`** (sentinel `extension/bin/log-watcher.js` is committed → resolves to the checked-out repo). Run command unchanged → release-gate parity intact. Verified locally: `EXTENSION_DIR=$repo getExtensionRoot() → repo root`.

**✅ Cause 1 CONFIRMED FIXED (re-measure 27588277475):** init-microverse MODULE_NOT_FOUND **46 → 0**; zero deployed-path resolutions remain. The EXTENSION_DIR=workspace fix + the 4 per-test repo-root fixes fully closed the deployed-extension dependency.

Surviving = 37 fail + 36 cancelled, three heterogeneous clusters (each its own fix, no silver bullet):

**Cause 2 — node:test async-cancellation (36 'Promise resolution still pending' = the 36 cancelled):** e.g. `writeWithWatchdog: surfaces sink error` (ERR_TEST_FAILURE). CI node 22.x vs dev/CLAUDE.md Node 25 (pass locally). Node-version-skew OR load. Fix candidates: node-version alignment (CLAUDE.md authoritative = Node 25; reversible experiment) OR per-test await-hygiene OR serialize per R-TFP. NOT a silver bullet — only ~36 of the survivors.

**Cause 3a — section-c-gate ENOENT cluster (~10 tests):** `ENOENT … /tmp/section-c-home-XXXX/.local/share/pickle-rick/bundle/section-c-still-needed.json` — the test's fake-HOME bundle dir isn't created before the runtime writes the artifact. Shared root cause across the cluster — likely one fix (mkdir -p the bundle dir, or the runtime should create it). Investigate `tests/*section-c*` + the bundle-write path.

**Cause 3b — runGate AssertionError cluster (~10 tests, `tests/services/convergence-gate-workspaces.test.js`):** `AssertionError: expected 'green'` — the convergence-gate runs REAL npm/tsc/lint against fixture packages; behaves differently on CI (tooling/fixture env). Investigate whether the fixtures need setup or the test should mock the command layer.

**Note:** the `claude --version probe timed out` lines are TAP `#` DIAGNOSTICS (benign fallback-to-measurement), NOT failures.

## STATUS 2026-06-16: structural causes SOLVED (84→25), remaining tail = env-specific hygiene

Four confirmed systematic fixes took CI from 84 failures to ~25 (70% reduction):
1. ✅ Deployed-extension dep (init-microverse 46→0): 4 test repo-root fixes + `EXTENSION_DIR=github.workspace` in workflows.
2. ✅ ENOENT data-root (section-c-gate/verify-recapture): hermetic-env strip of `EXTENSION_DIR`/`PICKLE_DATA_ROOT`/`PICKLE_DATA_DIR` (the EXTENSION_DIR side effect on `getDataRoot`).
3. ✅ node:test async-cancel (36→0): CI node 22→24 (node 22's runner over-strict on file-level unsettled promises; relaxed 23+).
4. ✅ stability-gate full-history checkout (`fetch-depth:0`, align ci.yml) — correct alignment, though it did NOT fix the runGate cluster (that was a wrong hypothesis).

### Remaining ~25 (de-prioritized hygiene tail — CI-green is NOT a release gate)

Two sub-classes, established by running each file under CI-sim (`EXTENSION_DIR=$repo TZ=UTC node --test`):

- **Reproducible locally (fix when convenient):** `addToJar` ×2 (`jar-utils.test.js`) — `withTimezone('America/Chicago')` just sets `process.env.TZ`, but Node caches the zone so under a UTC ambient the override doesn't take effect inside `mock.timers` → local-day computation stays UTC. Fix = make `withTimezone` force a real TZ re-read or restructure the date injection (fiddly Node-internals, not 1-line).
- **CI-ONLY (node-24/Linux-specific, do NOT reproduce on macOS/node25 even under CI-sim):** `getSessionPath` (12/12 pass locally), `runGate` ×9 (`convergence-gate-workspaces` — gate runs real npm/tsc on fixtures, returns 'red' on CI), `verify-recapture recovers-orphan-tmp`, `showStatus`, `mux-runner orphan-tmp`, `check-readiness`, `install-agent-overlay`, `guard-logging`, `purge-update-cache`, `check-update`, `FR-B10` (subprocess killed exit 1 = load/timeout). These need a Linux/node-24 repro environment OR methodical per-test CI-log forensics (expected-vs-actual extraction). **Name-based hypothesis guessing FAILED here twice (fetch-depth, pid-EINVAL both wrong) — do NOT guess; extract the real error block or get a repro env.**

### Recommendation

The high-value structural work is done and shipped. The remaining ~25 is a fiddly, environment-specific, hygiene-only residual best tackled in a dedicated session with a Linux/node-24 repro env (or accepted as known CI-red since CI-green is not a release gate). Do not let it consume every babysitter tick — pivot to higher-value drain (verify-first-close stale P2 rows) and return to this methodically.

## Honest scope note

This is a MULTI-SESSION CI-environment-alignment effort, not a quick flake-serialize. CI has likely NEVER been green (all prior betas shipped on the LOCAL gate, which is authoritative; CI-green is hygiene, not a release gate). Drive it incrementally: EXTENSION_DIR fix (b052f49a) should collapse cause 1; then measure causes 2+3 and decide node-version alignment vs per-test fixes.

## Method

`gh workflow run stability-gate.yml -f run_count=N` runs `npm run test:fast` (full output, not the budget loop's swallowed output) and uploads per-run logs as `stability-gate-logs`. The CI runner reproduces the env-gap (no deployed extension, no `claude` CLI) that a dev machine masks — it is the authoritative oracle. Iterate: fix a bucket → re-run → read remaining failures → repeat until 0, then a clean 30-run validation.

## Acceptance criteria

- **AC-1 (enumerate):** Run `stability-gate.yml -f run_count=30` (CI-side, no local oversubscription), download the artifact logs, and produce the COMPLETE list of tests that fail in ≥1 of the 30 runs. This is the authoritative flaky set.
- **AC-2 (classify):** For each, classify per the `extension/CLAUDE.md` taxonomy — `subprocess-spawn-timing`, `load-dependent-timeout`, `subprocess-timeout-coupling`, etc.
- **AC-3 (fix per the documented precedents, NOT by loosening the gate):**
  - Subprocess hang-guards below the ≥30s floor (e.g. the 10s ready-deadline) → widen to ≥30s per AC-R-ITIH-4 (a hang-guard is not a perf-assertion).
  - Tests that flake ONLY under parallel load → promote `@tier:fast`→`@tier:integration` + add to `tests/integration/.serial-tests.json` (runs at `--test-concurrency=1`) per the R-TFP precedent, with a 1:1 reason in `.serial-tests.reasons.json` (one of the five sanctioned classes).
  - Do NOT change `--fail-budget` or `--test-concurrency=8` in `check-flake-budget` / `test:fast:budget` (fixing the tests, not weakening the guard — north-star W5b subtract-before-add).
- **AC-4 (validate):** Re-run `stability-gate.yml -f run_count=30` → 0 failures across all 30 runs. CI `test:fast:budget` goes green.
- **AC-5 (audit parity):** `audit-test-tiers.sh`, `audit-test-isolation.sh`, `audit-subprocess-heavy-tests.sh`, and `serial-tests-reasons-coverage.test.js` all stay green after the moves.

## Execution note (recursive-flake hazard)

A pickle WORKER's own lint gate runs `test:fast` — i.e. the very flaky tests being fixed — so a pipeline build risks the worker's gate flaking on the work-in-progress. **Prefer babysitter-direct execution** with `stability-gate.yml` (CI-side) as the validation loop, rather than a pickle pipeline.

## Validation

`gh workflow run stability-gate.yml -f run_count=30` is the operator runbook tool; it runs `npm run test:fast` (full output, not the budget loop's swallowed output) RUN_COUNT× and uploads per-run logs as the `stability-gate-logs` artifact.
