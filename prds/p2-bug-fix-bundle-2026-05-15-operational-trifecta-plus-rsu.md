---
title: "Bug-fix bundle 2026-05-15 — operational tax trifecta + R-RSU (R-MWCL + R-WTB + R-QGSK + R-RSU)"
status: Draft
filed: 2026-05-15
priority: P2
type: bug-bundle
composes:
  - prds/p3-monitor-watcher-collapsed-layout-repair-gap.md
  - prds/p3-worker-timeout-default-too-short-blocks-test-gate.md
  - prds/p3-collapse-quality-gate-skip-flags.md
  - prds/p2-pickle-refine-section-umbrella-granularity-bug.md
r_codes:
  - R-MWCL-1
  - R-MWCL-2
  - R-MWCL-3
  - R-MWCL-4
  - R-MWCL-5
  - R-MWCL-6
  - R-MWCL-7
  - R-WTB-1
  - R-WTB-2
  - R-WTB-3
  - R-WTB-4
  - R-QGSK-1
  - R-QGSK-2
  - R-QGSK-3
  - R-QGSK-4
  - R-QGSK-5
  - R-RSU-1
  - R-RSU-2
  - R-RSU-3
  - R-RSU-4
  - R-RSU-5
  - R-CLOSER-1
sister_prds: []
related:
  - prds/MASTER_PLAN.md
---

# Bundle PRD — Operational Tax Trifecta + R-RSU

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only
**Working dir**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

## Bundle rationale

This is a sanctioned multi-PRD bundle under the **2026-05-15 PM operator directive** (bug-fix-only sequence; defer features). It composes four open bug PRDs into a single pickle pipeline run:

1. **R-MWCL** (Finding #29) — `inferMonitorMode` falls through to `'pickle'` for `szechuan-sauce.md`/`anatomy-park.md` → monitor pane crashes on every microverse iter → operator-blind during autonomous runs.
2. **R-WTB** (Finding #34) — `Defaults.WORKER_TIMEOUT_SECONDS: 1200` (20m) is below the R-PTG worker lifecycle floor → workers killed mid-`npm run test:fast` → spurious failures + retry burn.
3. **R-QGSK** — Two separate skip-flag fields (`skip_readiness_reason` + `skip_ticket_audit_reason`) force operators to set both on every codex launch → friction tax.
4. **R-RSU** (Finding #30) — `spawn-refinement-team.ts` collapses `composes:` bundle PRDs into N section-umbrella tickets → wedge in `c122b0f7` (R-MMTR-6 80-min no-progress) + `ba01c135` (R-ICDM umbrella 67-min no-commit).

**Why one bundle**: the three P3 PRDs (R-MWCL/R-WTB/R-QGSK) are individually small but together remove three high-frequency operator-friction taxes that compound on every codex pipeline launch. R-RSU is P2 risk-reduction (refinement bug that prevents future monster bundles from fanning out correctly). Bundling under sanctioned-exception per Phase 1b precedent + the 2026-05-15 directive's relaxed per-bundle cap (≤14 tickets under shared-intent rule; this bundle has 21 atomic + 1 closer = 22, justified by tightly-themed operational-tax + refinement-unblock intent).

**Why this PRD body enumerates each R-code inline**: defense against R-RSU's own bug — the section-umbrella collapse it fixes. By exposing every atomic R-code as its own `### R-XXX-N` section in this PRD body, refinement decomposes section-by-section rather than via the broken composes-walker fanout. Once R-RSU-1..5 ship, future bundles can rely on `composes:` frontmatter alone.

## Scope

### In-scope

- All 7 R-MWCL atomic tickets (monitor reliability)
- All 4 R-WTB atomic tickets (worker timeout default + per-tier overrides)
- All 5 R-QGSK atomic tickets (collapse skip flags + back-compat migration)
- All 5 R-RSU atomic tickets (composes fanout in refinement entrypoint)
- 1 closer ticket (version bump + parity check + MASTER_PLAN bookkeeping)

### Out of scope (deferred / shipped already)

- R-CSI Phase 1/Phase 2 (concurrent-session interference) — deferred per operator decision 2026-05-15 PM (wait for next incident)
- R-CCDC (citadel detection coverage) — deferred per operator decision (maybe-later)
- R-PIWG-3 worktree isolation — rejected per operator decision (no worktrees in pickle runs)
- R-MBLE + R-SLLJ + R-APMW + R-ICDM-1 + R-MDS + R-SOA + R-POD — already at HEAD per verify-then-close audit 2026-05-15 PM

## Functional Requirements

### R-MWCL-1 — Infer monitor mode from `state.command_template`, not pickle default

`extension/src/services/pickle-utils.ts::inferMonitorMode` currently only switches on `meeseeks.md` and `council-of-ricks.md`, falling through to `'pickle'` for `szechuan-sauce.md`/`anatomy-park.md`. Add switch arms for both microverse templates so `ensureMonitorWindow` spawns the correct render template at boot.

**Acceptance**: a unit test for `inferMonitorMode` asserts return value `'szechuan-sauce'` for `state.command_template === 'szechuan-sauce.md'` and `'anatomy-park'` for `state.command_template === 'anatomy-park.md'`. Existing `'meeseeks'`/`'council'`/`'pickle'` cases unchanged.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts` (+ tests).

### R-MWCL-2 — Make `render()` mode-mismatch tolerant

`extension/src/bin/monitor.ts::render` throws on missing pickle-mode fields before `checkAndSwapMode` (R-MDS-3) ever ticks. Add a guard at the top of `render` that detects mode mismatch (state.command_template's mode != current render mode) and either swaps mode immediately or returns an empty draw frame — never throws.

**Acceptance**: a unit test calls `render` against a state-mode mismatch (boot in `'pickle'` mode against `state.command_template === 'szechuan-sauce.md'`) and asserts no throw + correct subsequent mode swap.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts` (+ tests).

### R-MWCL-3 — `restartDeadWatcherPanes` collapsed-layout fallback

`extension/src/services/pickle-utils.ts::restartDeadWatcherPanes` at the `currentCommand === null` branch logs+continues. Replace with a `tmux split-window` fallback that recreates the missing pane in-place when the layout has collapsed.

**Acceptance**: an integration test injects a collapsed 1x2 layout (panes dead) and asserts `restartDeadWatcherPanes` restores 2x2 within one tick.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts` (+ tests).

### R-MWCL-4 — Capture monitor stderr to a session-local log

Add `${SESSION_ROOT}/monitor-stderr.log` capture so operators can diagnose monitor crashes post-mortem. Highest-value-first diagnostic — ship even if behavioral fixes (R-MWCL-1..3) are deferred.

**Acceptance**: a unit test asserts that a thrown error inside `render` is written verbatim to `monitor-stderr.log` within the session dir.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts` (+ tests).

### R-MWCL-5 — Watchdog initial tick fires on first interval, not after first interval

`monitor.ts::startRespawnWatchdog` currently waits `interval` ms before its first tick. Change to fire immediately on registration, then every `interval` ms after. Closes a window where collapsed layout persists for 2s+ before the watchdog notices.

**Acceptance**: a unit test asserts the watchdog fires within 100ms of registration (vs. 2000ms+ today).

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts` (+ tests).

### R-MWCL-6 — Regression test for R-MWCL-1..5

A new test file `extension/tests/monitor-mode-resilience.test.js` exercises all five R-MWCL fixes end-to-end (mode inference + tolerant render + split-window fallback + stderr capture + first-tick watchdog).

**Acceptance**: `cd extension && npm run test:fast` exits 0; the new test file appears in `extension/tests/` and is picked up by the fast tier.

**Files**: `extension/tests/monitor-mode-resilience.test.js` (new).

### R-MWCL-7 — Trap-door entry in `extension/src/services/CLAUDE.md`

Pin the R-MWCL-1 mode-inference shape (must handle all 5 template kinds: pickle / meeseeks / council / szechuan-sauce / anatomy-park) as an ENFORCE entry, verified by `bash extension/scripts/audit-trap-door-enforcement.sh`.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted in its summary.

**Files**: `extension/src/services/CLAUDE.md` (+ audit script regression).

### R-WTB-1 — Raise `Defaults.WORKER_TIMEOUT_SECONDS` from 1200 to 2400

`extension/src/types/index.ts` and the compiled `extension/types/index.js`. The 20-minute default is below the R-PTG worker lifecycle floor (5-8min research + 2-4min plan + 3-6min implement + 3-5min test:fast + 1-2min lint+tsc + 1-2min artifact writes + 30s commit = 16-28min realistic budget). Document the new default + reasoning in `extension/CLAUDE.md` invariant entry under `worker_timeout_seconds`.

**Acceptance**: a fresh `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "test"` session writes `worker_timeout_seconds: 2400` to `state.json` unless `--worker-timeout <N>` is passed.

**Verify**: `cd extension && npm run test:fast` exits 0; deployed `Defaults.WORKER_TIMEOUT_SECONDS === 2400` after `bash install.sh`.

**Files**: `extension/src/types/index.ts`, `extension/CLAUDE.md` (invariant section).

### R-WTB-2 — Per-tier overrides via `pickle_settings.json:tier_caps.<tier>.worker_timeout_seconds`

Suggested tier defaults: `small=1200`, `medium=2400`, `large=3600`, `xlarge=5400`. Extend `getTicketTierBudgetWithOverrides()` to read `pickle_settings.tier_caps.<tier>.worker_timeout_seconds` first, then `state.flags.tier_cap_override.<tier>.worker_timeout_seconds` second, then compiled `Defaults.WORKER_TIMEOUT_SECONDS` last.

**Acceptance**: `getTicketTierBudgetWithOverrides(state, 'medium')` returns `worker_timeout_seconds: 2400` when no override is set; honors settings and flags overrides in precedence order.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/ticket-tier-budget.ts` (or wherever `getTicketTierBudgetWithOverrides` lives — find via grep), `extension/pickle_settings.json`.

### R-WTB-3 — Regression test in `extension/tests/integration/worker-timeout-tier-budget.test.js`

Asserts: (a) default is 2400, (b) `small` tier resolves to 1200, (c) `medium` resolves to 2400, (d) `large` resolves to 3600, (e) `xlarge` resolves to 5400, (f) `pickle_settings.tier_caps.<tier>.worker_timeout_seconds` overrides the compiled default, (g) `state.flags.tier_cap_override.<tier>.worker_timeout_seconds` overrides settings.

**Acceptance**: `cd extension && npm run test:integration` exits 0; the new test is picked up by the integration tier.

**Files**: `extension/tests/integration/worker-timeout-tier-budget.test.js` (new).

### R-WTB-4 — Trap-door pin under `extension/src/services/CLAUDE.md`

Document the timeout invariant and its interaction with the R-PTG worker test gate. ENFORCE references the new R-WTB-3 regression test.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted.

**Files**: `extension/src/services/CLAUDE.md`.

### R-QGSK-1 — Add `skip_quality_gates_reason` field to `State` type

`extension/src/types/index.ts` adds a new field `skip_quality_gates_reason?: string` to the `State` interface. Existing `skip_readiness_reason?: string` and `skip_ticket_audit_reason?: string` fields remain for back-compat (deprecated, planned removal after one release cycle).

**Acceptance**: the type checker accepts `state.skip_quality_gates_reason = 'foo'` without complaint; the deprecated fields still work but emit a runtime warning when accessed.

**Verify**: `cd extension && npx tsc --noEmit` exits 0.

**Files**: `extension/src/types/index.ts`.

### R-QGSK-2 — Update `mux-runner.ts` to check the unified flag first

`mux-runner.ts` skip-flag check logic: check `state.flags.skip_quality_gates_reason` first; if absent, fall back to either `skip_readiness_reason` OR `skip_ticket_audit_reason` with a deprecation warning logged to `mux-runner.log`.

**Acceptance**: a unit test asserts the unified flag takes precedence; the deprecation warning is logged when only a legacy flag is set.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/mux-runner.ts`.

### R-QGSK-3 — Migration in `state-manager.ts::migrateState`

State files containing either legacy field auto-migrate to populate `skip_quality_gates_reason` with the concatenated values (`skip_readiness_reason` || `skip_ticket_audit_reason` — first non-empty wins). Schema version bumps to next available number.

**Acceptance**: a unit test loads a state.json fixture with `skip_readiness_reason: 'foo'` and asserts post-migration `skip_quality_gates_reason === 'foo'`.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/lib/state-manager.ts`.

### R-QGSK-4 — Regression test suite

A new test file `extension/tests/skip-flag-collapse.test.js` exercises: (a) unified flag set alone → bypasses both gates, (b) only `skip_readiness_reason` set → still bypasses readiness gate + emits deprecation warning, (c) only `skip_ticket_audit_reason` set → still bypasses ticket audit + emits warning, (d) both legacy flags set → both gates bypassed + two warnings, (e) migration from legacy state.json populates `skip_quality_gates_reason`.

**Acceptance**: `cd extension && npm run test:fast` exits 0; the new test file is picked up by the fast tier.

**Files**: `extension/tests/skip-flag-collapse.test.js` (new).

### R-QGSK-5 — Docs update

Update `extension/CLAUDE.md` skip-flag section + `prds/CLAUDE.md` (if it exists, otherwise the closest skill-prompt doc) to document `skip_quality_gates_reason` as the new canonical field. Deprecate legacy fields with a removal target (next release cycle).

**Acceptance**: `grep -n "skip_quality_gates_reason" extension/CLAUDE.md` returns at least one match; legacy field docs marked deprecated.

**Files**: `extension/CLAUDE.md`, `prds/CLAUDE.md` (if present).

### R-RSU-1 — Detect `composes:` bundle-of-bundles shape in refinement entrypoint

`extension/src/bin/spawn-refinement-team.ts` (or its entry caller) detects when the input PRD's frontmatter declares `composes:` AND each composed source PRD itself carries a `## Atomic decomposition` section (or `r_codes:` frontmatter list) with R-coded sub-tickets. Surface as `manifest.bundle_shape === 'composed'` for downstream consumers.

**Acceptance**: a unit test passes a fixture PRD with `composes: [a.md, b.md]` (each having `r_codes: [A-1, A-2]` / `[B-1, B-2]`) and asserts the detector returns `'composed'` with `source_prds.length === 2`.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/spawn-refinement-team.ts`.

### R-RSU-2 — Fan-out N parallel decomposer Mortys, one per composed source PRD

When `bundle_shape === 'composed'`, spawn N parallel decomposer Morty subprocesses (one per source PRD via `Promise.all`), each scoped to its single source. Aggregator collects per-source `analysis_decomposition_<source>.md` outputs and merges into a flat atomic ticket list (no section umbrellas).

**Acceptance**: a unit test mocks a 3-source bundle and asserts 3 parallel decomposer spawns + a merged manifest with N atomic tickets (N = sum of per-source R-codes), no section umbrellas.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/spawn-refinement-team.ts`.

### R-RSU-3 — Decomposer Morty prompt + ticket-writer contract

The per-source decomposer Morty prompt instructs the worker to: (1) read the source PRD, (2) walk its `## Atomic decomposition` section (or `r_codes:` frontmatter), (3) write one `linear_ticket_<hash>.md` per R-code with full atomic-ticket detail (acceptance criteria, verify commands, file paths, interface contracts). Output: a per-source ticket-list manifest the aggregator merges.

**Acceptance**: a unit test asserts the decomposer prompt template includes the required instructions; an integration test invokes a real decomposer Morty against a fixture source PRD and asserts N ticket files written.

**Verify**: `cd extension && npm run test:fast` exits 0; integration test passes under `npm run test:integration`.

**Files**: `extension/src/bin/spawn-refinement-team.ts` + decomposer prompt template asset.

### R-RSU-4 — Regression test: 3-source bundle produces ≥6 atomic tickets

A new integration test `extension/tests/integration/refinement-composes-fanout.test.js` constructs a synthetic 3-source bundle PRD (each source having 2 R-codes) and asserts: (a) decomposer Morty count == 3, (b) atomic ticket count ≥ 6, (c) no section-umbrella tickets in the manifest, (d) `prd_refined.md` lists all 6 atomic tickets in `## Implementation Task Breakdown`.

**Acceptance**: `cd extension && npm run test:integration` exits 0; the test is picked up by the integration tier.

**Files**: `extension/tests/integration/refinement-composes-fanout.test.js` (new), fixture PRDs under `extension/tests/integration/fixtures/composes-fanout/`.

### R-RSU-5 — Trap-door pin in refinement-team's nearest CLAUDE.md

`extension/src/bin/CLAUDE.md` (or `extension/src/services/CLAUDE.md` if more appropriate) adds an ENFORCE entry pinning the `composes:` fanout shape (must spawn N decomposers, never section-umbrellas). Verified by `bash extension/scripts/audit-trap-door-enforcement.sh`.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted.

**Files**: `extension/src/bin/CLAUDE.md`.

### R-CLOSER-1 — Bundle closer

Atomically: (a) bump version in `extension/package.json` to the next patch (or minor if any R-code introduces a state-schema migration — R-QGSK-3 likely does, so minor bump appropriate). (b) Run the full release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. (c) Deploy via `bash install.sh --closer-context --no-confirm`. (d) Verify md5 parity on the 5 most-trafficked compiled files. (e) Update `prds/MASTER_PLAN.md`: mark Findings #29 + #30 + #34 + slot #29 as CLOSED via verify-then-close; move entries to the archive; update the B-bundle table rows.

**Acceptance**:
- `extension/package.json#version` reads the new bump.
- All release gate steps exit 0.
- `git status` clean.
- MASTER_PLAN.md no longer lists Findings #29/#30/#34 in Open Findings; archive contains them verbatim.

**Verify**: as above per step.

**Files**: `extension/package.json`, `prds/MASTER_PLAN.md`, deployed copies under `~/.claude/pickle-rick/extension/`.

## Interface Contracts

### Contract 1 — `inferMonitorMode` return type

`inferMonitorMode(sessionDir: string): MonitorMode` where `MonitorMode = 'pickle' | 'meeseeks' | 'council' | 'szechuan-sauce' | 'anatomy-park'`. Returns the correct mode for every `state.command_template` value listed in the union; defaults to `'pickle'` only when `state.command_template` is unset or unrecognized.

### Contract 2 — `getTicketTierBudgetWithOverrides` return shape

`getTicketTierBudgetWithOverrides(state: State, tier: 'small'|'medium'|'large'|'xlarge'): { worker_timeout_seconds: number; ... }`. Precedence: `state.flags.tier_cap_override` > `pickle_settings.tier_caps` > compiled `Defaults`.

### Contract 3 — `skip_quality_gates_reason` State field

`State.skip_quality_gates_reason?: string`. Truthy value bypasses both readiness and ticket-audit gates. Legacy fields remain readable but emit deprecation warnings when accessed.

### Contract 4 — `bundle_shape` manifest field

`refinement_manifest.bundle_shape: 'flat' | 'composed'`. When `'composed'`, manifest also carries `source_prds: Array<{ path: string, r_codes: string[] }>` reflecting the per-source decomposition.

## Verification Strategy

- Unit tests for each R-code's atomic acceptance (per-section above).
- Integration tests for R-WTB-3 (tier budget), R-RSU-4 (composes fanout end-to-end), R-MWCL-6 (mode resilience).
- Audit script `audit-trap-door-enforcement.sh` validates R-MWCL-7 + R-WTB-4 + R-RSU-5 ENFORCE entries.
- Release gate validates state schema migration (R-QGSK-3).
- `npm run test:fast` and `npm run test:integration` both pass at the closer.

## Test Expectations

| R-code | Test file | Description |
|---|---|---|
| R-MWCL-1..5 | `extension/tests/monitor-mode-resilience.test.js` | Mode inference + tolerant render + split-window fallback + stderr capture + first-tick watchdog |
| R-MWCL-7 | (audit script) | ENFORCE entry verified |
| R-WTB-1 | `extension/tests/state-field-invariants.test.js` (existing, extended) | Default is 2400 |
| R-WTB-2/3 | `extension/tests/integration/worker-timeout-tier-budget.test.js` | Per-tier overrides |
| R-WTB-4 | (audit script) | ENFORCE entry |
| R-QGSK-1..4 | `extension/tests/skip-flag-collapse.test.js` | Unified flag + back-compat + migration |
| R-QGSK-5 | (grep) | Docs updated |
| R-RSU-1..4 | `extension/tests/integration/refinement-composes-fanout.test.js` | 3-source fanout produces ≥6 atomic tickets |
| R-RSU-5 | (audit script) | ENFORCE entry |
| R-CLOSER-1 | (release gate) | Full gate exit 0 |

## Risk Register

- **R1** (R-MWCL): the +2 LOC fix in R-MWCL-1 may interact badly with `restartDeadWatcherPanes` if existing call sites assume `mode === 'pickle'`. Mitigation: R-MWCL-3's split-window fallback handles unexpected mode values without crashing.
- **R2** (R-WTB): raising the default could mask real worker hangs that previously surfaced as timeouts. Mitigation: R-PTG's per-ticket test gate already catches stuck workers via test-failure mode; the timeout safety net is a backup.
- **R3** (R-QGSK): schema migration must handle nested state.flags objects correctly. Mitigation: R-QGSK-3 regression test fixture covers nested structure.
- **R4** (R-RSU): Concurrent decomposer Morty spawns could exceed claude API rate limits if N is large. Mitigation: R-RSU-2 spawns are bounded at N=number-of-source-PRDs (typically 2-10); rate-limiter already in place at `pickle-utils.ts::spawnClaudeProcess`.
- **R5** (bundle scope): 22 tickets is at the edge of the sanctioned 14-ticket cap. Mitigation: tightly-themed (operational tax + refinement unblock), section-by-section enumeration in this PRD body, no `composes:`-walker dependency (R-RSU's own bug is what motivated inline enumeration).

## Implementation Task Breakdown

Refinement team will decompose each `### R-XXX-N` section above into a `linear_ticket_<hash>.md` worker file. Expected output: 21 atomic implementation tickets + 1 closer = 22 total. Order: R-MWCL-1 → R-MWCL-2 → ... → R-RSU-5 → R-CLOSER-1 (priority by P3-then-P2 within R-codes, closer last).

## Out of Band Concerns

- R-MWCL-3's `tmux split-window` fallback assumes the tmux session is alive; if session was killed by SIGINT, that's a separate concern (R-SOA covers signal attribution, already shipped).
- R-WTB's tier override precedence MUST NOT silently downgrade timeout when settings/flags absent — explicit fall-through to compiled default, not to a lower value.
- R-QGSK's deprecation warnings can be suppressed via `state.flags.skip_quality_gates_deprecation_warning: true` for users who haven't migrated yet; deprecation removal target is one release cycle past this bundle's ship.
- R-RSU-2's parallel decomposer spawns MUST NOT share temp directories — each gets `mktemp -d` with `mkdtemp+realpathSync` to avoid the parallel-tmp race class.

## Success definition

Closer's release gate exits 0 against the full test tier; deployed `~/.claude/pickle-rick/` md5-parity verified on top 5 compiled files; MASTER_PLAN.md updated with closed findings; `git status` clean; no uncommitted changes; version tag advanced.
