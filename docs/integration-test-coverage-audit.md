# Integration-Test Coverage Audit

**Ticket:** R-ITIH AC-5 (`54a779c7`). **Status:** classification + migration plan only —
**migration itself is OUT OF SCOPE** and is the recommended follow-up bundle.

This audit classifies the subprocess-spawning integration-tier tests into three buckets
(`genuine-e2e` / `should-be-unit` / `flake-risk`), verifies the classification against the
actual test source (15 files deep-read), and produces a migration list for the
`should-be-unit` cohort using an interface-as-test-surface approach.

---

## 1. Scope & method

**Population = subprocess-spawning ∩ integration-tier = 84 files.**

Derived by command, run from `extension/`:

```bash
# subprocess-spawning = references a child_process spawn primitive
grep -rlE 'spawnSync|execSync|execFileSync|child_process' tests --include='*.test.js' | sort   # 309 files

# integration-tier = under tests/integration/  OR  // @tier: integration marker at col 0
find tests/integration -name '*.test.js' | sort                                                # 93
grep -rlE '^// @tier: integration' tests --include='*.test.js' | sort                           # 122
# union of the two integration definitions                                                      # 129

# PRIMARY POPULATION = the intersection
comm -12 <subprocess-list> <integration-union>                                                  # 84
```

Tier composition of the 84 (6 entered via the `tests/integration/` directory rule despite a
non-integration `@tier` marker — these are **tier-rule artifacts**, called out in the table):

| `@tier` marker | count |
|---|---|
| `integration` | 78 |
| `expensive` | 5 (`deploy-lifecycle-soak`, `quarantine-validation`, `release-gate-wiring`, `ccpm-wiring-smoke`, `worker-mcp-access`) |
| `fast` | 1 (`monitor-mode-resilience` — SUT is in-process; mis-filed under `tests/integration/`) |

---

## 2. Classification rubric

### `genuine-e2e` — the subprocess IS the unit under test
The test crosses the **same process seam a real caller crosses**. Removing the subprocess would
remove the coverage. Examples: a real `bash install.sh` run, a real `mux-runner`/`pipeline-runner`/
`spawn-morty`/`microverse-runner` orchestration across process boundaries, a real audit `.sh`/
`bin/*.js` executable invoked as a CLI, or state-file crash-recovery replayed across processes.

> **`git-fixture-only` (sub-class of genuine-e2e).** The test spawns **only** `git`/`tar` to seed a
> real repository or extract a tarball, then asserts via an **in-process** import (`runGate`,
> `inspectPhantomDoneTicketFile`, `setupScope`, …). The subprocess does not cross the test surface —
> it builds the world. These are *correctly architected* and are **NOT migration candidates**,
> because the real git/filesystem state IS the contract input the in-process function reads.

### `should-be-unit` — the subprocess is incidental scaffolding
The test reaches **past the interface** (an interface-as-test-surface violation): it spawns a
subprocess to exercise logic that already has — or could trivially expose — an in-process seam.
The subprocess is not the contract. Each `should-be-unit` row carries a one-line migration note
naming the in-process seam it should target instead. **Migration is OUT OF SCOPE here.**

### `flake-risk` — load-sensitive / non-deterministic at concurrency
Correctness aside, the `subprocess + timeout` pairing makes the test starve under parallel load.
Sourced from two existing artifacts:

- **`tests/integration/.serial-tests.json`** + **`tests/integration/.serial-tests.reasons.json`** —
  every serialized test, tagged with a reason class:
  `subprocess-timeout-coupling`, `subprocess-spawn-timing`, `load-dependent-timeout`,
  `real-repo-isolation`, `process-global-state`.
- **`scripts/audit-subprocess-heavy-tests.sh`** WARN band: a non-serialized subprocess spawn with a
  `timeout:` in **(5000, 15000] ms** raises a non-failing WARN ("6000–15000ms band — consider
  serialization"); `timeout: ≤ 5000 ms` FAILs the audit.

A test can be **BOTH `genuine-e2e` AND `flake-risk`** — these are dual-tagged below (the right
fix is serialization, not removal).

---

## 3. Full classification table (all 84)

Legend: **G** = genuine-e2e, **Gf** = genuine-e2e / git-fixture-only, **U** = should-be-unit,
**F** = flake-risk. `✓` in the Verified column = deep-read (see §4); blank = rubric-inferred from
the signal matrix (binary spawned + in-process-import presence + serial reason + timeout band).

| # | File | Bucket(s) | Verified | Evidence | Migration note (U only) |
|---|------|-----------|:--:|----------|-------------------------|
| 1 | `tests/audit-canary-flip-fixture.test.js` | G | | spawns real `scripts/audit-canary-flip.sh` + `git` over a fixture repo | |
| 2 | `tests/audit-subprocess-heavy-tests.test.js` | G+F | | spawns the real audit `.sh`; serial `load-dependent-timeout` | |
| 3 | `tests/audit-test-isolation.test.js` | G+F | | spawns the real audit `.sh`; serial `load-dependent-timeout` | |
| 4 | `tests/auto-resume-stop-conditions.test.js` | G+F | | spawns `mux-runner` via bash; serial `load-dependent-timeout` | |
| 5 | `tests/characterization/completion-commit-cluster/path-2-worker-autofill-belt-and-suspenders.test.js` | Gf | | `git` fixture only; asserts via in-process `spawn-morty` autofill seam | |
| 6 | `…/path-3-manager-drift-auto-completion-validation.test.js` | Gf | | `git` fixture only; asserts via in-process `mux-runner` drift seam | |
| 7 | `…/path-5-runmuxrunnermain-direct-guard-calls.test.js` | Gf | | `git` fixture only; direct in-process `mux-runner` guard calls | |
| 8 | `…/path-7-phantom-done-watcher-backfill.test.js` | Gf | ✓ | imports `inspectPhantomDoneTicketFile`; `git` seeds fixture only | |
| 9 | `tests/check-update.test.js` | G+F | | spawns `install.sh`/stop-hook; serial `process-global-state` | |
| 10 | `tests/council-publish.test.js` | G+F | | serial `subprocess-spawn-timing` | |
| 11 | `tests/fixtures/audit-subprocess-heavy-tests/candidate.test.js` | U | | corpus fixture (`timeout:3000`); exists only to be scanned by the parent audit | not a real test — fold into the parent audit's in-process fixture-string table |
| 12 | `tests/fixtures/audit-subprocess-heavy-tests/exempt-serial.test.js` | U | | corpus fixture (`timeout:3000`); scanned, never asserts | same — inline as a string fixture in `parallel-tier-isolation-audit` |
| 13 | `tests/fixtures/audit-test-isolation/bad-unsandboxed.test.js` | U | | corpus fixture for the isolation audit; spawns `setup.js` only as a violation sample | inline as a heredoc fixture in `audit-test-isolation.test.js` |
| 14 | `tests/fixtures/audit-test-isolation/bad-working-dir-real-repo.test.js` | U | | corpus fixture; `mux-runner` reference is a violation sample | same — heredoc fixture |
| 15 | `tests/fixtures/audit-test-isolation/good-extension-dir-repo-root.test.js` | U | | corpus fixture (passing sample) | same — heredoc fixture |
| 16 | `tests/fixtures/audit-test-isolation/good-no-session-bin.test.js` | U | | corpus fixture (passing sample) | same — heredoc fixture |
| 17 | `tests/fixtures/audit-test-isolation/good-sandboxed.test.js` | U | | corpus fixture (passing sample) | same — heredoc fixture |
| 18 | `tests/install-script-prefix.test.js` | G | | spawns real `install.sh --prefix`; subprocess IS the SUT | |
| 19 | `tests/install-script-real.test.js` | G+F | ✓ | real `install.sh` w/ fake `$HOME`; asserts deployed version + untouched settings.json; serial `real-repo-isolation` | |
| 20 | `tests/integration/anatomy-park-baseline-gate.test.js` | G | | spawns real `microverse-runner` baseline gate | |
| 21 | `tests/integration/anatomy-park-branch-switched.test.js` | Gf | ✓ | imports `runGate`; `execSync('git…')` seeds branch fixture only | |
| 22 | `tests/integration/anatomy-park-dirty-tree-skip.test.js` | Gf | ✓ | imports `runGate`; `git` fixture only | |
| 23 | `tests/integration/anatomy-park-gate-baseline-recovery.test.js` | G | | spawns real `microverse-runner` recovery path | |
| 24 | `tests/integration/anatomy-park-microverse-runner-no-key-metric.test.js` | G | | spawns real `microverse-runner`; in-proc `pickle-utils` for setup | |
| 25 | `tests/integration/anatomy-park-stall-limit.test.js` | G | | spawns real `microverse-runner`; asserts stall cap across process | |
| 26 | `tests/integration/audit-closer-template-compliance.test.js` | G | | spawns real `install.sh` + audit `.sh` (`timeout:30000`, above WARN band) | |
| 27 | `tests/integration/audit-ticket-bundle-backfill-2026-05-03.test.js` | G+U | ✓ | spawns `bin/audit-ticket-bundle.js` over a fixture corpus (real absolute session path) | audit logic is importable from `bin/audit-ticket-bundle.js`; call `runAudit()` in-process over the fixture, keep one CLI-smoke e2e |
| 28 | `tests/integration/audit-ticket-bundle-baseline.test.js` | G+U | ✓ | spawns `bin/audit-ticket-bundle.js`; module is importable | same seam as #27 — import the audit fn, assert findings in-process |
| 29 | `tests/integration/auto-resume-on-cap-hit.test.js` | G+F | | spawns `mux-runner` via bash; serial `load-dependent-timeout` | |
| 30 | `tests/integration/ccpm-wiring-smoke.test.js` | G | | `@tier: expensive`; spawns real `claude`/`mux-runner`/`setup.js` wiring smoke | |
| 31 | `tests/integration/codex-authority-recovery.test.js` | G+F | | spawns real `claude`/`mux-runner`; `timeout:5000` (FAIL band — see note) | |
| 32 | `tests/integration/codex-manager-fixed-wall-continuation.test.js` | G | | spawns `mux-runner`+`pipeline-runner` continuation across processes | |
| 33 | `tests/integration/codex-spark-worker-completion-commit.test.js` | G+F | | spawns `spawn-morty` + real `tsc`/`eslint`; serial `real-repo-isolation` | |
| 34 | `tests/integration/deploy-lifecycle-soak.test.js` | G+F | | `@tier: expensive`; real `install.sh` deploy soak; `real-repo-isolation` shape | |
| 35 | `tests/integration/extension-wiring.test.js` | G+U | ✓ | deploy-smoke asserts files under `~/.claude/pickle-rick` (genuine deploy e2e) **and** in-process `runGate`/`checkGateMain` (could split) | split the CLI-surface tests (4–5) to call `checkGateMain`/`finalizeGateMain` directly; keep deploy-smoke + tarball replay as e2e |
| 36 | `tests/integration/gate-ergonomics-keystone.test.js` | G+F | | spawns `setup.js`; in-proc `scope-resolver`; serial `subprocess-timeout-coupling` | |
| 37 | `tests/integration/gate-skip-activity-events.test.js` | G+F | | spawns `mux-runner` in a tmp git working_dir; serial `real-repo-isolation` | |
| 38 | `tests/integration/head-pin-mismatch-detection.test.js` | G+U | ✓ | imports `checkHeadPinMismatch`/`logPhaseHaltReason` (in-proc) **and** spawns real `setup.js --tmux` for scenario 1 | the two pure-function scenarios should drop the `git` repo round-trip and call `checkHeadPinMismatch` on a constructed state; keep the `setup.js --tmux` scenario as e2e |
| 39 | `tests/integration/install-chmod-coverage.test.js` | G+F | | real `install.sh`; serial `real-repo-isolation` | |
| 40 | `tests/integration/install-typescript-package.test.js` | G+F | | real `install.sh`+`pipeline-runner`; serial `real-repo-isolation` | |
| 41 | `tests/integration/install-ui-principles.test.js` | G+F | | real `install.sh`; serial `real-repo-isolation` | |
| 42 | `tests/integration/loa-618-replay.test.js` | Gf | ✓ | imports `runGate`/`spawnGateRemediatorMain`; `tar -xzf` extracts fixture tarball only | |
| 43 | `tests/integration/lock-scope-rejects-live-runner.test.js` | G+F | | spawns `pipeline-runner`; serial `subprocess-timeout-coupling` | |
| 44 | `tests/integration/lockdown-end-to-end.test.js` | G | | spawns real `install.sh` + node lockdown path | |
| 45 | `tests/integration/mega-bundle-e2e.test.js` | G+F | ✓ | imports mux-runner/setup/backend-spawn in-proc **and** spawns `install.sh` + mock `gh`/`tar`; real release replay; serial `real-repo-isolation` | |
| 46 | `tests/integration/microverse-runner-judge-failure.test.js` | G+F | | spawns real `claude`/`microverse-runner`; serial `process-global-state` | |
| 47 | `tests/integration/microverse-runner.worker-subprocess-error.test.js` | G+F | | spawns `microverse-runner` worker; serial `subprocess-timeout-coupling` | |
| 48 | `tests/integration/mmtrh-heal-script.test.js` | G+F | ✓ | spawns real `scripts/heal-deferred-tickets.sh` (shell SUT, no JS seam) w/ fake npm; serial `load-dependent-timeout` (`timeout:15000`) | |
| 49 | `tests/integration/monitor-collapsed-layout-respawn.test.js` | G | | spawns real `mux-runner` monitor respawn path | |
| 50 | `tests/integration/monitor-mode-resilience.test.js` | U | ✓ | `@tier: fast`; imports `restartDeadWatcherPanes`, **injects** a load-robust spawnSync — SUT fully in-process; mis-filed under `tests/integration/` | already unit-shaped — move file out of `tests/integration/`, drop the dir-rule integration classification |
| 51 | `tests/integration/monitor-pane-zero-watchdog.test.js` | U | | imports `pickle-utils` in-proc; `child_process` reference is a `tmux` shim, not product SUT | retarget the watchdog assertions at the imported `pickle-utils` fn with an injected spawn shim (as #50 already does) |
| 52 | `tests/integration/monitor-respawn-sessiondir-cascade.test.js` | Gf | | imports `monitor.js`; subprocess seeds session-dir fixture | |
| 53 | `tests/integration/parallel-tier-isolation-audit.test.js` | U | ✓ | re-implements the serial-manifest audit in-process + reads real `.serial-tests.json`; no product subprocess | already pure fs+regex — drop the `child_process` import, assert the in-process `auditSubprocessHeavyTests()` directly |
| 54 | `tests/integration/pipeline-e2e.test.js` | Gf | ✓ | imports `setupScope`/`writeSkippedByScope`; `spawnSync('git')` seeds repo only | |
| 55 | `tests/integration/pipeline-runner-dirty-tree-guard.test.js` | G+F | | spawns `pipeline-runner` dirty-tree guard; serial `real-repo-isolation` | |
| 56 | `tests/integration/pipeline-runner-dirty-tree-relaunch.test.js` | G+F | | spawns `pipeline-runner` relaunch; serial `real-repo-isolation` | |
| 57 | `tests/integration/pipeline-runner-judge-reasons.test.js` | G | | spawns `pipeline-runner`+`microverse-runner` judge path | |
| 58 | `tests/integration/pipeline-runner-judge-timeout-recovery.test.js` | G | | spawns `pipeline-runner`+`microverse-runner` timeout recovery | |
| 59 | `tests/integration/pipeline-state-coherence.test.js` | G+F | | spawns `mux-runner`+`pipeline-runner`; serial `subprocess-timeout-coupling` (`timeout:60000`) | |
| 60 | `tests/integration/pntr-pickle-deprecated.test.js` | G+F | | serial `subprocess-timeout-coupling`; deprecated-command e2e | |
| 61 | `tests/integration/pntr-teams-tmux.test.js` | G+F | | spawns `mux-runner`+`setup.js` (teams/tmux); serial `subprocess-spawn-timing` | |
| 62 | `tests/integration/process-cleanup.test.js` | G+F | | spawns real `claude`/`dispatch.js`; serial `subprocess-spawn-timing` (`timeout:90000`) | |
| 63 | `tests/integration/quarantine-validation.test.js` | G | ✓ | `@tier: expensive`; reruns a quarantined test 100× via subprocess — genuine flake harness | |
| 64 | `tests/integration/readiness-bundle-prd.test.js` | G+F | | serial `subprocess-timeout-coupling`; **WARN band** `timeout:10000` | |
| 65 | `tests/integration/recovery-ladder-e2e.test.js` | G | | spawns `microverse-runner`+`mux-runner`+real `tsc`; cross-process recovery ladder | |
| 66 | `tests/integration/release-gate-wiring.test.js` | U | ✓ | `@tier: expensive`; **no product subprocess** — reads CLAUDE.md/release.yml/ci.yml, regex-compares gate strings | drop the unused `spawnSync` import; this is pure fs+string parity — reclassify as fast-tier unit |
| 67 | `tests/integration/session-map-collision-block.test.js` | G+F | | spawns `setup.js`; serial `subprocess-spawn-timing` | |
| 68 | `tests/integration/setup-no-graph-mutation.test.js` | G | | spawns `setup.js`+`pipeline-runner`; asserts no graph mutation across process | |
| 69 | `tests/integration/spawn-morty-backend-resolution.test.js` | G+F | | spawns real `spawn-morty` + `claude`; serial `subprocess-timeout-coupling` (`timeout:45000`) | |
| 70 | `tests/integration/timeout-e2e.test.js` | G+F | | spawns real `claude`/`mux-runner`; serial `subprocess-timeout-coupling` | |
| 71 | `tests/integration/wmnp-source-progress.test.js` | G | | spawns `mux-runner` source-progress path | |
| 72 | `tests/integration/worker-backend-split.test.js` | G+F | | spawns `spawn-morty`; in-proc `backend-spawn`; serial `process-global-state` (`timeout:45000`) | |
| 73 | `tests/integration/worker-lint-gate-forensic.test.js` | G+F | | spawns `spawn-morty` + real `tsc`/`eslint`; serial `subprocess-timeout-coupling` | |
| 74 | `tests/integration/worker-lint-gate.test.js` | G+F | ✓ | spawns real `spawn-morty` w/ codex shim; asserts lint-gate across worker boundary; serial `subprocess-timeout-coupling` | |
| 75 | `tests/integration/worker-manager-wedge-oversized.test.js` | G+F | | spawns `mux-runner`; serial `subprocess-timeout-coupling`; **WARN band** `timeout:10000` | |
| 76 | `tests/integration/worker-mcp-access.test.js` | G | | `@tier: expensive`; spawns real `claude` MCP-access probe | |
| 77 | `tests/microverse.test.js` | G+F | | spawns `claude`/`mux-runner`/`microverse-runner`; serial `subprocess-spawn-timing` | |
| 78 | `tests/mux-exit-path-commit.test.js` | G | | spawns `mux-runner` exit-path commit | |
| 79 | `tests/mux-runner-fix-b.test.js` | G+F | | spawns `mux-runner`; serial `real-repo-isolation` | |
| 80 | `tests/mux-working-dir-failsafe.test.js` | G | | spawns `mux-runner` + real `tsc`; working-dir failsafe | |
| 81 | `tests/r-pdup-split-original-auto-close.test.js` | G | | spawns `mux-runner` split/auto-close path | |
| 82 | `tests/ticket-completion-evidence-baseline-guard.test.js` | G+F | | **WARN band** `timeout:8000`; not serialized — candidate for serialization | |
| 83 | `tests/timeout-progress-aware.test.js` | G | | spawns `mux-runner` progress-aware timeout | |
| 84 | `tests/wuwc-reproducer.test.js` | G | | spawns `mux-runner`+`pipeline-runner` reproducer | |

> **FAIL-band note (row 31, `codex-authority-recovery`, `timeout:5000`):** a `timeout: ≤ 5000 ms`
> subprocess spawn that is *not* serialized trips the `audit-subprocess-heavy-tests.sh` FAIL band.
> This row is a genuine-e2e but should be reviewed for either serialization or a longer timeout in
> the follow-up bundle (flagged, not migrated here).

---

## 4. Verification log (15 files deep-read)

Each row below was read in full; the column records the **binary actually spawned** and whether an
**in-process interface exists**. These back the `✓` marks in §3.

| File | Binary spawned | In-process seam? | Verified bucket |
|------|----------------|------------------|-----------------|
| `install-script-real` | `bash install.sh` (fake `$HOME`) | no — install is a shell script | genuine-e2e |
| `pipeline-e2e` | `git` (fixture seed) | yes — `setupScope`/`writeSkippedByScope` imported & asserted | git-fixture-only |
| `mega-bundle-e2e` | `install.sh` + mock `gh`/`tar` | partial — mux-runner/setup imported for setup, but release replay crosses processes | genuine-e2e + flake-risk |
| `worker-lint-gate` | real `bin/spawn-morty.js` (+ codex shim) | no — the worker IS the boundary | genuine-e2e + flake-risk |
| `quarantine-validation` | re-spawns a quarantined test 100× | n/a — flake harness by design | genuine-e2e |
| `release-gate-wiring` | **none** (regex over CLAUDE.md/workflows) | yes — pure fs+string | should-be-unit |
| `audit-ticket-bundle-baseline` | `bin/audit-ticket-bundle.js` | yes — audit module is importable | genuine-e2e + should-be-unit |
| `audit-ticket-bundle-backfill` | `bin/audit-ticket-bundle.js` | yes — same module | genuine-e2e + should-be-unit |
| `anatomy-park-branch-switched` | `git` (branch fixture) | yes — `runGate` imported & asserted | git-fixture-only |
| `anatomy-park-dirty-tree-skip` | `git` (dirty-tree fixture) | yes — `runGate` imported & asserted | git-fixture-only |
| `mmtrh-heal-script` | real `scripts/heal-deferred-tickets.sh` (+ fake npm) | no — shell script SUT | genuine-e2e + flake-risk |
| `extension-wiring` | deploy paths under `~/.claude/pickle-rick` + `tar` | partial — `runGate`/`checkGateMain` imported (splittable) | genuine-e2e + should-be-unit |
| `loa-618-replay` | `tar -xzf` (fixture tarball) | yes — `runGate`/`spawnGateRemediatorMain` imported | git-fixture-only |
| `monitor-mode-resilience` | `tmux` shim via **injected** spawnSync | yes — `restartDeadWatcherPanes` imported, spawn injected | should-be-unit (mis-filed) |
| `parallel-tier-isolation-audit` | **none** (re-implements the audit in-process) | yes — `auditSubprocessHeavyTests()` local | should-be-unit |
| `head-pin-mismatch-detection` | real `setup.js --tmux` (scenario 1) + `git` | yes — `checkHeadPinMismatch`/`logPhaseHaltReason` imported | genuine-e2e + should-be-unit |

---

## 5. Migration list — the `should-be-unit` cohort (recommended follow-up bundle)

**OUT OF SCOPE for this ticket.** Migration is a separate follow-up bundle. The cohort, with the
in-process seam each should target instead of a subprocess:

| File | Recommended in-process seam |
|------|-----------------------------|
| `tests/integration/release-gate-wiring.test.js` | drop unused `spawnSync`; it is already pure fs+regex gate-string parity → reclassify fast-tier unit |
| `tests/integration/parallel-tier-isolation-audit.test.js` | drop `child_process` import; assert the local `auditSubprocessHeavyTests()` directly |
| `tests/integration/monitor-mode-resilience.test.js` | already injects a spawn shim; relocate out of `tests/integration/` (it is `@tier: fast`) |
| `tests/integration/monitor-pane-zero-watchdog.test.js` | retarget at the imported `pickle-utils` watchdog fn with an injected spawn shim |
| `tests/integration/audit-ticket-bundle-baseline.test.js` | import the audit fn from `bin/audit-ticket-bundle.js`; assert findings in-process; keep 1 CLI-smoke e2e |
| `tests/integration/audit-ticket-bundle-backfill-2026-05-03.test.js` | same seam as baseline; in-process audit over the fixture corpus |
| `tests/integration/extension-wiring.test.js` | split CLI-surface tests to call `checkGateMain`/`finalizeGateMain`; keep deploy-smoke + tarball replay e2e |
| `tests/integration/head-pin-mismatch-detection.test.js` | move the two pure-function scenarios to call `checkHeadPinMismatch` on a constructed state; keep the `setup.js --tmux` scenario as e2e |
| `tests/fixtures/audit-test-isolation/{good,bad}-*.test.js` (5 files) | fold these corpus samples into heredoc fixture strings inside `audit-test-isolation.test.js` |
| `tests/fixtures/audit-subprocess-heavy-tests/{candidate,exempt-serial}.test.js` | inline as string fixtures in `parallel-tier-isolation-audit.test.js` |

The fixture files (`tests/fixtures/...`, 7 of the 11 entries) are not tests in the behavioral
sense — they are corpus inputs scanned by a parent audit, and the cleanest migration is to inline
them as in-process string fixtures, removing standalone `.test.js` files that pollute the population.

---

## 6. Summary

### Counts per bucket (primary tag; dual-tags counted in both rows)

| Bucket | Count | Notes |
|---|---|---|
| `genuine-e2e` (incl. `git-fixture-only`) | **65** | of which **9** are `git-fixture-only` (subprocess seeds a real fixture; SUT in-process) |
| `should-be-unit` | **11** | migration candidates (§5) — 7 are corpus-fixture files, 4 are real tests reaching past an in-process seam |
| `flake-risk` | **42** | = the population's intersection with `.serial-tests.json`; reason classes per `.serial-tests.reasons.json` |
| dual `genuine-e2e ∧ flake-risk` | **40** | the right fix is serialization, not removal |
| WARN-band timing (6000–15000 ms) | **3** | `readiness-bundle-prd` (10000), `worker-manager-wedge-oversized` (10000), `ticket-completion-evidence-baseline-guard` (8000) |
| FAIL-band timing (≤5000 ms, unserialized) | **1** | `codex-authority-recovery` (5000) — review for serialization/longer timeout |

### Headline findings
1. **The population is overwhelmingly genuine.** 65/84 spawn the real product surface (install.sh,
   mux/pipeline/spawn-morty/microverse runners, audit scripts) or seed a real git/tar fixture for an
   in-process assertion. The subprocess is load-bearing coverage, not slop.
2. **Flake-risk is already governed, not latent.** 42/84 are tracked in `.serial-tests.json` with
   typed reasons; the serial runner (`test:integration:serial`, concurrency=1) already neutralizes
   them. The audit WARN band closes the remaining 6000–15000ms blind spot.
3. **The genuine migration target is small and mostly cosmetic.** Only **4** real tests reach past an
   existing in-process seam (`release-gate-wiring`, `parallel-tier-isolation-audit`,
   `audit-ticket-bundle-{baseline,backfill}`), plus 7 corpus-fixture files that should be inlined.
   No high-value e2e is at risk.
4. **Tier-rule artifacts exist.** 6 files entered the population by living under `tests/integration/`
   while carrying a non-integration `@tier` marker (5 expensive, 1 fast); `monitor-mode-resilience`
   (fast) is a pure unit mis-filed by directory.

### Recommended next bundle
A small **"unit-migration"** follow-up bundle covering the §5 cohort:
inline the 7 corpus-fixture files, drop the 2 unused `child_process` imports
(`release-gate-wiring`, `parallel-tier-isolation-audit`), split the 4 in-process-seam tests
(`audit-ticket-bundle-{baseline,backfill}`, `extension-wiring`, `head-pin-mismatch-detection`),
and relocate `monitor-mode-resilience` out of `tests/integration/`. Net effect: shrink the
subprocess-spawning integration population, speed the fast tier, and reduce serial-runner load —
with zero loss of genuine cross-process coverage.
