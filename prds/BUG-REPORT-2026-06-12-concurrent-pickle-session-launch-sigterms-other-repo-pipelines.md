# BUG REPORT — 2026-06-12 — Launching a pickle session SIGTERMs concurrent pickle pipelines in OTHER repos (cross-session kill)

**Discovered by:** weekend autonomous babysitter running loanlight-api bundles while the operator concurrently ran a pickle-rick-claude beta build. pickle-rick v2.0-beta-2.
**Severity:** **P1 — progress/data-loss + pipeline-bricking class.** Killed TWO long-running builds (B1, B2) mid-flight. Forensic data point for the previously watch-only **#25 R-CSI** (concurrent-session interference).
**Class:** session isolation / process-ownership cleanup is repo-GLOBAL, not session-scoped.

---

## Symptom
A running `pipeline-runner.js` (loanlight-api, session `2026-06-12-4dddf819` then `2026-06-12-87176b56`) received an external **SIGTERM** and cascaded it to its `mux-runner` child, cancelling the pipeline mid-build. Twice:

| Build | Killed at | pickle-rick-claude session (`pipeline-8f02855b`) (re)created at | signal `is_tty` |
|---|---|---|---|
| B1 (4dddf819) | 18:03:05 | **18:04:43** | true |
| B2 (87176b56) | 20:09:04 | **20:09:26** | false (sender pid = parent node / pipeline-runner forwarding) |

The kill timestamp coincides with the **(re)launch of a pickle session in a different repo** (`pickle-rick-claude`, `pipeline-8f02855b`) to within seconds, both times. This is not coincidence — launching/initializing one pickle session terminates concurrent pickle `pipeline-runner`/`mux-runner` processes belonging to OTHER sessions in OTHER repos.

## Root-cause hypothesis (needs confirmation in code)
Session setup / ownership-refresh / stale-session cleanup (the `Session ownership refreshed (pid updated)` path seen in `mux-runner.log`, and/or a setup-time `pkill`/process-group sweep) selects target processes by a **global** predicate (e.g. `pkill -f mux-runner` / `-f pipeline-runner`, or a PID-table sweep that is not filtered by session dir / working_dir). So a new session's launch reaps every other session's runner regardless of repo. Candidate sites: `setup.ts` (session init / ownership claim), the launch path's concurrent-access probe (`probeConcurrentGitAccess`, R-PIWG-5), `state-manager` ownership/pid logic, any `kill`/`pkill`/`process.kill` in the setup/launch chain.

## Why this matters
The operator explicitly expects concurrent pickle sessions across repos to be ISOLATED ("we run many sessions at the same time, pickle rick isolates them"). They are not: one repo's session launch kills another repo's in-flight build, discarding all uncommitted-iteration progress and cancelling the pipeline. Over the weekend run this forced two full recoveries (re-pin + reset + relaunch per the R-RSPIN dance).

## Repro
1. Start a pickle pipeline in repo A (`/pickle-pipeline`), let it run.
2. Start (or restart) any pickle session in repo B (`setup.js` / `/pickle-*`).
3. Observe repo A's `pipeline-runner` receive SIGTERM at the moment repo B's session initializes; repo A's `state.exit_reason` becomes `signal:SIGTERM`/`signal:SIGINT`, `pipeline-status.status=cancelled`.

## Acceptance criteria (machine-checkable)
- [ ] Launching/initializing a pickle session does NOT signal any process whose session dir / working_dir differs from the one being launched. Verify: integration test — start a dummy long-lived `mux-runner` for session S1 (working_dir W1), run `setup.js`/launch for session S2 (working_dir W2 ≠ W1), assert S1's process is still alive and `state(S1).exit_reason == null`.
- [ ] Any process-reaping in the setup/launch/ownership path filters targets by session dir (or PID recorded in that session's own `state.json`), never a repo-global `pkill -f <runner>` / unfiltered PID sweep. Verify: `git grep -nE "pkill|process\.kill|kill -|killall" extension/src` audited; each kill site is session-scoped with a regression test.
- [ ] A documented invariant + trap door: "session A's lifecycle MUST NOT signal session B's processes."

## Operator workaround (in effect this weekend)
Do NOT (re)launch or restart any pickle session in another repo while the loanlight-api weekend bundles run — each restart kills the active build. Babysitter recovers via re-pin + relaunch, but progress in the killed iteration is lost.

---

## Secondary findings from the same session (lower severity, capture-only)

### S1 — build's `git add -A` sweeps untracked files onto the feature branch (PR pollution)
B1's build committed ~22 untracked `docs/*.md` PRDs (including unrelated pre-existing repo PRDs) onto the feature branch — PR #1938 (loanlight-api) carries them as scope pollution. A pickle worker/closer commit path uses a broad `git add -A`/`git add .` instead of adding only the ticket's declared `Files to modify/create`. **AC:** worker/closer commits stage only ticket-scoped paths; untracked files outside the ticket scope are never swept. (Also caused B2's PRD to vanish from the working tree on `git checkout main` because it had been committed onto B1.)

### S2 — `scope:branch` pipeline runs no whole-repo typecheck → out-of-fence consumer breaks escape to pre-PR
B1 added 4 columns to the `credit_runs` Drizzle type; an out-of-fence consumer (`audit-data-mapper.service.spec.ts` baseRow, outside the credit scope-fence) broke `tsc` repo-wide, but every scoped per-ticket gate + citadel + anatomy-park passed — only the babysitter's manual pre-PR `pnpm typecheck` caught it. **AC:** a build that changes an exported type/interface runs a whole-repo typecheck (not just scope-fenced) before the pickle phase reports success (relates to R-ORSR-6 consumer-sweep; appears regressed or not covering the scoped-pipeline path).
