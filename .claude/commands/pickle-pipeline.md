Run a full Pickle Rick pipeline in one tmux session: build (pickle-tmux) → deep review (anatomy-park) → deslop (szechuan-sauce).

# /pickle-pipeline

You are launching the **full pipeline** — build it, inspect every organ, then clean the slop. Three phases, one tmux session, zero hand-holding between phases.

## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux`." Stop.

## Step 2: Parse Arguments

From `$ARGUMENTS`:

**Pickle phase flags:**
- `--max-iterations <N>` → PICKLE_MAX_ITER (default: 500)
- `--max-time <M>` → MAX_TIME in minutes (default: 720)
- `--worker-timeout <S>` → WORKER_TIMEOUT in seconds (default: 1200)

**Anatomy Park flags:**
- `--anatomy-max-iterations <N>` → AP_MAX_ITER (default: 100)
- `--anatomy-stall-limit <N>` → AP_STALL (default: 3)

**Szechuan Sauce flags:**
- `--szechuan-max-iterations <N>` → SZ_MAX_ITER (default: 50)
- `--szechuan-stall-limit <N>` → SZ_STALL (default: 5)
- `--szechuan-domain <name>` → SZ_DOMAIN (optional)
- `--szechuan-focus "<text>"` → SZ_FOCUS (optional)

**Phase control:**
- `--skip-anatomy` → remove anatomy-park from pipeline
- `--skip-szechuan` → remove szechuan-sauce from pipeline
- `--target <path>` → TARGET for review phases (default: current working directory)

**Remainder** = TASK (the epic description for the pickle phase)

If no TASK provided, print error and stop.

Resolve TARGET to an absolute path. Verify it exists. If not found, print error and stop.

## Step 3: Session Setup

Build the setup.js flags from pickle phase settings:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --max-iterations <PICKLE_MAX_ITER> --max-time <MAX_TIME> --worker-timeout <WORKER_TIMEOUT> --task "<TASK>"
```

Extract `SESSION_ROOT=<path>` from output.

## Step 4: Create pipeline.json

Build the phases array. Default: `["pickle", "anatomy-park", "szechuan-sauce"]`. Remove entries if `--skip-anatomy` or `--skip-szechuan` were passed.

Write `${SESSION_ROOT}/pipeline.json`:
```json
{
  "phases": ["pickle", "anatomy-park", "szechuan-sauce"],
  "target": "<TARGET_ABSOLUTE_PATH>",
  "anatomy_stall_limit": <AP_STALL>,
  "szechuan_stall_limit": <SZ_STALL>,
  "anatomy_max_iterations": <AP_MAX_ITER>,
  "szechuan_max_iterations": <SZ_MAX_ITER>,
  "szechuan_domain": "<SZ_DOMAIN or omit>",
  "szechuan_focus": "<SZ_FOCUS or omit>"
}
```

Omit `szechuan_domain` and `szechuan_focus` keys entirely if not set.

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

```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> <SESSION_ROOT> pickle
```

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
