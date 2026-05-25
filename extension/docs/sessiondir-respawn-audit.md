# Session Dir Respawn Audit (R-MMRT-3)

Audit of every callsite that passes `sessionDir` into monitor respawn functions.

## Callsite Table

| Callsite | File | Approx Line | Function Called | sessionDir Source | Validation Applied | Notes |
|----------|------|-------------|-----------------|-------------------|--------------------|-------|
| `ensureMonitorWindow` | `extension/src/services/pickle-utils.ts` | ~2170 | `restartDeadWatcherPanes` | `opts.sessionDir` (caller param) | Yes — `validateSessionDirOrSkip` at top of `restartDeadWatcherPanes` | opts passed from `mux-runner.js` or `pipeline-runner.ts` |
| `startRespawnWatchdog` | `extension/src/bin/monitor.ts` | ~924 | `restartDeadWatcherPanes` | `opts.sessionDir` (CLI args) | Yes — `validateSessionDirOrSkip` with caller=`startRespawnWatchdog` | logTag='monitor-watchdog' triggers callerName remap |
| `pipeline-runner.ts` | `extension/src/bin/pipeline-runner.ts` | ~2706-2714 | `respawnMonitorWindowForMode` | `runtime.sessionDir` (from state.json) | Yes — `validateSessionDirOrSkip` at top of `respawnMonitorWindowForMode` | Fires at anatomy-park / szechuan-sauce / exit phase boundaries |

## sessionDir Source Analysis

| Source | Anchored? | Risk |
|--------|-----------|------|
| `opts.sessionDir` (ensureMonitorWindow / startRespawnWatchdog) | Yes — comes from CLI `--session-dir` arg or parent state | Low: validated at entry, but can be stale if session cleaned up mid-run |
| `runtime.sessionDir` (pipeline-runner.ts) | Yes — loaded from state.json at pipeline start | Low: canonical source, but same staleness risk at phase transitions |

**Finding**: No callsite uses `process.cwd()` or unanchored environment variables as the sessionDir value. All sources are deterministic. The primary risk is a session directory becoming stale (cleaned up, moved, or mismatched) between pipeline start and phase-boundary respawn — exactly what `validateSessionDirOrSkip` now catches.

## Validation Logic

`validateSessionDirOrSkip(sessionDir, caller)` in `extension/src/services/pickle-utils.ts`:

1. **empty** — `!sessionDir || typeof sessionDir !== 'string'`
2. **enoent** — `!fs.existsSync(sessionDir)`
3. **no_state_json** — `!fs.existsSync(path.join(sessionDir, 'state.json'))`
4. **session_dir_mismatch** — `StateManager.read()` resolves `state.session_dir` and compares `path.resolve` of both; also fires when `StateManager.read()` throws

Returns `true` (valid) or `false` (invalid — caller must skip tmux invocation). Emits `monitor_respawn_session_dir_invalid` activity event on first invalid detection per `(caller, sessionDir, reason)` tuple.

## Event Contract

```json
{
  "event": "monitor_respawn_session_dir_invalid",
  "ts": "<ISO-8601>",
  "source": "pickle",
  "gate_payload": {
    "caller": "restartDeadWatcherPanes | respawnMonitorWindowForMode | startRespawnWatchdog",
    "sessionDir": "<string>",
    "reason": "empty | enoent | no_state_json | session_dir_mismatch"
  }
}
```
