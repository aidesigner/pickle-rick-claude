---
title: "B-GA — v2.0.0 reliability GA: drop the -beta suffix on reliability + honesty, defer capability"
priority: P1
finding: GA-EXIT
status: open
type: bug-bundle
schema_neutral: true
composes: ["#108 R-WPEX"]
defers_to: "prds/p2-codegraph-default-on-capability-v2.1.md (codegraph default-on capability)"
ships_as: v2.0.0-beta.7
target_version: "v2.0.0 GA (drop -beta) — promoted only AFTER the all-tier autonomy criteria are proven in real unattended runs, not merely green in tests"
release_principle: "reliability first, capability second, be ambitious — gate GA on reliability + honesty; sequence capability into v2.1"
source_assessment: "2026-06-16 three-scout grounded audit + four-lens editor re-baseline + codex adversarial review, all against HEAD"
---

# B-GA — Exit criteria for dropping `-beta` (v2.0.0-beta.6 → v2.0.0)

## 0. TL;DR for the reader who just cleared context

We are at `v2.0.0-beta.6`. The master plan is drained of shippable bug bundles. A grounded audit
(2026-06-16) — three scouts, a four-lens editor re-baseline, and a codex adversarial pass, all
against HEAD — settled the shape of the GA cut.

**Governing principle: reliability first, capability second, be ambitious.** GA is a *reliability*
cut. It is gated on all-tier unattended autonomy + honesty, and **nothing else**. The codegraph
*capability* play (turning it default-on) is sequenced into a separate, evidenced v2.1 fast-follow
(`prds/p2-codegraph-default-on-capability-v2.1.md`) — not because we are unambitious, but because
default-on is currently dark, unmeasured, and pulls an unaudited native dependency, so it cannot
honestly gate a *reliability* release.

This PRD does NOT re-specify work that already has a bundle (R-WPEX #108) — it composes it and adds
the small honesty workstream. The deliverable of B-GA is a state where dropping `-beta` is
defensible: every tier runs unattended, and source/deployed/docs tell the truth about what is on.

**HEAD re-baseline + codex corrections (2026-06-16) — folded:**
- Recovery rung-3 IS wired (`executeConvergedPlanAdapter` `mux-runner.ts:4754`, injected `:4835`);
  the residual is its clean-tree down-scope. But the earlier "reconstruct a diff" framing was
  **incoherent** (codex BL-2/3): the plan parser persists only `verify` commands
  (`recovery-controller.ts:251,269` — `verify: string | null`), never executable mutation steps, and
  a clean tree has no artifacts to stage. AC-GA-REC-1 is re-scoped to **plan RE-EXECUTION**, below.
- CGH-2 injection telemetry is already landed AND deployed (`b1089e97`). AC-GA-CG-2 is a verification
  gate, not build work.
- `#101 R-ONPD / #102 R-PDUP / #103 R-SFRS` are already RESOLVED v1.102.0 (MASTER_PLAN 158/178/179)
  — dropped from `composes:`; their disposition is a one-line citation.
- **Codegraph default-on is DEFERRED to v2.1.** The install.sh propagation sidecar, the efficacy A/B
  harness (`runProbe` is a stub — `codegraph-efficacy-probe.js:155`), the native-dep supply-chain
  policy, and the staged-default-on soak all move to `p2-codegraph-default-on-capability-v2.1.md`.
  GA only makes codegraph **honestly opt-in**.
- Corrected anchor paths (codex BL-4): MCP gate is `extension/src/services/backend-spawn.ts:471-479`
  (not `bin/`); config-protection hook is `extension/src/hooks/handlers/config-protection.ts:77-85`
  (not `hooks/config-protection.ts`).

**Hard ordering:** WS-2 (reliability) is the headline and drains FIRST — it is the GA blocker. WS-1
(codegraph honesty) is small and independent. WS-3 reduces to one citation.

---

## 1. Why this exists — the two-pillar finding

### Pillar A — Reliability / design-simplification: **strong, two real holes (the GA work)**

Verified shipped and working (HEAD 2026-06-16):
- D1/D2/D3 structural defects addressed at the design layer (not band-aids): skip-flags collapsed to
  the single `skip_quality_gates_reason` surface with an audit gate against new ones; the
  `reconcileTicketTruth` + `salvageTicket` primitives are built, wired, and matrix-tested
  (`extension/src/lib/`, `salvage-ticket-matrix.test.js`); salvage-before-fail is the default at
  fail/cancel/timeout seams; recovery ladder shipped (B-ORSR v1.102.0) with terminal moved from the
  trigger-happy `closer_handoff_terminal` to `recovery_exhausted`; `/pickle-recover` is the single
  sanctioned re-entry.
- Recovery rung-3 IS wired (`executeConvergedPlanAdapter` `mux-runner.ts:4754`, bound at `:4835`,
  R-ORSR-3 `e8f46d84`): it parses authored Phases via `parsePlanPhases`, runs each Phase's `verify`,
  and commits per Phase through `executePhaseLoop`.

The two holes that keep autonomy at "semi-" (both source-verified; these ARE the GA reliability work):
- **Rung-3 cannot recover the CLEAN-TREE converged case** (the most common babysitter hand-build:
  approved `plan_*.md` on disk, zero diff). The cause is structural, not a tweak: the plan parser
  keeps only `verify` *check* commands (`recovery-controller.ts:251,269`), never the implementation
  steps, so there is nothing to "replay" to regenerate edits; and a clean tree has no artifacts to
  stage (`mux-runner.ts:4746-4753` documents the down-scope → per-Phase `git commit` finds nothing →
  rung honestly returns `ok:false` → escalation). The honest recovery is **re-execution**: re-run an
  implement pass against the already-approved plan (exactly what the babysitter does by hand today via
  the `morty-phase-implementer` subagent), producing real edits to commit.
- **R-WPEX #108 large-tier silent death** has no autonomous path. Mechanism captured (MASTER_PLAN row
  152, session `2026-06-13-2bd4740a`, ticket `fb60850a`): a headless `claude -p` MANAGER cannot hold a
  >600s large-tier worker against the 600s Bash-tool ceiling — foreground `spawn-morty` is SIGKILLed at
  600s (→ 0-byte log) and the bg+Monitor improvisation reaps the worker when the headless `-p` emits
  its final text. Net: small/medium run unattended; **large-tier needs interactive `/pickle-tmux` or
  phase-decomposition.** This is the honest reason "autonomous" is currently "semi-autonomous" — and
  closing it is the single biggest reliability lever in the cut.

### Pillar B — Codegraph: **well-engineered, but ships opt-in at GA (capability deferred)**

Service layer is good: fail-open, lazy native import, timeout races, corruption-quarantine,
kill-switch, ~1,700 LOC of tests; CGH-2 telemetry landed. But three compounding, verified facts mean
default-on is a v2.1 capability cut, not a GA gate:

1. **It is off in the deployed runtime.** Source `pickle_settings.json` = `enabled:true /
   index_at_setup:true`; deployed `~/.claude/pickle-rick/pickle_settings.json` = `false / false`;
   CLAUDE.md claims "Default-ON since beta.4"; README.md says opt-in/disabled-by-default. All four
   disagree — that is the honesty defect GA must fix.
2. **The default-on flip cannot honestly propagate to existing installs.** `install.sh:479` merges
   `jq -s '.[0] * .[1]'` (deployed values win), so an existing `false/false` install is
   indistinguishable from a deliberate operator disable. Solving that (an intent marker) is real work
   — it lives in v2.1, not GA.
3. **Default-on is unmeasured and pulls an unaudited native dep.** The efficacy probe is a stub
   (`runProbe` → `loadCorpus` only, `codegraph-efficacy-probe.js:155`), and `install.sh:441-469` does
   `npm install --no-save @colbymchenry/codegraph@0.9.9 --no-audit`. Forcing that on every operator at
   setup is exactly the kind of risk a *reliability* GA must not take.

**Lane note (HEAD-verified):** the in-process injection lane DOES traverse the graph —
`buildCodegraphContextSection` calls `searchNodes` (`spawn-morty.ts:665`), `getCallers` (`:680`),
`buildContext` (`:756`), capped at `context_max_bytes`. `expose_mcp_to_workers:false`
(`backend-spawn.ts:471-479`) gates only the SEPARATE interactive MCP lane. So opt-in codegraph at GA
still gives an opted-in operator a rich static graph slice; only the interactive query lane is off.

**Conclusion:** GA ships codegraph **opt-in** with source/deployed/docs reconciled to the truth. The
ambitious default-on flip is earned in v2.1 with a real harness, a supply-chain policy, and a
propagation mechanism (`prds/p2-codegraph-default-on-capability-v2.1.md`).

---

## 2. Workstreams

### WS-2 — Reliability: finish all-tier autonomy (GA blocker — drains FIRST; composes R-WPEX #108)

Goal: "the babysitter drains the plan unattended" is true for ALL tiers, not just small/medium.

- **AC-GA-REC-1 — rung-3 recovers the CLEAN-TREE converged case via plan RE-EXECUTION.** When
  `treeDirty=false`, `planConvergedUncommitted=true`, `noWorkProduced=false` (approved `plan_*.md` +
  research artifacts on disk, zero diff), the ladder MUST advance the ticket by **re-running an
  implement pass against the already-approved plan** — spawn the implementer over the persisted plan,
  let it produce real edits, then commit per the existing rung-3 Phase-commit path. It MUST NOT attempt
  to "reconstruct a diff" from `verify` commands (structurally impossible — `recovery-controller.ts:251`
  persists only `verify`). It MUST route through `salvageTicket`/`reconcileTicketTruth`, be idempotent
  (a second invocation on an already-advanced ticket is a no-op, not a double-apply), and leave the
  dirty-tree path unchanged. If re-execution yields no diff (plan already fully realized), the rung
  reconciles the ticket to its true terminal state rather than looping. — Type: test
  (`recovery-controller.test.js` clean-tree re-execution advances; integration test with a real
  approved-plan fixture and a stubbed implementer)
- **AC-GA-REC-2 — R-WPEX #108 large-tier autonomy fallback landed (per its bundle).** PRIMARY GA
  deliverable: the **large-tier routing fallback** — route large-tier tickets to interactive
  `/pickle-tmux` (a persistent REPL that survives the 600s turn ceiling) OR phase-decompose so each
  manager iteration < 600s — proven by an integration test that a large-tier ticket has a sanctioned
  autonomous path. The candidate-1 exit-drain change (250ms → 30–60s `'exit'` fallback in spawn-morty)
  is NOT confirmed by the captured repro and is CONDITIONAL/post-GA. (NB: the composed
  `p1-bug-fix-bundle-r-wpex-worker-silent-death.md` body still reads "NEEDS A REAL-WORKER REPRO"; it is
  stale vs MASTER_PLAN row 152 and must be reconciled to the captured mechanism before this AC is
  refined.) — Type: test + bundle-completion
- **AC-GA-REC-3 — typecheck + lint clean.** — Type: typecheck

### WS-1 — Codegraph honesty: make opt-in the truth (small, independent)

Goal: source / deployed / docs all agree that codegraph is opt-in. No install.sh surgery, no efficacy
run, no default-on — all deferred to v2.1.

- **AC-GA-CG-1 — source default reconciled to opt-in.** Set source `pickle_settings.json`
  `codegraph.enabled=false`, `index_at_setup=false` to match deployed reality. (This makes the
  `jq -s` merge a no-op for codegraph — no propagation mechanism needed at GA; that mechanism is the
  v2.1 prerequisite for the eventual default-on flip.) — Type: test (source defaults are opt-in)
- **AC-GA-CG-2 — docs reconciled to opt-in, BOTH files, real lane split.** CLAUDE.md and README.md
  both describe codegraph as opt-in/disabled-by-default; the literal string `Default-ON since B-CGH`
  is ABSENT from CLAUDE.md; the README claim that Claude-family workers get `codegraph serve --mcp` is
  corrected (it is false when `expose_mcp_to_workers !== true`, `backend-spawn.ts:477-490`) — document
  the real split: injected-context lane is live for opted-in sessions, interactive MCP lane is gated
  off. Per the project Documentation Rule, README reflects the shipped command/flag behavior. — Type:
  test (hermetic: greps source `pickle_settings.json` + CLAUDE.md + README.md; no read of the
  env-coupled `~/.claude/...` file)
- **AC-GA-CG-3 — every CGH-2 injection-telemetry event is wired across all surfaces (verification;
  already landed `b1089e97`).** For **every** event name in the set {`codegraph_context_injected`,
  `codegraph_context_skipped`}, that event satisfies **all three** invariants: (i) registered in every
  schema surface (`src/types/index.ts:769-770`, `activity-events.schema.json`, and the deployed root
  schema), (ii) emitted from `buildCodegraphContextSection` with `sessionDir` + `ticketId`, and (iii)
  aggregated via `countCodegraphContextEvents` (`mux-runner.ts:793`). The acceptance test is a single
  parametrized `describe.each([['codegraph_context_injected'], ['codegraph_context_skipped']])`
  conformance test asserting the three invariants per event; no new emission code — it fails only on
  regression. — Type: test (verification)
- **AC-GA-CG-4 — typecheck + lint clean.** — Type: typecheck

### WS-3 — Residual disposition (drains LAST; citation-only)

- **AC-GA-POL-1 — R-ONPD/R-PDUP/R-SFRS disposition cited (no build).** GA notes cite MASTER_PLAN rows
  158/178/179 confirming `#101/#102/#103` RESOLVED v1.102.0 (B-ORSR) with HEAD-reachable SHAs; removed
  from `composes:`. — Type: artifact (citation-only)

---

## 3. GA exit criteria (the gate for dropping `-beta`)

`v2.0.0` ships only when ALL of the following are machine-checkable green:

1. **All-tier autonomy (the reliability gate — first goal).** AC-GA-REC-1..3 green: rung-3 recovers
   the clean-tree converged case via re-execution, and the R-WPEX large-tier routing fallback is
   landed + tested. No tier silently requires a human hand-build.
2. **Codegraph honesty.** AC-GA-CG-1..4 green: source / deployed / docs (CLAUDE.md + README) all agree
   codegraph is opt-in; the stale "Default-ON" and `serve --mcp` claims are gone; CGH-2 telemetry
   verified. (Default-on, the efficacy harness, the propagation sidecar, and the native-dep policy are
   v2.1, not GA — `prds/p2-codegraph-default-on-capability-v2.1.md`.)
3. **No silent design residue.** AC-GA-POL-1 green: the three deferred recovery classes are
   dispositioned in the open (cited RESOLVED v1.102.0).
4. **Back-compat proven across the beta→GA line.** A `v2.0.0-beta.6` session `state.json` resumes
   cleanly under the GA-deployed runtime — not just the existing TS↔compiled-JS constant parity
   (`state-schema-version-deploy-parity.test.js` checks only that). `LATEST_SCHEMA_VERSION == 5`
   unchanged (validates `schema_neutral:true`); a resume smoke test exercises a real beta.6 state file
   end-to-end. — Type: test (`extension/tests/beta6-ga-session-resume.test.js`, forward-created)
5. **Engineering gate green.** The full release gate from `extension/` passes (tsc --noEmit, eslint
   --max-warnings=-1, tsc, all `audit-*.sh`, test:fast:budget, test:integration, `RUN_EXPENSIVE_TESTS=1`
   test:expensive) on a clean tree with compiled JS matching TS, AND the install.sh MD5 parity gate
   green. (CI-green remains hygiene, not a gate — R-CIFB #115 stays watch-only.)
6. **Migration / release note authored.** A GA release note records: the final codegraph posture
   (opt-in + why), beta-session compatibility, and the remaining known manual-recovery limits — so
   "GA" does not over-promise stability the recovery ladder cannot yet meet. — Type: artifact
7. **Version + release — ships as the next BETA, not GA.** This bundle's first shippable cut is
   `v2.0.0-beta.7` (the reliability + honesty increment): bump `extension/package.json`
   `2.0.0-beta.6` → `2.0.0-beta.7`, commit `chore: bump version to 2.0.0-beta.7`, `bash install.sh`,
   verify clean tree + JS-matches-TS, `git push`, `gh release create v2.0.0-beta.7` (prerelease).
   READ the gate result and confirm green BEFORE bump/commit/tag. **GA PROMOTION (drop `-beta` →
   `2.0.0`) is a SEPARATE downstream step**, taken only after criteria 1–4 are not just green in
   tests but demonstrated across real unattended runs (all-tier autonomy soaked, no silent
   hand-builds). Tests passing earns beta.7; field-proof earns GA. Standing babysitter authorization
   covers push + release on a green gate.

---

## 4. Out of scope (deferred to v2.1 capability cut or watch-only)

- **Codegraph default-on + everything that earns it** — the A/B harness (`runProbe` stub), native-dep
  supply-chain policy, install.sh default-flip propagation sidecar, staged-default-on soak, and the
  `expose_mcp_to_workers` interactive-lane decision. All in `prds/p2-codegraph-default-on-capability-v2.1.md`.
- **B-CSOR #118 (citadel graduated remediation)** — post-GA fast-follow. Verified NOT shipped
  (`isMechanicalCitadelFinding` absent from `extension/src/`); citadel is surface-only and sub-Critical
  findings fall through to advisory, which is honest behavior, not a silent defect. GA ships with it
  open and queued.
- R-CIFB #115 CI-red — hygiene, never a release gate; watch-only.
- R-CSI #25 — external-event-gated; cannot drain without a real incident.
- Any new feature epic. B-GA is a reliability/honesty cut.

## 5. Ticket classes (for refinement)

- **WS-2 (GA blocker, first):** rung-3 clean-tree re-execution recovery (impl + test) · R-WPEX
  large-tier routing fallback (per its bundle; reconcile the stale R-WPEX body first) · candidate-1
  drain fix (conditional/post-GA).
- **WS-1:** source default → opt-in · docs reconciliation CLAUDE.md + README (hermetic test) · CGH-2
  telemetry verification test.
- **WS-3:** recovery-class disposition citation artifact.
- **Closer:** beta6→GA resume smoke test, schema/parity preconditions, full release gate, migration
  note, GA bump to 2.0.0, install.sh, push, `gh release create v2.0.0`.

## 6. Notes

Source assessment: 2026-06-16 three-scout grounded audit, four-lens editor re-baseline, codex
adversarial review — all against HEAD. Governed by the standing release principle (reliability first,
capability second, be ambitious). Corrections folded:
- AC-GA-REC-1 re-scoped from the incoherent "reconstruct a diff" to **plan re-execution** (codex
  BL-2/3: parser persists only `verify`, `recovery-controller.ts:251`; clean tree has no artifacts to
  stage).
- Codegraph default-on + propagation + efficacy + native-dep all DEFERRED to v2.1 (codex BL-1/MAJ-1/
  MAJ-3): default-on can't honestly propagate to existing installs, the efficacy harness is a stub,
  and the native dep is `--no-audit`. GA ships opt-in.
- Anchor paths corrected (codex BL-4): `services/backend-spawn.ts:471-479`,
  `hooks/handlers/config-protection.ts:77-85`.
- Added beta6→GA session-resume smoke test (codex MAJ-4: parity test only checks constant equality)
  and a required GA migration/release note (codex MIN-2). Dropped the install.sh sidecar
  config-protection gate (codex MIN-1: a root sidecar participates in neither the hook nor the MD5
  parity probe) — moot here anyway since the sidecar moves to v2.1.
- CGH-2 telemetry already landed/deployed (`b1089e97`) → verification gate. `#101/#102/#103` RESOLVED
  v1.102.0 → citation.

Composes the existing R-WPEX bundle (`p1-bug-fix-bundle-r-wpex-worker-silent-death.md`); defers
capability to `p2-codegraph-default-on-capability-v2.1.md`. No remaining operator decision blocks
refinement — the codegraph posture is resolved (opt-in at GA) by the release principle.

### 6.1 Deferred recovery-class disposition (GA exit criterion 3 / AC-GA-POL-1)

The three recovery classes dropped from the GA `composes:` list are dispositioned in the open: all
RESOLVED v1.102.0 (B-ORSR), each with its `prds/MASTER_PLAN.md` row and a HEAD-reachable resolving SHA.
GA carries no silent design residue. (MASTER_PLAN rows referenced in this bundle as **158/178/179**;
the resolved R-code rows are actually at lines 162/182/183 of the current `prds/MASTER_PLAN.md`.)

- **#101 R-ONPD** — MASTER_PLAN row 158 (actual line 162) — RESOLVED v1.102.0 (B-ORSR): R-ORSR-3
  oversized taxonomy `plan_converged_uncommitted` (`3baf038b`) + R-ORSR-5 refiner decomposition-quality
  flag (`337c5157`). Both HEAD-reachable.
- **#102 R-PDUP** — MASTER_PLAN row 178 (actual line 182) — RESOLVED v1.102.0 (B-ORSR): R-ORSR-4
  phantom split-original auto-close with explicit `completion_commit` (`c119b78c`). HEAD-reachable.
- **#103 R-SFRS** — MASTER_PLAN row 179 (actual line 183) — RESOLVED v1.102.0 (B-ORSR): R-ORSR-6
  no-self-disown guard + interface-change consumer sweep (`091f47a2`). HEAD-reachable.

Summary line (single-grep): `R-ONPD` / `R-PDUP` / `R-SFRS` all RESOLVED v1.102.0 (B-ORSR), MASTER_PLAN
rows 158/178/179, SHAs `3baf038b` `337c5157` `c119b78c` `091f47a2` — all ancestors of GA HEAD.
