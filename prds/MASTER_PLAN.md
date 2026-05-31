---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Updated 2026-05-30.** Live ledger the babysitter (`prds/babysitter.md`) drains each tick — kept lean on purpose (re-read every 30 min). Shipped releases + closed-finding detail live in `MASTER_PLAN-archive.md` and `git log`.

## Status

| Item | Value |
|---|---|
| Version (source/deployed) | **v1.88.0** — 2026-05-31 |
| Latest GitHub release | v1.88.0 (v1.81.1..v1.88.0 all tagged) |
| Active pipeline | none — **B-CMWL** shipped v1.88.0 (session `2026-05-30-6333da9a`); next drain row: B-PNTR |
| Codex backend | `gpt-5.4` |

**Priority directive:** drain bug bundles before feature epics; P1 > P2 > P3. All feature epics (R-PGI v1.83.0 / R-PIAP v1.84.0 / R-DC v1.85.0) are shipped.

**Autonomy directive (2026-05-30):** the babysitter drains the ENTIRE plan with zero operator interaction — including the full release cycle (`git push` + `gh release create`), gated only on a green release gate + clean tree. Nothing here should require operator interaction. Sole permitted residue: external-event-gated work (#25 R-CSI needs a real concurrent-session incident to analyze).

---

## Drain Queue

The ordered worklist. Each tick the babysitter takes the top non-blocked row, launches its PRD (or authors one from the source in **Open Findings**, then launches), ships it through release, and repeats. Bugs before features, P1 > P2 > P3.

| # | Bundle | Pri | Open findings | PRD / source | Size |
|---|--------|-----|---------------|--------------|------|
| 3 | **B-PNTR** | P1 | #77 R-PNTR-DEPS | `prds/p2-remove-non-tmux-pickle-loop.md` (RE-SCOPED 2026-05-30: extract manager template to `_pickle-manager-prompt.md`, then remove bare `/pickle`; schema-neutral). Refinement recommended pre-launch. | ~9 |
| 4 | **B-R-MMTR** + **B-E2E** | P1+P3 | #28 R-ICDM, #19 R-MMTR | author — R-ICDM-2..7 audit + R-MMTRH heal + R-MMTR-7 closer; B-E2E re-attempts force-skipped R-MMTR-6 after | ~6 |
| 5 | **B-GATE** | P2 | #39 R-PVTA, #40 R-VSGE | author — verify-command host-tool check (#39) + zsh shell-glob safety (#40) | ~4+4 |
| 6 | **B-PPCD** | P2 | #85 R-PPCD | author — doc-only: citadel phase list in `pickle-pipeline.md` + `persona.md` (verified still drifted 2026-05-30) | ~1-2 |
| 7 | **B-ACSG** | P2 | #84 R-ACSG | `prds/BUG-REPORT-2026-05-27-refine-prd-ac-shape-gate-oscillation.md` (4 hypotheses — narrow=matcher, wide=convergence arch) | ~3-8 |
| 8 | **B-WEDGE** | P2 | #30 R-RSU | R-RSU refinement over-collapse (#33 R-WMW shipped with B-WSWA v1.86.0 per overlap rule; absorbs B-QSRC R-RSU residual; R-QGSK already shipped) | ~3 |
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
| 28 | R-ICDM | claude iteration classifier `detectManagerMaxTurnsExit` misuse — manager loop control regression | R-ICDM-1 shipped; R-ICDM-2..7 audit. **B-R-MMTR.** |
| 77 | R-PNTR-DEPS | B-PNTR R-PNTR-1 (`d586b545`) wrongly deleted load-bearing `.claude/commands/pickle.md` (read every tmux iteration by mux-runner/pipeline-runner/jar-runner as the manager-prompt template) → `[FATAL] pickle.md not found`. Restored `40f22573`. **RE-SCOPED 2026-05-30** (operator-confirmed): `pickle.md` is dual-purpose (bare-`/pickle` command + manager template). The bundle now **extracts** the manager-lifecycle body to `_pickle-manager-prompt.md` (infra template via the dormant `extensionRoot/templates/` resolver), repoints 3 consumers + the `command_template` default, adds a schema-neutral resume remap, then removes bare `/pickle`. Schema-neutral (dodges #74). PRD updated `prds/p2-remove-non-tmux-pickle-loop.md`, ~9 tickets, refinement recommended. **B-PNTR.** |

### P2

| # | Code | Summary | Notes |
|---|---|---|---|
| 30 | R-RSU | refinement collapses `composes:` bundle PRDs to N section-umbrellas | R-RSU-1..5; B2-RSU residuals. **B-WEDGE.** (Possibly shares a matcher with #84 — inverse: over-collapse vs under-acceptance.) |
| 39 | R-PVTA | verification commands use `rg`/`fd`/`bat`/`jq` without host-tool check → silent worker failures | PRD not drafted (~4). **B-GATE.** |
| 40 | R-VSGE | verification commands with shell-special chars error under zsh glob expansion | PRD not drafted (~4). **B-GATE.** |
| 84 | R-ACSG | AC-shape collapse-or-justify gate oscillates, false-rejects properly-consolidated analyst tickets (smell count 2→9 across 3 attempts, no monotonicity; ~9 worker quotas burned in one incident). Workarounds: table-driven PRD reshape or `--no-refine`. 4 root-cause hypotheses in PRD as a decision tree (H1 matcher-too-literal, H2 cycle-3 oscillation, H3 PRD/ticket conflation, H4 convergence-cost). `prds/BUG-REPORT-2026-05-27-refine-prd-ac-shape-gate-oscillation.md`. Sized ~3-8. **B-ACSG.** |
| 85 | R-PPCD | `/pickle-pipeline` skill prompt + `persona.md` routing omit citadel and assert a false phase list ("only runs build → anatomy-park → szechuan-sauce"). Real order is 4-phase pickle → citadel → anatomy-park → szechuan-sauce (`pipeline-runner.ts:normalizePipelinePhases` auto-splices citadel). Doc-only drift but misleads planning. Fix: `pickle-pipeline.md` (header, line-13 claim, Step 4 default array + template, Step 8 report) + `persona.md` routing line (edit source per [[feedback_persona_source_of_truth]], config-protected) + `bash install.sh`. Sized ~1-2. **B-PPCD.** |

### P3

| # | Code | Summary | Notes |
|---|---|---|---|
| 12 | R-PSAI | `/pickle-pipeline` ignores branch/subset signals in operator kickoff | `p2-pickle-pipeline-no-scope-auto-inference.md`. (Demoted P2→P3: operator can pass `--scope`.) |
| 19 | R-MMTR | claude manager max-turns family closeout pending | R-MMTR-1/5 shipped; 2/3/4 Skipped+commit; 6 force-skipped; 7 closer pending. **B-R-MMTR / B-E2E.** |
| 29 | R-MWCL | monitor `inferMonitorMode` falls through to `'pickle'` for szechuan/anatomy | R-MWCL-1 shipped; 3..7 residual. **B-MONITOR** (#27 R-MMRT half already closed v1.80.1). |
| 37e | R-PIWG-5 | git-isolation residual: `lsof` launch-time concurrent-access probe | **B-LSOF** (~2-3). |
| 87 | R-LASP | Deployed `bin/log-activity.js:36` resolves the activity schema via `new URL('../src/types/activity-events.schema.json', import.meta.url)` → `~/.claude/pickle-rick/extension/src/types/…` which `install.sh` does NOT create; the schema is deployed to `extension/` root (`~/.claude/pickle-rick/extension/activity-events.schema.json`). Result: `log-activity.js` CLI logs `Failed to load activity schema: ENOENT` and degrades (fail-open, validation skipped). **Regression surfaced after v1.86.0 install (2026-05-30)** — worked earlier same session. Fix: align `log-activity.js` (TS source) schema resolution with `install.sh`'s deploy target (read from `extension/` root, with a `src/types/` fallback for the in-repo case), + a deploy-parity test. P3 (tooling, fail-open; pipelines unaffected — runtime logging uses compiled `state-manager.js`). Author bundle **B-LASP** (~2). |

---

## Feature Epics

**Shipped:** R-PGI v1.83.0 · R-PIAP v1.84.0 · R-DC v1.85.0. PRDs retained in `prds/`.
**Queued:** B-DWF (R-DWF) — dynamic-workflow conversion of the refine-prd + council fan-out cores; researched + refined; drain row 12, gated after B-PNTR + B-ACSG. `prds/p2-dynamic-workflow-conversion-refine-prd-council.md`.

### Deferred future epics (not in drain scope until activated)

- **Integrations:** `hermes-integration.md` (P2 ready) — (`deepseek-integration.md` promoted to drain row 13 / **B-DSEK** on 2026-05-30; `openrouter-multi-provider-workers.md` deleted 2026-05-30 — text-only workers with no tool use are useless to the lifecycle without a tool proxy)
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
/pickle-tmux <prd>                   # 3+ tickets
/pickle <prd>                        # 1-2 tickets, interactive
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md`. Babysitter: `prds/babysitter.md`.
