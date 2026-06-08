# PRD: Full Review/Cleanup Stack Missed 14 Human-Review Defects on a Large Migration PR (LOA-907)

**Status**: Bug PRD / quality-gate efficacy gap (2026-06-08). The complete automated review+cleanup stack ran on a 117-file LangGraph-migration PR — `/pickle-pipeline` (incl. anatomy-park + szechuan-sauce), then THREE additional ultracode agent-team reviews (breadth code review, anatomy-park-depth re-run, CLAUDE.md audit). All reported the branch clean (0–1 trivial findings). A human reviewer (Jorge, `jcapona`) then opened the PR and found **14 real issues: 2 Critical, 8 Warning, 3 Simplification, 1 Historical.** Every one was inside the diff the gates already scanned.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/anatomy-park-szechuan-monorepo-missed-detection-gap.md` (the monorepo-flattening miss). Same family: declared-scope defects the post-pipeline review phases did not surface. That PRD fixed monorepo subsystem discovery; this PRD targets the **defect CLASSES the scan has no dimension for**, on a *single-package* target where flattening is not the excuse.
**Triggering work**: loanlight-api PR #1707 (`gregory/loa-907-...`), the appraisal LangGraph migration. Reviews run this session: ultracode breadth review (12 agents → 0 confirmed), anatomy-park scoped re-run (converged clean, 0 findings), szechuan-sauce (1 trivial dead-export removal), CLAUDE.md accuracy/token/efficacy audit. Jorge's review: 14 issues.

---

## What was missed

| # | Jorge issue | Severity | Should have been caught by | Why it slipped |
|---|-------------|----------|---------------------------|----------------|
| 1 | `appraisal.processor.ts` passes `lenderId` (UUID) into the `lenderCode: string` parameter → every LangSmith trace mislabeled with the UUID | **Critical** | data-flow trace; the PR's own AC-4 "observability verified" claim | **Type-correct, semantically-wrong.** Both args are `string`, so typecheck + type-aware data-flow tracing see nothing. No dimension checks "variable named `lenderId` flows into a parameter named `lenderCode`." The PR even *verified* the trace existed — but not that its **label value** was right. |
| 2 | Three sites do `Math.round(pipelineResult.coverage.coverage_pct * 100)`; the graph's empty-result fallback returns `coverage: {}` → `NaN` persisted to a numeric DB column | **Critical** | anatomy-park combinatorial-branch / null-flow verification | **Cross-file empty/fallback null-flow.** The `{} as T` fallback producer lives in `langgraph.service.ts`; the unguarded consumers live in `appraisal.processor.ts`. No phase traced "this function can return a partial `{} as T` — are all consumers guarded?" Same cross-file producer→consumer gap as the sibling PRD, but single-package. |
| 3 | Graph's `evaluateRules` node runs full compliance into `state.complianceResults`, but the output type drops it and the processor re-runs — double eval; node uses a module-level `let sharedDb = new pg.Pool({max:1})` outside DI, never closed | **Warning** | anatomy-park architectural / resource-lifecycle review | **No resource-lifecycle dimension.** Nothing flags a module-scope mutable connection/pool created outside DI and never closed. And nothing flags "this node's output is computed then discarded" (dead work across a type boundary). |
| 6 | `0154` migration step 2 `ON CONFLICT DO UPDATE SET enabled=false` silently downgrades any lender that already has `appraisal=true` | **Warning** | szechuan Override 6 (Migration Hygiene) | **Override 6 has no conflict-resolution-data-loss check.** It covers idempotency + constraint/enum drift, not "this `DO UPDATE SET col=const` clobbers a column another feature owns." |
| 7 | `fs.readFileSync('/etc/ssl/.../rds-ca-bundle.pem')` runs synchronously inside the graph node hot path (after paid extraction), per invocation | **Warning** | anatomy-park hot-path / blocking-IO review | Same root as #3 (the self-contained DB fallback). No dimension flags sync FS reads inside a node body / event-loop-blocking IO on the hot path. |
| 9 | `app.invoke(state as never)` — `as never` is a **direct repo CLAUDE.md trap-door violation** ("Never `as Type` when TS infers; only cast across untyped boundaries") | **Warning** | szechuan-sauce trap-door conformance; citadel | **The most damning miss.** A repo-wide trap door forbids exactly this pattern, yet `as never` (introduced by the diff) survived szechuan's principle scan. The scan does not grep the diff against the repo's own declared forbidden patterns. |
| 10 | New migration specs added to `jest.containers.config.json` + CI but **not** `package.json::testPathIgnorePatterns` — incomplete three-place edit (the rule is documented in root CLAUDE.md) | **Warning** | szechuan three-place-edit / containers-wiring conformance | A *documented* multi-place-edit invariant was left incomplete; no phase verifies "all N places of a known three-place edit were touched together." |
| 11 | `normalizeFormType(state.formType ?? "1004") as FormType` duplicated across 5 node files | Simplification | szechuan DRY (Rule of Three) | 5 occurrences > Rule-of-Three threshold, across sibling node files. The DRY scan did not cluster the cross-file repetition. |
| 13 | `default:` arm on a switch over a `0\|90\|180\|270` union defeats exhaustiveness | Simplification | szechuan type-safety / exhaustiveness | Exhaustiveness-defeating `default` on a narrowed union is a known anti-pattern with no scan rule. |
| 14 | Comment introduced by this PR is already stale (`via isCompoundRulesEnabled` → actually `isAppraisalEnabled`); has a **re-drift history** (flagged by a different human on PR #1602) | Historical | szechuan self-documenting-code; CLAUDE.md accuracy audit | The CLAUDE.md audit checked *doc files*, not *code comments introduced by the diff*. A comment that contradicts the code 20 lines below it is invisible to a docs-only audit. |

(#4 batched-query latency regression, #5 default-flip test-gap, #8 silent-1004-ATTOM-refusal, #12 boolean collapse omitted from the table for brevity — same families: latency-regression has no dimension; missing-regression-test has no dimension; silent-behavior-change-without-test has no dimension.)

**14 of 14 were in declared scope. Four full review passes (one human-equivalent each in token spend) surfaced essentially none of them. This is a systemic dimension gap, not bad luck.**

---

## Root-cause themes (what the scan structurally cannot see)

1. **Type-correct / semantically-wrong values** — same-typed args swapped (UUID vs code). Invisible to typecheck and type-aware data-flow. (#1)
2. **Cross-file empty/fallback null-flow** — a `{} as T` / partial fallback producer in file A; unguarded field access in file B. (#2)
3. **Resource-lifecycle defects** — module-scope pool/handle/connection created outside DI, never closed; sync FS/IO on a hot path. (#3, #7)
4. **Trap-door / declared-invariant conformance on the diff** — the repo *documents* forbidden patterns (`as never`, three-place edits) and the scan does not check the diff against them. (#9, #10)
5. **Migration conflict-resolution data-loss** — `ON CONFLICT DO UPDATE SET col=const` clobbering a column another feature owns. (#6)
6. **Missing-regression-test / silent-behavior-change** — a default flip or a universal off-switch shipped without a test pinning it. (#5, #8)
7. **Stale code comments introduced by the diff** — the CLAUDE.md audit covers doc files, not in-code comments. (#14)

The common shape: the existing phases scan for **principle violations in code-as-written** and **data-flow within a file/subsystem**. They have **no rule that cross-references the diff against the repo's own declared constraints**, and **no dimension for resource lifecycle, cross-file fallback null-flow, or semantic (not type) identity.**

---

## Proposed remediation (ACs)

Each AC names the issue(s) it would have caught.

- **AC-1 — Trap-door-conformance diff scan (citadel + szechuan).** Before scoring, harvest every `PATTERN_SHAPE:`, "Never …", "MUST …", and documented multi-place-edit rule from all in-scope `CLAUDE.md` files; grep the **diff** for new violations and emit P0/P1. Would catch **#9 (`as never`)** and **#10 (three-place edit)** — both are explicitly documented in this repo's CLAUDE.md. (Highest leverage: the repo already wrote down what not to do.)
- **AC-2 — Resource-lifecycle dimension (anatomy-park).** Flag: module-scope mutable connection/pool/client created outside DI; any `new Pool(`/`createConnection(`/`.connect(`/`open(` without a matching close in the lifecycle; sync `fs.readFileSync`/blocking IO inside a graph-node/handler hot path. Would catch **#3 + #7**.
- **AC-3 — Cross-file fallback null-flow trace (anatomy-park, extends sibling PRD).** When a function returns a partial/`{} as T`/`Partial<T>` fallback, trace every consumer of that return for unguarded field access (`x.field.subfield`, `Math.round(x.maybe * n)`). Would catch **#2**.
- **AC-4 — Migration conflict-resolution data-loss check (szechuan Override 6 extension).** Flag `ON CONFLICT … DO UPDATE SET <col>=<const>` where `<col>` is written by another feature/migration → P1, require `DO NOTHING` or an explicit guard. Would catch **#6**.
- **AC-5 — Missing-regression-test for behavior changes (citadel / spec-conformance).** When the diff flips a default, removes a fallback path, or makes a guard universal, require a new/changed spec that pins the new behavior; else P2. Would catch **#5 + #8**.
- **AC-6 — In-code stale-comment check (szechuan self-documenting-code).** For comments **added/modified by the diff** that cite a symbol/function/flag, verify the cited name still matches the code in the same hunk/file. Would catch **#14** (and its prior re-drift on #1602). The CLAUDE.md audit must extend from doc files to diff-introduced code comments.
- **AC-7 — Semantic-identity heuristic (stretch).** Flag a positional call argument whose source variable name strongly mismatches the parameter name on the **same type** (e.g. `lenderId` → `lenderCode: string`). Lower confidence; report-only. Would catch **#1**.

**Priority within the bundle:** AC-1 first (the repo already declares the constraints — pure leverage), then AC-2/AC-3 (the two highest-severity classes: leaked pool + NaN-to-DB), then AC-4/AC-5/AC-6, AC-7 last (heuristic).

---

## Acceptance / evidence

- Reconstruct PR #1707's diff as a fixture; assert the enhanced scans flag ≥ #2, #3, #6, #7, #9, #10, #14 (the seven with a concrete, codifiable shape).
- Regression: a clean diff with none of these patterns produces zero new findings (no false-positive inflation — guard the convergence-to-0 contract, cf. #95 R-SJWT).
- Trap-door-conformance scan (AC-1) must run on **scoped** targets too (the sibling PRD's Override-6 monorepo skip is the cautionary precedent — do not gate the new scans on a target-root path that a scoped run won't match).

---

## Notes

- This is **not** an autonomy/recovery bug (cf. B-ORSR family, #100–104). The pipeline ran to completion and produced good work; the gap is **review efficacy** — what the gates are blind to, even on a single package with warm scope.
- It validates keeping a human reviewer in the loop for large/architectural PRs **and** gives the automated gates concrete new dimensions so the human is reviewing the residue, not the obvious. The bar: a human review of a pipeline-passed PR should find *taste*, not Critical-severity NaN-to-DB and leaked-pool defects.
