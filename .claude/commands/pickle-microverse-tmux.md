Launch a Pickle Rick microverse convergence loop in tmux with true context clearing between iterations — best for long optimization runs.

# /pickle-microverse-tmux

## Step 1: Check tmux
Run `tmux -V`. If missing: "Install tmux: `brew install tmux` or `apt install tmux`, or use /pickle-microverse for interactive mode." Stop.

## Step 2: Parse Flags

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

If `--resume`: `--metric`/`--goal` and `--task` are NOT required.
Otherwise:
- Exactly one of `--metric` or `--goal` is required — print error and STOP if both or neither provided.
- `--task` is required — print error and STOP if missing.
- `--judge-model` without `--goal` is an error — print error and STOP.

## Step 3: Session Setup

### New Session
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --command-template microverse.md [--max-iterations <N>] --task "<TASK_TEXT>"
```

### Resume
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --command-template microverse.md --resume [<PATH>] [--max-iterations <N>]
```

Extract `SESSION_ROOT=<path>` from output. If `--resume`, skip Steps 4 and 5.

## Step 4: Create microverse.json (new sessions only)

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

## Step 5: Write prd.md (new sessions only)

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

## Step 6: tmux Session

Session name: `microverse-<hash>` from SESSION_ROOT basename.

Read `working_dir` from `${SESSION_ROOT}/state.json`.

```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```

Print attach command immediately: `tmux attach -t <name>` (Window 1 "monitor" = 4-pane; Window 0 "runner" = background, Ctrl+B 0).

## Step 7: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/microverse-runner.js ${SESSION_ROOT}; echo ''; echo 'Microverse runner finished.  Ctrl+B 1 → monitor  |  Ctrl+B D → detach'; read" Enter
```

## Step 8: Monitor (4-pane)
```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> ${SESSION_ROOT} pickle
```

## Step 9: Report
Print: session name, `tmux attach -t <name>`, window layout (monitor: dashboard top-left / log-stream top-right / morty-logs bottom-left / raw-morty bottom-right; runner: Ctrl+B 0), metric command, cancel: `cd <working_dir> && /eat-pickle`, emergency: `tmux kill-session -t <name>` then `node ~/.claude/pickle-rick/extension/bin/cancel.js`, state path: `<SESSION_ROOT>/state.json`.

Output: `<promise>TASK_COMPLETED</promise>`
