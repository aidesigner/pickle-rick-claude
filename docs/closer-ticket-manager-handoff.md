# Closer Ticket Manager Handoff

Use this runbook when a closer exits with `state.exit_reason = closer_handoff_terminal` or `state.exit_reason = manager_handoff_pending`.

## Meaning

- `closer_handoff_terminal`: the worker hit the configured closer-handoff stop condition and cannot complete manager-owned residuals from worker scope.
- `manager_handoff_pending`: worker-owned closer work is done and the latest conformance artifact includes a `## Manager Handoff` block.

## Manager-owned steps

1. Inspect the latest conformance artifact and confirm the remaining items are manager-owned only.
2. Run the version-bump step for `extension/package.json` if this closer is shipping a release.
3. Run `bash install.sh --closer-context --no-confirm`.
4. Verify the required MD5 parity set for the touched compiled files.
5. Update [prds/MASTER_PLAN.md](/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/prds/MASTER_PLAN.md) and any release/bookkeeping notes.
6. Commit and push manager-owned changes before optional `gh release create vX.Y.Z`.

## Gate heuristic

If the worker reports release-gate failures, verify whether they are pre-existing before reverting closer work. Cross-check open flake/regression findings such as Finding #32 `R-TFP`; inherited failures should become handoff notes, not rollback triggers.

## Recovery

If mux-runner did not stop cleanly:

1. Kill the tmux session for the closer.
2. Confirm no auto-resume loop is still active: `pgrep -af auto-resume`.
3. Only if needed, flip `state.active` to `false` after the session is fully stopped.

## Lockout protocol

After killing a closer session, do not start manager-owned edits until `auto-resume.sh` is confirmed absent. If manager work must proceed before that is certain, commit and push after each manager-owned step so a later rollback cannot erase unpushed work.
