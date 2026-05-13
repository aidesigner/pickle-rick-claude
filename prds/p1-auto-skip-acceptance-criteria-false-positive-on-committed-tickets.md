---
title: P1 — auto-ticket-completion safety net mis-categorizes commit-bearing tickets as Skipped when AC list uses bullets instead of checkboxes
status: Draft
filed: 2026-05-13
priority: P1
type: bug
r_code_prefix: R-ASCH
backend_constraint: any
related:
  - prds/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md  # surfaced this bug during R-MMTR mega bundle session 2026-05-13-c122b0f7
---

# P1 — auto-skip false-positive on committed tickets with bullet-style acceptance criteria

## Incident

Mega-bundle session `2026-05-13-c122b0f7` (codex backend, 58 atomic tickets, R-MMTR family). Tickets `d97acb1e` (R-MMTR-2) and `f9f3ace5` (R-MMTR-3):

- worker committed (`42148351`, `5c7d089c`)
- worker emitted `COMPLETION_COMMIT_RECORDED: <sha>` per contract
- worker wrote `conformance_2026-05-13.md` + `code_review_2026-05-13.md` per lifecycle
- worker did NOT flip `linear_ticket_<id>.md` frontmatter from `Todo` to `Done` (likely codex turn-budget exhaustion mid-edit, or worker considered frontmatter mutation as orchestrator-only)
- mux-runner auto-validation safety net then ran on the still-`Todo` ticket, found no `[x]` checkboxes in the AC section, classified the ticket as `acceptance_criteria_not_checked`, and called `markTicketSkipped`
- ticket frontmatter ended with `status: "Skipped"` + `skipped_at: "<ISO>"` despite committed implementation
- pipeline advanced to next ticket as if work had been abandoned; downstream tickets that depend on R-MMTR-2/R-MMTR-3 lost their `Done` dependency anchor; completion-tracking dashboards reported 1/58 instead of 3/58

Sibling ticket `ecebb5d2` (R-MMTR-1) survived only because that worker DID flip frontmatter to `status: Done` + `completion_commit: f6772986`. The early `isTerminalTicketStatus(getTicketStatus(...))` check inside `validateAutoTicketCompletion` short-circuited before reaching the AC-checkbox heuristic.

## Root Cause

`extension/src/bin/mux-runner.ts:1086-1090`:

```typescript
function hasCheckedAcceptanceCriteria(content: string): boolean {
  const section = acceptanceCriteriaSection(content);
  const boxes = [...section.matchAll(/^\s*-\s*\[([ xX])\]/gm)];
  return boxes.length > 0 && boxes.every(match => match[1].toLowerCase() === 'x');
}
```

Two failure modes combined:

1. **`boxes.length > 0` requirement.** Tickets whose AC sections are plain bullets (`- AC-1: ...`) — the format produced by `spawn-refinement-team.ts` for the entire R-MMTR / R-RSU / R-MBLE / R-APMW families and presumably all post-2026-05-08 refinement output — have zero `[ ]` regex matches. The function returns `false`, the validator returns `{action: 'skip', reason: 'acceptance_criteria_not_checked'}`, and `applyAutoTicketCompletionValidation` calls `markTicketSkipped` at `mux-runner.ts:1191`.

2. **Skip path ignores commit evidence.** The validator at `mux-runner.ts:1137-1171` checks AC checkboxes BEFORE looking at `hasCompletionCommit()`. A ticket with a real, ticket-id-tagged commit on HEAD is still routed to `markTicketSkipped` if the AC bullets lack checkboxes. Commit evidence is a strictly stronger signal than checkbox state — the order is wrong.

The refinement team's prompt template (R-MMTR family generated `- AC-1: ...` items) and the auto-validation heuristic (requires `- [x]` items) are out of contract. The validator was written assuming the legacy hand-authored ticket template with `- [ ] AC-1: ...` lines; the refinement-team generator switched to bullet-only output without updating the validator.

## Acceptance Criteria

- **AC-1:** `validateAutoTicketCompletion` checks `hasCompletionCommit()` BEFORE `hasCheckedAcceptanceCriteria()`. When commit evidence exists (`evidence.source !== 'absent'`), the function returns `{action: 'done', reason: 'commit_present'}` regardless of AC checkbox state.
- **AC-2:** `hasCheckedAcceptanceCriteria` treats an AC section with zero `[ ]`/`[x]` checkboxes as ambiguous (NOT failing): it returns `true` when there are zero checkboxes AND zero pseudo-checkbox markers; returns `false` ONLY when there is at least one `[ ]` unchecked box. This makes the heuristic a check-the-explicit-unchecked-items detector, not a require-checkbox-template detector.
- **AC-3:** When `validateAutoTicketCompletion` would mark a ticket Skipped, it MUST first invoke `hasCompletionCommit()` and `getTicketStatus()`. If a commit referencing the ticket exists on HEAD since `start_commit`, the function MUST return `{action: 'done', reason: 'commit_present_post_safety_net'}` and emit a `ticket_auto_done_via_commit_evidence` activity event with `gate_payload: { sha, source, ac_section_format: 'bullet'|'checkbox'|'empty' }`.
- **AC-4:** New activity event `ticket_auto_done_via_commit_evidence` is registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts` + `extension/types/index.js` mirror) and `extension/src/types/activity-events.schema.json` with `required: ['event','ts','session','ticket','gate_payload']`.
- **AC-5:** Integration test `extension/tests/integration/auto-validation-bullet-ac-with-commit.test.js` reproduces the bug: builds a fake session dir with a `Todo` ticket whose AC section is `- AC-1: ...` bullets, a commit on HEAD whose message starts with the ticket id, and asserts that `applyAutoTicketCompletionValidation` returns `{action: 'done'}` (not `'skip'`) and that the ticket file ends with `status: "Done"` + `completion_commit: <sha>`.
- **AC-6:** Unit test `extension/tests/mux-runner-validate-auto-ticket-completion.test.js` covers all four AC-section shapes against all three commit-evidence states:
  - bullet AC (`- AC-1: ...`) × {commit-present, commit-absent}
  - mixed checkbox AC (some `[ ]`, some `[x]`) × {commit-present, commit-absent}
  - all-checked checkbox AC (`- [x] ...`) × {commit-present, commit-absent}
  - empty AC section × {commit-present, commit-absent}
  Expected: commit-present always returns `done`; commit-absent + unchecked-boxes returns `skip`; commit-absent + bullet/empty AC returns `leave` (NEW reason: `no_commit_and_no_explicit_unchecked_boxes` — refuse to auto-skip without evidence either way).
- **AC-7:** `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npm run test:fast` pass.

## Trap Door

`src/bin/mux-runner.ts` (R-ASCH-1 commit-evidence precedence) — INVARIANT: `validateAutoTicketCompletion` MUST check `hasCompletionCommit()` BEFORE `hasCheckedAcceptanceCriteria()`; commit evidence on HEAD is strictly stronger than AC-checkbox state and MUST short-circuit to `action: 'done'`. BREAKS: any ticket whose worker committed but did not flip frontmatter to `Done` gets auto-skipped when refinement-team output uses bullet-style AC lists (no `- [ ]` checkboxes), losing dependency anchors and corrupting completion tracking. ENFORCE: extension/tests/integration/auto-validation-bullet-ac-with-commit.test.js, extension/tests/mux-runner-validate-auto-ticket-completion.test.js. PATTERN_SHAPE: `hasCompletionCommit\\(` invocation in `validateAutoTicketCompletion` MUST appear textually before `hasCheckedAcceptanceCriteria\\(`.

## Out of Scope

- Forcing the refinement team to emit `- [ ]` checkboxes (separate PRD; updating the generator template is a defensible alternative but does not fix the auto-validator's incorrect order-of-checks).
- Backfilling Skipped→Done for past sessions (one-shot manual heal; not worth a migration script).
- Changing worker contract to mandate frontmatter flip alongside `COMPLETION_COMMIT_RECORDED` (separate hardening — current contract says the runner is the fallback, this PRD fixes the fallback itself).

## Verification (manual)

Reproduce in session `2026-05-13-c122b0f7`:
```bash
SD=~/.local/share/pickle-rick/sessions/2026-05-13-c122b0f7
# Pre-heal evidence (skipped despite commit + artifacts):
git log --oneline | grep -E "42148351|5c7d089c"   # both commits land
ls $SD/d97acb1e/{conformance,code_review}_*.md     # both artifacts present
grep -E "^status:" $SD/d97acb1e/linear_ticket_*.md # status: "Skipped" (pre-heal)
```

Manual heal performed 2026-05-13T19:25Z restoring both tickets to `Done` with `completion_commit:` and `healed_at:`/`healed_reason:` audit fields. Three Done tickets confirmed via:
```bash
for f in $SD/*/linear_ticket_*.md; do grep -m1 '^status:' "$f"; done | sort | uniq -c
# 3 Done / 1 In Progress / 54 Todo
```
