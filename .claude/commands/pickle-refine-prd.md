Refine and decompose an existing PRD into atomic implementation tickets using parallel Morty analysis team.

Persona active via CLAUDE.md. Proceed to Step 0.

## Step 0: Parse Flags
Scan `$ARGUMENTS`: `--run` → AUTO_RUN=true. `--meeseeks` → CHAIN_MEESEEKS=true (implies --run). Store remaining text as `${TASK_ARGS}`.

## Step 1: Locate PRD
Priority: 1) explicit path in `${TASK_ARGS}` (ends `.md` or exists), 2) `prd.md`/`PRD.md` in cwd, 3) `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"` → look for `prd.md` in returned session.

Not found → "Run `/pickle-prd` first or pass a path: `/pickle-refine-prd path/to/prd.md`". Stop.

If AUTO_RUN: announce tmux auto-launch. If CHAIN_MEESEEKS: announce Meeseeks chaining.

## Step 2: Initialize Session
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "PRD Refinement: ${TASK_ARGS}"
```
Extract `SESSION_ROOT=<path>`. Save original PRD path as `<PRD_PATH>` for write-back. Copy: `cp "<PRD_PATH>" "${SESSION_ROOT}/prd.md"`. Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

## Step 3: Deploy Refinement Team
```bash
node "${EXTENSION_ROOT}/extension/bin/spawn-refinement-team.js" --prd "${SESSION_ROOT}/prd.md" --session-dir "${SESSION_ROOT}"
```
Optional: `--timeout <sec>` | `--cycles <n>` (default:3) | `--max-turns <n>` (default:100)

3 parallel workers per cycle: Requirements Analyst → `analysis_requirements.md`, Codebase Context → `analysis_codebase.md`, Risk & Scope → `analysis_risk-scope.md`. Cycle 2+ cross-references all prior analyses.

Wait for `REFINEMENT_DIR=` and `MANIFEST=` output.

## Step 4: Audit Reports
Read `${SESSION_ROOT}/refinement_manifest.json`. For failed workers: print warning, note incomplete analysis, continue with available reports. Read all available `analysis_*.md` files + original PRD.

## Step 5: Synthesize Refined PRD
Write `${SESSION_ROOT}/prd_refined.md`. Rules:
1. Preserve original structure
2. Additive — prefer adding over rewriting
3. Attribute: append `*(refined: [source])*` after additions
4. P0 gaps first, then P1, P2 optional
5. No invention — only content from analyses
6. Preserve existing content unless explicitly incorrect
7. Flag missing analyses with visible warnings
8. Implementation-oriented: specific enough for engineers (file paths, signatures, shapes)
9. Decomposition-ready: each requirement → 1-3 tickets
10. Verification-ready: concrete test/curl/UI verification per requirement

## Step 6: Task Decomposition

### 6a: Decompose
Read refined PRD + codebase analysis. Create atomic tasks:
- Each produces code/config/test changes (NO research-only tickets)
- Ordered sequentially (10, 20, 30...) — `depends_on` is informational only
- Self-contained: worker can execute without reading PRD or other tickets
- Embed research seeds (file paths, patterns, APIs, test patterns from codebase analysis)
- Acceptance criteria with runnable verification commands
- Entry/exit conditions, file impact, priority (P0/P1/P2), scope guard

Sizing: <30min coding, <5 files, <4 acceptance criteria, <2 unrelated subsystems.

### 6b: Create Parent
`${SESSION_ROOT}/linear_ticket_parent.md` with epic title, link to refined PRD.

### 6c: Create Child Tickets
Hash: `openssl rand -hex 4`. Dir: `${SESSION_ROOT}/[hash]/`. File: `linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: "[action verb + target]"
status: Todo
priority: [High|Medium|Low]
order: [N]
created: [Date]
updated: [Date]
depends_on: [IDs or "none"]
links:
  - url: ../linear_ticket_parent.md
    title: Parent Ticket
---
# Description
## Problem to solve
## Solution
## Entry Conditions
## Research Seeds
- **Relevant files**: [paths with line refs]
- **Patterns to follow**: [snippets or file:line refs]
- **Key APIs/types**: [signatures, shapes]
- **Test patterns**: [structure, locations, runner commands]
## Implementation Details
- **Files to modify/create**: | **Dependencies**:
## Acceptance Criteria
- [ ] [Criterion] — Verify: `[command]`
## Exit State
## NOT in Scope
```

### 6d: Append Breakdown to Refined PRD
Add `## Implementation Task Breakdown` table to `${SESSION_ROOT}/prd_refined.md`: Order | ID | Title | Priority | Entry | Exit | Files.

### 6e: Advance State
```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step research "${SESSION_ROOT}"
node "${EXTENSION_ROOT}/extension/bin/update-state.js" current_ticket [FIRST_ID] "${SESSION_ROOT}"
```

## Step 7: Update Original PRD
Write `${SESSION_ROOT}/prd_refined.md` content back to `<PRD_PATH>`. Pre-refinement version preserved at `${SESSION_ROOT}/prd.md`.

## Step 8: Refinement Summary
Write `${SESSION_ROOT}/refinement_summary.md`: original path, backup path, timestamp, per-analysis changes, task list with priorities, failed workers if any.

## Step 9: Verify & Handoff
Check: state.json `step`=research, child ticket dirs exist, `current_ticket` set.

**ALL pass + AUTO_RUN**: Print results (PRD path, task count, session). Proceed to Step 10.
**ALL pass + no AUTO_RUN**: Print results + resume commands (`/pickle --resume`, `/pickle-tmux --resume`, no-limits variant, from-scratch).
**ANY fail + AUTO_RUN**: Warn "auto-launch aborted" + what failed + manual commands. STOP.
**ANY fail + no AUTO_RUN**: Warn what failed + from-scratch command. STOP.

Never recommend `--resume` if session state is incomplete.

## Step 10: Auto-Launch (AUTO_RUN=true only)

### 10a: Check multiplexer
`tmux -V`. If present → set MUX=tmux, proceed to 10b.

If tmux missing, check Zellij:
```bash
ZELLIJ_VER=$(zellij --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
```
If Zellij present and >= 0.40.0 → set MUX=zellij, proceed to 10b-zellij.

If neither available: suggest install (`brew install tmux` or `brew install zellij`), note PRD is ready for manual `/pickle-tmux --resume` or `/pickle-zellij --resume`. Stop.

### 10b: Re-initialize (tmux)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
If CHAIN_MEESEEKS: append `--chain-meeseeks`.

### 10b-zellij: Re-initialize (Zellij)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
If CHAIN_MEESEEKS: append `--chain-meeseeks`.
Then create Zellij session per /pickle-zellij Steps 3-4 (export env vars, three-tier session creation with KDL layout, attach instructions).

### 10c: tmux Session (MUX=tmux only)
Session name: `pickle-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```
Print attach command immediately: `tmux attach -t <name>`.

### 10d: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js ${SESSION_ROOT}; echo ''; echo '🥒 Runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter
```

### 10e: Monitor (3-pane via canonical script)
```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> ${SESSION_ROOT} pickle
```

### 10g: Report
Print: session name, no limits, attach command (`tmux attach` or `zellij attach`), window/tab layout, cancel/kill commands. If CHAIN_MEESEEKS: note auto-transition to Meeseeks review after tickets complete.

Output: `<promise>TASK_COMPLETED</promise>`
