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

## Root cause (confirmed)

The flaky tests are **subprocess-spawn-timing** and **load-dependent-timeout** class (per the existing R-TFP / R-TSPF taxonomy in `extension/CLAUDE.md`). Worked example — `guardRereadBackoffMs: R-CCR-9 NaN and negative env values fall back to 500ms default` in `tests/mux-runner.test.js`:
- Spawns a `node -e` writer subprocess, then waits for its ready-marker with a **10_000ms deadline** (`tests/mux-runner.test.js:2374`).
- Under c=8 oversubscription the child process can't be scheduled + signal ready within 10s → throws `writer subprocess never signaled ready` (observed duration 10063ms; passes in 1687ms in isolation).
- The 10s deadline also **violates the AC-R-ITIH-4 hygiene principle** that a subprocess hang-guard should be **≥30s**, not a tight perf-assertion.

node:test concurrency is **per-file**, so a single flaky test cannot be serialized in place — its whole file (or the test) must move to the serial surface, OR its sub-second hang-guards must be widened to the ≥30s floor.

## Candidate flaky set (from CI history + gate-2)

| Test | File | Class |
|---|---|---|
| `guardRereadBackoffMs R-CCR-9 NaN/negative → 500ms default` | `tests/mux-runner.test.js` | subprocess-spawn-timing (10s ready-deadline) |
| `FR-B10 fixture manager sleeps 95% of worker_timeout budget` | (locate) | load-dependent-timeout |
| `verify-recapture recovers orphan tmp state … latest anatomy window` | (locate) | subprocess/load |
| `R-PSSS-2 szechuan-sauce proceeds when scope has ≥1 code file` | `tests/szechuan-scope.test.js` (locate) | subprocess/load |
| `szechuan scope injection` | (locate) | subprocess/load |

AC-1 of this bundle is to **enumerate the COMPLETE set** via `gh workflow run stability-gate.yml -f run_count=30` and grep the uploaded logs for every `✖`/`not ok` across runs — do not assume this list is exhaustive.

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
