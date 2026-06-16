# R-PPXR root-cause diagnosis — pickle phase premature exit, no relaunch

Forensic record for AC-PPXR-2. Source: live B-GA build session `2026-06-16-3c1831d7` (12 tickets,
several `large` tier). The pickle phase exited code 0 with tickets still pending three times, each
needing a manual babysitter relaunch.

## Three-field branch selector

The relaunch suppressor `isGenuineCrashOrSpawnFailure` (`extension/src/bin/mux-runner.ts`) and the
relaunch guard branch are selected by three fields per cut-off run: the iteration `outcome.exitCode`, the
iteration `outcome.timedOut`, and the resolved loop `result`. For all three cut-off runs the signature is
identical — a manager `claude -p` turn cut off mid-tool-result:

| Run | mux iter | `outcome.exitCode` | `outcome.timedOut` | resolved loop `result` | `result` events in iter log |
|-----|----------|--------------------|--------------------|------------------------|-----------------------------|
| 1   | 3        | `null`             | `false` (not timed out) | `'error'`         | 0 (last event `system/task_started` / `user`) |
| 2   | 8        | `null`             | `false` (not timed out) | `'error'`         | 0 (last event `system/task_started` / `user`) |
| 3   | 16       | `null`             | `false` (not timed out) | `'error'`         | 0 (last event `system/task_started` / `user`) |

Net per run: Run 1 → 0/12 done; Run 2 → 1/12 (`de345802` Done `ada1f5c0`, `28d95d77`
implemented-uncommitted); Run 3 → resumed. Within each run, the EARLIER manager turns ended cleanly
(`tmux_iteration_{4,15,16}.log` each carry a `result` event with `num_turns` 14/17/87 and the loop
continues); the run dies on a turn that is cut off (`tmux_iteration_{1,2}.log` have 0 `result` events).
Clean turns interleaved with suppressed cut-offs is the established qualitative pattern.

## Branch the signature selects (pre-fix, the bug)

With `outcome.exitCode === null`, `outcome.timedOut !== true`, `decision.exitKind === 'other_error'`, the
pre-fix predicate's `outcome.exitCode === null` arm fired → predicate returns `true` →
`decision.shouldRelaunch && !isGenuineCrashOrSpawnFailure` short-circuits → mux logs
`Subprocess error. Exiting loop.` and exits code 0 with tickets pending. `evaluateManagerRelaunch`
(`extension/src/services/manager-relaunch.ts`) had already returned `shouldRelaunch: true` for the
pending-ticket `other_error` below `CLAUDE_MANAGER_RELAUNCH_CAP=20` — the suppressor, not the cap, is the
limiter.

## Confirm / refute the three candidate causes

- **`signal_received` / `exit_reason=signal:*` (external SIGTERM): REFUTED.** No `activity-*.jsonl` and no
  `signal_received` / `exit_reason=signal:*` were present in the session. The cut-off is NOT a recorded
  external SIGTERM; there is no signal marker on `state` or `outcome` to read. (This is why the relaxed
  predicate's only fatal exit-code shape is a deterministic non-zero exit code — a deterministic crash —
  not a phantom signal field.)
- **Idle-stall watchdog `executeTimeoutHalt`: REFUTED.** `outcome.timedOut` is `false` and the exit
  `result` is `'error'`, not a timeout halt. The idle-stall / artifact-progress timeout path was not the
  exit driver; the loop entered the `result === 'error'` branch.
- **Max-turns-without-`result`: REFUTED as the clean-max-turns class.** The cut-off iteration logs carry
  ZERO `result` events; `detectManagerMaxTurnsExit` (R-ICDM-1 protected) requires a `result` event with
  `stop_reason: 'end_turn'`, `terminal_reason: 'completed'`, `is_error: false`, and `num_turns >= maxTurns`,
  so it correctly returns `false` here. The "Phase pickle hit iteration cap" log line is a MISLEADING
  label printed unconditionally by `reportPhaseIncomplete` (`pipeline-runner.ts`) on every incomplete
  exit — `max_iterations=500` was never approached (iters reached 3/8/16). The real exit driver was the
  Layer-A suppressor, not a turn-budget exit.

## Conclusion

The cut-off is an in-iteration manager-turn termination (`outcome` defined, `exitCode === null`,
`timedOut !== true`, no `result` event) that is RELAUNCHABLE-in-iteration, with pending tickets remaining
and the relaunch count far below cap. The fix relaxes `isGenuineCrashOrSpawnFailure` so this retryable
signal-kill-with-pending-tickets-below-cap signature returns `false` (allowing the existing
`evaluateManagerRelaunch` chain to relaunch), while a deterministic non-zero `exitCode` (a genuine crash)
stays `true` (terminal). `detectManagerMaxTurnsExit` is untouched (R-ICDM-1).
