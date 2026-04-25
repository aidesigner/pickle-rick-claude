Full pipeline orchestrator: pickle-tmux build, anatomy-park, szechuan-sauce.

# /pickle-pipeline

You are launching the **full pipeline** — build it, inspect every organ, then clean the slop. Three phases, one tmux session, zero hand-holding between phases.

## When to invoke this skill
- User lists 2+ pipeline stages in one request ("refine then build then szechuan", "build, review, deslop")
- User says "full pipeline", "everything", "the whole flow", "X then Y then Z"
- User asks for a not-yet-started feature AND mentions verification/cleanup phases
- User says "use codex" / "--backend codex" alongside multiple stages → still this skill, append `--backend codex`

If the user names `refine-prd` / `pickle-refine-prd` as a stage AND `prd_refined.md` does not exist in the session, run `/pickle-refine-prd` FIRST, then invoke this skill. The orchestrator itself runs only build → anatomy-park → szechuan-sauce.

## When NOT to invoke
- User explicitly names ONE stage (`/pickle-tmux`, `/szechuan-sauce`, `/anatomy-park`) — use that skill directly
- Resuming an existing session — use the specific stage skill instead
- Single-file edit, typo fix, question — answer directly

## Step 0: Refinement Prerequisite

Decide whether to run `/pickle-refine-prd` before launching the build/review/deslop pipeline. Explicit flags win; otherwise auto-infer from the request.

**Decision (first match wins):**
1. `$ARGUMENTS` contains `--no-refine` → `REFINE=false`
2. `$ARGUMENTS` contains `--refine` → `REFINE=true`
3. `$ARGUMENTS` matches `/refine|refinement|prd[\s-]?refinement|refine[\s-]?prd/i` (case-insensitive) → `REFINE=true` (auto-inferred)
4. Otherwise → `REFINE=false`

If `REFINE=false` → strip `--refine`/`--no-refine` from `$ARGUMENTS` if present and continue to Step 1.

**If `REFINE=true`:**

**0a — Resolve PRD path.** First match wins:
1. Explicit path in `$ARGUMENTS` (e.g. `path/to/prd.md`)
2. `prd.md` or `PRD.md` in current working directory
3. Most recent session's `prd.md` via `node "$HOME/.claude/pickle-rick/extension/bin/get-session.js"`

No PRD found → **fail fast**: print `"No prd.md found. Run /pickle-prd first to draft one, then re-invoke /pickle-pipeline."` Stop. Do NOT launch tmux.

**0b — Skip if already refined.** If `${SESSION_ROOT}/prd_refined.md` exists for the resolved session → log `"PRD already refined at <path> — skipping refinement."` Continue to Step 1.

**0c — Run `/pickle-refine-prd` inline.** Invoke the skill in the current Claude session, passing the resolved PRD path. Wait for `<promise>TASK_COMPLETED</promise>` from the refine skill. Refinement always uses the `claude` backend regardless of `--backend` on this skill (refinement is planning, not implementation; pinned by the refine skill itself).

**0d — On refine failure** (no `prd_refined.md` produced, or skill aborted) → **fail fast**: surface the refine error and stop. Do NOT launch the pipeline against an unrefined PRD.

**0e — Continue.** Strip `--refine`/`--no-refine` from `$ARGUMENTS` so they aren't reparsed as TASK content. Proceed to Step 1 with the same `${SESSION_ROOT}` (refinement initialized it).

## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux`." Stop.

## Step 2: Parse Arguments

From `$ARGUMENTS`:

**Pickle phase flags:**
- `--max-iterations <N>` → PICKLE_MAX_ITER (default: 500)
- `--max-time <M>` → MAX_TIME in minutes (default: 720)
- `--worker-timeout <S>` → WORKER_TIMEOUT in seconds (default: 1200)
- `--backend <claude|codex>` → BACKEND (default `claude`; `codex` routes every phase's worker/manager spawn through `codex exec` and propagates via `PICKLE_BACKEND` to sub-runners)

**Anatomy Park flags:**
- `--anatomy-max-iterations <N>` → AP_MAX_ITER (default: 100)
- `--anatomy-stall-limit <N>` → AP_STALL (default: 3)

**Szechuan Sauce flags:**
- `--szechuan-max-iterations <N>` → SZ_MAX_ITER (default: 50)
- `--szechuan-stall-limit <N>` → SZ_STALL (default: 5)
- `--szechuan-domain <name>` → SZ_DOMAIN (optional)
- `--szechuan-focus "<text>"` → SZ_FOCUS (optional)

**Phase control:**
- `--refine` → force refinement before pipeline (already consumed in Step 0)
- `--no-refine` → suppress auto-inferred refinement (already consumed in Step 0)
- `--skip-anatomy` → remove anatomy-park from pipeline
- `--skip-szechuan` → remove szechuan-sauce from pipeline
- `--target <path>` → TARGET for review phases (default: current working directory)

**Scope flags (optional):**
- `--scope <flag>` → SCOPE_FLAG (values: `branch`, `branch:one-hop`, `diff:<ref>`, `diff:<ref>:one-hop`, `paths:<glob,...>`)
- `--scope-base <ref>` → SCOPE_BASE (base ref override for `branch` mode)

When set, pipeline-runner resolves scope at setup (writes `${SESSION_ROOT}/scope.json`) and refreshes per non-pickle phase (archives to `${SESSION_ROOT}/archive/scope.<phase>.json`). Empty diff at setup → WARN; empty diff at anatomy-park refresh → `SCOPE_EMPTY_POST_BUILD` error.

**Remainder** = TASK (the epic description for the pickle phase)

If no TASK provided, print error and stop.

Resolve TARGET to an absolute path. Verify it exists. If not found, print error and stop.

## Step 3: Session Setup

Build the setup.js flags from pickle phase settings:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --max-iterations <PICKLE_MAX_ITER> --max-time <MAX_TIME> --worker-timeout <WORKER_TIMEOUT> [--backend <BACKEND>] --task "<TASK>"
```
Append `--backend <BACKEND>` only when the flag was passed.

Extract `SESSION_ROOT=<path>` from output.

## Step 4: Create pipeline.json

Build the phases array. Default: `["pickle", "anatomy-park", "szechuan-sauce"]`. Remove entries if `--skip-anatomy` or `--skip-szechuan` were passed.

Write `${SESSION_ROOT}/pipeline.json` with the required keys below. Append the optional keys ONLY when the corresponding flag was passed — do NOT emit placeholders or empty strings for unset values.

Required shape (example shown with `--backend codex`):
```json
{
  "phases": ["pickle", "anatomy-park", "szechuan-sauce"],
  "target": "<TARGET_ABSOLUTE_PATH>",
  "anatomy_stall_limit": <AP_STALL>,
  "szechuan_stall_limit": <SZ_STALL>,
  "anatomy_max_iterations": <AP_MAX_ITER>,
  "szechuan_max_iterations": <SZ_MAX_ITER>,
  "backend": "codex"
}
```

Optional keys — include each ONLY when the corresponding flag was set, and use the literal user-supplied value:
- `szechuan_domain` (string) — add when `--szechuan-domain` was passed
- `szechuan_focus` (string) — add when `--szechuan-focus` was passed
- `scope` (string) — add when `--scope` was passed
- `scope_base` (string) — add when `--scope-base` was passed
- `backend` (string: `"claude"` or `"codex"`) — add when `--backend` was passed; omit the key entirely otherwise

## Step 5: tmux Session

Session name: `pipeline-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```

Print attach command immediately: `tmux attach -t <name>`

## Step 6: Launch Runner

```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js <SESSION_ROOT>; echo ''; echo 'Pipeline finished. Ctrl+B 1 → monitor | Ctrl+B D → detach'; read" Enter
```

## Step 7: Monitor (4-pane)

pipeline-runner auto-creates the 4-pane monitor window on startup — no manual invocation needed.

## Step 8: Report

Print:
```
Full Pipeline — Build → Review → Deslop

Task: <TASK>
Target: <TARGET>
Phases: <list of active phases>
Session: tmux attach -t <name>
Monitor: Ctrl+B 1 | Runner: Ctrl+B 0 | Detach: Ctrl+B D
Cancel: tmux kill-session -t <name>
State: <SESSION_ROOT>/state.json
Pipeline: <SESSION_ROOT>/pipeline.json

Phase Limits:
  Pickle:        max_iterations=<PICKLE_MAX_ITER>
  Anatomy Park:  max_iterations=<AP_MAX_ITER>, stall_limit=<AP_STALL>
  Szechuan Sauce: max_iterations=<SZ_MAX_ITER>, stall_limit=<SZ_STALL>

"I turned myself into a pipeline, Morty!
 Build, inspect, clean — the whole lifecycle.
 No meeseeks required."
```

Output: `<promise>TASK_COMPLETED</promise>`
