# CONTEXT — 2026-05-06 path A meta-bundle in flight

> Bootstrap after `/clear`. Read this first. Supersedes `CONTEXT_2026-05-05_post-merge.md` (still on disk for historical reference; can be deleted).

## What's in flight RIGHT NOW

**Session `pickle-b8465d85`** is running the **path A meta-bundle** — 4 PRD-quality tickets that prepare `prds/p1-bug-fix-bundle-2026-05-05.md` for re-refinement into 50+ atomic implementation tickets.

| Order | ID | Status | Files touched |
|------:|----|--------|--------------|
| 10 | `3097eec3` | ✅ Done (`68d9c1bf`) | `prds/p1-bug-fix-bundle-2026-05-05.md` (lift section ACs) |
| 20 | `b90c4ebe` | 🔄 In Progress | `prds/p1-bug-fix-bundle-2026-05-05.md` (split AC-06 into 06a/06b) |
| 30 | `6836ef13` | Todo | `extension/src/types/index.ts`, `activity-events.schema.json`, `tests/activity-event-payload.test.js` |
| 40 | `e83118ff` | Todo | `extension/src/bin/spawn-refinement-team.ts`, `extension/scripts/audit-refinement-prompt-events.sh` (new), `extension/CLAUDE.md` (gate + trap-door) |

**Sessions:**
```
Path A meta-bundle session: /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-05-b8465d85
tmux:                       pickle-b8465d85   (tmux attach -t pickle-b8465d85)
state:                      <session>/state.json (active=true, iteration=N)
flag set:                   state.flags.skip_readiness_reason — 5 forward-references intentional
```

## Verify before acting

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
git rev-parse --abbrev-ref HEAD                       # expect: main
git rev-list --count origin/main..HEAD                # ≥32 (will grow as path A tickets land)
git log --oneline -8                                  # see recent commits incl. 68d9c1bf, 80430696, efe0e961, 1949c6a4, f6909d78, 49e0ff84, 244b4c51
git status --short                                    # expect: clean (worker commits atomically)
ls /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-05-b8465d85/state.json && echo session-exists
jq '.active, .step, .current_ticket, .iteration, .exit_reason' /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-05-b8465d85/state.json
```

## What just happened (2026-05-05 → 2026-05-06)

- **Slot 1q SHIPPED** (`f6909d78`, 99 min via `/pickle-tmux`). install.sh now has force-rebuild + md5-parity probe + `install_sh_parity_check` activity event + R-ITS regression test. Follow-up `1949c6a4` bumped activity-event-payload count assertion 11→12. Follow-up `efe0e961` made R-ITS-1 force-rebuild only delete TS-derived JS (preserved `parse-coverage-exception.js`, `replay-bundle-iter-stats.js` which the original aggressive `rm -f extension/bin/*.js` wiped).
- **`audit-canary-flip` removed from gate** (`244b4c51`). The 6 integration-tests commits' `Canary:` trailers no longer block. Per operator decision: local-only mode, no `gh release create`, no push. Script + fixture tests preserved for future re-wiring.
- **`trap-door-conformance.test.js` fixed** (`49e0ff84`). Pre-existing fast-tier failure: 5 trap-door entries used grep-based ENFORCE without naming a `.test.js` file. Appended explicit test refs.
- **Mega bundle PRD composed** (`80430696`). `prds/p1-bug-fix-bundle-2026-05-05.md` now includes Section CF carry-forwards from 2026-05-04 (9 tickets: AC-TAQ-09 + R-BUNDLE-1/2/DISPO-1 + 5 Section H Wire/Harden/Audit). Closer + R-CLOSER-1 DROPPED.
- **First refinement pass on the mega bundle returned only 5 meta-tickets** (deduped to 4). Reason: bundle PRD delegated ACs to peer PRDs via `composes:`, but refinement-team's machine-checkability gate requires inline ACs at the bundle level. Solution = path A: run 4 PRD-prep tickets, re-refine, then run 50+ implementation tickets via `/pickle-pipeline`.
- **Path A launched** at `pickle-b8465d85`. Halted at readiness gate iteration 1 (5 forward-reference findings — paths/symbols the tickets themselves create). Set `state.flags.skip_readiness_reason` with explicit justification per R-RTRC-* trap-door bypass; re-launched. Ticket 3097eec3 (load-bearing — lifts section ACs into bundle PRD) shipped at `68d9c1bf`.

## What's next (in order)

1. **Wait for path A meta-bundle to complete.** ~3 tickets remaining (b90c4ebe, 6836ef13, e83118ff). ETA varies — small/medium tickets, typically 30-90 min each.
2. **Re-run refinement** on the now-improved bundle PRD:
   ```bash
   node ~/.claude/pickle-rick/extension/bin/setup.js --paused --task "PRD Refinement (post path A): prds/p1-bug-fix-bundle-2026-05-05.md"
   # Then in the new session_root: cp the PRD, spawn refinement team
   ```
   OR re-invoke `/pickle-refine-prd prds/p1-bug-fix-bundle-2026-05-05.md`.

   Expected: 50+ atomic implementation tickets in `refinement_manifest.json`, covering slots 1o, 1p, 1r/1s, 1t, 1u, 1n, 1m, 1d + the 9 carry-forwards.
3. **Run those 50+ tickets via `/pickle-pipeline`** (build → anatomy-park → szechuan-sauce). Multi-hour, possibly overnight. Audit-canary-flip is no longer in the gate, so the prior bundle's release-time blocker is gone.
4. **No closer.** Local-only scope. After the implementation pipeline finishes, the operator decides whether to push and release later.

## Known pre-existing risks (carried from CONTEXT_2026-05-05_post-merge.md)

- **fast-tier deadlock** on `node --test tests/activity-event-payload.test.js` under `npm run test:fast`'s parallel worker pool. Standalone the test runs in 67ms; under the runner it spins forever. Workaround: `pkill -9 -f 'node --test'` to free a hung worker. Slot 1q's Morty hit this mid-flight; recovery worked. Future bundle workers may hit it again. If so, kill the hung tests and wait for mux-runner to respawn the worker.
- **mux-runner orphan accumulation.** Pickle's monitor watchdog (R-MWR-1) respawns mux-runners attached to active tmux sessions. Stale orphans after sessions end consume some resources but are usually harmless. If they balloon (>20), `pkill -9 -f 'mux-runner\.js'` is safe between runs.
- **Stale node_modules/.bin/ symlinks** can fail install-script tests. If `install-script-real.test.js` errors on `ln: ... node_modules/.bin/tsc: File exists`, run `rm -rf node_modules` at repo root.

## Don't do

- **Don't `git push`** — local-only mode; operator hasn't authorized. If you push, `audit-fix-commits.sh` and remaining audits use `git merge-base HEAD origin/main` as scope; pin `MERGE_BASE=v1.70.0` if needed.
- **Don't run `bash install.sh` mid-pipeline** — R-ITS-5-MIN refuses ALL invocations during active session (commit `52e7674d`). The R-ITS-1/-2 safety net catches cache drift now.
- **Don't kick off a sprawling parallel-agent bundle** — `Agent({isolation: "worktree"})` thrashes branch refs on this repo. Use `/pickle-tmux` (single-session sequential) instead.
- **Don't hand-edit `prds/p1-bug-fix-bundle-2026-05-05.md`** while session `pickle-b8465d85` is active — the worker is editing it via tickets 3097eec3 and b90c4ebe.

## Key files

- This bootstrap: `CONTEXT_2026-05-06_path-A.md`
- Master plan: `prds/MASTER_PLAN.md` (operational status)
- Mega bundle PRD: `prds/p1-bug-fix-bundle-2026-05-05.md` (in flux — being edited by path A worker)
- Path A session: `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-05-b8465d85/`
- 13 → 9 carry-forwards from prior bundle: `prds/p1-bug-fix-bundle-2026-05-04.md` (still on disk; refs in mega bundle Section CF)
- Slot 1q PRD (shipped): `prds/p2-install-sh-types-index-stale-on-fast-reinstall.md`

— Pickle Rick, 2026-05-06. *belch* Path A is the prep ramp; the real bundle ride starts after. Don't /clear in the middle without checking session state first.
