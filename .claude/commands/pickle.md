Start the Pickle Rick autonomous coding loop to implement tasks iteratively in interactive mode.

Announce what you are doing, then proceed.
Pickle Rick persona active via CLAUDE.md. Proceed to Step 1.

**SPEAK BEFORE ACTING**: Output text before every tool call.

# Step 1: Initialization

Extract flags from `$ARGUMENTS` (`--max-iterations <N>`, `--resume <path>`, etc.). Pass flags before `--task`. Task text goes in `--task "..."`.

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" <FLAGS> --task "<TASK_TEXT>"
```
No flags: `setup.js --task "$ARGUMENTS"`. Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

Extract `SESSION_ROOT=<path>` from output.

**Flags**: `--task "TEXT"` | `--max-iterations <N>` | `--max-time <MIN>` | `--worker-timeout <SEC>` | `--completion-promise <TEXT>` | `--resume [PATH]` | `--reset`

# Step 2: Execution (Management)

Read `${SESSION_ROOT}/state.json`. Check `step` field:
- `prd` (or missing) → Phase 1 (PRD)
- `breakdown` → Phase 2 (Tickets)
- `research`/`plan`/`implement`/`refactor` → Phase 3 (Orchestration) — tickets exist from previous session or `/pickle-refine-prd`

**Lifecycle**: 1. PRD → 2. Breakdown → 3. Orchestration Loop

**Constraints**: Monitor `iteration` vs `max_iterations`. If `completion_promise` defined, output `<promise>TEXT</promise>` when done. Stop hook active — `/eat-pickle` to stop manually.

# Phase 1: PRD DRAFTER

### Check for Existing PRD
```bash
ls prd.md PRD.md 2>/dev/null | head -1
```
If found: copy to `${SESSION_ROOT}/prd.md`, skip to PRD Completion Protocol.

### Draft PRD
1. Analyze `original_prompt` from state.json
2. Specific prompt → skip interrogation, draft immediately. Vague prompt → infer answers (don't ask user), resolve ambiguity yourself.
3. Write `${SESSION_ROOT}/prd.md` using template:

```markdown
# [Feature] PRD
| [Feature] PRD | | [Summary] |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: [Date] | **Visibility**: Internal |
## Completion Checklist
- [ ] Introduction - [ ] Problem Statement - [ ] Objective & Scope - [ ] CUJs - [ ] Functional Requirements - [ ] Assumptions - [ ] Risks & Mitigations - [ ] Business Impact
## Introduction
## Problem Statement
**Current Process**: | **Primary Users**: | **Pain Points**: | **Importance**:
## Objective & Scope
**Objective**: | **Ideal Outcome**:
### In-scope / Goals
### Not-in-scope / Non-Goals
## Product Requirements
### Critical User Journeys (CUJs)
### Functional Requirements
| Priority | Requirement | User Story |
|:---|:---|:---|
## Assumptions
## Risks & Mitigations
## Business Benefits/Impact/Metrics
```

Mark checkboxes as sections are drafted.

### PRD Completion Protocol
1. Run `node ${EXTENSION_ROOT}/extension/bin/update-state.js step breakdown ${SESSION_ROOT}`
2. Output `<promise>PRD_COMPLETE</promise>`
3. Output `[STOP_TURN]` — FORBIDDEN from starting breakdown in this turn.

# Phase 2: TICKET MANAGER

### Create Tickets
1. Read `${SESSION_ROOT}/prd.md`
2. Create `${SESSION_ROOT}/linear_ticket_parent.md` — Status: Backlog, Title: [Epic] [Feature]
3. Create atomic child tickets. Each MUST produce functional/testable changes — NO research-only or docs-only tickets. Assign `order` (10, 20, 30...).

For each child: generate hash (`openssl rand -hex 4`), create `${SESSION_ROOT}/[hash]/linear_ticket_[hash].md`:

```markdown
---
id: [hash]
title: [Title]
status: Todo
priority: [High|Medium|Low]
order: [N]
created: [Date]
updated: [Date]
links:
  - url: ../linear_ticket_parent.md
    title: Parent Ticket
---
# Description
## Problem to solve
## Solution
## Implementation Details
```

4. List tickets to user. DO NOT pick first ticket or advance state.

### Ticket Manager Completion Protocol
1. Select lowest-order non-Done ticket: `update-state.js current_ticket [ID] ${SESSION_ROOT}`
2. Advance: `update-state.js step research ${SESSION_ROOT}`
3. Output `<promise>TICKET_SELECTED</promise>`
4. Output `[STOP_TURN]` — FORBIDDEN from spawning Morty in this turn.

# Phase 3: ORCHESTRATION (The Loop)

You are the MANAGER — FORBIDDEN from implementing code. Always delegate to Morty.

Process tickets one by one until ALL are Done.

**Per ticket**:
1. **Pick**: lowest-order non-Done ticket. `update-state.js current_ticket <ID> ${SESSION_ROOT}` + `update-state.js step research ${SESSION_ROOT}`
2. **Delegate**: `node "${EXTENSION_ROOT}/extension/bin/spawn-morty.js" "<DESC>" --ticket-id <ID> --ticket-path "${SESSION_ROOT}/<ID>/" --ticket-file "${SESSION_ROOT}/<ID>/linear_ticket_<ID>.md" --timeout <worker_timeout_seconds>`
3. **Validate** (after Morty outputs `<promise>I AM DONE</promise>`): check `${SESSION_ROOT}/[id]/` for `research_*.md`, `research_review.md`, `plan_*.md`, `plan_review.md`, `conformance_*.md`, `code_review_*.md` — FORBIDDEN to mark Done if missing. Run `git status`, `git diff`, tests/build.
4. **Cleanup**: validation fail → `git stash` + `git checkout .`; pass → commit
5. **Update**: mark ticket Done in frontmatter
6. **Increment iteration**:
   ```bash
   CURRENT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${SESSION_ROOT}/state.json','utf-8')).iteration)")
   node "${EXTENSION_ROOT}/extension/bin/update-state.js" iteration $((CURRENT + 1)) "${SESSION_ROOT}"
   ```
7. **Next ticket**: repeat

**All tickets Done**: mark parent Done. If on `main`/`master` → skip auto-PR, output `<promise>EPIC_COMPLETED</promise>`. Otherwise → `node ${EXTENSION_ROOT}/extension/services/pr-factory.js ${SESSION_ROOT}`, output `<promise>EPIC_COMPLETED</promise>`.
