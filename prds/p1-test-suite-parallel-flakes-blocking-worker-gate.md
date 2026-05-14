---
title: P1 — 5 parallel-load test flakes block worker test:fast gate; deferral cascade continues until all five fixed
status: Draft
filed: 2026-05-14
priority: P1
type: bug
r_code_prefix: R-TSPF
backend_constraint: any
related:
  - prds/p1-test-flake-auto-resume-stop-conditions-banner-past-3.md  # R-ARSF — partial precursor: stabilized auto-resume in isolation but not under full suite parallel load
  - prds/p1-mmtr-cleanup-heal-deferred-tickets-to-done.md             # R-MMTRH — depends on this fix landing first
---

# P1 — five parallel-load test flakes block the worker `test:fast` AC gate

## Why this is urgent

Worker AC-7 (tests pass) runs `cd extension && npm run test:fast`. Under default Node test concurrency=8, **five tests fail intermittently** even though each passes 5/5 times in isolation. Workers correctly self-defer via `# DEFERRED:` per contract, but the cumulative deferral rate (~75% observed in session 2026-05-13-c122b0f7, ~50%+ observed in session 2026-05-13-c71ab3ca after R-ARSF partial fix) keeps long pipelines from completing. Until all five are fixed, every R-MMTRH/R-WMW/R-MMTR-7/family-bundle ticket faces the same deferral cascade.

## The five flakes

1. **`auto-resume.stop-conditions > prints [warn] banner past retry 3`** (`tests/auto-resume-stop-conditions.test.js`) — R-ARSF stabilized the harness; in isolation 5/5 green at `--test-concurrency=8`; full `npm run test:fast` still observes intermittent failures.
2. **`publishCouncilStack: hung gh pr comment is aborted by timeout, classified as failed`** (`tests/council-publish.test.js:924`) — fails with `assertion expected: 1, actual: 2`. Timeout-classification race; only fails under parallel load.
3. **`ensureMonitorWindow: phase re-entry performs a fresh recovery sweep with mode-specific pane 2`** (`tests/ensure-monitor-window.test.js`) — tmux probe race.
4. **`ensureMonitorWindow: returns error when tmux-monitor.sh is missing`** — file-existence-check race against another test creating/deleting the same fixture path.
5. **`mux-runner relaunch claims ownership before monitor recovery sees session state`** (`tests/mux-runner-relaunch.test.js:90`) — fails with `ENOENT observed-state.log`. Subprocess-spawn timing race; the log file is opened in the test before the subprocess writes its first line.

## Common pattern

All five are **parallel-execution races**, not internal logic bugs:
- Pass solo / pass under `--test-concurrency=1` / pass when their file is the only one running.
- Fail intermittently under `--test-concurrency=8` when the full suite runs.
- Symptoms: race on shared fixture paths (`/private/var/folders/.../<test-name>`), race on stderr capture, race on subprocess spawn timing, race on fixture file write-then-read sequencing.

## Acceptance Criteria

- **AC-1:** All five tests pass **10 consecutive runs** under `npm run test:fast` (full suite) AND under `node --test --test-concurrency=8` (target test file alone).
- **AC-2:** Root cause documented per test in the commit message — one of `{shared fixture path collision, stderr capture race, subprocess spawn timing, fake-timer interaction, file-existence race}`.
- **AC-3:** Fix preserves each test's original intent and assertions. No assertion weakening.
- **AC-4:** If a per-test serialization is the chosen fix for any of the five (i.e., that one test file runs with concurrency=1 while the rest stay parallel), it's documented in `tests/test-registration-hygiene.test.js` allowlist with a `serialize_reason: '<specific-race-class>'`.
- **AC-5:** `cd extension && npm run test:fast` exits 0 with zero failures on 10 consecutive runs. `npm run test:integration` and `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` also pass.

## Implementation Order

- **R-TSPF-1**: Diagnose all 5 with 20× parallel runs each + stderr capture + timestamp diff vs solo. Categorize each by race class.
- **R-TSPF-2..6**: One ticket per flake, fix it. Each ticket is bounded to its single test file.
- **R-TSPF-7**: Stability gate — 10 consecutive `npm run test:fast` runs green; trap-door entry in `extension/src/bin/CLAUDE.md` or wherever each lives.

## Out of Scope

- Replacing Node `--test` runner with a different framework.
- Refactoring the auto-resume.sh or council-publish.ts production code (the bugs are in test isolation, not in production logic).
- Filing per-flake PRDs separately — they're all the same class.

## Downstream impact when shipped

Worker AC-7 (tests pass) becomes reliable. Expected effects:
1. R-MMTRH heal script can flip R-MMTR-2/3/4 from Skipped to Done with confidence.
2. Long-pipeline bundles (20+ tickets) reach completion at expected throughput.
3. The DEFERRED-cascade pattern observed in c122b0f7 and c71ab3ca stops recurring.
4. R-ASCH (auto-skip rationale) becomes nice-to-have rather than critical (since DEFERRED scenarios become rare).
