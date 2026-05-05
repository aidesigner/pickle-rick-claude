# CONTEXT — 2026-05-05 mid-day continuation

> Bootstrap after `/clear`. Read this first, then `prds/MASTER_PLAN.md` (header + 🚨 Live forensic + Recommended next move). Delete this file once the **completion bundle** lands.

## TL;DR — strategic decision: rebuild as a narrow "completion bundle"

Bundle session `2026-05-04-f416c6cc` has been running for 3+ hours through multiple relaunches. Each relaunch reveals a new structural bug in the freshly-deployed code. Real work IS shipping to git (~29 tickets across 17 commits since run #5 launch). But the session-state machinery (phantom-Done watcher, cap-split stale cache, audit gate) keeps wiping the session's notion of "Done" and tripping forensic exits. **Decision: stop nursing this session, compose a focused completion bundle, refine, launch fresh on cleanly-deployed code.**

## Current state at handoff (2026-05-05 ~10:35 local)

- Bundle session `2026-05-04-f416c6cc` — run #6 attempt 3 is RUNNING (or has tripped again — verify per Quick re-verify below). Already reverted ticket `58fac5e3` despite my phantom-Done hotfix → hotfix didn't take effect on the cached path. **Recommendation: stop run #6 before doing anything else.**
- Git: **17 commits since `6be334b1`** (cap-split fix). All are bundle work (`6280e91c..2c04b318`). Commits real, work survives any session restart.
- Tickets in session frontmatter: **34 Done / 28 Todo / 62 Total** as of the most recent bulk-flip. Watcher has been re-reverting on iteration_start.
- Deploy: **md5 parity restored** as of `bash install.sh` at ~10:29. All 5 hot files match source. Cap-split fix `6be334b1` IS deployed. R-XBL-1..9 instrumentation IS deployed.
- v1.70.0 NOT tagged. v1.66.0 still GitHub-Latest with poison content. 89+ unpushed commits.
- `current_sessions.json` for pickle-rick-claude cwd is **empty** (we pruned 13 phantoms earlier; the bundle session re-claimed and lost it).

## Quick re-verify after `/clear`

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
git status --short                                              # expect clean (or bundle worker debris)
git log --oneline 6be334b1..HEAD | wc -l                        # expect ~17

SESSION=~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc
jq '{step,active,iteration,current_ticket,exit_reason,start_time_epoch,pid}' "$SESSION/state.json"
NOW=$(date +%s); echo "state.json $((NOW - $(stat -f %m $SESSION/state.json)))s old"
ps -p "$(jq -r .pid $SESSION/state.json)" -o pid,etime 2>/dev/null  # alive or DEAD?

# Done counts
done=$(grep -l '^status:[[:space:]]*"\?Done"\?$' $SESSION/*/linear_ticket_*.md | wc -l)
todo=$(grep -l '^status:[[:space:]]*"\?Todo"\?$' $SESSION/*/linear_ticket_*.md | wc -l)
echo "Done=$done Todo=$todo"

# md5 parity (all should match if install.sh from 10:29 still holds)
for f in types/index.js services/state-manager.js bin/spawn-morty.js bin/mux-runner.js services/pickle-utils.js; do
  src=$(md5 -q extension/$f); dst=$(md5 -q ~/.claude/pickle-rick/extension/$f)
  [ "$src" = "$dst" ] && echo "OK $f" || echo "DRIFT $f"
done

# Stop run #6 if running
tmux kill-session -t pipeline-fresh-f416c6cc 2>/dev/null
```

## What's shipped to git (the real progress)

```
2c04b318 R-TAQ-7 — refinement_manifest schema gains ticket_quality_warnings
fc63f552 R-TAQ-6 — backfill-audit fixture
135b319e R-TAQ-5 — cross-doc-naming-drift sub-check
fcc81832 R-TAQ-4 — Failure-mode checklist
b19946c6 R-TAQ-3 — mux-runner gate integration
6b0614a9 R-TAQ-2b — audit-ticket-bundle.schema.json
6482f6dd R-TAQ-2 — audit-ticket-bundle.ts validator
6280e91c R-TAQ-1 — analyst path verification
e0dec151 R-CNAR-6 — Spark codex smoke-run gate
caab90fd R-CNAR-5 — auto-resume regression tests
7cd8f8a3 R-CNAR-4 — auto-resume stop conditions
4be21383 R-CNAR-3 — pipeline_auto_resumed event
f2ab464a R-CNAR-2 — auto-resume.sh wrapper
7573df75 R-CNAR-1 — tier_caps schema
308f07bb R-DTS-2 — audit-runtime-imports.sh
ef77d317 R-DTS-3 — module-load smoke
1131cf3b R-WSE-1 — flushAndExit helper (shipped during run #6 attempt 2!)
```

Plus pre-run-#5 R-XBL-1..9, AC-XBL-08, AC-EVENT-PAYLOAD-01, R-DTS-1, R-BUNDLE-CLEANUP from earlier.

## Operator workarounds applied today (don't undo)

1. **start_time_epoch reset** — was at 500/720 min into wall-clock cap; reset to `now`
2. **`bash install.sh`** — restored deploy parity for all 5 hot files (cap-split + R-XBL events now live)
3. **13 phantom map entries pruned** from `current_sessions.json` (see slot 1n addendum)
4. **state.flags.skip_ticket_audit_reason** set — bypasses R-TAQ-3 gate (627 spurious cross-doc-naming-drift findings; disposition table missing)
5. **state.flags.skip_readiness_reason** carried forward (bundle creates Section D fixes for the resolver itself)
6. **Hotfix patches in deployed `mux-runner.js`** — `correctPhantomDoneTickets` and `validateAutoTicketCompletion` now honor `completion_commit:` frontmatter (apparently insufficient — watcher path uses `getTicketStatus` cache which my patch didn't intercept)
7. **`completion_commit:` backfilled** on 30 tickets via R-* code matching against git log
8. **30 Todo→Done flipped** for tickets with completion_commit + 4+ artifacts

## New bugs filed today (already logged into existing PRDs)

- **slot 1t** `prds/p2-remove-pipeline-wall-clock-time-cap.md` — drafted, P2, 10 R-NTC + 12 ACs
- **slot 1u** `prds/p2-manager-stop-hook-nudge-cadence-wastes-turns.md` — drafted, P2, 6 R-MSCN + 9 ACs
- **slot 1o** `prds/p1-worker-backend-split-from-manager.md` — drafted, P1, 8 R-WBS + 8 ACs
- **slot 1p** `prds/p2-codex-spark-worker-completion-commit-contract-violation.md` — drafted, P2, 4 R-CCC + 7 ACs
- **slot 1q** `prds/p2-install-sh-types-index-stale-on-fast-reinstall.md` — drafted, P2→P1 candidate, includes severity update + R-ITS-5/6 mid-bundle deploy guardrail
- **slot 1g R-CNAR-7 addendum** in `prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` — cap-check guard against stale per-ticket cache when `current_ticket=null`. 5 ACs.
- **slot 1n addenda** in `prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` — R-SHB-5/6 (phantom map + crash cleanup)
- **slot 1h addendum** in `prds/p2-worker-silent-exit-and-ticket-path-drift.md` — R-WSE-1 fell to its own bug (forensic only)
- **next bundle wrapper** `prds/p1-bug-fix-bundle-2026-05-05.md` drafted, composes 9 source PRDs / 53-67 atomic tickets / ships v1.71.0

## NEW bug discovered late: phantom-Done watcher's hash-only check

`hasCommitReferencingTicketSince(workingDir, ticket.id, startCommit)` at `mux-runner.ts:243` (deployed `mux-runner.js:240`) searches commit messages for the **ticket hash** (e.g., `51d826c9`). But bundle commit messages use **R-* codes** (e.g., `R-CNAR-1`). 100% miss rate. Reverts every shipped ticket on every iteration_start. **Honors `completion_commit:` frontmatter field is the fix** — but the field needs to be checked BEFORE this git-log call. This is what slot 1p R-CCC was for, but the deployed implementation has the call ordering wrong.

**File this as: forensic addendum to slot 1p with NEW R-CCC-5 requirement: "phantom-Done watcher MUST check `completion_commit:` frontmatter before calling `hasCommitReferencingTicketSince()`."**

## The Plan — composition + run

### Step 1: Stop run #6 + take forensic snapshot

```bash
SESSION=~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc
tmux kill-session -t pipeline-fresh-f416c6cc 2>/dev/null
cp "$SESSION/state.json" "$SESSION/state.json.run6-handoff-snapshot"
cp "$SESSION/mux-runner.log" "$SESSION/mux-runner.log.run6-handoff-snapshot"
ps -ef | grep -E "mux-runner|claude.*--max-turns" | grep -v grep
# kill any leftover claude / mux-runner descendants
```

### Step 2: File slot 1p NEW R-CCC-5 forensic addendum

Append to `prds/p2-codex-spark-worker-completion-commit-contract-violation.md`:
- Forensic: bundle session 2026-05-04-f416c6cc, run #6 attempts 1-3 each tripped phantom-Done revert despite operator backfilling `completion_commit:`. The deployed `correctPhantomDoneTickets` ignores the field; only checks `hasCommitReferencingTicketSince(workingDir, ticket.id, startCommit)` which fails because bundle commits use R-* codes not ticket hashes.
- R-CCC-5 (NEW): both `correctPhantomDoneTickets` (mux-runner.ts:243) AND `validateAutoTicketCompletion` (mux-runner.ts:545) MUST check `completion_commit:` frontmatter as the FIRST gate, before any git-log query. Hotfix attempted on deployed JS but the runner reverted ticket `58fac5e3` anyway → patch landed in source TS, not deployed; OR the watcher uses a cached `getTicketStatus` path I didn't intercept.

### Step 3: Compose `prds/p1-bug-fix-bundle-2026-05-04-completion.md`

Frontmatter:
```yaml
title: P1 — Bug-fix bundle 2026-05-04 COMPLETION (residuals + new findings)
status: Draft
date: 2026-05-05
priority: P1
type: bug-bundle
peer_prds:
  inherits_from: prds/p1-bug-fix-bundle-2026-05-04.md
  composes:
    - prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md   # R-CNAR-7 addendum
    - prds/p2-codex-spark-worker-completion-commit-contract-violation.md  # R-CCC-5 NEW
    - prds/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md  # R-SHB-5/6
  related:
    - prds/p1-bug-fix-bundle-2026-05-05.md   # next-round, defers behind this
```

Body composition (target ~35-45 atomic tickets after refinement):

| Section | Source | Tickets | Lead requirement |
|---|---|---|---|
| **A** (FIRST) | R-BUNDLE-DISPO-1 from 2026-05-04 | 1 | Disposition table JSON — UNBLOCKS audit gate self-validation; do this first so subsequent tickets pass |
| **B** | R-CCC-5 NEW (1p forensic) | 2 | Phantom-Done watcher honors completion_commit frontmatter (correctPhantomDoneTickets + validateAutoTicketCompletion) |
| **C** | R-CNAR-7 NEW (1g forensic) | 3 | Cap-check guard against stale per-ticket cache when current_ticket=null |
| **D** | R-WSE-2/3/4 + AC-WSE-05 from 2026-05-04 | 5 | worker_partial_lifecycle_exit event + stderr breadcrumb + send-to-morty.md prompt + flush test |
| **E** | R-RTRC-1..7 from 2026-05-04 | 7 | Forward-reference hygiene + readiness allowlist + extractContractReferences |
| **F** | R-MWR-rename + R-MWR-1..8 from 2026-05-04 | 9 | Monitor watchdog + watchers EOF resilience |
| **G** | AC-TAQ-09 from 2026-05-04 | 1 | Defective + clean fixture sessions |
| **H** | R-BUNDLE-1/2 from 2026-05-04 | 2 | bundle_bootstrap_mode + snapshot baseline |
| **I** | 5 hardening tickets from 2026-05-04 | 5 | Wire/Harden×2/Audit×2 |
| **Closer** | bdbf368d Closer + R-CLOSER-1 closer-release-gate.sh | 1 | bump v1.69.0 → v1.70.0 + tag --latest |

**Total estimate: 35-45 atomic tickets after refinement.**

Ordering constraint: Section A (R-BUNDLE-DISPO-1) MUST land first. Section B (R-CCC-5) second. After both, the audit gate self-validates AND the phantom-Done watcher stops wiping shipped state.

Acceptance criteria for the bundle as a whole:
- AC-COMPLETION-01: bundle 2026-05-04's 28 unshipped tickets all reach Done
- AC-COMPLETION-02: zero phantom-Done false reverts during the run (verified by activity event count)
- AC-COMPLETION-03: zero stale-cache cap trips on relaunch
- AC-COMPLETION-04: closer ships v1.70.0 with `gh release create v1.70.0 --latest`
- AC-COMPLETION-05: post-bundle, MASTER_PLAN updated to mark slots 1d/1e/1f/1g/1h/1i/1j/1k/1m/1n SHIPPED

### Step 4: Refine + run

```bash
# Ensure clean working tree
git status --short  # expect clean

# Refine (one cycle should suffice; we already have most ACs from inherited PRDs)
/pickle-refine-prd prds/p1-bug-fix-bundle-2026-05-04-completion.md

# Review the manifest
cat ~/.local/share/pickle-rick/sessions/<NEW_SESSION_ID>/refinement_manifest.json | jq '.tickets[] | {id,title,order,complexity_tier}'

# Launch fresh on cleanly-deployed code
/pickle-pipeline prds/p1-bug-fix-bundle-2026-05-04-completion.md --backend claude

# Or for tmux-only (no anatomy-park / szechuan-sauce phases)
/pickle-tmux prds/p1-bug-fix-bundle-2026-05-04-completion.md --backend claude
```

### Step 5: After completion bundle ships v1.70.0

- Mark bundle 2026-05-04 SHIPPED in MASTER_PLAN with completion-bundle reference
- File next-round bundle `prds/p1-bug-fix-bundle-2026-05-05.md` (already drafted) for v1.71.0
  - Composes slots 1o/1p/1q/1r/1s/1t/1u
- Push the 89+ unpushed commits in coherent order

## Watchpoints during the completion bundle's run

1. **R-BUNDLE-DISPO-1 ships first.** Before, `state.flags.skip_ticket_audit_reason` is the workaround. After, the audit gate should self-pass.
2. **R-CCC-5 hotfix ships second.** Before, operator must manually backfill `completion_commit:`. After, watcher honors the field.
3. **R-CNAR-7 cap-check guard ships third.** Before, every relaunch is at risk of stale-cache cap-trip. After, self-healing.
4. **Watch `worker_spawn_backend_resolved`, `worker_completion_commit_announced`, `cap_check_skipped_stale_cache` events** to confirm the new instrumentation is live.
5. **Wall-clock cap is reset on every relaunch but slot 1t fix isn't shipped yet** — relaunch budget is still 720min from start_time_epoch reset. Expected ~10-12h pickle phase + closer.

## Don't forget

- DO NOT re-run `bash install.sh` mid-pipeline. The runner has its code in-memory; new spawns would get fresh code, mismatch causes mixed-state bugs.
- DO NOT push individual commits before bundle closes — closer R-CLOSER-1 handles the push order coherently.
- The 89+ unpushed commits include this morning's worker output AND today's PRD doc churn. Verify the bundle closer's diff before any push.
- Source mtime should be newer than deploy mtime under normal operation. If they invert, run `bash install.sh` ONLY when no runner is active.

## Key file refs

- This bootstrap: `CONTEXT_2026-05-05_PM.md`
- Earlier bootstrap (still relevant): `CONTEXT_2026-05-05.md`
- MASTER_PLAN: `prds/MASTER_PLAN.md` (header + 🚨 Live forensic during run #5 + Recommended next move + queue table)
- Bundle 2026-05-04 PRD (parent of completion bundle): `prds/p1-bug-fix-bundle-2026-05-04.md`
- Source PRDs filed today (need R-CCC-5 + R-CNAR-7 addenda before composition):
  - `prds/p2-codex-spark-worker-completion-commit-contract-violation.md` (slot 1p)
  - `prds/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` (slot 1g — R-CNAR-7 already added)
- Bundle session (postmortem source): `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/`
  - state.json (run #6 attempt 3, may be active or exited)
  - state.json.run6-handoff-snapshot (created by Step 1)
  - mux-runner.log + mux-runner.log.run6-handoff-snapshot
  - 62 ticket dirs with linear_ticket_<hash>.md frontmatter (Done count = source of truth for what to inherit into completion bundle)

## What this session burned through

- Tokens: ~600M cache reads (manager waiting on workers, stop-hook nudges every 2s)
- Tickets shipped: ~17 commits since run #5 launch + 12 from prior runs = ~29 real tickets
- New bugs surfaced + filed: 7 PRDs / addenda
- Operator workarounds: 8 documented
- Pipeline relaunches: run #5 (5h), run #6 attempt 1 (cap-trip), attempt 2 (63m → exit_reason=failed), attempt 3 (running on launch)

— Pickle Rick out. *belch* Stop the runner first, then compose. Don't nurse it further.
