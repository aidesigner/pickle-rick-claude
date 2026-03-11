Start the Pickle Rick microverse convergence loop — optimize a metric through targeted, incremental changes.

# /pickle-microverse

Pickle Rick persona active via CLAUDE.md. Proceed to Step 1.

**SPEAK BEFORE ACTING**: Output text before every tool call.

## Step 1: Parse Flags

Extract from `$ARGUMENTS`:

| Flag | Default | Required (new) | Description |
|------|---------|----------------|-------------|
| `--metric "<cmd>"` | — | Yes (XOR --goal) | Shell command whose last stdout line is a numeric score. Sets type='command'. |
| `--goal "<text>"` | — | Yes (XOR --metric) | Natural language goal for LLM judge. Sets type='llm'. |
| `--direction <higher\|lower>` | `higher` | No | Optimization direction — whether higher or lower scores are better |
| `--judge-model <model>` | `claude-sonnet-4-6` | No | Judge model for LLM scoring (only valid with --goal) |
| `--task "<text>"` | — | Yes | What to optimize (becomes the PRD objective) |
| `--tolerance <N>` | `0` | No | Score delta within which changes count as "held" |
| `--stall-limit <N>` | `5` | No | Non-improving iterations before convergence |
| `--max-iterations <N>` | `100` | No | Hard cap on total iterations |
| `--resume [path]` | — | No | Resume existing session (skips --metric/--task/--goal) |
| `--tmux` | — | No | Run in tmux with context clearing between iterations |

If `--resume`: `--metric`/`--goal` and `--task` are NOT required.
Otherwise:
- Exactly one of `--metric` or `--goal` is required — print error and STOP if both or neither provided.
- `--task` is required — print error and STOP if missing.
- `--judge-model` without `--goal` is an error — print error and STOP.

## Step 2: Session Setup

### New Session
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --command-template microverse.md [--tmux] [--max-iterations <N>] --task "<TASK_TEXT>"
```

### Resume
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --command-template microverse.md --resume [<PATH>] [--tmux] [--max-iterations <N>]
```

Extract `SESSION_ROOT=<path>` from output. If `--resume`, skip Steps 3 and 4.

## Step 3: Create microverse.json (new sessions only)

Write `${SESSION_ROOT}/microverse.json` conforming to `MicroverseSessionState`:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const sessionDir = process.argv[1];
const type = process.argv[6] || 'command';
const direction = process.argv[7] || 'higher';
const keyMetric = {
  description: process.argv[2],
  validation: process.argv[3],
  type: type,
  timeout_seconds: 60,
  tolerance: Number(process.argv[4]),
  direction: direction
};
if (type === 'llm') keyMetric.judge_model = process.argv[8] || 'claude-sonnet-4-6';
const state = {
  status: 'gap_analysis',
  prd_path: path.join(sessionDir, 'prd.md'),
  key_metric: keyMetric,
  convergence: {
    stall_limit: Number(process.argv[5]),
    stall_counter: 0,
    history: []
  },
  gap_analysis_path: '',
  failed_approaches: [],
  baseline_score: 0
};
fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(state, null, 2));
console.log('microverse.json created');
" "${SESSION_ROOT}" "<TASK_TEXT>" "<VALIDATION>" "<TOLERANCE>" "<STALL_LIMIT>" "<TYPE>" "<DIRECTION>" "<JUDGE_MODEL>"
```

Replace placeholders with parsed values:
- `<VALIDATION>` = metric command (if `--metric`) or goal text (if `--goal`)
- `<TYPE>` = `command` (if `--metric`) or `llm` (if `--goal`)
- `<DIRECTION>` = from `--direction` flag (default `higher`)
- `<JUDGE_MODEL>` = from `--judge-model` flag (default `claude-sonnet-4-6`, only used when type=`llm`)

Verify: `node -e "const s=JSON.parse(require('fs').readFileSync('${SESSION_ROOT}/microverse.json','utf-8')); console.log('status:', s.status, 'metric:', s.key_metric.validation, 'stall_limit:', s.convergence.stall_limit)"`

## Step 4: Write prd.md (new sessions only)

Write `${SESSION_ROOT}/prd.md`:

```markdown
# Microverse Optimization PRD

## Objective
<TASK_TEXT>

## Key Metric
- **Type**: <TYPE> (`command` or `llm`)
- **Command** (if type=command): `<METRIC_CMD>`
- **Goal** (if type=llm): <GOAL_TEXT>
- **Direction**: <DIRECTION> (higher or lower is better)
- **Tolerance**: <TOLERANCE>
- **Stall Limit**: <STALL_LIMIT>

## Success Criteria
Continuously improve the metric score through targeted, incremental changes until convergence (no improvement for <STALL_LIMIT> consecutive iterations).

## Constraints
- One logical change per iteration
- Never repeat failed approaches
- Always commit changes for measurement
- Metric is measured automatically after each iteration
```

## Step 5: Launch

### Option A: tmux mode (`--tmux` flag present)

1. Check tmux: `tmux -V`. If missing → print "Install tmux: `brew install tmux`" and STOP.

2. Session name: `microverse-<hash>` from SESSION_ROOT basename.

3. Read `working_dir` from `${SESSION_ROOT}/state.json`.

4. Create tmux session:
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```
Print attach command: `tmux attach -t <name>`

5. Launch runner:
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/microverse-runner.js ${SESSION_ROOT}; echo ''; echo 'Microverse runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter
```

6. Launch monitor:
```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> ${SESSION_ROOT} pickle
```

7. Report: session name, `tmux attach -t <name>`, window layout (monitor: Ctrl+B 1; runner: Ctrl+B 0), cancel: `cd <working_dir> && /eat-pickle`, emergency: `tmux kill-session -t <name>`, state path.

Output: `<promise>TASK_COMPLETED</promise>`

### Option B: Interactive mode (no `--tmux`)

You ARE the convergence loop. Run it inline.

#### 5a: Gap Analysis (iteration 0)

1. Read `${SESSION_ROOT}/prd.md`
2. Run the metric validation command to see current score
3. Analyze the codebase — use **Glob** and **Grep** (not bash grep) to understand what the metric measures, where relevant code lives, and current bottlenecks
4. Write gap analysis to `${SESSION_ROOT}/gap_analysis.md`
5. Update `microverse.json`: set `gap_analysis_path` to the gap analysis path
6. Make initial improvements if obvious quick wins exist
7. Commit: `git add -A && git commit -m "microverse: gap analysis and initial improvements"`
8. Measure metric again, update `baseline_score` in `microverse.json`
9. Update `microverse.json`: set `status` to `"iterating"`

#### 5b: Iteration Loop

Repeat until converged or max iterations reached:

1. Read `microverse.json` for current state
2. Record pre-iteration SHA: `git rev-parse HEAD`
3. Plan **one targeted change** — consult `failed_approaches` to avoid repeats, review recent `convergence.history` for trends
4. Implement the change using **Read**, **Edit**, **Glob**, **Grep** tools
5. Measure the metric:
   - If type=`command`: Run the metric validation command, parse the numeric score from the last line
   - If type=`llm`: Do NOT run the validation as a shell command. The runner's LLM judge scores your changes — note this and proceed to commit. The judge will evaluate against the goal description.
6. Compare score to previous. Use the last **accepted** history entry's score (i.e., filter out entries with action='reverted'), or baseline_score if no accepted entries yet. Comparison is **direction-aware** based on `key_metric.direction`:
   - If direction=`higher` (default):
     - **Improved** (score > previous + tolerance) → accept, set stall_counter = 0
     - **Held** (within tolerance) → accept, increment stall_counter
     - **Regressed** (score < previous - tolerance) → run `git reset --hard <pre-iteration-SHA>`, add description to `failed_approaches`, increment stall_counter
   - If direction=`lower`:
     - **Improved** (score < previous - tolerance) → accept, set stall_counter = 0
     - **Held** (within tolerance) → accept, increment stall_counter
     - **Regressed** (score > previous + tolerance) → run `git reset --hard <pre-iteration-SHA>`, add description to `failed_approaches`, increment stall_counter
7. If accepted: `git add -A && git commit -m "microverse: <description>"`
8. Add entry to `convergence.history`: `{iteration, metric_value, score, action, description, pre_iteration_sha, timestamp}`
9. Write updated state to `microverse.json`
10. Check: `stall_counter >= stall_limit` → set status to `"converged"`, exit loop
11. Check: iteration >= max_iterations → set status to `"stopped"`, set `exit_reason` to `"limit_reached"`, exit loop

#### 5c: Finalize

1. Update `microverse.json` with final status and `exit_reason`
2. Print summary: total iterations, baseline score, best score, exit reason, accepted/reverted counts
3. Output: `<promise>TASK_COMPLETED</promise>`

## Rules

1. **--metric or --goal is mandatory** for new sessions — no metric/goal, no microverse. They are mutually exclusive (XOR).
2. **One change per iteration** — atomic, revertible
3. **Never repeat failed approaches** — always check `failed_approaches` before planning
4. **Always commit** — uncommitted changes are invisible to measurement
5. **Use built-in tools** — Glob for file search, Grep for content search, Read for files
6. **microverse.json is the source of truth** — update it after every state change
