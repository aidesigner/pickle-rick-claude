---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-06-01.** Live ledger the babysitter (`prds/babysitter.md`) drains each tick — kept lean on purpose (re-read every 30 min). Shipped releases + closed-finding detail live in `MASTER_PLAN-archive.md` and `git log`.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.89.6** — 2026-06-01 |
| Latest GitHub release | v1.89.6 (v1.81.1..v1.89.6 all tagged) |
| Active pipeline | _none_ — **B-E2E** ✅ shipped v1.89.6 (max-turns-relaunch E2E test: R-MMTR-6A fixture → 6B harness → 6C 3-scenario test → 6D CI gate; closer serialized `install-ui-principles.test.js` to close a real-install concurrency flake). Closes #19 R-MMTR-6 residual. All P1+P2 bug bundles shipped (1.89.0–1.89.6). |
| Codex backend | `gpt-5.4` |

**Priority directive:** drain bug bundles before feature epics; P1 > P2 > P3. All feature epics (R-PGI v1.83.0 / R-PIAP v1.84.0 / R-DC v1.85.0) are shipped.

**Autonomy directive (2026-05-30):** the babysitter drains the ENTIRE plan with zero operator interaction — including the full release cycle (`git push` + `gh release create`), gated only on a green release gate + clean tree. Nothing here should require operator interaction. Sole permitted residue: external-event-gated work (#25 R-CSI needs a real concurrent-session incident to analyze).

---

## Drain Queue

The ordered worklist. Each tick the babysitter takes the top non-blocked row, launches its PRD (or authors one from the source in **Open Findings**, then launches), ships it through release, and repeats. Bugs before features, P1 > P2 > P3.

| # | Bundle | Pri | Open findings | PRD / source | Size |
|---|--------|-----|---------------|--------------|------|
| ~~3~~ | **B-PNTR** ✅ SHIPPED v1.89.0 | — | #77 closed | `prds/p2-remove-non-tmux-pickle-loop.md` — extracted `_pickle-manager-prompt.md`, removed bare `/pickle`, schema-neutral. Closer caught + fixed a latent FATAL deploy bug (template was deployed one level too deep for the runtime resolver; added explicit install.sh cp). | done |
| ~~4~~ | **B-R-MMTR** ✅ SHIPPED v1.89.1 | — | #28 + #19 closed | `prds/p1-bug-fix-bundle-r-mmtr-closeout.md` — R-ICDM-2..7 conformance audits (already-shipped intactness confirmed) + R-MMTRH heal-script + closer. Schema-neutral. Closer (babysitter-completed) stripped a spurious reliability trailer from 273a2d68 that failed audit-fix-commits. | done |
| ~~4b~~ | **B-E2E** ✅ SHIPPED v1.89.6 | — | #19 R-MMTR-6 closed | `prds/p2-bug-fix-bundle-b-e2e-mmtr6.md` (built max-turns-relaunch E2E test: 6A fixture/6B harness/6C 3-scenario test/6D CI gate; schema-neutral). Source: `p1-mmtr-6-decompose-e2e-into-sub-tickets.md`. B-WEDGE mooted original fan-out AC. Closer (this session) serialized `install-ui-principles.test.js` to close a latent real-install concurrency flake (`ln: tsc: File exists` under parallel tier load); full gate (fast 5450✓ / integration 405✓ / expensive✓) green. | done |
| ~~5~~ | **B-GATE** ✅ SHIPPED v1.89.2 | — | #39 + #40 closed | `prds/p2-bug-fix-bundle-b-gate-verify-command-safety.md` — host-tool preflight (#39) + zsh shell-glob safety (#40) via shared `verify-command-safety.ts` wired into `ac-phase-gate.ts`/`convergence-gate.ts`, forward-protection lint, trap-door pins. Schema-neutral. Closer (this session) fix-forwarded a `containsUnquotedGlobHazard` eslint-complexity error and stripped a worker-hallucinated `Resolves: prds/p1-vsge.md` trailer from the R-VSGE-2 commit that failed audit-fix-commits. | done |
| ~~6~~ | **B-PPCD** ✅ SHIPPED v1.89.3 | — | #85 closed | `prds/p2-bug-fix-bundle-b-ppcd-pipeline-citadel-phase-list-drift.md` (doc-only: citadel-omitting 3-phase claim → real 4-phase in `pickle-pipeline.md` + `persona.md`; schema-neutral). Closer (babysitter) reconciled two `pickle-pipeline-skill.test.js` pins coupled to the old wording: trimmed line-1 description to ≤80 chars (kept citadel) and updated the Step 4 `--skip-*` regex to the 4-flag form. | done |
| ~~7~~ | **B-ACSG** ✅ SHIPPED v1.89.4 | — | #84 closed | `prds/p2-bug-fix-bundle-b-acsg-ac-shape-gate.md` (NARROW H1+H3: loosen field-bound matcher + `PICKLE_AC_GATE_DEBUG`, PRD-advisory/ticket-normative decouple + `--skip-ac-shape-gate`, LOA-727 regression fixture + monotonicity + negative-corpus, trap-door pin; schema-neutral). Closer (babysitter, this session) ff-reattached an orphaned R-ACSG-3 commit (spurious worker Failed-flip), fix-forwarded a missing `ac_shape_gate_bypassed` entry in `activity-logger.test.js`'s expected-events list, and ran the full gate (fast/integration-serial/expensive all green). | done |
| 8 | **B-WEDGE** | P2 | #30 R-RSU | `prds/p2-bug-fix-bundle-b-wedge-rsu.md` (refinement over-collapse: analyst-prompt fan-out guidance + non-throwing over-collapse guard + regression; schema-neutral). Source: `p2-pickle-refine-section-umbrella-granularity-bug.md`. INDEPENDENT of B-ACSG. **SHIPPED v1.89.5 (2026-06-01).** | ~5 |
| 9 | **B-MONITOR** | P3 | #29 R-MWCL | author — monitor `inferMonitorMode` szechuan/anatomy fall-through (#27 R-MMRT already closed v1.80.1) | ~4 |
| 10 | **B-LSOF** | P3 | #37e R-PIWG-5 | author — `lsof` launch-time concurrent-git-access probe | ~2-3 |
| 11 | **R-PSAI** | P3 | #12 | `prds/p2-pickle-pipeline-no-scope-auto-inference.md` (UX friction; lowest) | ~2 |
| 12 | **B-DWF** | P2 | (feature — no bug finding) | `prds/p2-dynamic-workflow-conversion-refine-prd-council.md` (convert `/pickle-refine-prd` + `/council-of-ricks` fan-out cores to Claude Code dynamic workflows; **researched + refined 2026-05-30**, no refinement needed). Feature → drains after the bug bundles. **Gated:** slot after B-PNTR (row 3 — verify the shared `mux-runner` call site, PRD Risk 9) AND after B-ACSG (row 7 — reconcile the `ac_shape_smells` parse-path logic collision, PRD Risk 7). **R-DWF-1 is a hard spike gate** (headless allowlist + batch-throughput probes); a FAIL shelves the bundle. Schema-neutral. | ~6 |
| 14 | **B-DSEK** | P3 | (feature — no bug finding) | `prds/deepseek-integration.md` (add `'deepseek'` as a third backend — ride the `claude` CLI via DeepSeek's Anthropic-compat shim with honest `'deepseek'` identity in state/logs/metrics/jar; Shape A). Draft complete (checklist ✓); pricing figures removed (intentionally rate-free — Pickle does not track $/token). Refinement recommended pre-launch. Feature → drains after the bug bundles + B-DWF. | ~4 |

**Watch-only — NOT in the drain (out of scope until their gate clears):**
- **B-CSI** (#25 R-CSI) — external-event-gated: needs a real concurrent-session destructive-command incident to analyze. Re-activates on the next incident. Not operator-interaction.
- **B-CCDC** — operator-deferred by choice (maybe-later).

---

## Open Findings

Open only — closed-finding detail in `MASTER_PLAN-archive.md`. Priority: **P1** = data-loss / pipeline-bricking / recurrence ≥3×; **P2** = pipeline-friction / quality gap; **P3** = polish / niche. Each is the authoring source for its Drain-Queue bundle.

### P1

| # | Code | Summary | Notes |
|---|---|---|---|
| 25 | R-CSI | Concurrent claude-session destructive-command interference (3 SIGINT incidents/36h) — DATA LOSS class | `p1-concurrent-claude-session-interference-with-running-pipelines.md`. **Watch-only — external-event-gated:** Phase 1 forensics need a real incident to analyze. Skipped by the drain; surfaces on the next incident. |
| ~~28~~ | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse — manager loop control regression | **CLOSED — SHIPPED v1.89.1 (B-R-MMTR).** R-ICDM-1 shipped; R-ICDM-2..7 conformance audits confirmed the fix intact at HEAD (reclassifier ternary, template relaxation, regression test, trap-door, event all present). |
| 77 | R-PNTR-DEPS | B-PNTR R-PNTR-1 (`d586b545`) wrongly deleted load-bearing `.claude/commands/pickle.md` (read every tmux iteration by mux-runner/pipeline-runner/jar-runner as the manager-prompt template) → `[FATAL] pickle.md not found`. Restored `40f22573`. **RE-SCOPED 2026-05-30** (operator-confirmed): `pickle.md` was dual-purpose (bare-`/pickle` command + manager template). **IMPLEMENTED R-PNTR-1..7** (session `2026-05-31-30c7524b`): extracted manager-lifecycle body to `_pickle-manager-prompt.md` (infra template via `extensionRoot/templates/`), repointed 3 consumers + `command_template` default, added schema-neutral resume remap, removed bare `/pickle`. Schema-neutral (dodges #74). **CLOSED — SHIPPED v1.89.0 (2026-05-31).** Closer (completed by babysitter) caught a latent FATAL: install.sh deployed the template to `$EXTENSION_ROOT/extension/templates/` but the runtime resolver reads `getExtensionRoot()/templates` = `$EXTENSION_ROOT/templates/`; added an explicit cp so fresh installs no longer FATAL. **B-PNTR.** |

### P2

| # | Code | Summary | Notes |
|---|---|---|---|
| ~~39~~ | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check → silent worker failures | **CLOSED — SHIPPED v1.89.2 (B-GATE).** `detectMissingTools` + `NON_GUARANTEED_TOOLS` in `verify-command-safety.ts`, wired as a preflight short-circuit into `runCriterion` (ac-phase-gate) + `runCheckCommand` (convergence-gate); regression tests + trap-door pins present. |
| ~~40~~ | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | **CLOSED — SHIPPED v1.89.2 (B-GATE).** String-form AC commands run glob-safe (argv-form or `set -f`, no bare `shell: true`); `containsUnquotedGlobHazard` predicate + forward-protection lint + regression tests + trap-door pins present. |
| ~~84~~ | R-ACSG | AC-shape collapse-or-justify gate oscillates, false-rejects properly-consolidated analyst tickets (smell count 2→9 across 3 attempts, no monotonicity; ~9 worker quotas burned in one incident). **CLOSED — SHIPPED v1.89.4 (B-ACSG).** NARROW H1+H3 fix: loosened the field-bound matcher to read joined `title`+`acceptance_test`+`justification` text + `PICKLE_AC_GATE_DEBUG` tracing (R-ACSG-1); decoupled PRD-advisory vs ticket-normative channels + `--skip-ac-shape-gate <reason>` escape hatch with actionable per-violation errors (R-ACSG-2); LOA-727 regression fixture + same-input monotonicity + negative-corpus no-regression tests (R-ACSG-3); trap-door pin (R-ACSG-TD). H2 cycle-3 freeze + H4 convergence-cost remain out of scope (not reproduced). |
| ~~85~~ | R-PPCD | `/pickle-pipeline` skill prompt + `persona.md` routing omit citadel and assert a false phase list. Real order is 4-phase pickle → citadel → anatomy-park → szechuan-sauce. **CLOSED — SHIPPED v1.89.3 (B-PPCD).** Both docs corrected to the real 4-phase order; closer reconciled two doc-coupled test pins and redeployed via `install.sh`. |

### P3

| # | Code | Summary | Notes |
|---|---|---|---|
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. (Demoted P2→P3: operator can pass `--scope`.) |
| ~~19~~ | R-MMTR | claude manager max-turns family closeout pending | **CLOSED — SHIPPED v1.89.1 (B-R-MMTR).** R-MMTR-1/5 shipped; 2/3/4 healed close-by-evidence (commits in main); 7 closer ran (babysitter). Residual R-MMTR-6 oversized E2E ticket → **B-E2E** row 4b, ✅ SHIPPED v1.89.6 — residual fully closed. |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR** (#27 R-MMRT half already closed v1.80.1). |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3). |
| 87 | R-LASP | Deployed `bin/log-activity.js:36` resolves the activity schema via `new URL('../src/types/activity-events.schema.json', import.meta.url)` → `~/.claude/pickle-rick/extension/src/types/…` which `install.sh` does NOT create; the schema is deployed to `extension/` root (`~/.claude/pickle-rick/extension/activity-events.schema.json`). Result: `log-activity.js` CLI logs `Failed to load activity schema: ENOENT` and degrades (fail-open, validation skipped). **Regression surfaced after v1.86.0 install (2026-05-30)** — worked earlier same session. Fix: align `log-activity.js` (TS source) schema resolution with `install.sh`'s deploy target (read from `extension/` root, with a `src/types/` fallback for the in-repo case), + a deploy-parity test. P3 (tooling, fail-open; pipelines unaffected — runtime logging uses compiled `state-manager.js`). Author bundle **B-LASP** (~2). |

---

## Feature Epics

**Shipped:** R-PGI v1.83.0 · R-PIAP v1.84.0 · R-DC v1.85.0. PRDs retained in `prds/`.
**Queued:** B-DWF (R-DWF) — dynamic-workflow conversion of the refine-prd + council fan-out cores; researched + refined; drain row 12, gated after B-PNTR + B-ACSG. `prds/p2-dynamic-workflow-conversion-refine-prd-council.md`.

### Deferred future epics (not in drain scope until activated)

- **Integrations:** `hermes-integration.md` (P2 ready); `p2-cli-backend-integration-pattern.md` (**R-CBI / B-CBI** — one contract for native-CLI Shape-B backends; instances **grok + kimi**; supersedes the standalone grok PRD; filed 2026-05-31) — (`deepseek-integration.md` → drain **B-DSEK** [Shape-A shim, separate]; `openrouter-multi-provider-workers.md` deleted 2026-05-30 — text-only, no tool use)
- **Refactor:** `god-functions-remediation-phase-2.md` (27 carve-outs)
- **Methodology PRDs:** `portal-gun.md`, `pickle-debate.md`, `pickle-microverse.md`
- **Design docs (no ship target):** `citadel.md`, `pickle-dot-codegen-builder.md`, `council-of-ricks-catalog-mode-and-publish-fixes.md`, `plumbus-generative-audit-frames.md`, `pickle-agent-teams.md`, `smart-iteration-handoff.md`, `tool-error-retry-tracking.md`

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `prds/citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (+ audit scripts + `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`). Green before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per bundle at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # launch ticket pipeline (tmux, all sizes)
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md`. Babysitter: `prds/babysitter.md`.
