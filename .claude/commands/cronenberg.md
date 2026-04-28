Meta-router: explicit `/cronenberg` picks the right pickle metaphor + cleanup chain for a build/implement request.

# /cronenberg

Mutate a request into the correct pipeline shape. Deterministic — same signals → same plan, no LLM judgment inside the matrix.

## When to invoke
User explicitly types `/cronenberg`. Never auto-trigger; persona's existing Routing rules are unchanged.

## When NOT to invoke
- User already named a skill (`/pickle`, `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`, `/anatomy-park`, `/szechuan-sauce`) — use that directly.
- One-liner / typo / single-file fix → just do it.
- Pure question → answer directly.

## Step 1: Parse Flags

From `$ARGUMENTS`:
- `--dry-run` — print the plan and stop without executing. Cronenberg-only. (Default behavior is to execute the plan.)
- `--no-followups` — skip cleanup chain. Cronenberg-only.
- Everything else (flags + free text) → `FORWARD` — passed through verbatim to the chosen metaphor and its followups.

If `FORWARD` has no task description AND no PRD detected in Step 2 → print `"Cronenberg needs a task or prd.md. Add a task or run /pickle-prd first."` Stop.

## Step 2: Signals

| Signal | Definition (source) |
|---|---|
| `PRD_PRESENT` | `prd.md`/`PRD.md` in cwd OR most recent session has one (`get-session.js`) |
| `MEASURABLE_METRIC` | TASK/PRD names a measurable target: coverage %, latency budget, lint count, error rate, bundle size, "improve X to Y" |
| `TICKET_COUNT` | If `prd_refined.md` exists, count tickets; else infer from TASK verbs (1 / 2-3 / 4+) |
| `MULTI_STAGE` | TASK lists 2+ of: refine, build, optimize, cleanup, deslop, szechuan, anatomy-park, review |
| `STACK_REVIEW` | TASK is review-focused AND mentions PR stack, branch chain, `gt log`, graphite stack |
| `SUBSYSTEM_TOUCHES` | distinct top-level dirs implied by TASK + PRD file mentions (≥2 if multiple modules named) |
| `INTERACTIVE_HINT` | TASK contains "interactive", "watch me", "step through", or `FORWARD` has `--interactive` |

## Step 3: Pick Metaphor (first match wins)

| If | → |
|---|---|
| `STACK_REVIEW` | `/council-of-ricks` |
| `MEASURABLE_METRIC` and TASK reads "optimize/improve/reduce X to Y" | `/pickle-microverse` |
| `MULTI_STAGE` | `/pickle-pipeline` |
| `INTERACTIVE_HINT` | `/pickle` |
| `TICKET_COUNT ≥ 3` | `/pickle-tmux` |
| Default | `/pickle` |

## Step 4: Pick Followups

Skip all followups if any of: `--no-followups` was passed, OR chosen metaphor is `/pickle-pipeline` (chains anatomy-park + szechuan-sauce internally — followups would duplicate), OR chosen metaphor is `/pickle-microverse` or `/council-of-ricks` (their work is orthogonal to cleanup).

Otherwise append in order:

| If | → |
|---|---|
| `SUBSYSTEM_TOUCHES ≥ 2` | `/anatomy-park` |
| Expected diff ≥ 500 LOC OR ≥ 10 files OR TASK mentions "cleanup / deslop / refactor sweep" | `/szechuan-sauce` |

Hardening tickets are produced upstream by `/pickle-refine-prd`; followups only handle structural review and slop cleanup.

## Step 5: Print Plan

```
Cronenberg — request mutated.

Task: <TASK or "(driven by PRD)">
Signals: PRD=<y/n> tickets=<N> multi-stage=<y/n> metric=<y/n> stack=<y/n> subsystems=<N> interactive=<y/n>

Plan:
  1. <metaphor> <FORWARD>
  <numbered followups, each invoked with --target <cwd> + any FORWARD flags the followup accepts>

Forward any flag (e.g. --backend codex, --refine, --scope branch, --max-iterations 50) by passing it to /cronenberg — it carries through. Cronenberg-only flags: --dry-run, --no-followups.
```

## Step 6: Execute or Stop

**With `--dry-run`** → print `"Dry run. Re-invoke without --dry-run to execute, or copy the commands above."` Stop. Output `<promise>TASK_COMPLETED</promise>`.

**Default (no `--dry-run`)** — chain behavior depends on the chosen metaphor:

- **`/pickle` (interactive, in-session)** — invoke and wait for `TASK_COMPLETED`. Then chain followups in-session with `--target <cwd>` + applicable forwarded flags. On any failure, stop and report the failed step.

- **Tmux-launching metaphors (`/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`)** — these return `TASK_COMPLETED` immediately after detaching tmux. **Do NOT auto-chain followups** — they would race the in-progress build. Instead: (1) invoke the metaphor, (2) print `"Build launched in detached tmux. Followups will NOT auto-run — they would race the build. After the tmux session finishes, run:"` followed by the followup commands ready to copy, (3) output `<promise>TASK_COMPLETED</promise>`.

## Logging

At Step 6 entry: `node ~/.claude/pickle-rick/extension/bin/log-activity.js research "cronenberg → <metaphor>+<followups>"`
