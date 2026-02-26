# PRD: `/meeseeks` — Autonomous Code Review Loop Command

## Summary

Add a `/meeseeks` slash command to the Pickle Rick extension that runs an autonomous code review loop in tmux mode. Each pass scans the user's codebase, identifies issues, fixes them, runs tests, and commits. The loop enforces a minimum of 10 passes before accepting a "clean" exit signal. Exit token: `EXISTENCE_IS_PAIN`.

> "I'm Mr. Meeseeks, look at me! I'll review your code until EXISTENCE IS PAIN!"

## Acceptance Criteria

1. User runs `/meeseeks <optional-description>` and a tmux session launches with fresh Claude per review pass
2. Each review pass: scan codebase → identify issues → fix → run tests → commit (if fixes made)
3. Minimum 10 passes before `EXISTENCE_IS_PAIN` exit token is accepted
4. Maximum 50 passes (configurable)
5. `EXISTENCE_IS_PAIN` token recognized by stop-hook and tmux-runner
6. `min_iterations` field in state.json gates early exit
7. `command_template` field in state.json tells tmux-runner which .md file to load per iteration (instead of hardcoded `pickle.md`)
8. All existing `/pickle` and `/pickle-tmux` sessions unaffected (backward-compatible)
9. All tests pass (current 308 + new tests)
10. Build succeeds: `npx tsc --noEmit && npx tsc`

## Architecture Notes (Context for Each Task)

### Key Files

| File | Role |
|------|------|
| `extension/src/types/index.ts` | State interface, PromiseTokens, VALID_STEPS, hasToken() |
| `extension/src/bin/setup.ts` | Session initializer — creates state.json, parses CLI flags |
| `extension/src/bin/update-state.ts` | CLI tool to update state.json fields |
| `extension/src/bin/tmux-runner.ts` | Context-clearing loop — spawns fresh `claude -p` per iteration |
| `extension/src/hooks/handlers/stop-hook.ts` | Gatekeeper — checks tokens, enforces limits, blocks/approves exit |
| `extension/src/services/pickle-utils.ts` | Shared utilities — printMinimalPanel, buildHandoffSummary |
| `pickle_settings.json` | Default limits and settings |
| `.claude/commands/*.md` | Slash command prompt templates |

### Critical Patterns (MUST follow)

- **Source of truth**: TypeScript in `extension/src/` — JS files are build artifacts, never edit directly
- **CLI guards**: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js')` (exact match, never startsWith)
- **Error handling**: `err instanceof Error ? err.message : String(err)` (never cast blindly)
- **Hook decisions**: Only `"approve"` or `"block"` (never `"allow"`)
- **Numeric coercion**: Use `Number.isFinite()` guards (not `|| 0` which fails for Infinity)
- **Atomic writes**: `.tmp.${process.pid}` + rename pattern
- **Build**: `cd extension && npx tsc --noEmit && npx tsc && npm test`

---

## Tasks

### - [ ] Task 1: Add EXISTENCE_IS_PAIN token, new State fields, and review step to types

**Context**: `extension/src/types/index.ts` is the foundation — all other tasks depend on these type changes. The file contains the `State` interface (lines 1-17), `VALID_STEPS` (line 27), and `PromiseTokens` (lines 34-41).

**Changes**:

1. Add to `State` interface (after `tmux_mode?: boolean` on line 16):
```typescript
  min_iterations?: number;
  command_template?: string;
```

2. Add `'review'` to `VALID_STEPS` (line 27):
```typescript
export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review'] as const;
```

3. Add `EXISTENCE_IS_PAIN` to `PromiseTokens` (after line 40):
```typescript
  EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
```

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 2: Add meeseeks settings to pickle_settings.json

**Context**: `pickle_settings.json` (project root) contains default numeric settings read by `setup.ts`. Currently has 7 fields. All values are numbers.

**Changes**: Add two new settings at the end:
```json
  "default_meeseeks_min_passes": 10,
  "default_meeseeks_max_passes": 50
```

**Verification**: File is valid JSON.

---

### - [ ] Task 3: Add min_iterations and command_template to update-state allowed keys

**Context**: `extension/src/bin/update-state.ts` validates state.json key updates. It has `NUMERIC_KEYS` (Set of field names coerced to Number), `BOOLEAN_KEYS`, and `ALLOWED_KEYS` (union of all valid keys). The `step` key is validated against `VALID_STEPS` from types (so adding `'review'` in Task 1 automatically makes it valid here).

**Changes**:

1. Add `'min_iterations'` to the `NUMERIC_KEYS` Set
2. Add `'command_template'` to the `ALLOWED_KEYS` Set (it's a string key, not numeric)

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 4: Add --min-iterations and --command-template flags to setup.ts

**Context**: `extension/src/bin/setup.ts` initializes sessions. It parses CLI flags in a for-loop (lines 84-127), creates the State object (lines 199-217), and handles resume mode (lines 133-187). Settings are loaded from `pickle_settings.json` at lines 68-81.

**Changes**:

1. **New variables** (near line 61, after `tmuxMode`):
```typescript
let minIterations = 0;
let commandTemplate: string | undefined = undefined;
```

2. **Settings loading** (inside the try block at lines 69-80): Read meeseeks settings:
```typescript
if (typeof settings.default_meeseeks_min_passes === 'number' && settings.default_meeseeks_min_passes > 0)
  /* store in a local but don't override minIterations — the command passes these explicitly */;
if (typeof settings.default_meeseeks_max_passes === 'number' && settings.default_meeseeks_max_passes > 0)
  /* same */;
```
Actually, settings are consumed by meeseeks.md which reads the JSON and passes flags. Setup just accepts the flags.

3. **Arg parser** (add before the `else { taskArgs.push(arg); }` fallback at line 124):
```typescript
} else if (arg === '--min-iterations') {
  const v = parseInt(args[++i], 10);
  if (isNaN(v) || v < 0) die('--min-iterations requires a non-negative integer');
  minIterations = v;
  explicitFlags.add('min-iterations');
} else if (arg === '--command-template') {
  const v = args[++i];
  if (!v || v.startsWith('--')) die('--command-template requires a non-empty value');
  if (v.includes('/') || v.includes('\\') || v.includes('..')) die('--command-template must be a plain filename');
  commandTemplate = v;
  explicitFlags.add('command-template');
```

4. **State object** (lines 199-217): Add new fields after `tmux_mode`:
```typescript
  min_iterations: minIterations,
  command_template: commandTemplate,
```

5. **Resume mode** (after line 167): Preserve from state unless explicit:
```typescript
if (explicitFlags.has('min-iterations')) state.min_iterations = minIterations;
if (explicitFlags.has('command-template')) state.command_template = commandTemplate;
```
And sync display vars:
```typescript
const rawMinIter = Number(state.min_iterations);
minIterations = Number.isFinite(rawMinIter) ? rawMinIter : 0;
commandTemplate = state.command_template;
```

6. **Panel output** (line 224-237): Add 'Min Passes' and 'Template' when set:
```typescript
...(minIterations > 0 ? { 'Min Passes': minIterations } : {}),
...(commandTemplate ? { Template: commandTemplate } : {}),
```

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 5: Add EXISTENCE_IS_PAIN recognition and min_iterations gate to stop-hook

**Context**: `extension/src/hooks/handlers/stop-hook.ts` is the loop gatekeeper. It reads stdin JSON, checks state.json, and outputs `{"decision": "approve"}` or `{"decision": "block", "reason": "..."}`. Completion tokens are checked at lines 102-128 — when found, the hook sets `active: false` and approves. In tmux mode, subprocess processes get `PICKLE_STATE_FILE` env var so the hook knows they're not the main window.

**Changes**:

1. **Add token detection** (after line 109):
```typescript
const isExistenceIsPain = hasToken(responseText, PromiseTokens.EXISTENCE_IS_PAIN);
```

2. **Add to log line** (line 117): Include `isExistenceIsPain` in the Promises log.

3. **Modify exit condition** (line 121):
```typescript
if (hasPromise || isEpicDone || isTaskFinished || isWorkerDone || isAnalysisDone || isExistenceIsPain) {
```

4. **Add min_iterations gate** inside the exit block (before the `if (!isWorker && !isRefinementWorker)` on line 123):
```typescript
  // min_iterations gate: only applies to EXISTENCE_IS_PAIN token
  if (isExistenceIsPain) {
    const rawMinIter = Number(state.min_iterations);
    const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
    // Reuse curIter from limit section? No — it's computed later. Compute here:
    const rawCurIter2 = Number(state.iteration);
    const curIter2 = Number.isFinite(rawCurIter2) ? rawCurIter2 : 0;
    if (minIter > 0 && curIter2 < minIter) {
      log(`Decision: APPROVE (EXISTENCE_IS_PAIN at ${curIter2}/${minIter} — below min, runner continues)`);
      approve();
      return;
    }
  }
```
This approves exit (so the subprocess terminates) but does NOT set `active: false`, so tmux-runner continues spawning passes.

**CRITICAL**: The min_iterations gate ONLY applies to `isExistenceIsPain`. Other tokens (EPIC_COMPLETED, TASK_COMPLETED, etc.) always deactivate — this prevents regression for existing `/pickle` sessions.

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 6: Add dynamic template loading and min_iterations to tmux-runner

**Context**: `extension/src/bin/tmux-runner.ts` is the context-clearing loop manager. `runIteration()` (lines 10-126) loads `.claude/commands/pickle.md` (hardcoded on line 22), replaces `$ARGUMENTS` with `--resume <session>`, and spawns `claude -p`. It checks for EPIC_COMPLETED/TASK_COMPLETED in the log (lines 95-96) to determine if the epic is done. The main loop (lines 168-231) calls `runIteration()` and breaks on `'completed'` (line 226).

**Changes**:

1. **Dynamic template** (line 22): Replace hardcoded path:
```typescript
// BEFORE:
const picklePromptPath = path.join(os.homedir(), '.claude/commands/pickle.md');
// AFTER:
const templateName = state.command_template || 'pickle.md';
const picklePromptPath = path.join(os.homedir(), '.claude/commands', templateName);
```
Backward-compatible: `command_template` is undefined for existing sessions → falls back to `pickle.md`.

2. **Error message** (line 24): Update to include template name:
```typescript
throw new Error(`${templateName} not found at ${picklePromptPath}. Run install.sh first.`);
```

3. **Completion check** (lines 95-96): Add EXISTENCE_IS_PAIN:
```typescript
if (hasToken(output, PromiseTokens.EPIC_COMPLETED) ||
    hasToken(output, PromiseTokens.TASK_COMPLETED) ||
    hasToken(output, PromiseTokens.EXISTENCE_IS_PAIN)) {
  resolve('completed');
}
```

4. **Main loop min_iterations gate** (line 226): Replace single-line break with min_iterations check:
```typescript
if (result === 'completed') {
  const curState: PickleState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const rawMinIter = Number(curState.min_iterations);
  const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
  const rawCurIter = Number(curState.iteration);
  const curIterNow = Number.isFinite(rawCurIter) ? rawCurIter : 0;
  if (minIter > 0 && curIterNow < minIter) {
    log(`Clean pass at iteration ${curIterNow}, but min_iterations=${minIter}. Continuing.`);
  } else {
    log('Completed. Exiting loop.');
    break;
  }
} else if (result === 'inactive') { log('Session deactivated. Exiting loop.'); break; }
  else if (result === 'error') { log('Subprocess error. Exiting loop.'); break; }
```

5. **Completion panel** (line 243-248): Include min_iterations if set:
```typescript
...(finalMinIter > 0 ? { 'Min Passes': finalMinIter } : {}),
```

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 7: Update buildHandoffSummary in pickle-utils for meeseeks context

**Context**: `extension/src/services/pickle-utils.ts` contains `buildHandoffSummary(state, sessionDir)` which generates context text appended to each iteration's prompt by tmux-runner. It shows iteration count, task description, ticket status, and "NEXT ACTION" instructions.

**Changes**:

1. Add `Min Passes` line when `state.min_iterations` is set (after the iteration line):
```typescript
const rawMinIter = Number(state.min_iterations);
const minIter = Number.isFinite(rawMinIter) ? rawMinIter : 0;
if (minIter > 0) {
  lines.push(`Min Passes: ${minIter}`);
}
if (state.command_template) {
  lines.push(`Template: ${state.command_template}`);
}
```

2. Change "Do NOT restart from PRD" to "Do NOT restart from scratch" — backward-compatible and correct for both modes.

**Verification**: `cd extension && npx tsc --noEmit` passes.

---

### - [ ] Task 8: Create the meeseeks.md slash command file

**Context**: `.claude/commands/meeseeks.md` is a dual-purpose file: (1) the slash command invoked by the user that sets up the tmux session, and (2) the per-iteration prompt template loaded by tmux-runner via `state.command_template = 'meeseeks.md'`. The file detects mode via `$ARGUMENTS` containing `--resume` or not. Follow the pattern of `pickle-tmux.md` for setup mode.

**The file should contain**:

**SETUP MODE** (no `--resume` in `$ARGUMENTS`):
1. Check tmux: `tmux -V`
2. Read `$HOME/.claude/pickle-rick/pickle_settings.json` for `default_meeseeks_min_passes` (default 10) and `default_meeseeks_max_passes` (default 50)
3. Extract any `--min-iterations <N>` or `--max-iterations <N>` flags from `$ARGUMENTS`
4. Run: `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --min-iterations <MIN> --max-iterations <MAX> --command-template meeseeks.md --task "Mr. Meeseeks Code Review: <task-text>"`
5. Parse `SESSION_ROOT=` from output
6. Create tmux session: `tmux new-session -d -s meeseeks-<hash> -c <working_dir>`
7. Launch tmux-runner in pane 0 (with farewell message: "Mr. Meeseeks has ceased to exist")
8. Create monitor window with 3 panes (monitor, log-watcher, morty-watcher) — same layout as pickle-tmux.md Step 5
9. Print attach instructions and exit with `<promise>TASK_COMPLETED</promise>`

**REVIEW PASS MODE** (`--resume <path>` in `$ARGUMENTS`):
1. Read `<SESSION_ROOT>/state.json`
2. Increment iteration via `update-state.js`
3. Update step to `review` via `update-state.js`
4. Determine focus area based on pass number:
   - 1-3: Critical bugs, security, crashes, error handling
   - 4-5: Logic errors, edge cases, null handling, validation
   - 6-7: Dead code, duplication, simplification, unused imports
   - 8-9: Consistency, naming, patterns, API style
   - 10+: Polish, minor improvements, documentation
5. Scan the codebase systematically
6. If issues found: fix them, run tests, commit: `git add -A && git commit -m "meeseeks pass N: <summary>"`
7. If NO issues found: output `<promise>EXISTENCE_IS_PAIN</promise>`

**Mr. Meeseeks persona**: Narrate everything. "Look at me! I'm Mr. Meeseeks!" each pass. "CAN DO!" when fixing. "EXISTENCE IS PAIN!" when clean.

**Verification**: Run `/meeseeks review this codebase` from a test project.

---

### - [ ] Task 9: Add tests for all new functionality

**Context**: Tests live in `extension/tests/*.test.js`, run via `node --test`. Tests use subprocess execution (spawnSync/execFileSync), isolated temp dirs, and cleanup in `finally` blocks. The test command in `package.json` lists test files explicitly — new files must be added to the list.

**Tests to add**:

**In `extension/tests/stop-hook.test.js`** (4 new tests):
1. `EXISTENCE_IS_PAIN → approve + active=false` (standard completion)
2. `EXISTENCE_IS_PAIN below min_iterations → approve, active stays true` (gate works)
3. `EXISTENCE_IS_PAIN at min_iterations → approve + active=false` (gate passes)
4. `EPIC_COMPLETED ignores min_iterations → still deactivates` (no regression)

**In `extension/tests/promise-tokens.test.js`** (1 update):
- Add `'EXISTENCE_IS_PAIN'` to the expected keys list

**In `extension/tests/setup.test.js`** (3 new tests):
1. `--min-iterations 10` sets `min_iterations: 10` in state.json
2. `--command-template meeseeks.md` sets field; `../evil.md` is rejected
3. Without flags, `min_iterations` is `0` and `command_template` is `undefined`

**In `extension/tests/update-state.test.js`** (3 new tests):
1. `min_iterations` accepted as numeric key
2. `command_template` accepted as string key
3. `step: 'review'` is valid

**Update `extension/package.json`**: No new test files needed — tests go into existing files.

**Verification**: `cd extension && npm test` — all tests pass.

---

### - [ ] Task 10: Update documentation (CLAUDE.md, README.md)

**Context**: `CLAUDE.md` (project root) documents commands and architecture. `README.md` has user-facing docs.

**CLAUDE.md changes**:
- Add `/meeseeks` to Commands section: `**\`/meeseeks [task]\`**: Autonomous code review loop — tmux only, minimum 10 passes, commits per pass, exits when clean`
- Add `meeseeks.md` to Architecture section: `**\`meeseeks.md\`** — Dual-purpose: slash command setup + per-iteration review template`

**README.md changes**:
- Add `/meeseeks` documentation with usage examples

**Verification**: Read the docs to confirm accuracy.

---

### - [ ] Task 11: Build, compile, and run full test suite

**Context**: TypeScript sources in `extension/src/` compile to JS artifacts. All commands run from `extension/` directory.

**Steps**:
```bash
cd extension
npx tsc --noEmit   # Type-check — catches type errors
npx tsc            # Compile TS → JS
npm test           # Run all tests — must all pass
```

If any step fails, fix the issue and re-run.

**Verification**: Zero errors in type-check, zero compilation errors, all tests pass.
