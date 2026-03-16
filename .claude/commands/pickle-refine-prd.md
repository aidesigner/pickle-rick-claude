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

### 7d: Append Breakdown
Add `## Implementation Task Breakdown` table to `${SESSION_ROOT}/prd_refined.md`: Order | ID | Title | Priority | Entry | Exit | Files.

### 7e: Advance State
```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step research "${SESSION_ROOT}"
node "${EXTENSION_ROOT}/extension/bin/update-state.js" current_ticket ${FIRST_ID} "${SESSION_ROOT}"
```

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
