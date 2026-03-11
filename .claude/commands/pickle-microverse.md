Start the Pickle Rick microverse convergence loop — optimize a metric through targeted, incremental changes.

# /pickle-microverse

## Step 1: Parse Flags

Extract from `$ARGUMENTS`:

| Flag | Type | Default | Required |
|------|------|---------|----------|
| `--metric '<cmd>'` | string | — | Yes (new session) |
| `--tolerance <N>` | number | 0 | No |
| `--stall-limit <N>` | number | 5 | No |
| `--task '<text>'` | string | — | Yes (new session) |
| `--resume <path>` | string | — | No (skips --metric/--task) |
| `--max-iterations <N>` | number | 100 | No |

If `--resume` is present, skip validation of `--metric` and `--task`.
Otherwise, both `--metric` and `--task` are required — error if missing.

## Step 2: Session Setup

Build the setup.js command with extracted flags:

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --command-template microverse.md [--max-iterations <N>] [--resume <path>] --task "<task text>"
```

For `--resume`: `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --command-template microverse.md --resume <path> [--max-iterations <N>]`

Extract `SESSION_ROOT=<path>` from the output.

## Step 3: Create microverse.json (new sessions only)

Skip this step if `--resume` was used.

Write `microverse.json` to `SESSION_ROOT`:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const sessionDir = '<SESSION_ROOT>';
const state = {
  status: 'gap_analysis',
  prd_path: path.join(sessionDir, 'prd.md'),
  key_metric: {
    description: '<task text>',
    validation: '<metric cmd>',
    type: 'command',
    tolerance: <TOLERANCE>,
    timeout_seconds: 30
  },
  convergence: {
    stall_limit: <STALL_LIMIT>,
    stall_counter: 0,
    history: []
  },
  gap_analysis_path: '',
  failed_approaches: [],
  baseline_score: 0
};
fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(state, null, 2));
console.log('microverse.json created');
"
```

Replace `<SESSION_ROOT>`, `<task text>`, `<metric cmd>`, `<TOLERANCE>`, `<STALL_LIMIT>` with the parsed values.

## Step 4: Write prd.md (new sessions only)

Skip this step if `--resume` was used.

Write `prd.md` to `SESSION_ROOT` with the task as the optimization objective:

```markdown
# Microverse PRD

## Objective
<task text>

## Key Metric
- **Validation Command**: `<metric cmd>`
- **Tolerance**: <TOLERANCE>
- **Stall Limit**: <STALL_LIMIT>

## Strategy
Optimize the metric through targeted, incremental changes. Each iteration should make one focused improvement. The microverse runner will automatically measure the metric after each iteration, accept improvements, and revert regressions.
```

## Step 5: Launch Runner

Run `microverse-runner.js` directly (interactive mode — no tmux):

```bash
node "$HOME/.claude/pickle-rick/extension/bin/microverse-runner.js" <SESSION_ROOT>
```

## Step 6: Report

Print:
- Session path: `<SESSION_ROOT>`
- Metric: `<metric cmd>`
- Tolerance: `<TOLERANCE>`
- Stall limit: `<STALL_LIMIT>`
- Max iterations: `<N>`
- Cancel: `/eat-pickle`
- State: `<SESSION_ROOT>/state.json`
- Microverse state: `<SESSION_ROOT>/microverse.json`

Output: `<promise>TASK_COMPLETED</promise>`
