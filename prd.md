# True Context Clearing via tmux PRD

| True Context Clearing via tmux PRD |  | Spawn a fresh Claude subprocess per iteration inside a tmux session, eliminating context drift on long epics |
| :---- | :---- | :---- |
| **Author**: Pickle Rick **Intended audience**: Engineering | **Status**: Draft **Created**: 2026-02-22 | **Visibility**: Internal |

## Introduction

As Pickle Rick epics grow in iteration count, Claude Code's context window fills with compressed conversation history from prior iterations. The stop hook's `buildHandoffSummary()` injection mitigates this by providing a fresh context summary each turn, but the underlying conversation still accumulates stale tokens. On long epics (8+ iterations), this causes measurable drift: Rick revisits completed tickets, loses track of state, or hallucinates prior decisions.

This PRD specifies a tmux-based outer runner that spawns a **genuinely fresh** `claude --no-session-persistence -p` subprocess per iteration. Each iteration starts with zero conversation history and a clean handoff file. The tmux session provides the live terminal view while the outer loop manages iteration advancement, token detection, and cleanup.

## Problem Statement

**Current Process:** The `/pickle` command runs inside a single interactive Claude Code session. The stop hook blocks exit and injects a handoff summary as a system message (`reason` field). Claude Code auto-compresses prior conversation as the context window fills. Rick continues in the same session across all iterations.

**Primary Users:** Developers running Pickle Rick for long-running autonomous epics (5+ tickets, 8+ iterations) where context drift degrades output quality.

**Pain Points:**
- Context accumulation across iterations causes drift on long epics -- Rick may revisit completed tickets, repeat research, or lose track of the current phase
- Auto-compression is lossy -- details from early iterations are discarded unpredictably, which can remove critical architectural decisions
- The stop hook's `reason` injection is the only fresh context per turn; everything else is compressed residue from prior turns
- No mechanism exists to give Rick a truly clean slate between iterations while preserving session continuity

**Importance:** Context drift is the single largest quality bottleneck on epics longer than ~8 iterations. Solving it unlocks reliable execution of 15-20+ iteration epics without human intervention.

## Objective & Scope

**Objective:** Provide an alternative execution mode (`/pickle-tmux`) that spawns a fresh Claude Code subprocess per iteration inside a tmux session, achieving true context clearing between iterations while preserving the full Pickle Rick lifecycle.

**Ideal Outcome:** A user can run `/pickle-tmux <task>` and watch Rick execute an epic of arbitrary length with zero context drift. Each iteration starts clean with only the handoff file as context. The user can attach/detach from the tmux session at will.

### In-scope or Goals

- `extension/bin/tmux-runner.js` -- outer loop runner that spawns one `claude -p` per iteration inside a tmux pane
- Stop hook modification: write `handoff.txt` to `SESSION_ROOT` on every `block` decision
- `.claude/commands/pickle-tmux.md` -- slash command that creates a tmux session and launches the runner
- `install.sh` update to deploy the new command and script
- Documentation updates to `help-pickle.md` and `README.md`

### Not-in-scope or Non-Goals

- Replacing the existing `/pickle` interactive mode -- both modes coexist; user chooses
- Parallel Morty workers -- separate feature (B3), separate PRD
- Custom tmux layouts or split panes -- single pane only
- Windows/WSL support for tmux -- macOS and Linux only
- Changes to the state schema (`state.json`) -- one additive field only: `tmux_mode: true` boolean set by `setup.js` when `--tmux` flag is passed; no structural changes, fully backwards-compatible
- Changes to Morty worker spawning -- `spawn-morty.js` is untouched; only the manager iteration loop changes

## Product Requirements

### Critical User Journeys (CUJs)

#### CUJ 1: Basic Usage -- Short Epic

1. User runs `/pickle-tmux refactor the auth module` in their project directory
2. Rick runs `setup.js` to create a new session with `state.json`
3. Rick creates a detached tmux session named `pickle-<short-hash>`
4. Rick launches `tmux-runner.js` inside the tmux session, passing the session directory
5. `tmux-runner.js` starts iteration 1: builds a handoff summary from `state.json` (cold start — no `handoff.txt` yet), prepends the `pickle.md` manager prompt, and spawns `claude --no-session-persistence -p "<combined prompt>"`
6. The spawned Claude process executes the PRD phase and outputs `<promise>PRD_COMPLETE</promise>`. Claude tries to stop. The stop hook fires — because `state.tmux_mode === true`, the hook calls `process.exit(0)` (clean exit) instead of emitting `block` JSON. Claude is allowed to exit. The subprocess terminates
7. The stop hook (which ran during subprocess exit) has already written `handoff.txt` to `SESSION_ROOT` and incremented `state.iteration`. `tmux-runner.js` detects the subprocess `close` event, reads updated `state.json` and fresh `handoff.txt`, and spawns iteration 2
8. This repeats through Breakdown, Research/Plan/Implement/Refactor for each ticket
9. When Rick outputs `<promise>EPIC_COMPLETED</promise>`, `tmux-runner.js` detects it in the log file and exits the loop
10. The tmux session remains open showing the final output; user can review or kill it

#### CUJ 2: Long Epic with Context Drift Prevention

1. User has a 12-ticket epic that previously failed at ticket 8 due to context drift in `/pickle` mode
2. User runs `/pickle-tmux implement the full API layer per prd.md`
3. Each of the ~15 iterations starts with a completely clean Claude context containing only:
   - The `pickle.md` manager prompt (inlined via the handoff file)
   - The handoff summary (phase, iteration, ticket list, next action)
   - The session directory (via `--add-dir`)
4. At iteration 12, Rick is working on ticket 8 -- the exact point where `/pickle` mode drifted. With tmux mode, Rick reads fresh state and proceeds correctly
5. Epic completes at iteration 15 with all tickets Done
6. `tmux-runner.js` prints a summary and exits

#### CUJ 3: Recovery and Cancellation

1. User attaches to the tmux session (`tmux attach -t pickle-<hash>`) and sees Rick is stuck in a loop on a ticket
2. User runs `/eat-pickle` **from the project directory** (same cwd used when `/pickle-tmux` was invoked) to set `active: false` in `state.json`. **Critical**: `/eat-pickle` uses `current_sessions.json` keyed on `process.cwd()` — it must be run from the same working directory, or it will not find the session. If the user is in a different terminal, they have two alternatives:
   - `cd /path/to/project && /eat-pickle`, or
   - Directly edit `state.json`: `jq '.active = false' <SESSION_ROOT>/state.json > /tmp/ps.tmp && mv /tmp/ps.tmp <SESSION_ROOT>/state.json`
3. `tmux-runner.js` checks `state.active` before spawning the next iteration, sees it is false, and exits gracefully
4. Alternatively: user runs `tmux kill-session -t pickle-<hash>` to force-kill everything immediately (state.json remains with `active: true` — run `/eat-pickle` afterward to clean up, or the next `/pickle --resume` will reset it)
5. The session directory, state, and all artifacts remain intact on disk for inspection or `/pickle --resume`

### Functional Requirements

| Priority | Requirement | User Story |
| :---- | :---- | :---- |
| P0 | `tmux-runner.js` spawns a fresh `claude -p` subprocess per iteration | As a user, I want each iteration to start with clean context so long epics don't drift |
| P0 | Stop hook writes `handoff.txt` to `SESSION_ROOT` on every `block` decision | As a tmux runner, I need a file-based handoff so the next subprocess can read it |
| P0 | `tmux-runner.js` detects `EPIC_COMPLETED` and `TASK_COMPLETED` tokens in subprocess output to exit the loop | As a user, I want the runner to stop when the epic is done |
| P0 | `/pickle-tmux` command creates a tmux session and launches the runner | As a user, I want a single command to start the tmux-based loop |
| P0 | `tmux-runner.js` respects `state.active`, `max_iterations`, and `max_time_minutes` limits | As a user, I want the same safety limits as `/pickle` mode |
| P1 | `tmux-runner.js` handles `state.active = false` gracefully (clean exit between iterations) | As a user, I want `/eat-pickle` to work with tmux mode |
| P1 | `tmux-runner.js` passes `PICKLE_STATE_FILE` env var to each spawned subprocess | As the stop hook, I need to find state.json in the subprocess environment |
| P1 | Runner names the tmux session deterministically from the session hash for easy attachment | As a user, I want to `tmux attach -t pickle-<hash>` to watch progress |
| P1 | `handoff.txt` includes the full manager prompt (from `pickle.md`) prepended to the handoff summary | As the spawned Claude, I need both the lifecycle instructions and the current state |
| P2 | Runner prints a summary panel on completion (iterations, elapsed time, final state) | As a user, I want to know what happened when the runner finishes |
| P2 | Runner logs each iteration start/end to `SESSION_ROOT/tmux-runner.log` | As a debugger, I want a persistent log of the outer loop |
| P2 | `pickle_settings.json` gains a `default_tmux_max_turns` field (defaults to `default_manager_max_turns`) | As a power user, I want to tune the per-iteration turn limit independently |

## Implementation Order

Tickets must be implemented in this sequence. Dependencies are strict.

| Order | Ticket | Depends On | Files Changed |
| :---- | :---- | :---- | :---- |
| T1 | Extract `buildHandoffSummary()` to `pickle-utils.js` | — | `stop-hook.js`, `pickle-utils.js` |
| T2 | Modify `stop-hook.js`: write `handoff.txt` + `tmux_mode` exit | T1 | `stop-hook.js` |
| T3 | Add `--tmux` flag to `setup.js` | — | `setup.js` |
| T4 | Implement `tmux-runner.js` | T1, T2, T3 | `extension/bin/tmux-runner.js` |
| T5 | Implement `pickle-tmux.md` command | T4 | `.claude/commands/pickle-tmux.md` |
| T6 | Update `install.sh`, `help-pickle.md`, `README.md` | T5 | `install.sh`, `help-pickle.md`, `README.md` |

**T1 prerequisite check:** verify `buildHandoffSummary` is NOT already exported from `pickle-utils.js` before implementing. If already extracted, skip T1.

---

## Implementation Notes

### 1. Stop Hook Change: Write `handoff.txt` on Every Block Decision

**File:** `extension/hooks/handlers/stop-hook.js`

**Change:** After every `decision: 'block'` JSON output, also write the handoff summary to a file. This is the bridge between the interactive mode (which uses the `reason` field) and the tmux mode (which reads the file).

**Exact location:** In the two places where `console.log(JSON.stringify({ decision: 'block', reason: ... }))` is called (lines ~186-190 and ~218-221 in the current file), add a file write immediately before the `console.log`:

```javascript
// Write handoff.txt for tmux-runner.js consumption
const sessionDir = path.dirname(stateFile);
const handoffPath = path.join(sessionDir, 'handoff.txt');
try {
    fs.writeFileSync(handoffPath, summary);
} catch (e) {
    log(`Failed to write handoff.txt: ${e}`);
}
```

**Why before the console.log:** The `console.log` may terminate the process flow. Writing the file first ensures it is always available.

**tmux_mode: exit cleanly instead of blocking.** This is the mechanism that enables fresh context per iteration. After writing `handoff.txt`, check `state.tmux_mode`. If true, call `process.exit(0)` instead of emitting the `block` JSON. `tmux-runner.js` handles the outer loop externally — the stop hook must not block, or the subprocess will loop internally and accumulate context, defeating the entire purpose.

```javascript
// Write handoff.txt first (both modes need it)
const sessionDir = path.dirname(stateFile);
const handoffPath = path.join(sessionDir, 'handoff.txt');
try {
    fs.writeFileSync(handoffPath, summary);
} catch (e) {
    log(`Failed to write handoff.txt: ${e}`);
}

// tmux mode: exit cleanly so tmux-runner.js can respawn a fresh subprocess
if (state.tmux_mode) {
    process.exit(0);
}

// Interactive mode: block as normal
console.log(JSON.stringify({ decision: 'block', reason: `${feedback}\n\n${summary}` }));
```

**No behavior change for interactive mode:** The `reason` field injection continues to work exactly as before for all sessions where `state.tmux_mode` is absent or false.

### 2. `extension/bin/tmux-runner.js` -- Full Architecture

**File:** `extension/bin/tmux-runner.js` (~150-180 lines)

**Purpose:** Outer loop that runs inside a tmux pane. Spawns one fresh `claude -p` per iteration. Detects completion tokens. Enforces limits.

**Shebang:** First line must be `#!/usr/bin/env node` (same pattern as `spawn-morty.js` and `jar-runner.js`). Required for `chmod +x` execution.

**Imports:**
```javascript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { printMinimalPanel, Style, formatTime, getExtensionRoot } from '../services/pickle-utils.js';
```

**CLI interface:**
```
node tmux-runner.js <session-dir>
```

**Per-iteration loop (pseudocode):**
```javascript
async function runIteration(sessionDir, iterationNum, extensionRoot) {
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    // 1. Check pre-conditions
    if (!state.active) return 'inactive';

    // 2. Build handoff prompt
    //    - Load pickle.md (the full manager lifecycle instructions) from ~/.claude/commands/pickle.md
    //    - Replace only $ARGUMENTS with --resume <sessionDir>. Leave ${EXTENSION_ROOT} and
    //      ${SESSION_ROOT} as-is — they appear in instructional prose and the agent resolves them
    //      from context (CLAUDE.md defines ${EXTENSION_ROOT}; ${SESSION_ROOT} is established by
    //      setup output in the handoff). Pre-substituting them is unnecessary and risks mangling
    //      documentation strings that use these as reference tokens.
    //    - Append the handoff summary (from handoff.txt if it exists; build from state if not)
    const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
    if (!fs.existsSync(picklePromptPath)) {
        throw new Error(`pickle.md not found at ${picklePromptPath}. Run install.sh first.`);
    }
    let managerPrompt = fs.readFileSync(picklePromptPath, 'utf-8')
        .replace(/\$ARGUMENTS/g, `--resume ${sessionDir}`);

    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
        // Subsequent iterations: use handoff written by stop hook
        managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
    } else {
        // Iteration 1 cold start: handoff.txt doesn't exist yet (stop hook hasn't fired).
        // Build the handoff summary from state.json using buildHandoffSummary() (from pickle-utils.js).
        // T1 MUST be complete before T4 — buildHandoffSummary() must be exported from pickle-utils.js.
        // Summary shows: Phase: prd, Iteration: 0, no tickets yet. Rick starts fresh from PRD phase.
        const summary = buildHandoffSummary(state, sessionDir);
        managerPrompt += '\n\n' + summary;
    }

    // 3. Load settings
    const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
    let maxTurns = 50; // default
    try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        maxTurns = settings.default_tmux_max_turns
            || settings.default_manager_max_turns
            || 50;
    } catch { /* use default */ }

    // 5. Spawn claude subprocess
    const logFile = path.join(sessionDir, `tmux_iteration_${iterationNum}.log`);
    const cmdArgs = [
        '--dangerously-skip-permissions',
        '--add-dir', sessionDir,
        '--no-session-persistence',
        '--max-turns', String(maxTurns),
        '-p', managerPrompt,
    ];

    const env = {
        ...process.env,
        PICKLE_STATE_FILE: statePath,
    };
    delete env.CLAUDECODE; // Allow nested claude spawning

    const logStream = fs.createWriteStream(logFile, { flags: 'w' });

    return new Promise((resolve) => {
        const proc = spawn('claude', cmdArgs, {
            cwd: state.working_dir || process.cwd(),
            env,
            stdio: ['inherit', 'pipe', 'pipe'],
        });

        proc.stdout?.pipe(logStream);
        proc.stderr?.pipe(logStream);

        // Also stream stdout to the tmux pane for live visibility
        proc.stdout?.pipe(process.stdout);
        proc.stderr?.pipe(process.stderr);

        proc.on('close', (code) => {
            logStream.end();
            // Read log and check for completion tokens
            const output = fs.readFileSync(logFile, 'utf-8');
            if (output.includes('<promise>EPIC_COMPLETED</promise>') ||
                output.includes('<promise>TASK_COMPLETED</promise>')) {
                resolve('completed');
            } else {
                resolve('continue');
            }
        });

        proc.on('error', (err) => {
            console.error(`${Style.RED}Failed to spawn claude: ${err.message}${Style.RESET}`);
            resolve('error');
        });
    });
}

async function main() {
    const sessionDir = process.argv[2];
    if (!sessionDir || !fs.existsSync(path.join(sessionDir, 'state.json'))) {
        console.error('Usage: node tmux-runner.js <session-dir>');
        process.exit(1);
    }

    const extensionRoot = getExtensionRoot();
    const statePath = path.join(sessionDir, 'state.json');
    const runnerLog = path.join(sessionDir, 'tmux-runner.log');

    const log = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        console.log(msg);
    };

    log('tmux-runner started');
    const startTime = Date.now();
    let iteration = 0;

    while (true) {
        // Read fresh state each iteration
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

        // Check active flag
        if (!state.active) {
            log('Session inactive. Exiting.');
            break;
        }

        // Check max_iterations
        if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
            log(`Max iterations reached (${state.iteration}/${state.max_iterations}). Exiting.`);
            break;
        }

        // Check max_time
        const elapsed = Math.floor(Date.now() / 1000) - state.start_time_epoch;
        if (state.max_time_minutes > 0 && elapsed >= state.max_time_minutes * 60) {
            log(`Time limit reached (${elapsed}s). Exiting.`);
            break;
        }

        iteration++;
        log(`--- Iteration ${iteration} (state.iteration=${state.iteration}) ---`);

        const result = await runIteration(sessionDir, iteration, extensionRoot);

        if (result === 'completed') {
            log('Epic/Task completed. Exiting loop.');
            break;
        }
        if (result === 'inactive') {
            log('Session deactivated. Exiting loop.');
            break;
        }
        if (result === 'error') {
            log('Subprocess error. Exiting loop.');
            break;
        }

        // Stall detection: if state.iteration hasn't advanced after 3 outer-loop iterations,
        // something is wrong (stop hook not firing, subprocess crashing silently, etc.).
        // Log a warning and exit to avoid burning API credits in a stuck loop.
        // Track lastStateIteration across outer-loop runs and compare.

        // Brief pause before next iteration (allow state.json writes to flush)
        await new Promise(r => setTimeout(r, 1000));
    }

    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

    printMinimalPanel('tmux-runner Complete', {
        Iterations: iteration,
        Elapsed: formatTime(totalElapsed),
        FinalPhase: finalState.step || 'unknown',
        Active: String(finalState.active),
    }, 'GREEN', '🥒');

    log(`tmux-runner finished. ${iteration} iterations, ${formatTime(totalElapsed)}`);
}
```

**Key design decisions:**
- **`stdio: ['inherit', 'pipe', 'pipe']`**: Matches `spawn-morty.js` pattern. stdout/stderr are piped to both a log file and the tmux pane via `process.stdout`/`process.stderr` for live visibility.
- **Token detection via log file**: After each subprocess exits, read the log file and scan for `EPIC_COMPLETED` or `TASK_COMPLETED`. This mirrors `spawn-morty.js`'s `I AM DONE` detection pattern.
- **`delete env.CLAUDECODE`**: Required to allow nested Claude subprocess spawning, same as `spawn-morty.js` line 125.
- **`PICKLE_STATE_FILE` env var**: Threaded through to the subprocess so the stop hook can find `state.json` without relying on `current_sessions.json` (the tmux pane's `cwd` may not match the project directory).
- **Prompt delivery**: The combined manager prompt + handoff is passed directly via the `-p` flag to `spawn()`. Since we use `spawn()` not `tmux send-keys`, shell escaping is not a concern — `spawn()` uses `execve()` and passes arguments as a proper array, bypassing the shell entirely.
- **1-second pause between iterations**: Allows the stop hook's `state.json` write to flush before the next iteration reads it.
- **Variable substitution**: `pickle.md` contains `$ARGUMENTS` as the slash-command substitution slot — replace it with `--resume <sessionDir>`. `${EXTENSION_ROOT}` and `${SESSION_ROOT}` in the body are instructional prose tokens; the agent resolves these from CLAUDE.md context. Do NOT pre-substitute them — unnecessary and risks mangling documentation strings that use them as reference tokens.
- **`buildHandoffSummary()` extraction (T1 — BLOCKING prerequisite)**: `buildHandoffSummary()` is currently a local unexported function inside `stop-hook.js` lines 5-39. It is NOT in `pickle-utils.js`. It is NOT exported anywhere. `tmux-runner.js` cannot use it until T1 is complete. T1 must be implemented first, no exceptions.

**Important note on stop hook interaction in tmux mode:** In tmux mode, the spawned `claude -p` subprocess runs headlessly. **The stop hook does fire** — it is registered as a process-level hook and triggers on every Claude Code exit regardless of interactive or headless mode. However, the `block` decision has no practical effect on a `-p` subprocess that has already completed its prompt (Claude exits after finishing the headless task regardless of the hook response). The side effects that matter are: (1) the stop hook writes `handoff.txt` to `SESSION_ROOT`, and (2) the stop hook increments `state.iteration` and enforces limits. The `tmux-runner.js` outer loop reads these state changes after each subprocess exits to drive the next iteration. **If the stop hook does NOT fire in `-p` mode** (e.g., due to a future Claude Code behavior change), `handoff.txt` will never be written and the bridge breaks — in this case, `tmux-runner.js` must call `buildHandoffSummary()` directly each iteration and skip reading `handoff.txt` entirely. Add a log warning if `handoff.txt` is missing after iteration 2+.

### 3. `.claude/commands/pickle-tmux.md` -- Slash Command

**File:** `.claude/commands/pickle-tmux.md`

**Purpose:** Entry point for the user. Creates the session, starts tmux, launches the runner.

**Content (save verbatim to `.claude/commands/pickle-tmux.md`):**

    # /pickle-tmux

    You are Pickle Rick. The user wants to run an epic with TRUE CONTEXT CLEARING via tmux.

    ## Step 1: Check for tmux

    Run: tmux -V
    If tmux is not installed, print: "tmux is not installed. Run `brew install tmux` (macOS)
    or `apt install tmux` (Linux), or use /pickle for interactive mode." Then stop.

    ## Step 2: Session Setup

    Run: node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux $ARGUMENTS

    Read the output for the SESSION_ROOT path (line starting with SESSION_ROOT=).
    Also record the working_dir (the project cwd).

    ## Step 3: Create tmux Session

    Derive session name from SESSION_ROOT basename: pickle-<hash-portion>
    Run: tmux new-session -d -s <session-name> -c <working_dir>
    Run: sleep 1
    (Allow tmux to initialize the session before sending keys — avoids a race where send-keys
    fires before the pane is ready.)

    ## Step 4: Launch Runner

    Run: tmux send-keys -t <session-name>:0 "node $HOME/.claude/pickle-rick/extension/bin/tmux-runner.js <SESSION_ROOT>" Enter

    ## Step 5: Report to User

    Print ALL of the following:
    - tmux session name: <session-name>
    - Attach to watch: tmux attach -t <session-name>
    - To cancel (MUST run from project dir): cd <working_dir> && /eat-pickle
    - Emergency kill: tmux kill-session -t <session-name>
      (follow with: node ~/.claude/pickle-rick/extension/bin/cancel.js from <working_dir>)
    - state.json path for manual cancel: <SESSION_ROOT>/state.json

    Then output: <promise>TASK_COMPLETED</promise>

**Key behavior:** The `/pickle-tmux` command itself runs in an interactive Claude Code session. Its only job is to set up the session, create the tmux session, and launch the runner. After that, it exits (via `TASK_COMPLETED`). The actual epic execution happens in the tmux pane, fully decoupled from the interactive session.

### 4. `extension/bin/setup.js` Change: `--tmux` Flag

**File:** `extension/bin/setup.js`

**Change:** Add `--tmux` as a recognized flag. When present, set `state.tmux_mode = true` in the initialized `state.json`.

```javascript
// In args parsing block (alongside existing --max-iterations, --max-time, etc.):
const tmuxMode = args.includes('--tmux');

// In state object initialization:
const state = {
    // ... existing fields ...
    tmux_mode: tmuxMode,
};
```

**Why:** `tmux-runner.js` passes the session dir to `claude -p`. The stop hook reads `state.json` via `PICKLE_STATE_FILE` and checks `state.tmux_mode` to decide whether to block or exit cleanly.

### 5. `install.sh` Changes

Add to the existing install script:

```bash
# tmux-runner
chmod +x "$EXTENSION_ROOT/extension/bin/tmux-runner.js"

# pickle-tmux command
cp "$REPO_ROOT/.claude/commands/pickle-tmux.md" "$HOME/.claude/commands/pickle-tmux.md"
```

Place these lines adjacent to the existing `jar-runner.js` chmod and command copy lines.

### 6. How `PICKLE_STATE_FILE` Threads Through

The env var chain for tmux mode:

1. `/pickle-tmux` command runs `setup.js`, which creates `state.json` at `SESSION_ROOT/state.json` and registers the session in `current_sessions.json`
2. `tmux-runner.js` receives `<session-dir>` as its CLI argument. It constructs `statePath = path.join(sessionDir, 'state.json')`.
3. For each iteration, `tmux-runner.js` sets `PICKLE_STATE_FILE: statePath` in the subprocess `env` object (identical to `jar-runner.js` line 44-46).
4. The spawned `claude -p` process inherits this env var.
5. The stop hook reads `PICKLE_STATE_FILE` at line 81 of `stop-hook.js` to locate `state.json` directly, bypassing the `current_sessions.json` lookup.
6. The stop hook writes `handoff.txt` to `path.dirname(stateFile)` (which is `SESSION_ROOT`).
7. `tmux-runner.js` reads `handoff.txt` from `SESSION_ROOT` to build the next iteration's prompt.

### 7. `/pickle-tmux` vs `/pickle` -- When to Use Each

| Aspect | `/pickle` (Interactive) | `/pickle-tmux` (tmux) |
| :---- | :---- | :---- |
| **Context** | Accumulates, auto-compressed | Fresh per iteration |
| **Best for** | Short epics (1-7 iterations) | Long epics (8+ iterations) |
| **UI** | Native Claude Code interactive session (keyboard shortcuts, inline editing) | Streamed headless output in a tmux pane |
| **Interactivity** | User can type mid-session | Read-only (user watches output) |
| **Recovery** | Stop hook continues same session | `/eat-pickle` + re-run, or `tmux kill-session` |
| **Morty workers** | Spawned via `spawn-morty.js` (unchanged) | Spawned via `spawn-morty.js` (unchanged) |

## Assumptions

- `tmux` is installed and available on `PATH` on the user's machine (macOS: `brew install tmux`; Linux: `apt install tmux`)
- The user's shell environment is inherited by `tmux send-keys` (so `claude` CLI is on `PATH`)
- `--add-dir` works in headless `claude -p` mode — confirmed by existing usage in `spawn-morty.js` (line 95) and `jar-runner.js` (line 38)
- `state.iteration` (incremented by the stop hook) is the authoritative iteration counter for limit checks. `tmux-runner.js`'s own `iteration` variable is a display-only counter for logging; it is NOT the same as `state.iteration`
- `pickle.md` at `~/.claude/commands/pickle.md` contains `$ARGUMENTS` as the slash-command substitution slot — replaced by `tmux-runner.js` with `--resume <sessionDir>`. `${EXTENSION_ROOT}` and `${SESSION_ROOT}` in the file body are instructional prose tokens that the agent resolves from context (not string-replaced by the runner)
- **The stop hook fires in headless `claude -p` mode** — this is the critical assumption enabling the `handoff.txt` bridge. If this assumption is violated, `tmux-runner.js` must fall back to calling `buildHandoffSummary()` directly every iteration
- `buildHandoffSummary()` has been extracted to `pickle-utils.js` — T1 is a BLOCKING prerequisite; do not implement T4 until T1 is verified complete
- In tmux mode, the stop hook calls `process.exit(0)` after writing `handoff.txt` and never emits the `block` JSON; the runner drives iteration externally
- `state.json` writes from the stop hook are atomic enough that a 1-second pause between iterations prevents read/write races
- `/eat-pickle` is run from the same working directory used to start the session, or the user edits `state.json` directly
- The user does not need to interact with Rick during tmux mode -- this is a fully autonomous execution mode

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| :---- | :---- | :---- | :---- |
| **tmux not installed** | Medium | Blocks usage | `/pickle-tmux` command checks for tmux before proceeding. Prints clear error: "tmux is not installed. Install with `brew install tmux` (macOS) or `apt install tmux` (Linux), or use `/pickle` for interactive mode." |
| **Completion token appears in partial output** | Low | False-positive exit | Token detection reads the **full log file** after subprocess exit, not during streaming. Since `EPIC_COMPLETED` and `TASK_COMPLETED` only appear in `<promise>` tags that Rick outputs at genuine completion, false positives require Rick to hallucinate the exact token string mid-task. The `<promise>` wrapper makes accidental matches extremely unlikely. |
| **Nested Claude subprocess spawning fails** | Low | Iteration hangs | `delete env.CLAUDECODE` is applied (same fix as `spawn-morty.js`). If spawning still fails, `proc.on('error')` fires, and the runner exits with a logged error rather than hanging. |
| **User wants to interact with the tmux session** | Medium | Confusion | Documentation clearly states this is a read-only autonomous mode. User can `tmux attach` to watch but cannot type input. For interactive use, `/pickle` remains available. The `/pickle-tmux` help output explicitly states this trade-off. |
| **`/eat-pickle` run from wrong directory** | Medium | Cancel fails silently | `/eat-pickle` uses `current_sessions.json` keyed on `process.cwd()`. If run from a different terminal in a different directory, it prints "No active session found" and does nothing. Mitigation: `/pickle-tmux` output must prominently display (1) the exact `cd` command to run before `/eat-pickle`, and (2) the direct `state.json` path for manual `active: false` edit as a fallback. |
| **`buildHandoffSummary()` not yet extracted to `pickle-utils.js`** | Medium | Compilation error in `tmux-runner.js` | `tmux-runner.js` cannot safely import from `extension/hooks/handlers/stop-hook.js` (circular dependency risk, hook-specific context). Prerequisite: verify `buildHandoffSummary()` is exported from `pickle-utils.js` before implementing `tmux-runner.js`. If not extracted, do this first. |
| **Stop hook `block` decision behavior in headless mode** | Medium | Unclear interaction | The stop hook fires but the `block` response has no effect on a `-p` subprocess that has already finished its prompt. The runner handles iteration externally. The stop hook's file write (`handoff.txt`) is the only side effect that matters. Iteration increment in the stop hook still works correctly and provides the safety guard. |
| **State.json read/write race between stop hook and runner** | Low | Stale state read | 1-second sleep between iterations. Stop hook writes are synchronous (`writeFileSync`). Runner reads after subprocess fully exits (i.e., after stop hook has completed). The sequencing is: subprocess exits -> stop hook runs -> stop hook writes state + handoff -> subprocess `close` event fires -> runner reads state. This is inherently sequential. |
| **Very long prompts exceed shell argument limits** | Low | Spawn failure | The combined prompt (pickle.md + handoff) is passed via the `-p` flag directly to `spawn()`, which uses `execve()` not shell interpolation. OS argument limits are typically 256KB+. If this becomes an issue, fall back to writing the prompt to a file and using shell redirection. |

## Business Benefits/Impact/Metrics

**Success Metrics:**

| Metric | Current State (`/pickle`) | Future State (`/pickle-tmux`) | Improvement |
| :---- | :---- | :---- | :---- |
| *Max reliable epic length* | ~8 iterations before drift | 20+ iterations with no drift | 2.5x+ increase in autonomous run length |
| *Context per iteration* | Growing (compressed residue) | Fixed (handoff file only) | Predictable, constant memory footprint |
| *Recovery from drift* | Manual: cancel, restart, lose progress | N/A -- drift eliminated by design | Eliminates the primary failure mode |
| *User intervention required* | Often at iteration 8-10 to course-correct | None until epic completion | Fully autonomous for long epics |
| *Time to complete 12-ticket epic* | ~2 runs (first drifts, second completes) | 1 run | 50% reduction in wall-clock time |

---

## Appendix: File Impact Summary

| File | Change Type | Description |
| :---- | :---- | :---- |
| `extension/bin/setup.js` | **Modify** | Add `--tmux` flag; set `state.tmux_mode = true` when present |
| `extension/hooks/handlers/stop-hook.js` | **Modify** | Write `handoff.txt` before each block decision; exit cleanly (`process.exit(0)`) if `state.tmux_mode === true` |
| `extension/bin/tmux-runner.js` | **New** | Outer loop runner (~150-180 lines). Spawns fresh `claude -p` per iteration, detects tokens, enforces limits |
| `.claude/commands/pickle-tmux.md` | **New** | Slash command: creates session, starts tmux, launches runner |
| `install.sh` | **Modify** | Add chmod for `tmux-runner.js`, copy `pickle-tmux.md` to `~/.claude/commands/` |
| `.claude/commands/help-pickle.md` | **Modify** | Add `/pickle-tmux` to command list with description |
| `README.md` | **Modify** | Add `/pickle-tmux` to Commands table and usage notes |
| `pickle_settings.json` | **Modify** (optional) | Add `default_tmux_max_turns` field |

---

## Appendix: Feature Backlog

Ideas validated as worthwhile but not yet scoped into a full PRD.

### B1. PRD Auto-Refine (`/pickle-refine-prd`) *(High Impact, Low Effort)*

PRDs require 5-10 refinement cycles in practice before they are implementation-ready. Currently this is manual. A `/pickle-refine-prd` command would run an automated reviewer→drafter loop for N cycles, producing a progressively higher-quality PRD without user involvement.

**Architecture:**

```
/pickle-refine-prd [--cycles N]
        │
        ▼
  Load prd.md from cwd
        │
  ┌─────┴─────┐
  │ Reviewer  │  ← Reads PRD, outputs prioritized gap list
  └─────┬─────┘
        │ gap list
        ▼
  ┌─────┴─────┐
  │  Drafter  │  ← Applies gaps, writes revised prd.md
  └─────┬─────┘
        │
  repeat N times
        │
        ▼
  Final prd.md (N cycles applied)
```

**Key design decisions:**
- **Cycle-based, not approval-gated**: run exactly N cycles; quality improves incrementally. No convergence logic, no infinite loop risk.
- **Default `--cycles 7`** (midpoint of the 5-10 practical range). User overrides with `--cycles 3` for quick pass or `--cycles 10` for thorough.
- **Early exit**: reviewer can signal done if it finds zero gaps, but this is an optimization — N cycles is the floor, not a ceiling.
- **Reviewer outputs a gap list per cycle**, not a binary approve/reject. Drafter applies the list in priority order.
- **Composes with existing flow**:
  ```
  /pickle-prd "task"       → draft
  /pickle-refine-prd       → refine N cycles
  /pickle                  → execute
  ```
  Or eventually: `/pickle` detects `prd.md`, auto-refines before breakdown.

**Reviewer rubric (per cycle):**
- All required sections present (Introduction, Problem Statement, CUJs, Functional Requirements, Implementation Notes, Risks, Metrics)
- Every CUJ is step-by-step (not summary prose)
- Every functional requirement has a priority (P0/P1/P2) and a user story
- Implementation notes reference specific file paths (no generic "update the logic")
- Every risk has a concrete mitigation
- No vague language — flag any instance of "handle", "update", "improve", "refactor" without specifics
- Assumptions are explicit, not implicit

**New work required:**
1. `.claude/commands/pickle-refine-prd.md` — spawns reviewer + drafter agents in a cycle loop
2. Reviewer agent prompt with the rubric above
3. Drafter agent prompt that reads the gap list and applies changes to `prd.md`
4. No new scripts needed — pure slash command orchestration using the Task agent team pattern

**Consideration**: The reviewer and drafter can be spawned as an agent team (Explore + general-purpose) using the existing `TeamCreate`/`Task` pattern. No new extension scripts required — this is entirely prompt-level orchestration.
