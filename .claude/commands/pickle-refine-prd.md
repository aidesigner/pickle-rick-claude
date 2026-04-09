Refine and decompose PRD into atomic tickets using parallel Morty analysis team.

Persona via CLAUDE.md. Proceed to Step 0.

## Step 0: Parse Flags
`$ARGUMENTS`: `--run` → AUTO_RUN. `--meeseeks` → CHAIN_MEESEEKS (implies --run). `--resume [PATH]` → RESUME_MODE (reuse existing session). Remainder = `${TASK_ARGS}`.

If `--resume` has a path argument → `RESUME_SESSION = <path>`. If `--resume` with no path → resolve via `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → `RESUME_SESSION`.

## Step 1: Locate PRD

**If RESUME_MODE**: PRD is at `${RESUME_SESSION}/prd.md`. If missing → "Session has no prd.md. Run `/pickle-prd` first." Stop. Set `SESSION_ROOT = ${RESUME_SESSION}`.

**If NOT RESUME_MODE**: Priority: 1) explicit path in `${TASK_ARGS}`, 2) `prd.md`/`PRD.md` in cwd, 3) `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → session's `prd.md`.

Not found → "Run `/pickle-prd` first or pass path." Stop.

## Step 1b: Org Context

If `context/` exists in cwd or repo root, read it. Carry into Steps 5-7 to ground refinement in real customer signals. No `context/` → skip.

## Step 2: Verification Readiness Check
Read PRD. Gate on verification quality before spending tokens on refinement.

### 2a: Section Scan
Check for (exact or equivalent headings):
- Interface Contracts / API Contracts / type definitions
- Verification Strategy / Acceptance Criteria with commands
- Test Expectations / test descriptions per requirement
- Functional Requirements with Verification column

Score: FULL (all present, substantive) / PARTIAL (some present or thin) / MISSING.

### 2b: Quality Scan
- **Contracts**: Exact shapes (fields+types) = PASS. Prose ("accepts loan data") = NEEDS_WORK.
- **Verification**: Runnable commands = PASS. Aspirational ("should be tested") = NEEDS_WORK.
- **Tests**: Specific files/assertions = PASS. Vague ("needs tests") = NEEDS_WORK.
- **Requirements**: Machine-checkable criteria = PASS. Subjective ("good UX") = NEEDS_WORK.

### 2c: Gate
**FULL + PASS** → "PRD verification-ready." Continue to Step 3.

**PARTIAL/NEEDS_WORK** → Pause, print gaps, interview:
1. Missing contracts: "What data crosses boundaries? Exact shapes — fields and types."
2. Missing verification: "How to verify each requirement automatically? Commands or assertions."
3. Missing tests: "What test files should exist? Scenarios and assertions."
4. Subjective reqs: Quote each, ask for machine-checkable rewrite.

Iterate until PASS. Update PRD in place. Continue to Step 3.

**MISSING + AUTO_RUN** → "Cannot auto-run on under-specified PRD." Set AUTO_RUN=false, interview.

## Step 3: Initialize Session

Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

**If RESUME_MODE**: `SESSION_ROOT` is already set from Step 1. `<PRD_PATH> = ${SESSION_ROOT}/prd.md`. Skip session creation — reuse existing session directory and state.

**If NOT RESUME_MODE**:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "PRD Refinement: ${TASK_ARGS}"
```
Extract `SESSION_ROOT`. Save original path as `<PRD_PATH>`. `cp "<PRD_PATH>" "${SESSION_ROOT}/prd.md"`.

## Step 4: Deploy Refinement Team

### 4a: Monitor (if tmux)
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
REFINE_SESSION="refine-${REFINE_HASH}"
tmux new-session -d -s "$REFINE_SESSION" -c "$(pwd)"
tmux send-keys -t "$REFINE_SESSION" "node ${EXTENSION_ROOT}/extension/bin/refinement-watcher.js ${SESSION_ROOT}" Enter
```
No tmux → skip to 4b.

### 4b: Spawn Workers
```bash
node "${EXTENSION_ROOT}/extension/bin/spawn-refinement-team.js" --prd "${SESSION_ROOT}/prd.md" --session-dir "${SESSION_ROOT}"
```
Optional: `--timeout <sec>` | `--cycles <n>` (default:3) | `--max-turns <n>` (default:100)

3 workers/cycle: Requirements → `analysis_requirements.md`, Codebase → `analysis_codebase.md`, Risk → `analysis_risk-scope.md`. Cycle 2+ cross-references prior analyses. Wait for `REFINEMENT_DIR=` and `MANIFEST=`.

### 4c: Cleanup Monitor
```bash
tmux kill-session -t "refine-${REFINE_HASH}" 2>/dev/null || true
```

## Step 5: Audit Reports
Read `${SESSION_ROOT}/refinement_manifest.json`. Warn on failed workers, continue with available `analysis_*.md` + original PRD.

## Step 6: Synthesize Refined PRD
Write `${SESSION_ROOT}/prd_refined.md`. Rules:
1. Preserve structure, additive over rewriting
2. Attribute: `*(refined: [source])*`
3. P0 gaps first, P1 next, P2 optional
4. No invention — analyses only
5. Preserve existing unless incorrect
6. Implementation-oriented: file paths, signatures, shapes
7. Decomposition-ready: each requirement → 1-3 tickets
8. Verification-first: every requirement gets machine-checkable criterion. No unverifiable requirements survive.
9. Contracts required: exact I/O/error shapes per boundary. Missing = failure.
10. Test expectations: file paths, descriptions, assertions per requirement
11. LLM conformance-ready: requirements phrased for yes/no answer. Rewrite ambiguous ones.

## Step 7: Task Decomposition

### 7a: Decompose
Atomic tasks from refined PRD + codebase analysis:
- Produces code/config/test changes (no research-only tickets)
- Sequential order (10, 20, 30...), `depends_on` informational
- Self-contained: worker executes without reading PRD
- Embed research seeds (file paths, patterns, APIs, test patterns)
- Machine-checkable acceptance criteria with verify commands
- Interface contracts: exact I/O/error shapes
- Test expectations: file, description, assertion per criterion
- Entry/exit conditions, file impact, priority, scope guard

Sizing: <30min coding, <5 files, <4 criteria, <2 subsystems.

### 7b: Create Parent
`${SESSION_ROOT}/linear_ticket_parent.md` — epic title, link to refined PRD.

### 7c: Create Child Tickets
Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "[verb + target]"
status: Todo
priority: [High|Medium|Low]
order: [N]
working_dir: [path or omit]
created: [Date]
updated: [Date]
depends_on: [IDs or "none"]
links:
  - url: ../linear_ticket_parent.md
    title: Parent
---
# Description
## Problem / ## Solution / ## Entry Conditions
## Research Seeds
- **Files**: [paths:line] | **Patterns**: [snippets] | **APIs/types**: [signatures] | **Test patterns**: [structure, runner]
## Implementation Details
**Files to modify/create**: | **Dependencies**:
## Interface Contracts
**Inputs**: [types] | **Outputs**: [types] | **Errors**: [shapes] | **Invariants**: [conditions]
## Acceptance Criteria
- [ ] [Criterion] — Verify: `[command]` — Type: [test|typecheck|lint|curl|llm-conformance]
## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] [Project-specific checks]
## Exit State / ## NOT in Scope
```

### 7d: Create Wiring Ticket

**Skip gate:** Skip this step if total implementation tickets ≤ 2 OR PRD scope is a single module/file (no cross-module integration needed).

After all implementation tickets exist, create one final integration ticket. Isolated Morty workers build modules in fresh context — the wiring ticket connects them into a functioning whole.

**Detect project type** from Step 2 tech stack analysis:
- **Application** (has entry point: `main.ts`, `index.ts`, `app.ts`, `server.ts`, Next.js/NestJS/Express scaffold, UI framework): use the **Application** template variant below
- **Library/CLI/Infrastructure** (exports modules, no launch entry point, internal tooling, SDK, CLI tool): use the **Library** template variant below

**Derive verify commands** from Step 2 tech stack: use `${TC_CMD}`, `${TEST_CMD}`, `${BUILD_CMD}`, `${LINT_CMD}` detected during PRD analysis. Never leave `[project-specific run command]` placeholders — the worker runs headless.

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Wire: integrate all modules into working [project name]"
status: Todo
priority: High
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
depends_on: [ALL prior ticket IDs, comma-separated]
links:
  - url: ../linear_ticket_parent.md
    title: Parent
---
# Description
## Problem
Each implementation ticket was designed to be self-contained with fresh context. The modules, components, and subsystems have been built in isolation and must now be connected. Without this wiring step, the project has parts but no whole.

## Solution

### For Application projects:
Connect every module, component, and service into the running application. Wire entry points, register components, connect data flows, mount UI panels, link handlers, and verify end-to-end.

### For Library/CLI/Infrastructure projects:
Wire all modules into the public API surface. Ensure exports are connected, CLI commands are registered, internal modules are properly imported, and the integration test exercises the full public interface.

## Entry Conditions
All prior tickets (depends_on) are complete and individually verified.

## Research Seeds
- **Files**: Review all files modified/created across prior tickets — each ticket's "Exit State" section names them
- **Patterns**: [Application] Entry point registration, component mounting, service wiring, dependency injection | [Library] Public API exports, barrel files, CLI command registration, module re-exports
- **APIs/types**: Public interfaces defined in prior tickets' Interface Contracts sections
- **Test patterns**: Integration tests, smoke tests, [Application] e2e tests | [Library] API surface tests

## Implementation Details
**Files to modify/create**: [Application] Entry point files, root component, main application file | [Library] Index/barrel export files, CLI entry point, public API surface
**Dependencies**: All modules produced by prior tickets

## Interface Contracts
**Inputs**: [Application] User/environment triggers the entry point | [Library] Consumer imports the public API
**Outputs**: [Application] Fully functional application — all PRD features reachable via intended interface | [Library] All public exports work end-to-end, CLI commands execute correctly
**Errors**: Any missing wiring surfaces as runtime error or missing feature — must be resolved here
**Invariants**: No module is imported but unused; no module is needed but unimported

## Acceptance Criteria
- [ ] All modules/components from prior tickets are connected — Verify: `${TEST_CMD}` — Type: integration
- [ ] No dead code or orphaned modules — Verify: grep for each module's export to confirm at least one import — Type: lint
- [ ] Build passes clean — Verify: `${BUILD_CMD}` — Type: build
- [ ] Type checker passes — Verify: `${TC_CMD}` — Type: typecheck
- [ ] [Application] Application starts without errors — Verify: `${BUILD_CMD} && ${START_CMD}` exits cleanly or enters expected running state — Type: integration
- [ ] [Library] Public API surface matches Interface Contracts — Verify: `${TEST_CMD}` exercises all exports — Type: integration

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| [Application] Full app runs | test/e2e/ or test/integration/ | Launch app, exercise top-level features | No errors, all routes/handlers respond |
| [Library] API surface works | test/integration/ | Import public API, call each export | All exports resolve, return expected types |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Lint passes — no new warnings
- [ ] All prior ticket Exit States are satisfied end-to-end

## Exit State
[Application] The application runs as a unified whole. Every PRD feature is reachable via the intended interface.
[Library] All public exports are connected and tested. The module/CLI/tool works end-to-end as specified in the PRD.

## NOT in Scope
Implementing new features. Fixing bugs in individual modules (those belong in the relevant ticket). Performance optimization.
```

### 7e: Create Hardening Tickets

After all implementation and wiring tickets, create **two** hardening tickets. These run as normal Morty workers with full implementation context. They depend on ALL prior tickets (including wiring if present).

**Skip gate:** Skip this step if total implementation tickets = 1 AND that ticket's `complexity_tier` is `trivial` or `small`.

Collect the union of all `Files to modify/create` from every implementation + wiring ticket → `MODIFIED_FILES`. Collect unique parent directories of MODIFIED_FILES → `AFFECTED_SUBSYSTEMS`.

**Derive verify commands**: Use the same `${TC_CMD}`, `${TEST_CMD}`, `${BUILD_CMD}` detected in Step 2 tech stack analysis. Replace ALL bracketed placeholders (`[MODIFIED_FILES...]`, `[AFFECTED_SUBSYSTEMS...]`, `[feature area]`) and `${...}` template variables with concrete values before writing the ticket file. No unresolved placeholders may survive into the written ticket.

**Ticket 1: Code Quality Hardening**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Harden: code quality review of [feature area]"
status: Todo
priority: High
complexity_tier: large
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
depends_on: [ALL prior ticket IDs, comma-separated]
links:
  - url: ../linear_ticket_parent.md
    title: Parent
---
# Description
## Problem
Implementation tickets were built by isolated workers with fresh context. Each ticket passes its own acceptance criteria, but cross-cutting quality issues — DRY violations across tickets, inconsistent error handling, dead code from iteration, premature abstractions, missing edge cases — only become visible when reviewing the complete diff.

## Solution
Review ALL files modified by implementation tickets against the principle checklist below. Fix violations P0-P2 one at a time, write regression tests, commit atomically.

## Entry Conditions
All prior tickets (depends_on) are complete and individually verified. Test suite passes.

## Research Seeds
- **Files**: [MODIFIED_FILES — full list from all prior tickets]
- **Patterns**: KISS, YAGNI, DRY (Rule of Three), Small Functions, Guard Clauses, Cognitive Load, Self-Documenting Code, Fail-Fast, Encapsulation, Separation of Concerns
- **APIs/types**: Public interfaces from prior tickets' Interface Contracts sections
- **Test patterns**: Run existing test suite, add missing edge case tests

## Implementation Details
**Review scope**: ONLY files listed in MODIFIED_FILES. Do not touch files outside the implementation diff.

**Lifecycle mapping**: During Research phase, read all MODIFIED_FILES and catalog violations. During Plan phase, prioritize violations by severity and plan fix order. During Implement phase, execute the review-fix loop below. Standard lifecycle artifacts (research, plan, conformance, review) are required.

**Review-fix loop (Implement phase)** — repeat for each file until zero P0-P1 violations remain, then move to next file:
1. Read the file. Check against each principle below.
2. Rate each violation: P0 (security/data loss), P1 (bugs waiting), P2 (maintainability), P3 (polish).
3. Fix highest-priority violation. One fix per commit.
4. Write regression test if the fix changes behavior.
5. Run full test suite. If regression → revert, move to next violation.
6. Re-check the file. If P0-P1 violations remain, repeat from step 3.

**Principle checklist (check ALL modified files)**:
- Functions > 50 lines → extract named helpers
- Nesting 3+ levels → guard clauses / early return
- Copy-pasted code 3+ times across tickets → extract shared function
- Magic numbers/strings → named constants
- Dead code from iteration (unused exports, stale imports) → delete
- Silent error swallowing → fail-fast or log
- Missing input validation at system boundaries → add guards
- Tautological test assertions → assert on real behavior
- Only happy path tested → add error/boundary tests
- Speculative features/abstractions not used → delete (YAGNI)

## Interface Contracts
**Inputs**: MODIFIED_FILES list (file paths from prior tickets) | **Outputs**: Cleaned files, regression tests, atomic commits | **Errors**: Test regressions trigger revert of the specific fix | **Invariants**: No behavioral change without a regression test

## Acceptance Criteria
- [ ] Zero P0 violations in MODIFIED_FILES — Verify: manual review complete, no security/data-loss issues — Type: llm-conformance
- [ ] Zero P1 violations in MODIFIED_FILES — Verify: manual review complete, no bugs-waiting-to-happen — Type: llm-conformance
- [ ] All functions ≤ 50 lines in MODIFIED_FILES — Verify: grep for function bodies — Type: lint
- [ ] No dead imports/exports in MODIFIED_FILES — Verify: `${TC_CMD}` + grep unused — Type: lint
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Type checker passes — Verify: `${TC_CMD}` — Type: typecheck

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| P1 violation fixes | Alongside each fix | Regression test per behavioral fix | Exercises the specific failure mode |
| Edge cases | In existing test files | Error/boundary tests for modified code | Covers empty, null, max, error states |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] No new dead code introduced by fixes

## Exit State
All MODIFIED_FILES have zero P0-P1 violations. P2 fixes applied where time permits. Each fix is an atomic commit with format: `harden: [principle] — [description]`.

## NOT in Scope
Reviewing files outside MODIFIED_FILES. Adding new features. Refactoring code not touched by implementation tickets. P3-P4 violations unless trivially fixable.
```

**Ticket 2: Data Flow Audit**

Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "Audit: data flow integrity for [feature area]"
status: Todo
priority: High
complexity_tier: large
order: [last order + 10]
working_dir: [project root]
created: [Date]
updated: [Date]
depends_on: [ALL prior ticket IDs, comma-separated]
links:
  - url: ../linear_ticket_parent.md
    title: Parent
---
# Description
## Problem
Isolated workers build modules with fresh context. Cross-module data flow bugs — mismatched IDs, stale schema imports, timezone-unsafe date parsing, inconsistent rounding, DTO fields that are stored but never returned — only surface when tracing the full path from input to output across the implementation.

## Solution
Three-phase data flow trace through AFFECTED_SUBSYSTEMS: read-only review, targeted fix, read-only self-verify. One finding per commit. Maximum 3 phase cycles.

## Entry Conditions
All prior tickets including code quality hardening are complete. Test suite passes.

## Research Seeds
- **Files**: [MODIFIED_FILES — full list from all prior tickets]
- **Subsystems**: [AFFECTED_SUBSYSTEMS — parent directories]
- **APIs/types**: Public interfaces from prior tickets' Interface Contracts sections
- **Patterns**: Data flow tracing — follow values from construction to every consumption site
- **Test patterns**: Integration-style tests exercising actual data flow, not mocked internals

## Implementation Details
**Scope**: Trace data flows ONLY through AFFECTED_SUBSYSTEMS. You may READ unmodified files to understand context, but only MODIFY files listed in MODIFIED_FILES.

**Lifecycle mapping**: During Research phase, read all MODIFIED_FILES and trace data flows across them. During Plan phase, catalog findings with severity ratings. During Implement phase, execute the three-phase protocol below. Standard lifecycle artifacts (research, plan, conformance, review) are required.

**Three-phase protocol (Implement phase)** — maximum 3 cycles. If findings persist after 3 cycles, document remaining issues as trap doors and exit:

**Phase 1 — READ-ONLY review (do NOT edit files)**:
For each modified file, trace data flows across ticket boundaries. For each finding:
1. **Trace data path**: input → processing → output. Show: "value X constructed at file.ts:123, passed to file2.ts:456, consumed at file3.ts:789 where..."
2. **Check fix history**: `git log --oneline -- <file>` for files with findings
3. **Rate severity**: CRITICAL (data corruption, security bypass, wrong calculations) or HIGH (defense-in-depth gap, incorrect but non-corrupting)
4. **Propose fix** with exact code — but DO NOT apply yet

**Review checklist — check ALL**:
- Every index/ID: construction site matches consumption site
- Every schema/type export: grep all imports, verify current version
- Every `new Date(string)`: UTC-safe parsing — no `getMonth()` on non-UTC dates
- Every financial calculation: same rounding at both pipeline ends
- Every new DTO field: stored, read, AND returned
- Every `.refine()`/`.min()`/`.max()`: `.parse()` called at runtime
- Cross-ticket interfaces: types match across ticket boundaries

**Phase 2 — FIX** (only if Phase 1 found issues):
Pick single highest-severity finding. Minimal fix. Write regression test exercising actual data flow. Run test suite. If regression → revert, defer to next finding.

**Phase 3 — READ-ONLY self-verify**:
After each fix: verify callers, consumers, dead code, boolean logic branches. If verification fails → revert.

**Convergence**: Two consecutive Phase 1 passes where zero CRITICAL+HIGH findings are discovered means convergence — exit the loop. If not converged after 3 full cycles, document remaining findings as trap doors in subsystem CLAUDE.md and exit.

## Interface Contracts
**Inputs**: MODIFIED_FILES list, AFFECTED_SUBSYSTEMS list | **Outputs**: Verified data flows, regression tests, atomic commits, trap door documentation | **Errors**: Verification failures trigger revert of the specific fix | **Invariants**: No data flow crosses a ticket boundary without type alignment at both ends

## Acceptance Criteria
- [ ] Zero CRITICAL findings in data flows through AFFECTED_SUBSYSTEMS — Verify: Phase 1 review complete — Type: llm-conformance
- [ ] Zero HIGH findings in data flows through AFFECTED_SUBSYSTEMS — Verify: Phase 1 review complete — Type: llm-conformance
- [ ] All cross-ticket interfaces type-match — Verify: `${TC_CMD}` — Type: typecheck
- [ ] Test suite passes — Verify: `${TEST_CMD}` — Type: test
- [ ] Each fix has a regression test — Verify: `git log --oneline` shows test alongside each fix — Type: test

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Data flow integrity | Integration test file | Trace value from entry to exit | Output matches expected transformation |
| Cross-ticket handoff | Integration test file | Value crosses module boundary | Types align, no silent coercion |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] Contracts match impl signatures (resolve aliases, compare fields)
- [ ] All CRITICAL/HIGH findings resolved or documented as trap doors

## Exit State
Zero CRITICAL+HIGH findings across two consecutive Phase 1 reviews, OR all remaining findings documented as trap doors after 3 cycles. Each fix is an atomic commit with format: `audit: [CRITICAL/HIGH] [description]`. Trap doors documented in subsystem CLAUDE.md.

## NOT in Scope
Reviewing subsystems not in AFFECTED_SUBSYSTEMS. Modifying files not in MODIFIED_FILES. Adding features. P2+ findings. Performance optimization.
```

### 7f: Append Breakdown
Add `## Implementation Task Breakdown` table to `${SESSION_ROOT}/prd_refined.md`: Order | ID | Title | Priority | Entry | Exit | Files. Include wiring and hardening tickets as final rows.

### 7g: Advance State
```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step research "${SESSION_ROOT}"
node "${EXTENSION_ROOT}/extension/bin/update-state.js" current_ticket ${FIRST_ID} "${SESSION_ROOT}"
```

Note: `${FIRST_ID}` is the first **implementation** ticket, not a hardening ticket. Hardening tickets run last.

## Step 8: Update Original PRD
Write `${SESSION_ROOT}/prd_refined.md` back to `<PRD_PATH>`. Pre-refinement preserved at `${SESSION_ROOT}/prd.md`.

## Step 9: Refinement Summary
Write `${SESSION_ROOT}/refinement_summary.md`: paths, timestamp, per-analysis changes, task list, failures.

## Step 10: Verify & Handoff
Check: state.json `step`=research, child dirs exist, `current_ticket` set.

**ALL pass + AUTO_RUN** → print results, proceed to Step 11.
**ALL pass** → print results + resume commands.
**ANY fail + AUTO_RUN** → "auto-launch aborted" + failures. STOP.
**ANY fail** → warn + from-scratch command. STOP.

Never recommend `--resume` if state incomplete.

## Step 11: Auto-Launch (AUTO_RUN only)

### 11a: Check multiplexer
`tmux -V` → MUX=tmux → 11b. Else check `zellij --version` >= 0.40.0 → MUX=zellij → 11b-zellij. Neither → suggest install, stop.

### 11b: Re-initialize (tmux)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
CHAIN_MEESEEKS → append `--chain-meeseeks`.

### 11b-zellij: Re-initialize (Zellij)
Same setup command. Then create Zellij session per /pickle-zellij Steps 3-4.

### 11c: tmux Session
```bash
tmux new-session -d -s pickle-<hash> -c <working_dir>
sleep 1
```

### 11d: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js ${SESSION_ROOT}; echo 'Runner finished.'; read" Enter
```

### 11e: Monitor
```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> ${SESSION_ROOT} pickle
```

### 11g: Report
Print: session, attach command, layout, cancel/kill commands. CHAIN_MEESEEKS → note auto-transition.

Output: `<promise>TASK_COMPLETED</promise>`
