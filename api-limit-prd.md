# API Limit Detection & Auto-Wait PRD
| API Limit Detection & Auto-Wait | | Intelligent handling of Claude API rate limits, 5-hour usage caps, and extra-usage scenarios in tmux-runner |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: 2026-03-01 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction
- [x] Problem Statement
- [x] Objective & Scope
- [x] User Journeys
- [x] Technical Design
- [x] Implementation Details
- [x] Acceptance Criteria
- [x] Assumptions *(refined: risk-scope)*
- [x] Risks & Mitigations
- [x] NOT in Scope

## Introduction

Pickle Rick's tmux-runner spawns `claude -p` subprocesses in a loop. When the Claude API hits a rate limit (hourly) or the 5-hour usage cap, the subprocess exits with an error. The tmux-runner currently treats this identically to any other error — the circuit breaker sees "no progress + error" and eventually trips to OPEN, permanently halting the session. This is the wrong response: the correct behavior is to wait for the limit to reset, then resume automatically.

Inspired by [frankbria/ralph-claude-code](https://github.com/frankbria/ralph-claude-code)'s three-layer API limit detection and auto-wait system, adapted for Pickle Rick's TypeScript/tmux architecture.

## Problem Statement

**Current State**: tmux-runner has no awareness of API limits. All subprocess failures are classified as generic errors.

**Failure Modes**:
1. **Hourly rate limit**: Claude CLI returns a rate limit signal in its output. tmux-runner sees it as an error, circuit breaker increments `consecutive_same_error`, eventually trips.
2. **5-hour usage cap**: Claude enforces a rolling 5-hour usage window. When exhausted, the subprocess exits with a rate limit signal. Same misclassification as above.
3. **Extra usage prompts**: On some plans, Claude prompts for "extra usage" confirmation. In `claude -p` (non-interactive) mode, this causes an exit. tmux-runner has no way to handle this.
4. **CB poisoning**: `extractErrorSignature()` at `circuit-breaker.ts:261-262` checks `parsed.subtype.startsWith('error')` — if the CLI emits a `result` event with `subtype: "error_rate_limit"`, the circuit breaker extracts it as an error signature. After 5 identical rate-limit errors, the CB trips to OPEN — permanently halting a session that a 60-minute wait would fix. *(refined: codebase, risk-scope)*

**Impact**: Long-running epics (8+ hours) frequently hit the 5-hour cap. The circuit breaker trips after 5 iterations of identical rate-limit errors, permanently stopping the session. The user returns to find a dead session that was 80% complete, with no indication that a simple wait would have fixed it.

## Objective & Scope

**Objective**: Detect API rate limits distinctly from other errors, auto-wait with countdown when limits are hit, and resume automatically — enabling truly unattended multi-hour sessions.

**Ideal Outcome**: A 12-hour tmux session that hits the 5-hour cap at hour 5, waits 60 minutes, resumes, and completes without human intervention. The monitor shows the wait state in real time.

**In Scope**:
- Two-layer rate limit detection in tmux-runner (NDJSON structural + text regex fallback) *(refined: requirements, codebase — Layer 1/exit code guard removed, see NOT in Scope)*
- Auto-wait with configurable duration and countdown
- Monitor display of wait state
- Circuit breaker exclusion (rate limit waits don't count as errors)
- Configurable settings in `pickle_settings.json`
- Exit code capture from subprocess (for debugging/future use) *(refined: codebase)*

**Out of Scope**:
- Proactive hourly call counting / throttling (we don't control API billing)
- Interactive mode (`/pickle`) rate limit handling (stop-hook architecture is different)
- Extra-usage auto-acceptance (requires Claude CLI changes, not our layer)
- Billing alerts or cost tracking

## User Journeys

### CUJ 1: 5-Hour Cap Hit During Epic
1. User launches `/pickle-tmux --run my-prd.md` and walks away
2. 5 hours in, Claude API returns rate limit
3. tmux-runner detects rate limit via NDJSON event or text pattern in iteration log *(refined: requirements — detection mechanism made generic across layers)*
4. tmux-runner logs: `"API rate limit detected. Waiting 60 minutes for reset..."`
5. Monitor shows: `Circuit: CLOSED  |  Status: ⏳ Rate limited (52m 30s remaining)` *(refined: codebase — `formatTime()` returns `Xm Ys` not `MM:SS`)*
6. After 60 minutes, tmux-runner resumes the loop
7. Session continues to completion

### CUJ 2: Repeated Rate Limits (Degraded API)
1. Session hits rate limit, waits 60 minutes, resumes
2. Immediately hits rate limit again on the next iteration
3. tmux-runner detects consecutive rate-limit waits (`consecutiveRateLimits` local counter) *(refined: risk-scope — distinguished from `consecutive_waits` in JSON)*
4. After 3 consecutive rate-limit iterations with no **progress-making** (`'success'`) iteration between them, tmux-runner gives up *(refined: requirements — reset semantics defined)*
5. Session exits with reason `rate_limit_exhausted`
6. Notification: "Pickle Run Failed — rate limit not resetting after 3 retries" *(refined: requirements, risk-scope — "Paused" contradicted `isFailure=true`)*

**Counter reset rule**: `consecutiveRateLimits` resets to 0 ONLY when `classifyIterationExit()` returns `'success'`. Iterations classified as `'error'` or `'inactive'` do NOT reset the counter — they may be symptoms of the same underlying rate limit. *(refined: requirements)*

### ~~CUJ 3: Timeout (Not a Rate Limit)~~ — REMOVED *(refined: all three analysts)*
> Removed from v1. `portable_timeout` does not exist in tmux-runner — `tmux-runner.ts:132` spawns `claude` directly with no timeout wrapper. The `spawn-morty.ts:203-211` `setTimeout`+SIGTERM pattern exists but is NOT used by tmux-runner. Per-iteration timeout is a separate enhancement. See NOT in Scope.

### CUJ 4: Rate Limit During Meeseeks Review
1. Session is in Meeseeks review mode (`chain_meeseeks` transition completed)
2. Rate limit hits during review pass 6 of 10
3. Same detection + wait behavior applies
4. After wait, Meeseeks review continues from where it left off

### CUJ 5: Rate Limit on First Iteration *(refined: requirements)*
1. User launches `/pickle-tmux --run my-prd.md`
2. Very first iteration hits rate limit (API already exhausted from prior usage)
3. tmux-runner detects rate limit, waits 60 minutes
4. First successful iteration numbered `iteration=2` in logs (`tmux_iteration_2.log`). `tmux_iteration_1.log` contains rate-limited output.
5. Handoff says: `"Resumed after 60-minute API rate limit wait."`
6. Session has made zero prior progress — this is expected and handled correctly

## Pre-Implementation Verification (BLOCKING) *(refined: risk-scope)*

Before writing detection code:

1. Trigger a rate limit against the Claude API (use rapid requests or a low-tier key)
2. Capture output: `claude -p "hello" --output-format stream-json --verbose 2>&1 | tee capture.log`
3. Document exact event types and field names for rate-limit responses
4. If `rate_limit_event` appears with `"status": "rejected"`: Layer 2 patterns match actual fields — proceed
5. If `rate_limit_event` does NOT appear in `-p` mode:
   - Promote Layer 3 (text regex) to PRIMARY detection
   - Layer 2 becomes stub with warning log: `log('Layer 2 detected rate_limit_event — first verified occurrence')`
   - Add 2-3 additional Layer 3 patterns based on actual error text observed
   - Update test fixtures to use actual captured output

**If a rate limit CANNOT be triggered on demand**: Proceed with Layer 3 as primary. Layer 2 code is still written but guarded.

## Technical Design

### Detection: Two-Layer Classification *(refined: all analysts — Layer 1 removed)*

After each `runIteration()` call, classify the result with a new function `classifyIterationExit()`:

```typescript
type IterationExitType = 'success' | 'error' | 'api_limit' | 'inactive';
```
*(refined: requirements, codebase, risk-scope — `'timeout'` removed, no producer exists in v1)*

**`classifyIterationExit()` input contract** *(refined: codebase)*:
- `completionResult === 'inactive'` → return `'inactive'` (pass-through, no log inspection)
- `completionResult === 'error'` → return `'error'` (pass-through — spawn failure, log may be empty/truncated)
- `completionResult === 'task_completed' || 'review_clean'` → return `'success'`
- `completionResult === 'continue'` → run Layer 2 then Layer 3 (only this case inspects the log file)

```typescript
function classifyIterationExit(
  completionResult: string,  // from runIteration()
  logFile: string,
): IterationExitType {
  if (completionResult === 'inactive') return 'inactive';
  if (completionResult === 'error') return 'error';
  if (completionResult === 'task_completed' || completionResult === 'review_clean') return 'success';

  // Only 'continue' needs log-based classification
  if (detectRateLimitInLog(logFile)) return 'api_limit';   // Layer 2
  if (detectRateLimitInText(logFile)) return 'api_limit';   // Layer 3

  return 'success';  // Normal continuation — CB will track progress
}
```
*(refined: codebase — complete spec with pass-through semantics)*

**Layer 2 — Structural NDJSON detection** (unverified — see Pre-Implementation Verification): Parse the iteration log for `rate_limit_event` JSON objects. If the last `rate_limit_event` has `"status": "rejected"`, classify as `'api_limit'`. *(refined: risk-scope — marked as unverified)*

```typescript
function detectRateLimitInLog(logFile: string): boolean {
  // Scan NDJSON lines for rate_limit_event with status:"rejected"
  // Only check last 100 lines (rate limits appear near end of output)
}
```

**Layer 3 — Text fallback** (may be primary if Layer 2 unverified): Read the last 100 lines of the iteration log file (or the entire file if < 100 lines). Exclude any line containing `"type":"user"` or `"type":"tool_result"` (prevents false positives from echoed file content). Apply case-insensitive regex patterns against remaining lines: *(refined: requirements — defined "tail" as 100 lines with explicit filtering)*
- `/5.*hour.*limit/i`
- `/limit.*reached.*try.*back/i`
- `/usage.*limit.*reached/i`
- `/rate limit/i`

If any pattern matches, return `true`.

### Auto-Wait Logic

When `classifyIterationExit()` returns `'api_limit'`:

1. **Don't count toward circuit breaker** — rate limits are not bugs, they're infrastructure constraints
2. **Increment `consecutiveRateLimits`** (local `let` variable alongside `stallCount` at `tmux-runner.ts:212`) *(refined: risk-scope — storage location specified)*
3. **Check exhaustion cap**: if `consecutiveRateLimits >= max_rate_limit_retries` (default 3), set `exitReason = 'rate_limit_exhausted'`, `state.active = false`, break *(refined: requirements — check before wait, not after)*
4. **Log the event**: `logActivity({ event: 'rate_limit_wait', source: 'pickle', session: path.basename(sessionDir), duration_min: waitMinutes })` *(refined: requirements — metadata shape specified)*
5. **Write wait state** to `rate_limit_wait.json` in the session directory using `writeStateFile` (atomic writes via `.tmp` + `renameSync`, same as `circuit_breaker.json`):
   ```json
   {
     "waiting": true,
     "reason": "API rate limit",
     "started_at": "2026-03-01T19:30:00.000Z",
     "wait_until": "2026-03-01T20:30:00.000Z",
     "consecutive_waits": 1
   }
   ```
6. **Pre-wait time check**: Before entering the sleep loop, check if the session time limit would be exceeded *(refined: requirements, risk-scope)*:
   ```typescript
   const maxTimeSec = maxTimeMins * 60;
   const elapsed = Math.floor(Date.now() / 1000) - epoch;
   const remaining = maxTimeSec > 0 ? maxTimeSec - elapsed : Infinity;
   if (remaining <= 0) {
     exitReason = 'limit';
     state.active = false;
     writeStateFile(statePath, state);
     break;
   }
   const actualWaitMs = Math.min(waitMinutes * 60 * 1000, remaining * 1000);
   ```
7. **Sleep in a cancellable loop** with 10-second intervals using `sleep()` from `pickle-utils.ts:342-344` (already exported, already imported by `monitor.ts:4`) *(refined: codebase — reuse existing utility)*. Each cycle checks:
   - `state.active` via re-reading `state.json` — if `false` (`/eat-pickle`), set `exitReason = 'cancelled'`, break
   - Elapsed time vs `max_time_minutes` — if exceeded, set `exitReason = 'limit'`, break *(refined: requirements, risk-scope — prevents 60-min overage)*
   - **`state.active` remains `true` during normal rate-limit waits** — only `/eat-pickle` sets it to `false`. If it were set to `false` during wait, the monitor at `monitor.ts:168` would exit. *(refined: codebase)*
8. **On wake** (wait completed without cancellation):
   - Delete `rate_limit_wait.json`
   - Log: `logActivity({ event: 'rate_limit_resume', source: 'pickle', session: path.basename(sessionDir) })` *(refined: requirements — metadata shape specified)*
   - Write `handoff.txt` for next iteration (see Integration Points)
   - `continue` the main while loop — time/iteration checks at top of loop execute before next `runIteration()`
9. **On `'success'` iteration**: reset `consecutiveRateLimits = 0`. Other results (`'error'`, `'inactive'`) do NOT reset the counter. *(refined: requirements — explicit reset semantics)*

### Monitor Integration

In `monitor.ts` `render()`, after reading `circuit_breaker.json`, also try reading `rate_limit_wait.json`:

- If `waiting: true`: compute countdown from `wait_until`, display using `formatTime()` *(refined: codebase — uses existing function)*:
  ```
  Status: ⏳ Rate limited (52m 30s remaining)
  ```
  Color: `Style.YELLOW` — this is a pause, not an error
- If missing or `waiting: false`: omit the field
- Monitor refresh (2s) is independent of wait polling (10s) — countdown updates smoothly *(refined: codebase)*

### Settings

New keys in `pickle_settings.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `default_rate_limit_wait_minutes` | 60 | How long to wait when rate limit detected |
| `default_max_rate_limit_retries` | 3 | Consecutive rate-limit waits before giving up |

**Validation floors** (following `circuit-breaker.ts:134-140` pattern): `wait_minutes >= 1` (0 creates infinite tight-loop), `max_retries >= 1` (0 causes immediate exhaustion on first rate limit). *(refined: risk-scope)*

**Settings loading**: Read inline in `tmux-runner.ts` main(), following existing pattern at lines 90-99 where `default_tmux_max_turns` is read with type guards. Do NOT add to `loadSettings()` in `circuit-breaker.ts` (that returns `CircuitBreakerConfig` — conflating CB with rate-limit settings). *(refined: codebase)*

### State & Types

New event types in `VALID_ACTIVITY_EVENTS`:
- `'rate_limit_wait'` — rate limit detected, entering wait
- `'rate_limit_resume'` — wait complete, resuming
- `'rate_limit_exhausted'` — gave up after max retries

**Event metadata shapes** *(refined: requirements)*:
- `rate_limit_wait`: `{ event, source: 'pickle', session, duration_min: <configured_wait_minutes> }`
- `rate_limit_resume`: `{ event, source: 'pickle', session }`
- `rate_limit_exhausted`: `{ event, source: 'pickle', session, error: 'max retries (N) exceeded' }`

New exit reason in tmux-runner:
```typescript
let exitReason: 'success' | 'cancelled' | 'error' | 'limit' | 'stall' | 'circuit_open' | 'rate_limit_exhausted' = 'error';
```

`buildTmuxNotification` at `tmux-runner.ts:436`:
```typescript
// Before:
const isFailure = exitReason === 'error' || exitReason === 'stall' || exitReason === 'circuit_open';
// After:
const isFailure = exitReason === 'error' || exitReason === 'stall' || exitReason === 'circuit_open' || exitReason === 'rate_limit_exhausted';
```
*(refined: codebase — exact line change specified)*

### Integration Points

**Circuit breaker interaction — CRITICAL ORDERING** *(refined: all three analysts — P0 consensus)*:

In the main loop at `tmux-runner.ts`, after `runIteration()` returns `result` (line 286), the FIRST operation MUST be rate-limit classification. The ENTIRE circuit breaker block (lines 289-338) — including `detectProgress()`, `extractErrorSignature()`, and `recordIterationResult()` — is SKIPPED when classification returns `'api_limit'`. This prevents `extractErrorSignature()` at `circuit-breaker.ts:261-262` (which checks `parsed.subtype.startsWith('error')`) from extracting rate-limit subtypes as CB error signatures.

```typescript
const result = await runIteration(sessionDir, iteration, extensionRoot);

// === Rate limit classification — MUST run before CB ===
const iterLogFile = path.join(sessionDir, `tmux_iteration_${iteration}.log`);
const exitType = classifyIterationExit(result, iterLogFile);

if (exitType === 'api_limit') {
  consecutiveRateLimits++;
  log(`API rate limit detected (consecutive: ${consecutiveRateLimits}/${maxRateLimitRetries})`);
  if (consecutiveRateLimits >= maxRateLimitRetries) {
    exitReason = 'rate_limit_exhausted';
    logActivity({ event: 'rate_limit_exhausted', source: 'pickle',
      session: path.basename(sessionDir), error: `max retries (${maxRateLimitRetries}) exceeded` });
    state.active = false;
    writeStateFile(statePath, state);
    break;
  }
  logActivity({ event: 'rate_limit_wait', source: 'pickle',
    session: path.basename(sessionDir), duration_min: waitMinutes });
  writeStateFile(path.join(sessionDir, 'rate_limit_wait.json'), {
    waiting: true, reason: 'API rate limit',
    started_at: new Date().toISOString(),
    wait_until: new Date(Date.now() + waitMinutes * 60 * 1000).toISOString(),
    consecutive_waits: consecutiveRateLimits,
  });
  // Cancellable + time-limit-aware sleep loop (see Auto-Wait Logic §6-7)
  const waitEnd = Date.now() + actualWaitMs;
  while (Date.now() < waitEnd) {
    await sleep(10_000);
    try {
      const ws = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (ws.active !== true) { exitReason = 'cancelled'; break; }
    } catch { /* proceed */ }
    // Time limit check
    const rawEpoch = Number(state.start_time_epoch);
    const epoch = Number.isFinite(rawEpoch) ? rawEpoch : 0;
    const rawMax = Number(state.max_time_minutes);
    const maxMins = Number.isFinite(rawMax) ? rawMax : 0;
    if (maxMins > 0 && epoch > 0) {
      const elapsed = Math.floor(Date.now() / 1000) - epoch;
      if (elapsed >= maxMins * 60) { exitReason = 'limit'; break; }
    }
  }
  if (exitReason === 'cancelled' || exitReason === 'limit') {
    state.active = false;
    writeStateFile(statePath, state);
    break;
  }
  try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* ok */ }
  logActivity({ event: 'rate_limit_resume', source: 'pickle',
    session: path.basename(sessionDir) });
  // Write handoff.txt for next iteration
  fs.writeFileSync(path.join(sessionDir, 'handoff.txt'), [
    buildHandoffSummary(state, sessionDir, iteration + 1), '',
    `NOTE: Resumed after ${waitMinutes}-minute API rate limit wait.`,
    'Resume from current phase — do not repeat the rate-limited iteration.',
  ].join('\n'));
  continue;  // Skip CB recording + result branching entirely
}
consecutiveRateLimits = 0;  // Reset on any 'success' iteration (only reached for non-api_limit)

// === Existing CB recording (line 289+) only reached for non-rate-limit ===
if (cbEnabled && cbState && result !== 'error' && result !== 'inactive') {
  // ... existing CB logic unchanged ...
}
```

**Why this ordering is load-bearing**: `extractErrorSignature()` at `circuit-breaker.ts:261-262` checks `parsed.subtype.startsWith('error')`. A rate-limit `result` event with `subtype: "error_rate_limit"` will be extracted as a CB error signature. After 5 identical signatures (`default_cb_same_error_threshold`), the CB trips to OPEN — defeating the entire feature.

**Cancel during wait**: The wait loop checks `state.active` every 10 seconds by re-reading `state.json`. If the user runs `/eat-pickle` (which sets `active: false`), the wait aborts and the session exits cleanly with `exitReason = 'cancelled'`.

**Handoff context via `handoff.txt`** *(refined: requirements, codebase)*: After the rate-limit wait completes, before the `continue` statement, write a `handoff.txt` file to `sessionDir`. This leverages the existing consumption mechanism at `tmux-runner.ts:82-85`:
```typescript
const handoffPath = path.join(sessionDir, 'handoff.txt');
if (fs.existsSync(handoffPath)) {
  managerPrompt += '\n\n' + fs.readFileSync(handoffPath, 'utf-8');
  try { fs.unlinkSync(handoffPath); } catch { /* consumed */ }
}
```
On the next `runIteration()` call, `handoff.txt` is read and deleted, and its content augments the default `buildHandoffSummary()` output. Zero changes to `buildHandoffSummary()` at `pickle-utils.ts:224-280` or `State` interface required.

**Stale `rate_limit_wait.json` cleanup** *(refined: codebase)*: In tmux-runner's ownership block (line 201-202), delete any stale `rate_limit_wait.json` from a previous crash:
```typescript
try { fs.unlinkSync(path.join(sessionDir, 'rate_limit_wait.json')); } catch { /* not present */ }
```

**Exit code capture** *(refined: codebase)*: At `tmux-runner.ts:149`, change `proc.on('close', () => {` to `proc.on('close', (code) => {` following the existing pattern at `spawn-morty.ts:240`. Persist exit code to sidecar file for debugging:
```typescript
proc.on('close', (code) => {
  if (settled) return;
  settled = true;
  try { fs.closeSync(logFd); } catch { /* already closed */ }
  const exitCodeFile = logFile.replace('.log', '.exitcode');
  try { fs.writeFileSync(exitCodeFile, String(code ?? -1)); } catch { /* best effort */ }
  let output = '';
  try { output = fs.readFileSync(logFile, 'utf-8'); } catch { /* missing */ }
  resolve(classifyCompletion(output));
});
```
This does NOT change `runIteration()`'s return type (constraint preserved). Exit code is available for future Layer 1 implementation.

## Implementation Details

### Files to Modify

| File | Changes |
|------|---------|
| `extension/src/bin/tmux-runner.ts` | Add `classifyIterationExit()`, `detectRateLimitInLog()`, `detectRateLimitInText()`, auto-wait loop at line 287 (before CB block), `consecutiveRateLimits` local var, new exit reason, stale cleanup in ownership block, exit code capture in `proc.on('close')`, import `sleep` from pickle-utils, `handoff.txt` write after wait |
| `extension/src/bin/monitor.ts` | Read `rate_limit_wait.json`, display countdown using `formatTime()` |
| `extension/src/types/index.ts` | Add 3 event types to `VALID_ACTIVITY_EVENTS` |
| `pickle_settings.json` | Add `default_rate_limit_wait_minutes: 60`, `default_max_rate_limit_retries: 3` |
| `extension/tests/activity-logger.test.js` | Update `VALID_ACTIVITY_EVENTS.length` from 15 to 18 (line 34); add `'rate_limit_wait'`, `'rate_limit_resume'`, `'rate_limit_exhausted'` to expected array (lines 35-40) *(refined: requirements, codebase)* |
| `install.sh` | No changes needed (jq merge handles new keys) |

### Files to Create

| File | Purpose |
|------|---------|
| `extension/tests/rate-limit.test.js` | Unit tests for detection functions, classification, wait logic, notification |

### Key Implementation Constraints

- `runIteration()` currently returns a string (`'task_completed' | 'review_clean' | 'continue' | 'inactive' | 'error'`). The rate limit detection happens AFTER `runIteration()` returns, by inspecting the iteration log file — same pattern as error signature extraction. Do NOT change `runIteration()`'s return type.
- `classifyIterationExit()` only performs log inspection when `completionResult === 'continue'`. All other values are mapped directly without I/O. *(refined: codebase)*
- The `result === 'error'` hard-exit at `tmux-runner.ts:393-398` is only reached for spawn failures (ENOENT at line 158-165). `classifyIterationExit('error', logFile)` passes through as `'error'` — no log inspection attempted for spawn failures because the log may be empty/truncated. *(refined: codebase, risk-scope)*
- The wait loop MUST be cancellable (check `state.active` every 10 seconds). A blocking `sleep(3600000)` that ignores cancellation is unacceptable.
- The wait loop MUST check session time limits every 10 seconds. Without this, sessions can exceed `max_time_minutes` by up to 60 minutes. *(refined: requirements, risk-scope)*
- `rate_limit_wait.json` uses `writeStateFile` from `resolve-state.ts:60` for atomic writes (accepts `State | object`).
- Detection functions are pure (take a file path or string, return boolean) for testability.
- Reuse `sleep()` from `pickle-utils.ts:342-344` — do NOT re-implement. Already exported, already imported by `monitor.ts:4`. Add to tmux-runner's import. *(refined: codebase)*
- `IterationExitType` should be defined in `types/index.ts` for reuse by both `classifyIterationExit()` and `buildTmuxNotification()`. *(refined: codebase)*

## Acceptance Criteria

- [ ] Rate limit in NDJSON correctly detected — Verify: create mock log with `rate_limit_event` having `status:"rejected"`, run `detectRateLimitInLog()`, assert true
- [ ] Text fallback detects "5-hour limit" — Verify: unit test with text-only output containing limit message
- [ ] Text fallback ignores echoed file content — Verify: unit test where `tool_result` line contains "rate limit" string, assert `detectRateLimitInText()` returns false
- [ ] Text fallback scans only last 100 lines — Verify: unit test with rate-limit text at line 1 of a 200-line file, assert not detected *(refined: requirements)*
- [ ] Auto-wait sleeps for configured duration — Verify: unit test with mock clock
- [ ] Wait is cancellable via `state.active = false` — Verify: unit test that sets active=false during wait
- [ ] Wait loop respects session time limit — Verify: set `max_time_minutes` such that elapsed + wait exceeds it, assert wait exits early with `exitReason = 'limit'` *(refined: requirements, risk-scope)*
- [ ] Monitor shows countdown during wait — Verify: create `rate_limit_wait.json`, run monitor render, check output contains `⏳` and `remaining`
- [ ] Rate limit waits don't count toward circuit breaker — Verify: unit test confirming CB counters unchanged after rate limit
- [ ] Rate-limit classification intercepts BEFORE circuit breaker recording — Verify: create mock log with `result` event having `subtype: "error_rate_limit"`. Run classification+CB path. Assert `extractErrorSignature()` was NOT called AND `recordIterationResult()` was not called. *(refined: requirements — tests mechanism, not just outcome)*
- [ ] Rate-limit `continue` skips CB gate and result branching — Verify: after `classifyIterationExit()` returns `'api_limit'`, assert control flow skips the CB block (lines 289-338) and result branching (lines 340-401) entirely. *(refined: requirements)*
- [ ] Consecutive rate limit retries cap works — Verify: unit test with 3 consecutive api_limit results → exit with `rate_limit_exhausted`
- [ ] `consecutiveRateLimits` resets only on `'success'` — Verify: sequence `api_limit` → `error` → `api_limit` → `api_limit` should have counter at 3, NOT reset by the `'error'` between. *(refined: requirements)*
- [ ] `rate_limit_exhausted` triggers failure notification — Verify: `buildTmuxNotification('rate_limit_exhausted', ...)` returns `isFailure=true`
- [ ] Rate-limit handoff context delivered to next iteration — Verify: after rate-limit wait, assert `handoff.txt` exists in sessionDir with rate-limit note. After next `runIteration()`, assert `handoff.txt` is consumed (deleted). *(refined: requirements)*
- [ ] Exit code captured from subprocess — Verify: unit test confirming `.exitcode` sidecar file written after `proc.on('close')`
- [ ] Settings loaded from `pickle_settings.json` — Verify: unit test with custom wait/retry values; verify floor checks (`wait >= 1`, `retries >= 1`)
- [ ] Stale `rate_limit_wait.json` cleaned up on startup — Verify: create stale file before tmux-runner ownership block, assert deleted *(refined: codebase)*
- [ ] All existing tests still pass — Verify: `cd extension && npx tsc --noEmit && npx tsc && npm test`

## Assumptions *(refined: risk-scope)*

| # | Assumption | Source | Blast Radius if Wrong |
|---|-----------|--------|----------------------|
| 1 | Claude CLI emits `rate_limit_event` JSON in `-p --output-format stream-json` mode | Unverified — inferred from ralph-claude-code | Layer 2 detection is dead; only Layer 3 (text regex) works. See Pre-Implementation Verification. |
| 2 | 5-hour usage cap resets within 60 minutes | Empirical observation (unverified) | Sessions wait 60 min but limit isn't reset; wastes time then fails after 3 retries |
| 3 | NDJSON logs are fully flushed before `proc.on('close')` fires | Node.js pipe behavior assumption | Rate limit events missing from log; classification false negative → CB poisoning |
| 4 | `state.active` remains `true` during rate-limit waits | Design intent (explicit in this PRD) | If set to `false`, monitor exits and `/eat-pickle` cancel mechanism breaks |
| 5 | `--max-turns` is sufficient to bound subprocess lifetime | Current architecture | Without per-iteration timeout, a stuck subprocess runs until `--max-turns` exhausted |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Rate limit detection false positive (echoed content) | Medium | Layer 3 filters out `"type":"user"` and `"type":"tool_result"` lines; scans only last 100 lines |
| Wait duration too short (limit not actually reset) | Low | Configurable `default_rate_limit_wait_minutes`, consecutive retry tracking with cap |
| Wait duration too long (wastes time when limit resets early) | Low | Acceptable tradeoff — correctness over speed. Could add early-exit probe in future. |
| `rate_limit_wait.json` left behind after crash | Low | Stale cleanup in tmux-runner ownership block on startup. Monitor handles missing/corrupt file gracefully. |
| Extra-usage prompt causes exit but is not a rate limit | Medium | Layer 3 won't match "extra usage" text. These exits fall through to normal error handling → CB counts them. Known v1 limitation. Users on affected plans should increase `default_cb_same_error_threshold`. |
| Claude CLI output format changes between versions | High | Pin detection patterns to named constants. Log warning when Layer 3 matches but Layer 2 doesn't (format drift). Test against captured CLI output snapshots. *(refined: risk-scope)* |
| Truncated log — rate limit event not flushed before close | Medium | Layer 3 provides secondary detection via text patterns even if NDJSON is incomplete. Known v1 limitation for fully truncated logs. *(refined: risk-scope)* |

## NOT in Scope
- Proactive hourly call counting or pre-emptive throttling
- Interactive mode (`/pickle`) rate limit handling
- Extra-usage prompt auto-acceptance
- Billing/cost alerts
- Per-iteration token budget tracking
- Retry with exponential backoff (fixed wait is simpler and sufficient for hourly/5-hour resets)
- Per-iteration timeout mechanism in tmux-runner — `tmux-runner.ts` spawns `claude -p` with `--max-turns` as the only execution bound. Adding a wall-clock timeout via `setTimeout` + SIGTERM (matching `spawn-morty.ts:203-211`) is a separate enhancement with its own PRD. `classifyIterationExit()` has no `'timeout'` path in v1. *(refined: all three analysts)*
- Extra-usage prompt exits inflating circuit breaker — on plans with extra-usage prompts, non-interactive mode causes exits that `extractErrorSignature()` counts as errors. After 5 consecutive occurrences, CB trips. Known v1 limitation. *(refined: risk-scope)*
- Cross-session rate limit coordination — each tmux session tracks rate limits independently. Two concurrent sessions may exhaust the shared API quota in alternating fashion. *(refined: risk-scope)*
- Hourly limit optimization — hourly rate limits (which reset in 1-5 minutes) incur the full 60-minute wait in v1. Future versions could parse `retry_after_seconds`. *(refined: risk-scope)*

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|-------|-----|-------|----------|-------|------|-------|
| 10 | 78267e1b | Add IterationExitType and rate limit event types | High | Clean build | Type exported, 18 events, tests pass | types/index.ts, activity-logger.test.js |
| 20 | a617e783 | Add rate limit settings to pickle_settings.json | High | Clean build | Settings loaded with floor validation | pickle_settings.json, tmux-runner.ts |
| 30 | 33b0541b | Implement rate limit detection functions | High | 78267e1b done | 3 pure functions exported, tests pass | tmux-runner.ts, rate-limit.test.js |
| 40 | d6ed51ab | Capture subprocess exit code in runIteration | Medium | Clean build | .exitcode sidecar written, return type unchanged | tmux-runner.ts |
| 50 | 87e1fdde | Add auto-wait loop and main loop integration | High | 78267e1b + a617e783 + 33b0541b done | Classification before CB, wait loop, handoff.txt | tmux-runner.ts, rate-limit.test.js |
| 60 | cac3e379 | Add rate_limit_exhausted exit reason and notification | Medium | 87e1fdde done | isFailure includes rate_limit_exhausted | tmux-runner.ts, rate-limit.test.js |
| 70 | f7294d13 | Add rate limit countdown to monitor display | Medium | 87e1fdde done | Yellow countdown in monitor TUI | monitor.ts, rate-limit.test.js |
