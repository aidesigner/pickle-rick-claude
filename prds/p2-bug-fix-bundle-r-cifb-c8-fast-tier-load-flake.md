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

## Fix progress

- **✅ Dominant bucket (61 MODULE_NOT_FOUND) FIXED 2026-06-15:** `tests/anatomy-park-scope.test.js` + `tests/szechuan-scope.test.js` `EXTENSION_ROOT` now resolves from the REPO (`path.resolve(__dirname, '..', '..')`) so the spawned `init-microverse.js` is the repo copy (present on CI). Verified locally: 28/28 pass, no breakage. Re-running `stability-gate.yml` to measure the reduction + reveal remaining buckets.
- **TODO:** claude-CLI-probe tests (4) — guard/skip when `claude` absent (env-gate or mark integration/expensive); microverse.json ENOENT (6) — likely resolved by the EXTENSION_ROOT fix, confirm; any residual AssertionErrors; the minor `guardRereadBackoffMs` 10s→≥30s hang-guard widen (AC-R-ITIH-4).

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
