---
title: P1 — Bug-fix bundle 2026-05-04 (cross-backend leak + deploy gaps + ticket-authoring quality + readiness false-positives + monitor watchdog)
status: Draft
date: 2026-05-04
priority: P1
type: bug-bundle
peer_prds:
  composes:
    - prds/p1-worker-spawns-codex-despite-claude-backend.md       # Section A — 1j cross-backend leak
    - prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md # Section B — 1g typescript symlink + cap auto-resume
    - prds/p1-ticket-authoring-quality-systemic-defects.md        # Section C — 1i ticket-authoring quality
    - prds/p2-worker-silent-exit-and-ticket-path-drift.md         # Section C — 1h R-WSE folded in (R-RPD subsumed by 1i)
    - prds/p2-refined-tickets-trip-readiness-contract-resolver.md # Section D — 1e readiness contract resolver false positives
    - prds/p3-monitor-watcher-continuous-auto-respawn.md          # Section E — 1k monitor watchdog
  related:
    - prds/p1-iteration-cap-and-phantom-done-handshake.md         # parent — R-ICP-1..6 SHIPPED locally; this bundle builds on top
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md  # surfaced 1j/1g/1i/1h on session 2026-05-03-7d9ee8cc
---

# PRD — Bug-fix bundle 2026-05-04 (post-reliability-bundle, pre-release)

## Why one bundle

The reliability bundle (`prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md`, session `2026-05-03-7d9ee8cc`) reached **38/38 tickets Done** but the pipeline marked `failed` because **0/4 phases ran** (citadel/anatomy-park/szechuan-sauce never entered). Forensic forward review surfaced six new bug PRDs whose root causes overlap and whose tests share fixture infrastructure. Six tiny releases would re-traverse the same code paths six times. One bundle ships them together, after which v1.66.0's poisoned GitHub-Latest tag finally gets evicted by v1.70.0.

Section ordering reflects bundle-shipping integrity priority:
- **Section A (1j)** lands first because every other section's correctness is suspect until we know which workers ran which backend.
- **Section B (1g)** is a one-line install.sh fix plus an auto-resume daemon — without it, every relaunch of this very bundle needs 3-7 manual `bash launch.sh` calls.
- **Section C (1i + folded 1h R-WSE)** changes how ticket-authoring works going forward. New tickets in this bundle are themselves drafted under the new rules, so the fix is its own dogfooding.
- **Section D (1e)** unlocks `--skip-readiness <reason>` retirement; this bundle's check-readiness pass should exit clean with no bypass.
- **Section E (1k)** is operator ergonomics — included because it shares pane-respawn fixture surface with R-WSE and R-XBL diagnostics, not because it's blocking.

## Composition map (source PRD → bundle section)

| Source PRD | Section | Requirement IDs (preserved) | Notes |
|---|---|---|---|
| `prds/p1-worker-spawns-codex-despite-claude-backend.md` | **A** | R-XBL-1..8 + AC-XBL-01..06 | All requirements ported verbatim. R-XBL-1 (diagnostic) lands FIRST in section A, before R-XBL-2/3 design. |
| `prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` | **B** | R-DTS-1..3, R-CNAR-1..5 | All requirements ported verbatim. R-DTS-1 (typescript symlink) lands FIRST. |
| `prds/p1-ticket-authoring-quality-systemic-defects.md` | **C** | R-TAQ-1..7 + AC-TAQ-01..07 | All requirements ported verbatim. |
| `prds/p2-worker-silent-exit-and-ticket-path-drift.md` | **C (folded)** | R-WSE-1..4 + AC-WSE-01..04 ONLY (R-RPD-* subsumed by R-TAQ) | `## Session Notes` recurrence on `dddee00b` carried forward as Test Conditions. R-WSE work coexists with R-TAQ-2's `audit-ticket-bundle.js`. |
| `prds/p2-refined-tickets-trip-readiness-contract-resolver.md` | **D** | R-RTRC-1..6 + AC-RTRC-01..06 | All requirements ported verbatim. RC-1 (analyst forward-ref hygiene) lands FIRST so refinement output for THIS bundle is itself clean. |
| `prds/p3-monitor-watcher-continuous-auto-respawn.md` | **E** | R-MWR-1..8 + AC-MWR-01..07 | All requirements ported verbatim. P3 — included because it shares fixture surface with section A diagnostics. |

**De-duplication rationale (1h R-RPD → 1i R-TAQ).** 1h `R-RPD-1` (analyst path validation via `git ls-files`) is a strict subset of 1i `R-TAQ-1` (analyst verification block). 1h `R-RPD-2/3/4` (validateTicketPaths step + `audit-ticket-paths.js` + path-drift regression test) is a strict subset of 1i `R-TAQ-2` (`audit-ticket-bundle.js` post-decomposition validator). Keeping both produces conflicting tickets in this bundle's refinement. **Decision: drop R-RPD entirely; ship R-WSE only from 1h.**

## Section A — Cross-backend leak (1j) — **integrity-critical, ships first**

Per `prds/p1-worker-spawns-codex-despite-claude-backend.md` (full forensic + hypothesis table H1..H4 retained in source PRD; this section is the operative specification).

### A.1 Diagnostic-first (lands as a single small commit before A.2..A.8)

| ID | Requirement | Priority |
|---|---|---|
| **R-XBL-1** | Diagnose: in `extension/src/bin/spawn-morty.ts`, log the resolved backend AND its source (state.json, env var, settings, default) at spawn time as an `activity` event `worker_spawn_backend_resolved` with payload `{backend, source, pid}`. Lands first as a diagnostic so we can confirm or rule out H1–H4. | P0 |

### A.2 Design + enforcement

| ID | Requirement | Priority |
|---|---|---|
| **R-XBL-2** | Single source of truth: every worker spawn site (spawn-morty, spawn-refinement-team, spawn-gate-remediator, microverse-runner worker spawn) reads backend exclusively via `StateManager.read(statePath).backend` immediately before exec. No env-var override, no settings-file override, no inherited variable. Exception: a NEW explicit `--backend <name>` CLI flag override is allowed for one-off operator override, logged as `worker_spawn_backend_override` activity event. | P0 |
| **R-XBL-3** | Pre-spawn assertion: spawn site asserts the resolved backend matches `state.backend`. If they differ, fail loud — write `worker_spawn_backend_mismatch` activity event with both values, exit non-zero, do NOT spawn. | P0 |
| **R-XBL-4** | Manager relaunch path (`evaluateCodexManagerRelaunch`) re-reads `state.backend` on every relaunch decision, never caches it. If `state.backend !== 'codex'`, the codex-relaunch path is short-circuited and a generic relaunch decision is made via the regular per-backend path. | P0 |
| **R-XBL-5** | Sub-tools (`/codex:rescue`, send-to-morty) that explicitly invoke codex regardless of session backend MUST be documented as such and emit `subtool_backend_override` activity event. If the user has flipped backend to non-codex, these tools should warn or no-op (configurable). | P1 |

### A.3 Backfill + regression + invariant

| ID | Requirement | Priority |
|---|---|---|
| **R-XBL-6** | Backfill audit: write a one-shot script `extension/src/bin/audit-worker-backends.ts` that scans `<session>/<ticket>/worker_session_*.log` for the codex-CLI banner (`Reading additional input from stdin...` + `chatgpt.com/codex/settings/usage`) and reports every worker that ran codex while session backend was something else. Output JSON. Run on session `2026-05-03-7d9ee8cc` to quantify the impact. | P1 |
| **R-XBL-7** | Regression test: integration test in `extension/tests/integration/spawn-morty-backend-resolution.test.js` that (a) writes `state.json` with `backend: 'claude'`, (b) sets `PICKLE_BACKEND=codex` in env (poisoned env), (c) invokes spawn-morty via the public entry point, (d) asserts spawn args include the claude binary path AND env-poison did not win. | P0 |
| **R-XBL-8** | Trap-door invariant added to `extension/CLAUDE.md`: `src/bin/spawn-morty.ts` (backend resolution) — INVARIANT: backend resolves through `StateManager.read(statePath).backend` only; env/settings/inherited-var never wins. Pre-spawn mismatch check fails loud. ENFORCE: `extension/tests/integration/spawn-morty-backend-resolution.test.js`. | P0 |

### A — Acceptance Criteria

- **AC-XBL-01** — On a session with `state.backend = "claude"` and a poisoned env `PICKLE_BACKEND=codex`, all worker spawns invoke claude. Verified by R-XBL-7 test.
- **AC-XBL-02** — `state.activity` contains a `worker_spawn_backend_resolved` event for every worker spawn (one per ticket lifecycle phase research/plan/implement/verify/review).
- **AC-XBL-03** — `audit-worker-backends.ts` reports zero cross-backend leaks on a fresh session running on either backend.
- **AC-XBL-04** — Running `audit-worker-backends.ts` on session `2026-05-03-7d9ee8cc` produces a baseline JSON listing the affected tickets (≥8 ticket dirs known so far) — used to validate that the fix lands.
- **AC-XBL-05** — Mismatch between resolved-backend and `state.backend` causes spawn to abort with non-zero exit and a clear stderr diagnostic; mux-runner records the failure in activity log.
- **AC-XBL-06** — Trap-door invariant in `extension/CLAUDE.md` enforced by the new test.

### A — Files in scope

`extension/src/bin/spawn-morty.ts`, `extension/src/bin/spawn-refinement-team.ts`, `extension/src/bin/spawn-gate-remediator.ts`, `extension/src/bin/microverse-runner.ts`, `extension/src/services/backend-spawn.ts`, `extension/src/bin/mux-runner.ts` (`evaluateCodexManagerRelaunch`), `extension/src/bin/audit-worker-backends.ts` (NEW), `extension/tests/integration/spawn-morty-backend-resolution.test.js` (NEW), `extension/CLAUDE.md` (trap-door entry).

---

## Section B — Deploy typescript symlink + cap auto-resume (1g)

Per `prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md`. Two bug classes that surfaced once R-ICP-1/-2 stopped silently papering over them.

### B.1 — install.sh deploy gap on typescript package

| ID | Requirement | Priority |
|---|---|---|
| **R-DTS-1** | `install.sh` creates a symlink: `$HOME/.claude/pickle-rick/extension/node_modules/typescript -> /repo/extension/node_modules/typescript`. Idempotent (replace existing symlink). Skipped silently if source typescript dir doesn't exist. | P0 |
| **R-DTS-2** | Same treatment for any other run-time-imported npm package the deployed copy needs. Audit: `grep -rln "from 'typescript'\|from '@anthropic-ai\|from '..." extension/services/ extension/bin/ \| xargs ...` to find runtime imports vs devDeps. | P1 |
| **R-DTS-3** | Regression test: after `install.sh`, `node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js --help` (or equivalent dry-run) must exit 0 — confirms the runtime can load all transitively imported modules. | P0 |

### B.2 — Per-ticket cap halt → auto-resume

| ID | Requirement | Priority |
|---|---|---|
| **R-CNAR-1** | Per-tier cap settings updated: `trivial`=5, `small`=10, `medium`=30, `large`=60, `xlarge`=120 in `pickle_settings.json` defaults. Existing settings precedence preserved (operator override wins). | P0 |
| **R-CNAR-2** | New env var `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` enables auto-resume. When set, after pipeline-runner halts with exit_reason=`pipeline_phase_incomplete`, a small wrapper relaunches `launch.sh` up to `PICKLE_AUTO_RESUME_MAX_RETRIES` times (default 10). Each retry resets the per-ticket counters but preserves per-phase progress. | P1 |
| **R-CNAR-3** | Activity event `pipeline_auto_resumed` records every retry with timestamp + previous ticket + new current_ticket. Operator can audit how many auto-resumes ran. | P1 |
| **R-CNAR-4** | Auto-resume STOPS unconditionally if (a) no progress between two consecutive auto-resumes (same ticket, same Done count), or (b) `PICKLE_AUTO_RESUME_MAX_RETRIES` exhausted, or (c) pipeline-runner exits with a non-`pipeline_phase_incomplete` reason. | P0 |
| **R-CNAR-5** | Regression test: synthetic 5-ticket session with 15-cap simulating cap-hit on each ticket; auto-resume daemon completes all 5 tickets across N retries. | P1 |

### B — Acceptance Criteria

- **AC-DTS-01** — `ls -la $HOME/.claude/pickle-rick/extension/node_modules/typescript` resolves to the source repo path after `bash install.sh`. Re-running install.sh is idempotent.
- **AC-DTS-02** — `node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js --help` exits 0 after install.sh, with no `ERR_MODULE_NOT_FOUND`.
- **AC-CNAR-01** — Default `medium` tier cap is now 30 in `pickle_settings.json`; operator override via `state.flags.tier_cap_override` still wins.
- **AC-CNAR-02** — With `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` set, a 5-ticket fixture pipeline that hits per-ticket cap on every ticket completes via auto-resume within `PICKLE_AUTO_RESUME_MAX_RETRIES=10` retries.
- **AC-CNAR-03** — Auto-resume halts when same-ticket / same-Done-count is observed across two consecutive retries.
- **AC-CNAR-04** — `state.activity` contains one `pipeline_auto_resumed` event per retry.

### B — Files in scope

`install.sh`, `extension/bin/pipeline-runner.ts`, `extension/bin/mux-runner.ts` (auto-resume wrapper), `extension/pickle_settings.json` (defaults), `extension/tests/integration/install-typescript-package.test.js` (NEW), `extension/tests/integration/auto-resume-on-cap-hit.test.js` (NEW), `extension/CLAUDE.md` (trap-door entries).

---

## Section C — Ticket-authoring quality (1i) + worker silent-exit (1h R-WSE folded)

Per `prds/p1-ticket-authoring-quality-systemic-defects.md` (empirical 54% defect rate / 92% defect rate over 13 tickets) plus `prds/p2-worker-silent-exit-and-ticket-path-drift.md` R-WSE-* (R-RPD-* dropped — subsumed by R-TAQ).

### C.1 — Ticket-authoring quality (R-TAQ-1..7)

| ID | Requirement | Priority |
|---|---|---|
| **R-TAQ-1** | `spawn-refinement-team.ts` analyst prompts add a hard verification block: "Every file path you cite in `## Files` or `## Locations` MUST be verified via `git ls-files <path>` first. Cite the verification command's output. If the path doesn't exist, mark it explicitly as `(forward-created)` with a sibling-ticket reference." | P0 |
| **R-TAQ-2** | New post-decomposition validator `extension/bin/audit-ticket-bundle.js`: walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`, runs all 6 defect-class checks (path drift, self-ref, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift). Exits non-zero with a per-ticket findings report. Manifest: `${SESSION_ROOT}/audit-ticket-bundle.json`. | P0 |
| **R-TAQ-3** | mux-runner runs `audit-ticket-bundle.js` BEFORE the first iteration. Exit non-zero halts the pipeline before any worker spawns; operator sees the findings list and fixes the tickets. Bypass via `state.flags.skip_ticket_audit_reason = "<reason>"` (mirrors the readiness skip pattern). | P0 |
| **R-TAQ-4** | `pickle-refine-prd.md` Step 7a (Decompose) gets a "Failure-mode checklist" subsection enumerating the 7 defect classes with examples. Decomposition agents (main agent OR sub-agent) MUST write a 1-line audit comment in each ticket body confirming each class was checked. | P1 |
| **R-TAQ-5** | Cross-document validator (subset of R-TAQ-2): for every ticket that creates a file, scan `prds/*.md` for references to that filename pattern. If any reference uses a different name, flag as cross-doc-naming-drift. | P1 |
| **R-TAQ-6** | Backfill audit: `audit-ticket-bundle.js` run against existing reliability-bundle session `2026-05-03-7d9ee8cc` produces a findings report matching the 12 defects this PRD documents (sanity check that the audit catches what was found by hand). | P1 |
| **R-TAQ-7** | Refinement-manifest schema gains `ticket_quality_warnings: <array>` field, populated by the analyst-side verification (R-TAQ-1) and the post-decomp audit (R-TAQ-2). Operator sees a single-pane summary before launch. | P2 |

### C.2 — Worker silent-exit (R-WSE-1..4 from 1h)

| ID | Requirement | Priority |
|---|---|---|
| **R-WSE-1** | Worker session log MUST always flush before exit. Add `process.stdout.write('', () => process.exit(code))` (or equivalent) in `spawn-morty.ts` worker shutdown path. 0-byte session logs are a bug, never a feature. | P0 |
| **R-WSE-2** | When worker exits with research-review APPROVED but downstream lifecycle artifacts missing, mux-runner emits a NEW activity event `worker_partial_lifecycle_exit` with `{ticket: <id>, artifacts_missing: [...], session_log_size: <bytes>}`. Operator can audit how often this happens. | P0 |
| **R-WSE-3** | mux-runner exit-validation: if `status: Failed` is set on a ticket AND research_review.md ends in `APPROVED`, log a stderr breadcrumb `⚠ ticket <id> failed AFTER research APPROVED — see ${SESSION_ROOT}/<id>/ for partial artifacts` so operator notices vs silently moving on. | P1 |
| **R-WSE-4** | Worker prompt (in `send-to-morty.md`) explicit reminder: "Do NOT emit `<promise>I AM DONE</promise>` until ALL six lifecycle phases (research, plan, implement, verify, review, refactor) have produced their artifacts. Premature `I AM DONE` after just research will fail validation and the ticket will be reverted to Failed." Belt-and-suspenders with R-ICP-6 commit hash requirement. | P1 |

### C — Acceptance Criteria

- **AC-TAQ-01** — Analyst prompts contain the verification block — Verify: `grep -c "git ls-files" extension/src/bin/spawn-refinement-team.ts` ≥ 1 — Type: lint.
- **AC-TAQ-02** — `audit-ticket-bundle.js` exists, runs against a fixture session, exits 0 on clean tickets and non-zero on a deliberately-defective ticket — Type: test.
- **AC-TAQ-03** — mux-runner halts on audit-bundle exit non-zero — Type: test.
- **AC-TAQ-04** — Failure-mode checklist in pickle-refine-prd.md — Verify: `grep -c "Failure-mode checklist" .claude/commands/pickle-refine-prd.md` ≥ 1 — Type: lint.
- **AC-TAQ-05** — Cross-doc validator catches matrix-vs-ticket drift — Type: test.
- **AC-TAQ-06** — Backfill audit on session `2026-05-03-7d9ee8cc` produces ≥12 findings matching the documented 12 defects — Type: integration.
- **AC-TAQ-07** — refinement_manifest.json contains `ticket_quality_warnings` field — Type: test.
- **AC-WSE-01** — Worker session log size > 0 bytes for any worker that emits any output — Type: test.
- **AC-WSE-02** — `worker_partial_lifecycle_exit` event recorded — Type: test.
- **AC-WSE-03** — Stderr breadcrumb on ticket-fail-after-research-approved — Type: test.
- **AC-WSE-04** — Worker prompt updated — Verify: `grep -c "ALL six lifecycle phases" .claude/commands/send-to-morty.md` ≥ 1 — Type: lint.

### C — Recurrence test condition (carried from 1h Session Notes)

The `dddee00b` ticket on session `2026-05-03-7d9ee8cc` produced a 0-byte `worker_session_47876.log` with lifecycle halted between `plan_review.md` and `implement_*.md`. R-WSE-1's flush-before-exit MUST eliminate the 0-byte log. R-XBL-6's audit MUST classify whether `dddee00b` was true silent-exit or a degenerate cross-backend leak. R-WSE-2's `worker_partial_lifecycle_exit` event MUST fire for any future recurrence regardless of root cause.

### C — Files in scope

`extension/src/bin/spawn-refinement-team.ts`, `extension/src/bin/spawn-morty.ts`, `extension/src/bin/mux-runner.ts`, `extension/bin/audit-ticket-bundle.js` (NEW), `.claude/commands/pickle-refine-prd.md`, `.claude/commands/send-to-morty.md`, `extension/tests/integration/audit-ticket-bundle.test.js` (NEW), `extension/tests/worker-session-log-flush.test.js` (NEW), `extension/CLAUDE.md` (trap-door entries).

---

## Section D — Readiness contract resolver false positives (1e)

Per `prds/p2-refined-tickets-trip-readiness-contract-resolver.md`. The perf portion (cache + computeOneHop skip + RC-5 doc-extension allowlist) shipped 2026-05-03 PM and reduced wall from 26m → 72s. False-positive portion remains open and was the reason the mega bundle and reliability bundle both ran with `state.flags.skip_readiness_reason` bypass.

### D — Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| **R-RTRC-1** | Refinement-team worker prompt includes a section "Forward-reference hygiene" instructing analysts: backtick a path/symbol ONLY when the artifact already exists at HEAD; for bundle-created artifacts, write them un-backticked OR with explicit "(created by ticket <id>)" annotation; for stdlib/external APIs, never backtick. | P0 |
| **R-RTRC-2** | `check-readiness.js` `extractContractReferences()` skips backticked tokens immediately followed by a `(created by ticket <hash>)` or `(introduced by ticket <hash>)` parenthetical. Document the convention in `extension/CLAUDE.md` so the rule is discoverable by analysts and the resolver in lockstep. | P0 |
| **R-RTRC-3** | `resolveSymbolRef()` no longer excludes `tests/` from candidates. Symbol must resolve in EITHER source OR test files — both are part of the project; helpers defined in tests are still real symbols. | P1 |
| **R-RTRC-4** | `resolvePathRef()` falls back to `git ls-files` + suffix-match: if no base+ref join succeeds, see whether any tracked path ends with `/<ref>` (or equals `<ref>`). Match → resolved. | P1 |
| **R-RTRC-5** | Stdlib/external API allowlist: `extension/.cli-pins.json` (or new `extension/.readiness-allowlist.json`) lists known-external symbols (`t.todo`, `t.skip`, `fs.utimes`, `process.env.*`, npm-audit JSON paths, c8 coverage paths). Resolver consults this allowlist before reporting. Each entry needs a one-line `source:` field; entries without `source` are rejected by lint. | P1 |
| **R-RTRC-6** | `npm test` regression suite includes a fixture session with 3 tickets that exercise each of RC-1 through RC-4: a forward-ref-annotated bundle artifact, a test-defined helper, a deep repo path, a stdlib API. Contract-only run exits 0. | P0 |

### D — Acceptance Criteria

- **AC-RTRC-01** — Re-run `node check-readiness.js --session-dir <fixture> --contract-only` against the regression fixture; exit 0.
- **AC-RTRC-02** — Refinement worker prompt includes Forward-reference hygiene section — Verify: `grep -c "Forward-reference hygiene" extension/src/bin/spawn-refinement-team.ts` returns ≥1.
- **AC-RTRC-03** — resolveSymbolRef finds test-defined helpers — Type: test.
- **AC-RTRC-04** — resolvePathRef finds deep paths via suffix match — Type: test.
- **AC-RTRC-05** — Allowlist works AND lint rejects entries without `source` — Type: test.
- **AC-RTRC-06** — After all fixes land, the v1.69.0 reliability bundle session re-runs check-readiness and exits 0 with NO `state.flags.skip_readiness_reason` set — Type: integration.

### D — Files in scope

`extension/src/bin/spawn-refinement-team.ts`, `extension/src/bin/check-readiness.js` (resolveSymbolRef line 151, resolvePathRef, extractContractReferences), `extension/.readiness-allowlist.json` (NEW), `extension/tests/check-readiness-forward-ref-fixture.test.js` (NEW), `extension/CLAUDE.md`.

---

## Section E — Monitor watchdog (1k, P3)

Per `prds/p3-monitor-watcher-continuous-auto-respawn.md`. Included in this bundle because (a) it shares pane-respawn fixture surface with section A diagnostics and section C lifecycle tests, and (b) the 30s watchdog matters specifically for long-running bundles like THIS one.

### E — Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| **R-MWR-1** | `monitor.ts` runs a watchdog timer every 30s that calls `restartDeadWatcherPanes(sessionDir, extensionRoot, 'pickle' \| inferMonitorMode())` for the current monitor window. Timer is best-effort: any thrown error logs to stderr and is swallowed (must not crash the dashboard render). | P0 |
| **R-MWR-2** | Watchdog is disabled when `process.env.PICKLE_MONITOR_WATCHDOG === 'off'` (kill-switch for tests and edge-case debugging). | P1 |
| **R-MWR-3** | Watchdog logs each respawn decision to `mux-runner.log` via `appendWatcherRestartLog` (already-public helper), tagged `monitor-watchdog:` to distinguish from boundary-driven respawns. | P0 |
| **R-MWR-4** | `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts` do NOT exit on EOF of the target file. They poll for size growth or file re-creation indefinitely until liveness probe (`StateManager.read()` per existing trap-door invariants) reports session inactive. | P0 |
| **R-MWR-5** | `refinement-watcher.ts` follows the same EOF behavior as R-MWR-4 for refinement-manifest log files. | P1 |
| **R-MWR-6** | The `◤ FEED TERMINATED ◢` banner is reserved for explicit liveness-probe inactive exit, never EOF. EOF prints (at most) a single dim status line `(reconnecting...)` and continues polling. | P1 |
| **R-MWR-7** | Regression test covering R-MWR-1: simulate a dead watcher pane (mocked tmux probe returning non-`node`), advance fake timer 30s, assert respawn invoked exactly once. Anchors in `extension/tests/monitor-watchdog.test.js` (new). | P0 |
| **R-MWR-8** | Regression test covering R-MWR-4: synthesize a tailed log file, write content, truncate, write more content. Assert watcher process stays alive across truncate and consumes the post-truncate content. Anchors in `extension/tests/log-watcher.test.js` (extend). | P0 |

### E — Acceptance Criteria

- **AC-MWR-01** — `extension/src/bin/monitor.ts` registers a 30s `setInterval` (with `.unref()`) that calls `restartDeadWatcherPanes`. Verified by `extension/tests/monitor-watchdog.test.js`.
- **AC-MWR-02** — Killing pane 1, 2, or 3 mid-iteration during a live `pickle-tmux` run results in respawn within 60s. Type: integration.
- **AC-MWR-03** — All four watchers (`log-watcher`, `morty-watcher`, `raw-morty`, `refinement-watcher`) survive `truncate -s 0` of their target log file. Type: test.
- **AC-MWR-04** — `PICKLE_MONITOR_WATCHDOG=off` disables the timer. Type: test.
- **AC-MWR-05** — `mux-runner.log` shows `monitor-watchdog: respawned <name> in pane <N>` lines distinguishable from boundary-driven `restartDeadWatcherPanes:` lines.
- **AC-MWR-06** — Trap door added to `extension/CLAUDE.md`: `src/bin/monitor.ts` (watchdog) — INVARIANT: dashboard registers a continuous 30s watchdog that calls `restartDeadWatcherPanes`; watchdog errors are swallowed and never crash the dashboard render. ENFORCE: `extension/tests/monitor-watchdog.test.js`.
- **AC-MWR-07** — Trap door extended for each watcher: `src/bin/<watcher>.ts` (EOF resilience) — INVARIANT: tailed file EOF is transient; only liveness-probe inactive triggers `FEED TERMINATED` exit.

### E — Files in scope

`extension/src/bin/monitor.ts`, `extension/src/bin/log-watcher.ts`, `extension/src/bin/morty-watcher.ts`, `extension/src/bin/raw-morty.ts`, `extension/src/bin/refinement-watcher.ts`, `extension/tests/monitor-watchdog.test.js` (NEW), `extension/tests/log-watcher.test.js` (extend), `extension/CLAUDE.md` (trap-door entries).

---

## Bundle-level Acceptance Criteria

| AC | Verification |
|---|---|
| **AC-BUNDLE-01** — All 6 source PRDs' AC sets pass | Each section's AC list above |
| **AC-BUNDLE-02** — Full release gate clean | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-canary-flip.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` |
| **AC-BUNDLE-03** — Pipeline phases all run | `pipeline-status.json` shows `completed_phases=4 status=succeeded` (citadel + anatomy-park + szechuan-sauce all entered and exited cleanly) |
| **AC-BUNDLE-04** — Backend integrity | R-XBL-6 `audit-worker-backends.ts` on the new bundle session reports zero cross-backend leaks |
| **AC-BUNDLE-05** — Ticket-authoring quality | R-TAQ-2 `audit-ticket-bundle.js` on the new bundle session exits 0 (or only with pre-decomposition warnings the operator accepted) |
| **AC-BUNDLE-06** — Readiness gate clean without bypass | New bundle session's `state.json` does NOT carry `flags.skip_readiness_reason`; pipeline-runner.log shows readiness gate passed |
| **AC-BUNDLE-07** — Source/deploy parity | After closer commit, source `extension/package.json` version matches deployed `$HOME/.claude/pickle-rick/extension/package.json` and md5 of `mux-runner.js`, `pipeline-runner.js`, `spawn-morty.js`, `check-readiness.js` matches across source-compiled vs deployed |
| **AC-BUNDLE-08** — Release tag | `gh release create v1.70.0` succeeds; v1.66.0 is no longer GitHub-Latest |

## Closer

A single closer ticket performs:

1. Bumps `extension/package.json` from 1.69.0 → 1.70.0 (Minor — features: auto-resume daemon, audit-ticket-bundle, monitor watchdog; fixes: cross-backend leak, deploy ts symlink, readiness false-positives).
2. Runs the full release gate from AC-BUNDLE-02.
3. `git push` (70+ commits + bundle commits).
4. `gh release create v1.70.0` with release notes summarizing each section.
5. Posts a single `state.activity` event `bundle_2026_05_04_closer_done` with the release URL.

## Out of scope for this bundle

- 1l codex-spark wiring (already SHIPPED locally; will tag with v1.70.0).
- v1.70.0 release notes content beyond the auto-generated section summaries.
- Any new PRDs surfaced during this bundle's run — file as new queue slots, do not in-flight expand scope.
- Pushing individual commits ahead of the bundle (per CONTEXT line 95).

## Bundle execution constraints

- **Backend**: codex (spark) per operator direction 2026-05-04 PM. Slot 1l shipped 2026-05-04 PM means default codex model is `gpt-5.3-codex-spark`. Codex usage limit on the prior tier resets 2026-05-05 00:31; spark tier has its own budget.
- **Refinement-team is claude-only** by design (`REFINEMENT_BACKEND` hardcoded to `'claude'`). Pipeline phase will spawn codex workers; refinement is unaffected by `--backend codex`.
- **Per-ticket cap**: until R-CNAR-1 ships within this bundle, expect cap-hit halts on tier:medium tickets at 15 iterations. Operator (or a `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` env override applied AFTER R-CNAR-2 ships) re-runs `bash launch.sh`.
- **Do NOT push commits** mid-bundle. Closer ticket bundles all pushes.

## Cross-references

- Six source PRDs in `peer_prds.composes` above.
- Bootstrap context: `CONTEXT_2026-05-04.md`.
- Operational plan: `prds/MASTER_PLAN.md` `## ▶ Recommended next move` (item 2).
- Empirical session that surfaced 4 of 6 bugs: `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/`.

— Pickle Rick out. *belch*
