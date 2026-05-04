---
title: P2 — Worker silent-exit after research-review + refined-ticket file-path drift
status: Draft
date: 2026-05-04
priority: P2
type: bug
peer_prds:
  related:
    - prds/p1-iteration-cap-and-phantom-done-handshake.md   # parent — phantom-Done watcher catches *flips*; this PRD handles *no-flip-no-progress* exits
    - prds/p2-refined-tickets-trip-readiness-contract-resolver.md   # adjacent — that PRD handles the gate; this one is post-gate
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md   # surfaced here
---

# PRD — Worker silent-exit + ticket file-path drift

## Symptoms

Reliability-bundle session `2026-05-03-7d9ee8cc` ticket `ab62807f` flipped to `status: Failed` post-research-review. Forensics:

| Artifact | Status |
|---|---|
| `linear_ticket_ab62807f.md` | exists, 3.7K |
| `research_2026-05-04.md` | exists, COMPLETE |
| `research_review.md` | exists, 228B, **APPROVED** |
| `plan_*.md` | **MISSING** |
| `plan_review.md` | **MISSING** |
| `conformance_*.md` | **MISSING** |
| `code_review_*.md` | **MISSING** |
| `worker_session_94069.log` | exists, **0 bytes** (empty) |

Worker (PID 94069) ran 1 minute 8 seconds, then exited. The session log captured ZERO output. The lifecycle `research → plan → implement → verify → review → refactor` halted silently after the research-review approval.

The validation rule (`pickle.md:Phase 3.A` Step 3 — "FORBIDDEN to mark Done if missing [plan_*.md, conformance_*.md, code_review_*.md]") correctly refused to mark Done, and instead the ticket was marked Failed. mux-runner moved on to the next ticket. **No alert, no retry, no diagnosis** — the failure surface is a single `status: Failed` flip in frontmatter.

Two distinct root causes contributed:

### RC-1 — Worker silent-exit after research-review

The worker process exited after producing research + research_review without producing the downstream lifecycle artifacts. The `worker_session_<pid>.log` is 0 bytes, suggesting either:

- The worker's stdout was redirected but never flushed before exit
- The worker's claude CLI subprocess hit an internal limit (token budget, max-turns) and exited 0 without surfacing the abort to its log file
- The worker emitted `<promise>I AM DONE</promise>` prematurely after just research, before plan/implement/verify/review

Without log evidence, root cause is hypothesis-only. The 0-byte log is itself a bug — workers should always flush stream output before exit.

### RC-2 — Refined ticket points at a non-existent file path

The ticket body says:

> ## Implementation Details
> ### Files to modify
> - `extension/src/services/resolve-state.ts`

But `extension/src/services/resolve-state.ts` does not exist. The actual code path is `extension/src/services/state-manager.ts:recoverStaleActiveFlag` (line 618). The research output correctly identified the discrepancy:

> The ticket path `extension/src/services/resolve-state.ts` is wrong; that file doesn't exist. The dead-pid demotion logic lives in `state-manager.ts:recoverStaleActiveFlag`.

This is a refinement-team output quality issue. The analyst that drafted the ticket assumed `resolve-state.ts` based on prose like "resolve-state demotes paused orphan" but didn't verify the file existed in source. The hooks `extension/src/hooks/resolve-state.ts` exists (different layer — hook handler, not service), but the service variant doesn't.

## Why this is a distinct bug class

`prds/p1-iteration-cap-and-phantom-done-handshake.md` shipped fixes for:
- Cap-hit-without-promise → exit code 3 (R-ICP-1)
- Pipeline halt on phase exit 3 (R-ICP-2)
- Phantom-Done watcher with backfill (R-ICP-5)
- Worker prompt requires completion_commit (R-ICP-6)

None of those help here:
- The worker did NOT hit the cap.
- The worker did NOT phantom-flip status: Done.
- The worker did NOT lie about completing — it just didn't continue past research.

`prds/p2-refined-tickets-trip-readiness-contract-resolver.md` covers refinement-team output drift in the form of forward-references and bad backticks. RC-2 is a different drift — wrong-file-path-in-prose — that the contract resolver doesn't catch (because the path exists at SOMEONE's home, just not where the ticket claims).

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-WSE-1 | Worker session log MUST always flush before exit. Add `process.stdout.write('', () => process.exit(code))` (or equivalent) in `spawn-morty.ts` worker shutdown path. 0-byte session logs are a bug, never a feature. | P0 |
| R-WSE-2 | When worker exits with research-review APPROVED but downstream lifecycle artifacts missing, mux-runner emits a NEW activity event `worker_partial_lifecycle_exit` with `{ticket: <id>, artifacts_missing: [...], session_log_size: <bytes>}`. Operator can audit how often this happens. | P0 |
| R-WSE-3 | mux-runner exit-validation: if `status: Failed` is set on a ticket AND research_review.md ends in `APPROVED`, log a stderr breadcrumb `⚠ ticket <id> failed AFTER research APPROVED — see ${SESSION_ROOT}/<id>/ for partial artifacts` so operator notices vs silently moving on. | P1 |
| R-WSE-4 | Worker prompt (in `send-to-morty.md`) explicit reminder: "Do NOT emit `<promise>I AM DONE</promise>` until ALL six lifecycle phases (research, plan, implement, verify, review, refactor) have produced their artifacts. Premature `I AM DONE` after just research will fail validation and the ticket will be reverted to Failed." Belt-and-suspenders with R-ICP-6 commit hash requirement. | P1 |
| R-RPD-1 | Refinement-team analyst prompt (in `spawn-refinement-team.ts`) adds a hard rule: "Every `Files to modify` path MUST be verified to exist in the repo at HEAD via `git ls-files <path>` BEFORE inclusion. Files that don't exist must use the `Files to create` section instead. Path-drift between description and reality fails downstream lifecycle." | P0 |
| R-RPD-2 | Refinement-team `extractContractReferences`-equivalent (or a new `validateTicketPaths` step) scans ticket body for paths under `## Files to modify`/`## Files to create`/`Files:`/`### Files to modify` and runs `git ls-tree HEAD -- <path>` for each. Paths that don't resolve get a per-ticket warning in `refinement_manifest.json`. | P1 |
| R-RPD-3 | Existing-session backfill: small script `extension/bin/audit-ticket-paths.js` walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` files, runs the same check, prints a report. Operator runs this BEFORE pipeline launch on bundles that haven't been path-validated. | P1 |
| R-RPD-4 | Regression test: synthetic ticket with `Files to modify: extension/src/imaginary.ts`; refinement validation flags the warning; CI fails on the path-drift fixture. | P1 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-WSE-01 | Worker session log size > 0 bytes for any worker that emits any output — Verify: `cd extension && npm test -- --grep worker-session-log-flush` — Type: test |
| AC-WSE-02 | `worker_partial_lifecycle_exit` event recorded — Verify: regression fixture forces partial-exit; `state.activity` contains the event — Type: test |
| AC-WSE-03 | Stderr breadcrumb on ticket-fail-after-research-approved — Verify: regression fixture; stderr contains `⚠ ticket .* failed AFTER research APPROVED` — Type: test |
| AC-WSE-04 | Worker prompt updated — Verify: `grep -c "ALL six lifecycle phases" .claude/commands/send-to-morty.md` ≥ 1 — Type: lint |
| AC-RPD-01 | Refinement analyst prompt updated — Verify: `grep -c "git ls-files" extension/src/bin/spawn-refinement-team.ts` references the path-validation rule — Type: lint |
| AC-RPD-02 | refinement_manifest.json has `path_drift_warnings` field with one entry per non-existent `Files to modify` path — Verify: regression fixture — Type: test |
| AC-RPD-03 | `audit-ticket-paths.js` exits 0 when all paths resolve, 1 + report when any drift — Verify: regression fixture session — Type: shell |
| AC-RPD-04 | Existing reliability-bundle session `2026-05-03-7d9ee8cc` re-audited; ab62807f flagged with the resolve-state.ts→state-manager.ts drift — Verify: `bash extension/bin/audit-ticket-paths.js /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc` — Type: integration |

## Workaround until R-WSE-* + R-RPD-* land

- **For ab62807f**: when the bundle finishes, manually edit the ticket's `## Files to modify` section: replace `extension/src/services/resolve-state.ts` with `extension/src/services/state-manager.ts:recoverStaleActiveFlag`. Then `/pickle-retry ab62807f`.
- **For other Failed/Todo tickets in this session**: run a parallel-agent path audit (already dispatched in the current Pickle Rick session). Flag any ticket with the same drift, fix descriptions before retry.
- **General-case**: operator manually runs `git ls-files | grep <claimed-path>` on each Failed ticket's "Files to modify" section before retry.

## Cross-references

- Ticket dir: `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/ab62807f/`
- Worker artifacts: `research_2026-05-04.md` (COMPLETE), `research_review.md` (APPROVED), `worker_session_94069.log` (0B)
- Source PRD: `prds/p3-paused-session-orphan-blocks-stop-hook.md` (R-PSO-1 mapping)
- Source code (correct path): `extension/src/services/state-manager.ts:618-629` `recoverStaleActiveFlag`
- Worker spawn entry point: `extension/src/bin/spawn-morty.ts`
- Validation site: `extension/src/bin/mux-runner.ts` (the lifecycle-artifact check + Failed flip)
- Refinement entry point: `extension/src/bin/spawn-refinement-team.ts` (where R-RPD-1/-2 land)

— Pickle Rick out. *belch*

---

## Session Notes — Recurrence on `2026-05-03-7d9ee8cc` (2026-05-04 PM)

**RC-1 fired again on the very last ticket of the reliability bundle.**

- Ticket: `dddee00b` — "Audit: cross-reference consistency for reliability + test-coverage bundle" (order 380, last in queue)
- Worker session log: `<session>/dddee00b/worker_session_47876.log` — **0 bytes**
- Observable: lifecycle artifacts up through `plan_2026-05-04.md` and `plan_review.md` exist; downstream `implement_*`, `verify_*`, `review_*` artifacts do NOT
- Pipeline impact: ticket stuck `In Progress`, session marked `step=completed exit_reason=failed`, **0/4 phases ran** (no citadel/anatomy-park/szechuan-sauce)
- Final tally: 37/38 tickets Done; this single 0-byte spawn is the entire reason the bundle did not ship clean

**Pairing with the cross-backend leak PRD.** Peer bug `prds/p1-worker-spawns-codex-despite-claude-backend.md` was filed the same day after forensic review found 11+ worker logs across 8 ticket dirs ending in the codex CLI's `chatgpt.com/codex/settings/usage` error. The two bugs interact: when the spawned worker IS codex but the session backend is claude, codex exits on the usage limit — sometimes producing hundreds of KB of output (the cross-backend leak case), sometimes apparently producing zero output (this RC-1 case at `dddee00b`).

It is NOT yet confirmed whether the `dddee00b` 0-byte log is:
- (a) The same RC-1 silent-exit (worker process aborted before any write), OR
- (b) A degenerate case of the cross-backend leak where codex exited so fast it didn't even flush its banner

If (b), then RC-1 is partially subsumed by the cross-backend PRD and the count of "true silent exits" drops. The R-XBL-6 audit script (in that new PRD) is the cheapest way to disambiguate — once `audit-worker-backends.ts` lands, run it on this session and see whether `dddee00b` shows up.

**Operator impact.** Bundle has 22 unpushed local commits (work is real and shippable), but pipeline-status.json reports `failed`. Per resume directive the operator does not push automatically; this recurrence note plus the cross-backend PRD are the inputs to that decision.
