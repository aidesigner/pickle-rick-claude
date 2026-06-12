---
title: P1 mega-bundle — B-RRH — Runtime Recovery & Resilience Hardening (the v2-beta "11 babysitter interventions in one run" class)
status: Draft
filed: 2026-06-12
priority: P1
type: bug-bundle
code: B-RRH
backend_constraint: claude   # touches mux-runner / pipeline-runner control flow heavily; codex no-progress authority already wired separately (B-CHTS-CODEX v1.103.0)
schema_neutral: false        # new events (rate_limit_parked/resumed, ticket_ladder_exhausted, crashed_ticket_files_quarantined, pickle_incomplete) + likely a rate_limit_parked phase/exit_reason + an activity-log cap. All forward-migrated via normalizeV<N>StateDefaults → MINOR, NOT major. Confirm the bump inside ticket A0.
composes:
  - "#37 B-PDBL — inferred completion_commit drives a phantom-Done backfill loop (1.9MB→20MB state.json freeze); recovery then blocked by dirty-tree FATAL. → Workstream D (idempotency) + C8 (dirty-tree self-heal)."
  - "#36 B-XSPA — external SIGTERM to the pickle phase makes pipeline-runner read exit-0 and advance through citadel+anatomy on a 16/25 build; anatomy auto-commit then resets-orphans a good commit. → Workstream C1/C2/C4."
  - "#35 B-XCOF — external SIGTERM cancel teardown marks an already-committed ticket Failed and resets HEAD off its commit. → Workstream C3/C4/C5."
  - "#34 B-HRPW — post-rate-limit thin quota wedges a large ticket at research→plan; a CONCURRENT peer session's dirty prds/ files pollute this session's zero-progress signature. → Workstream A3/A4/A5."
  - "#33 B-MRSW — mid-pipeline /login re-auth hangs an in-flight worker (alive but 0% CPU); 46m of complete, gate-green, uncommitted work stranded behind an idle mux. → Workstream C6/C7."
  - "#32 B-RLAR — rate-limit detection neither parks the run nor auto-resumes: burns iterations into the wall with reset_at in hand, charges zero-progress to innocent tickets, idles 6h+ past reset. → Workstream B + A5."
  - "#31 B-LERD — WMW recovery ladder run-EXITS on an already-Done ticket (status-blind zero-progress accounting) stranding 24 Todo tickets; citadel handoff missing state.prd_path. → Workstream A1/A2 + D3/D4."
  - "#30 B-RFCB — readiness gate + refinement symbol auditor are blind to forward-created citations across command strings, tables, cross-ticket refs, the exit-code checker, and the contract resolver; the annotation grammar chokes on trailing chars. → Workstream E1–E6."
  - "#38 B-V2RG — review hammers scan only changed files (miss cross-file test/canonical drift); the release gate runs test:fast single-pass against the documented R-TSPF flake class. → Workstream E7/E8 (+E9 P3 residuals)."
  - "#110 R-PRPATH — paused-refine → /pickle-pipeline --resume leaves state.prd_path UNSET → citadel hard-fails; manager-crash mid-implement strands non-gate-passing source → dirty-tree FATAL bricks relaunch. → Workstream D3/D4/D5 + C8 (== B-PDBL D2 == the dirty-tree P3, deduped here)."
relates:
  - "B-ORSR v1.102.0 (#100-103) — shipped the RecoveryController ladder. B-RRH Workstream A feeds that EXISTING ladder better inputs (status/scope/phase/rate-limit awareness); it does NOT re-implement the ladder."
  - "B-WMNP v1.105.1 (#106) — shipped computeSourceTreeSignature + per-ticket cap repopulation + clear-current_ticket-on-flip + route-through-ladder. A3 refines that source signature to be ticket-scoped (the B-HRPW cross-session-pollution finding)."
  - "B-MWIS v1.105.0 (#107) — shipped process-exit primary completion + evaluateMuxIdleStallWatchdog (mux-runner.ts:~3159) + commit-on-exit + checkPartialLifecycleExit salvage policy. C6/C7 EXTEND that watchdog with CPU/artifact-mtime liveness + a conformance-present fast-path."
  - "H1 detectAndRecoverHeadRegression (built in the v2-beta bundle, commit c79a0d84/e56ed23f) — the ff-only HEAD-regression reattach. C4/C5 WIRE this already-built seam into the cancel-teardown and --resume paths (it currently isn't called there — the same 'seam built, sites not wired' shape as B-CHTS-CODEX)."
  - "R-FRA-6 forward-ref-annotation.ts — the shared annotation module already imported by check-readiness.ts + audit-ticket-bundle.ts. Workstream E EXTENDS its coverage + grammar; no new mechanism."
  - "#25 R-CSI (watch-only, external-event-gated) — concurrent-session destructive interference. A3/C8 path-scoping is the structural mitigation for the benign half of that class (progress-signal + dirty-tree cross-contamination), independent of the destructive-command forensics."
  - "memory: feedback_pickle_rick_autonomy_north_star — 'closer_handoff_terminal pauses are THE anti-pattern; default should be KEEP GOING; the babysitter's recovery playbook should be native.' Every finding here is a babysitter intervention that should have been a runtime self-recovery."
source:
  - "v2.0.0-beta.1 bundle, session 2026-06-10-f50e5c11 (pickle-rick-claude, claude backend, 25 tickets). Babysat to a shipped release across 2026-06-10..12 — ELEVEN logged babysitter interventions (#1-#11). Seven of this bundle's ten findings were filed from that single run. This PRD is the consolidated, evidence-backed design report from it."
  - "LOA-1097 staged-credit-rule-bundles, concurrent session 2026-06-11-c653c95f (loanlight-api, codex, 12 tickets) — source of #110 R-PRPATH + the cross-session-pollution half of #34."
  - prds/MASTER_PLAN.md   # Open Findings #30-38, #110; Drain Queue
---

# B-RRH — Runtime Recovery & Resilience Hardening

> **One-line thesis.** None of these ten findings is about the agent doing bad work — the v2-beta bundle *shipped a clean release*. They're about what the runtime does when something **interrupts** a long run: a five-hour API window, a stray SIGTERM, a `/login`, a manager crash, a concurrent peer session, an inferred-completion edge. In every case the runtime either **destroys committed/completed work, charges an innocent ticket, or bricks its own relaunch** — and a human (the babysitter) had to inspect the tree, reattach an orphaned commit, clear a poisoned counter, hand-stamp a state field, and relaunch. Eleven times in one run. The fix is not ten point-patches; it's hardening the **five subsystems** that every interruption funnels through. B-ORSR made the *recovery ladder* exist; B-RRH makes the *inputs to recovery* trustworthy and the *teardown/relaunch paths* non-destructive.

## The common themes (why this is one bundle, not ten)

The ten open bug PRDs cross-reference each other relentlessly because they are **five root pathologies wearing ten incident reports**. Three ACs are literally the same fix filed 2–3 times:

| Theme | Root pathology | Findings that are really this one bug |
|---|---|---|
| **A. Progress accounting is blind & poisonable** | `worker_artifact_progress.zero_progress_count` is charged without consulting ticket status, phase, path-ownership, or rate-limit state — then the ladder picks run-EXIT over advance | B-LERD (Done-ticket), B-HRPW (cross-session signature, phase-blind), B-RLAR D2 (429-spawn poisoning) |
| **B. Rate-limit has the reset time but no structural park** | runner knows `reset_at` yet spawn-burns into the wall and never auto-resumes | B-RLAR |
| **C. Interruption ≠ done — but teardown/relaunch treats them alike** | SIGTERM/crash/hang → exit-0 misread as completion, committed work reset-orphaned, completed-but-unsignaled work stranded, crashed files brick relaunch | B-XSPA, B-XCOF, B-MRSW, R-PRPATH D2 / B-PDBL D2 / the dirty-tree P3 (**one fix, three filings**) |
| **D. State mutation is un-idempotent / fields unstamped** | inferred-completion re-backfills forever (unbounded state.json); `prd_path` never stamped on the paused-refine→resume path (citadel un-runnable) | B-PDBL D1, B-LERD D2 + R-PRPATH D1 (**one prd_path fix, two filings**) |
| **E. Gate/validator scope ≠ the thing it protects** | readiness/symbol-audit honor annotations on only *some* surfaces; review hammers scan only the diff; release gate runs the known-flaky suite single-pass | B-RFCB, B-V2RG (and the already-shipped B-SJWT whole-tree-judge, same meta-bug) |

**Dedup dividend:** consolidating removes ~3 duplicate tickets — the `prd_path` stamp (filed in both B-LERD and R-PRPATH) and the dirty-tree self-heal (filed in B-PDBL, R-PRPATH, *and* the standalone P3) each get a single owner here.

Workstreams ship **independently** (each is its own atomic sub-bundle behind its own gate). Recommended drain order: **A → C → B → D → E** (A and C are the P1 autonomy bleeders; B unblocks long runs; D/E are correctness-of-recovery and gate-scope).

---

## Workstream A — Progress & recovery accounting (status / scope / phase / rate-limit aware)

Feeds the EXISTING B-ORSR RecoveryController + B-WMNP source-signature better inputs. The counter must never fire on a ticket the runtime already knows is fine.

- **AC-A1 — Done-ticket guard in the ladder.** Before charging `zero_progress_count` or executing any ladder rung, re-read the current ticket's frontmatter; if Done with an explicit `completion_commit`, reset that ticket's progress counter, clear `current_ticket`, and ADVANCE to the next runnable ticket. *Assert:* fixture with ticket A Done (valid commit) + worker spawns producing zero artifacts → runner advances to ticket B within one iteration, no counter increment on A. (B-LERD D1)
- **AC-A2 — exit-action audit.** A per-ticket `ladder_exhausted` MUST emit `ticket_ladder_exhausted {ticket}` and advance while ≥1 runnable Todo ticket remains; full run-exit is reserved for *no runnable tickets remain* or a global cap. *Assert:* ladder exhaustion on ticket A with Todo B/C present → run continues at B, does not `mux-runner finished`. (B-LERD D1 #2)
- **AC-A3 — source signature scoped to own ticket paths.** `computeSourceTreeSignature` / `last_source_signature` is computed over ONLY `git status`/`numstat` entries under the current ticket's declared `Files to modify/create` (or `working_dir`), excluding any path no ticket in *this* session owns. *Assert:* an unrelated dirty file (a `prds/` file written by a concurrent peer session) does not appear in the signature and does not affect zero-progress classification. (B-HRPW AC-1 — also the structural fix for the benign half of #25 R-CSI)
- **AC-A4 — phase-aware progress.** A worker that ADVANCED a lifecycle phase within the iteration (wrote `research_*`/`plan_*` where none existed) counts as progress even without a new review/conformance artifact, for the first N iterations of a `large`-tier ticket. *Assert:* research→plan→implement across 3 iterations is never flagged zero-progress. (B-HRPW AC-2)
- **AC-A5 — rate-limit / breaker counter immunity.** Spawn outcomes classified as rate-limited or occurring within K seconds of a circuit-breaker recovery NEVER increment `zero_progress_count` nor any recovery-ladder counter. *Assert:* a worker that 429-dies K seconds after a breaker `HALF_OPEN→CLOSED` does not move the counter. (B-HRPW AC-3 + B-RLAR #3)

## Workstream B — Rate-limit park & auto-resume

The runner already parks a fixed config-sourced 5 minutes; the bug is it ignores the reported `reset_at`. **Replace** the fixed-wait resume condition — do not add a parallel mechanism.

- **AC-B1 — park-until-reset.** On `consecutive >= threshold` with a reported reset time, enter `rate_limit_parked`: no manager/worker spawns, no iteration advance, no zero-progress accounting; emit `rate_limit_parked {reset_at, ts}`; sleep in capped intervals. *Assert:* injected 429-classifier responses → runner parks within one iteration; zero spawns while parked; counters frozen; event emitted.
- **AC-B2 — auto-resume.** At `max(reset_at + jitter[60-120s], now + configured_min_wait)`, probe once; success → emit `rate_limit_resumed {parked_minutes, ts}` and continue the SAME iteration with counters untouched; still limited → re-park to the newly reported reset. *Assert:* fake clock past reset + healthy probe → resumes same ticket; total spawns during park == probe calls only.
- **AC-B3 — wall-clock exclusion.** Parked time is excluded from `max_time` budget accounting when a session wall is set. *Assert:* a park spanning T minutes does not consume T minutes of the configured wall.
- **AC-B4 — park survives resume.** A park/resume round-trip survives a `setup.js --resume` mid-park (re-arms the timed resume from persisted `reset_at`). *Assert:* `--resume` during a park does not spawn-burn and does not lose the resume arm. (B-RLAR #1/2/4/5)

## Workstream C — Interruption resilience (never destroy committed or completed work)

The unifying rule: **a killed/crashed/hung run is not a finished run, and teardown/relaunch must preserve every commit and every gate-green tree.** Wires the already-built H1 `detectAndRecoverHeadRegression` into the seams that don't yet call it.

- **AC-C1 — pickle-phase completion gated on all-tickets-Done, not mux exit code.** After the pickle mux exits, pipeline-runner reads the ticket frontmatter set; if ANY ticket is Todo/In-Progress/Failed, the phase is INCOMPLETE (re-enter pickle or halt for recovery), never advance to citadel. *Assert:* a mux killed by SIGTERM with ≥1 Todo ticket does not advance to PHASE 2. (B-XSPA AC-1)
- **AC-C2 — signal exit distinguishable from clean completion.** A mux deactivated by a signal with tickets remaining exits non-zero (or writes a `pickle_incomplete` sentinel). *Assert:* SIGTERM-deactivation with Todo tickets → non-zero exit / sentinel; pipeline-runner does not phase-advance. (B-XSPA AC-2)
- **AC-C3 — never Failed-flip a committed ticket on cancel.** Cancel/signal teardown MUST NOT mark the in-flight ticket Failed if it has a `completion_commit` / full artifact set. *Assert:* SIGTERM during a ticket that already committed → ticket status not Failed. (B-XCOF AC-1)
- **AC-C4 — teardown/auto-commit NEVER resets HEAD off a ticket's own commit.** Every reset path (cancel teardown, anatomy/microverse "auto-commit dirty tree then reset") is guarded by `git merge-base --is-ancestor` (H1 logic) and ff-reattaches rather than rewinds. *Assert:* fixture where the in-flight ticket committed then the run is cancelled / auto-commit-reset runs → HEAD remains at the ticket commit, no orphan. (B-XCOF AC-2 + B-XSPA AC-3 — **deploys the built-but-unwired H1 seam**)
- **AC-C5 — resume self-heals an orphaned ticket commit.** On `setup.js --resume`, if a Failed/In-Progress ticket's frontmatter or reflog names a commit that ff-descends from HEAD, auto-reattach (`merge --ff-only`) + mark Done. *Assert:* a session whose in-flight ticket commit was orphaned pre-resume → resume reattaches + marks Done, no manual ff. (B-XCOF AC-3)
- **AC-C6 — CPU/artifact liveness watchdog.** Extend `evaluateMuxIdleStallWatchdog`: a child worker that is alive but has consumed `< N` seconds CPU over `> M` minutes wall AND shows no artifact-mtime advance is a STALL, not healthy-because-pid-exists; on trip, run the `checkPartialLifecycleExit` salvage path. *Assert:* two samples spaced 55s with no iteration/log/artifact advance + a live-but-0%-CPU worker → watchdog trips within one idle-eval cycle. (B-MRSW #1)
- **AC-C7 — conformance-present fast-path.** When the current ticket has a complete artifact set (research/plan/conformance) and a gate-green tree but the worker is unresponsive, validate-and-commit (reset-proof, explicit `completion_commit`) rather than waiting for a lost `<promise>I AM DONE</promise>` token. *Assert:* fixture with a complete artifact set + gate-green tree + a worker stub that never emits the token → watchdog commits + advances; an INCOMPLETE artifact set + unresponsive worker → does NOT auto-commit (waits / restarts). (B-MRSW #2)
- **AC-C8 — dirty-tree relaunch self-heals the current ticket's own files** (the deduped B-PDBL D2 / R-PRPATH D2 / dirty-tree-P3 fix). On launch, when the tree is dirty SOLELY within `current_ticket`'s declared `Files to modify/create` AND that ticket is not Done, the runner quarantines those files (stash or `git clean` to a recoverable ref) and resets the ticket to Todo, instead of FATAL; emit `crashed_ticket_files_quarantined {ticket, files, recovery_ref}`. Files dirty OUTSIDE the current ticket's set still FATAL (no scope creep). *Assert:* relaunch after a simulated mid-implement crash proceeds past preflight, quarantined diff recoverable from the ref; an out-of-scope dirty file still FATALs. (R-MCDT-1/2/3 + B-PDBL AC-3)

## Workstream D — State integrity & idempotency

- **AC-D1 — promote-once completion.** When a ticket is Done and an inferred OR explicit commit resolves in git, the phantom-Done watcher promotes `completion_commit_inferred → completion_commit` EXACTLY ONCE and stops re-emitting. *Assert:* a Done ticket with `completion_commit_inferred` produces exactly one promotion event, never a growing `phantom_done_backfilled` count over N passes. (B-PDBL AC-1)
- **AC-D2 — bounded activity log.** `state.activity` is capped (ring buffer / size ceiling) so a misbehaving emitter cannot grow state.json unbounded. *Assert:* N backfill attempts → `activity.length` stays ≤ cap; state.json size stays bounded. (B-PDBL AC-2)
- **AC-D3 — stamp `state.prd_path`** (the deduped B-LERD D2 / R-PRPATH D1 fix). `setup.js --resume` and the `/pickle-refine-prd` handoff persist `state.prd_path`, resolving to `${SESSION_ROOT}/prd_refined.md` when present else `${SESSION_ROOT}/prd.md`. *Assert:* after a `--paused` → refine → `--resume` sequence, `jq -r .prd_path state.json` points at an existing file. (R-PRPATH AC-1 + B-LERD D2 #3)
- **AC-D4 — citadel preflight self-heal.** When `state.prd_path` is absent but `start_commit` is set and `${SESSION_ROOT}/prd_refined.md|prd.md` exists, the citadel phase adopts that path (+ logs) rather than hard-failing `missing state.prd_path`. *Assert:* a session with `start_commit` set, `prd_path` unset, `prd_refined.md` present runs citadel instead of `exit 1`. (R-PRPATH AC-2)
- **AC-D5 — regression.** A scripted `--paused` → refine → `--resume` fixture (both backends) reaches PHASE 2 CITADEL without the `missing state.prd_path` failure. (R-PRPATH AC-3)

## Workstream E — Gate & validator scope correctness

Extend the EXISTING R-FRA-6 module + review hammers + release gate. No new mechanisms.

- **AC-E1 — bundle-creation index.** A new R-FRA-6 export builds an index from every bundle ticket's "Files to modify/create" + annotated citations; both readiness + symbol-audit consult it before flagging any `tests/**`, `scripts/**`, `src/**`, `data/**` path. *Assert:* a path declared-or-annotated anywhere in the bundle is not a finding (covers cross-ticket + activity-event first-contact). (B-RFCB #1, A1)
- **AC-E2 — command-string + table coverage.** A path inside a backticked command string or a table cell is covered when it appears in the bundle-creation index. *Assert:* `node --test tests/foo.test.js` for a forward-created `tests/foo.test.js` is not flagged. (B-RFCB #2)
- **AC-E3 — grammar hardening.** `FORWARD_REF_ANNOTATION_RE` accepts a trailing `, ; ) .` immediately after the annotation's closing paren. *Assert:* unit matrix — `(forward-created))`, `(forward-created),`, `(created by ticket ab1234cd).`, `(introduced by ticket ab1234cd);` all parse. (B-RFCB #3)
- **AC-E4 — annotation honor in ALL checkers.** The exit-code checker and the contract resolver (`extractContractReferences` symbol branch) honor the annotation grammar, not only the path branch. *Assert:* an annotated forward-created symbol/type/contract on an "exit code"/contract line is not flagged. (B-RFCB #4)
- **AC-E5 — classifier precision.** Registry-check a backticked token only when cited AS an event / exit code (`event \`X\``, `emits \`X\``, `exit code \`N\``), not merely co-located on a line containing those words. *Assert:* `ok`/`status`/`allowed_paths`/`getImpactRadius` co-located with "exit code" / event prose are not flagged. (B-RFCB #5)
- **AC-E6 — `path_not_verified` precision.** Skip URL segments, slash-joined identifier lists (>2 slashes + no file extension), and `node_modules`. *Assert:* `releases/latest`, `init/indexAll/sync/searchNodes`, `extension/node_modules` produce no warning. (B-RFCB #6)
- **AC-E7 — review-hammer cross-file scope.** The test-quality + cross-ref review hammers grep the bundle's changed symbols/commands across ALL tests + canonical-config files (`check-wired.sh`, the gate-wiring test), not only the diff. *Assert:* a fixture where the bundle changes behavior X and a PRE-EXISTING test pins old-X (or a canonical config encodes old gate wiring) is flagged. (B-V2RG review-hammer)
- **AC-E8 — flake-tolerant release gate.** Replace the single-pass `npm run test:fast` in the canonical `FULL_CMD` (CLAUDE.md / ci.yml / release.yml / check-wired.sh / release-gate-wiring.test.js) with the flake-tolerant mechanism (`check-flake-budget` rerun-with-budget or a serial-manifest pass). *Assert:* release.yml goes green on a clean bundle; an actually-broken test still reds it. (B-V2RG fast-suite — the documented R-TSPF/R-TFP class)
- **AC-E9 (P3 residuals)** — add the codegraph `serve --mcp` handshake test to a serial manifest (or low-concurrency expensive tier); add the `INSTALL_BYPASS_ACTIVE_SESSION` audit-write to install.sh that the README documents. *Assert:* handshake test stable under expensive-tier concurrency; install.sh emits the documented audit event. (B-V2RG P3s — split out if it bloats the workstream)

### Bundle closer
- **C-RRH-CLOSER** — full release gate from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all `audit-*.sh`, test:fast, test:integration, `RUN_EXPENSIVE_TESTS=1` test:expensive) green at low concurrency; confirm the schema bump (ticket A0) forward-migrates old `state.json`; single MINOR version bump; `bash install.sh`; clean tree + JS↔TS parity; push + `gh release create`.

## Schema & invariants

- **A0 (schema-migration ticket, if needed)** — new events (`rate_limit_parked`, `rate_limit_resumed`, `ticket_ladder_exhausted`, `crashed_ticket_files_quarantined`, `pickle_incomplete`) added to `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json`; any new `rate_limit_parked` phase / exit_reason added with a `normalizeV<N>StateDefaults` forward-migration so old states stay readable. `_internalSchemaBump` flag per `extension/CLAUDE.md`. **Forward-migrated ⇒ MINOR, not MAJOR.**
- Every new `extension/CLAUDE.md` invariant (e.g. "teardown never resets off a ticket commit", "parked spawns never charge the counter") gets an enforcing trap-door test.
- Forward-created paths in this PRD use the R-FRA-6 annotation grammar; this bundle is itself creation-heavy (many new tests) — expect to set `state.flags.skip_quality_gates_reason` at launch ONLY if E1–E6 are not yet landed (chicken-and-egg: B-RFCB hardens the very gate that would otherwise false-halt this bundle's launch — consider draining Workstream E first, or skip-flag the launch).
