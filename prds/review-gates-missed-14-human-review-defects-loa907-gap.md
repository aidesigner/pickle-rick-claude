# PRD: Review Gates Missed 14 Human-Review Defects — Add Two General Finding Dimensions (LOA-907)

**Status**: Bug PRD / quality-gate efficacy gap (2026-06-08). The complete automated review+cleanup stack ran on a 117-file LangGraph-migration PR — `/pickle-pipeline` (incl. anatomy-park + szechuan-sauce), then THREE additional ultracode agent-team reviews (breadth code review, anatomy-park-depth re-run, CLAUDE.md audit). All reported the branch clean (0–1 trivial findings). A human reviewer (Jorge, `jcapona`) then opened the PR and found **14 real issues: 2 Critical, 8 Warning, 3 Simplification, 1 Historical.** Every one was inside the diff the gates already scanned.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension (the gate prompts live here; the defects were in the *target* repo, loanlight-api)
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/anatomy-park-szechuan-monorepo-missed-detection-gap.md` (the monorepo-flattening miss). Same family: declared-scope defects the post-pipeline review phases did not surface. That PRD fixed subsystem *discovery*; this PRD targets the **defect classes the finders have no dimension for**, on a *single-package* target where flattening is not the excuse.
**Triggering work**: loanlight-api PR #1707 (`gregory/loa-907-...`), the appraisal LangGraph migration.

---

## Design thesis (read this first)

The naive fix is one bespoke scanner per missed defect class. **We are explicitly NOT doing that.** Seven special-case scanners would be seven new false-positive surfaces, and in this codebase a finder that emits P0/P1 is a *pipeline halt* — so every bespoke scanner is a candidate new wedge point. The repo's entire trap-door history is "a well-meaning gate false-positived and stalled a launch." Catching 14 defects must not cost us autonomy.

The 14 defects reduce to **two questions a human asks that the gates do not**:

1. **"Does this match what we *said* we'd do?"** — checkable against the target's *own declared constraints* (`CLAUDE.md` trap doors / `PATTERN_SHAPE:` / "Never…" / "MUST…" / documented multi-place edits).
2. **"Does this *make sense*?"** — open-ended skeptical reasoning (a UUID flowing into a `code` field, a comment that lies, a pool opened and never closed, a fallback whose consumers don't guard it).

So this PRD ships **two general finding dimensions, not seven rules** — and crucially, **most of dimension 1 already exists.** B-HRP (v1.99.0, this PRD's predecessor) already shipped a directory of diff-scanning citadel analyzers (`banned-casts`, `sibling-auth`, `stale-reference`, `schema-registry-drift`, `test-authenticity`, …) feeding a **no-halt** `GateResult → spawn-gate-remediator` rail. The bulk of the LOA-907 misses already have a detector — they slipped because **citadel only runs inside `/pickle-pipeline`** and the review used standalone passes that never invoked it. So the work is mostly **invoke + extend what exists**, plus **one** new analyzer and a **report-only** judgment lens. Net machinery should trend *down*, the way B-HRP and B-GNXR did. The flywheel turns every future human/Council catch into a permanent automated check at near-zero cost.

---

## What was missed (fixture source of truth)

| # | Jorge issue | Severity | Caught by | Mechanism |
|---|-------------|----------|-----------|-----------|
| 1 | appraisal.processor.ts passes `lenderId` (UUID) into the `lenderCode: string` parameter → every LangSmith trace mislabeled with the UUID. Type-correct, semantically-wrong: both args are `string`, so typecheck + type-aware data-flow see nothing. | **Critical** | M2 (semantic identity) | 2 |
| 2 | Three sites do `Math.round(pipelineResult.coverage.coverage_pct * 100)`; the graph's empty-result fallback returns `coverage: {}` → `NaN` persisted to a numeric DB column. `{} as T` producer in langgraph.service.ts; unguarded consumers in appraisal.processor.ts. | **Critical** | M2 (fallback null-flow) | 2 |
| 3 | Graph `evaluateRules` node computes compliance into `state.complianceResults`, output type drops it, processor re-runs (double eval); node uses module-level `let sharedDb = new pg.Pool({max:1})` outside DI, never closed. | **Warning** | M2 (resource lifecycle / dead-work) | 2 |
| 6 | `0154` migration step 2 `ON CONFLICT DO UPDATE SET enabled=false` silently downgrades any lender that already has `appraisal=true` (clobbers a column another feature owns). | **Warning** | M1 (if documented) / M2 (SQL conflict-clobber) | 1+2 |
| 7 | `fs.readFileSync('/etc/ssl/.../rds-ca-bundle.pem')` runs synchronously inside the graph-node hot path, per invocation. | **Warning** | M2 (blocking IO on hot path) | 2 |
| 9 | `app.invoke(state as never)` — a **direct violation of the target repo's CLAUDE.md trap door** ("Never `as Type` when TS infers; only cast across untyped boundaries"). The most damning miss: the rule is *written down*, yet the diff introduced the violation and no scan cross-referenced it. | **Warning** | **M1** (declared-constraint conformance) | 1 |
| 10 | New migration specs added to jest.containers.config.json + CI but **not** `package.json::testPathIgnorePatterns` — incomplete three-place edit (documented in the target's root CLAUDE.md). | **Warning** | **M1** (documented multi-place edit) | 1 |
| 11 | `normalizeFormType(state.formType ?? "1004") as FormType` duplicated across 5 node files. | Simplification | M2 (cross-file DRY) | 2 |
| 13 | `default:` arm on a switch over a `0\|90\|180\|270` union defeats exhaustiveness. | Simplification | M2 (exhaustiveness) | 2 |
| 14 | Comment introduced by this PR is already stale (`via isCompoundRulesEnabled` → actually `isAppraisalEnabled`); has re-drift history (flagged by a different human on PR #1602). | Historical | M2 (stale comment on the diff) | 2 |

(#4 latency regression, #5 default-flip test-gap, #8 silent-1004-ATTOM-refusal, #12 boolean collapse omitted for brevity — same families.)

**14 of 14 were in declared scope. Four full review passes surfaced essentially none. This is a systemic dimension gap, not bad luck.** Every issue above is now assigned to Mechanism 1 (it's a *declared* rule) or Mechanism 2 (it requires *judgment*).

---

## Evidence from the 2026 merged-PR corpus

LOA-907 is not a one-off. A mining pass over **all 63 PRs `gregorydickson` merged in 2026** (~230 reviewer-flagged issues; full taxonomy in **`docs/review-defect-taxonomy.md`** — the flywheel seed) confirms the two-mechanism design and sharpens it:

- **The class ranking validates the split.** Top classes by frequency: **Security/trust-boundary (~35)**, Error-handling/edge-case (~34), DRY/dead-code (~30), Semantic-correctness (~26), Migration/data-loss (~19), declared-constraint violations (~18). Roughly **half the corpus is M1** (declarable / eslint-able) — M1 is the highest-leverage investment, more so than the original draft assumed.
- **Trust-boundary asymmetry is the #1 shape and it is *comparative*, not novel.** Almost every security finding was "a new path omits a guard its documented sibling already has" (missing `@UseGuards`, a budget check present on chat but not summary, CSRF sent but never validated, an `E2E_MOCK_AUTH` dual-gate enforced on the API side but not the Next.js side). So **Mechanism 1 must include sibling-route guard parity, not only CLAUDE.md text** — see the Mechanism 1 section.
- **The flywheel is proven, not hypothetical.** The `E2E_MOCK_AUTH` single-gate bug was caught on **PR#1585, fixed, then reappeared on PR#1649 six days later**; a stale JSDoc flagged on **PR#1586 carried forward into PR#1602**. Both are "caught twice because nobody wrote it down" — exactly what AC-6 prevents.
- **Recurring eslint-able violations.** Brace-free one-liner `if` (5 PRs) and nested ternaries in JSX (2 PRs) are flagged manually every time, caught by no current lint rule. Cheapest possible M1 wins — an eslint config change, not a gate prompt.
- **The gates are frequently the *only* review.** octy merged **10/10 PRs with zero substantive human review**; ~25% of loanlight-api likewise. For agent-generated and infra PRs the automated gate is not a backstop to a human — it *is* the reviewer. This raises the stakes and reframes the "human reviews the residue" note below: for many PRs there is no human pass at all.

---

## Mechanism 1 — Diff-vs-declared-constraints conformance scan

**The only thing the target already wrote down what NOT to do — so just check the diff against it.**

**Most of this already exists — B-HRP (v1.99.0) shipped it.** The citadel analyzer directory (`extension/src/services/citadel/`) already contains diff-scanning analyzers that cover the bulk of the declared-constraint classes, all feeding the **shipped** `citadelFindingsToGateResult()` adapter → `spawn-gate-remediator` rail (where **nothing halts** — B-HRP removed citadel's halt):

| LOA-907 / corpus class | Existing analyzer (already shipped) |
|---|---|
| `as never` / unnecessary cast (#9) | `banned-casts-audit.ts` |
| nested ternary / brace-free `if` / forbidden constructs | `banned-constructs-audit.ts` |
| sibling-route guard parity (corpus's #1 security shape) | `sibling-auth-audit.ts` |
| stale comment/ref on the diff (#14) | `stale-reference-audit.ts` |
| schema drift | `schema-registry-drift-audit.ts` |
| vacuous / inauthentic tests (#6) | `test-authenticity-audit.ts` |

So Mechanism 1 is **mostly an audit-and-wire task, not a build task.** Three pieces of real work, in leverage order:

1. **Invocation gap (the actual reason LOA-907 slipped).** Per the ledger, **citadel runs only inside `/pickle-pipeline`** — the LOA-907 review used standalone `/anatomy-park` + `/szechuan-sauce` + ultracode passes, which **never invoked these analyzers.** Half the misses had a working detector that simply was not run. Making the citadel analyzer set invokable on a review target (or having the standalone review paths call it) is higher-leverage than any new detector — and adds no detector at all.
2. **Coverage audit + extend the closest analyzer.** Run the existing analyzers against the LOA-907 diff fixture and find the gaps — e.g. does `banned-casts-audit` flag `as never` specifically? does `sibling-auth-audit` catch a missing *budget*/feature-flag/CSRF guard, not just auth? Extend the nearest analyzer; **do not author a parallel one.**
3. **The one genuinely-new analyzer.** A declared-`PATTERN_SHAPE`-conformance check — the *reverse direction* of the existing `trap-door-coverage-audit.ts` (which asks "is a documented trap door tested?"; the new one asks "does the diff *violate* a documented trap door?") — plus the SQL `ON CONFLICT … DO UPDATE SET <col>=<const>` data-loss check. Both ship as plain modules under `citadel/` wired into `audit-runner.ts` (per the R-CCNW-2 analyzer-wiring invariant) → the **existing** `citadelFindingsToGateResult` rail. The SQL check is **diff-level on any `.sql` change, never gated on a Drizzle _journal.json** (the monorepo-skip cautionary precedent). No new severity model, no new flags, no new dedup, no new state.

**Why this is the simple, no-wedge shape:** it rides B-HRP's already-shipped rail. Findings are **deterministic** (regex/AST on the diff, no LLM judgment, no convergence loop) and convert to `GateResult` exactly as citadel's own findings already do, feeding the *mechanical* `spawn-gate-remediator`. It therefore cannot false-stall or score-inflate the way the fuzzy loop-driving finders that produced **B-SJWT** / **R-SLLJ** did this month. Net analyzer count goes up by **one** (the conformance scan), and AC-8 requires checking whether it lets us **delete** a bespoke one — net complexity trends flat-or-down, the B-HRP way.

---

## Mechanism 2 — One "review like a skeptic" lens, **report-only, off the convergence loop**

The judgment classes need open-ended reasoning, not a regex. Add them as a few **prompt bullets on the existing citadel / anatomy analyzer** — one skeptic dimension that reasons about the diff with human-style suspicion:

- **Semantic identity** — a call argument whose source-variable name strongly mismatches the parameter name on the *same* type (`lenderId` → `lenderCode: string`). (#1)
- **Fallback null-flow** — a function that can return a partial / `{} as T` / `Partial<T>` value, traced to consumers with unguarded field access (`x.a.b`, `Math.round(x.maybe * n)`). (#2)
- **Resource lifecycle** — a module-scope mutable pool/connection/handle created outside DI and never closed; sync `readFileSync`/blocking IO inside a node/handler hot path; output computed then discarded across a type boundary. (#3, #7)
- **Comment accuracy on the diff** — an added/modified comment that cites a symbol/flag which no longer matches the code in the same hunk. (#14)
- **Cross-file repetition & exhaustiveness** — Rule-of-Three repetition clustered across sibling files; `default:` on a narrowed union. (#11, #13)

**Critical — learned from this month's ledger: M2 must NOT drive a convergence-to-0 loop.** A fuzzy LLM "does this make sense?" finder feeding an iterate-fix-remeasure loop is precisely the shape that produced **B-SJWT** (judge scope → `judge_timeout` + score inflation), **B-ORSR** (over-sensitive trigger), and the **R-SLLJ** judge-non-determinism family — the loop never cleanly converges, and "fixing" a taste finding can regress real code. Therefore:

- M2 findings are **surfaced like a Council directive** — written to the report / PR comment for a human or a follow-up agent to act on. They are **NOT** fed to the mechanical `spawn-gate-remediator` (which can only do prettier/eslint/4 hand-fix classes and cannot safely fix a semantic bug), and **NOT** used as a convergence signal.
- This makes M2 **a prompt addition plus a report section. Zero new code path, zero new loop, zero new state, zero new control flow** — so it physically cannot wedge anything.
- Improves by prompt iteration; the deterministic, mechanically-fixable half stays in Mechanism 1 where the remediator can safely act.

---

## The flywheel — make every future human catch a permanent check (nearly free)

Close the loop between human review and the gate: **when a human or the Council finds a defect the gate missed, the remediation is to write it as a `PATTERN_SHAPE:` trap door in the target's `CLAUDE.md`** — at which point **Mechanism 1 enforces it on every future diff, forever.** The human is the teacher; the conformance scan is the student that never forgets. This converts one-off review labor into compounding automated coverage with a convention plus the one scan — no new code per defect class. M2 surfaces *novel* judgment defects; M1 ensures we never miss the *same* class twice.

---

## Acceptance criteria

All ACs inherit two standing guarantees: **(G1) no new pipeline hard-stop** — findings ride B-HRP's already-shipped no-halt rail (`citadelFindingsToGateResult` → `spawn-gate-remediator`), never a new halt; **(G2) no false-positive inflation** — a clean diff produces zero new findings (guard the converge-to-0 contract, cf. #95 R-SJWT).

- **AC-1 — Close the invocation gap (highest leverage, zero new detectors).** Make the citadel analyzer set invokable on a review target *outside* `/pickle-pipeline` (or wire the standalone `/anatomy-park` + `/szechuan-sauce` review paths to invoke it). The existing `banned-casts` / `banned-constructs` / `sibling-auth` / `stale-reference` / `schema-registry-drift` / `test-authenticity` analyzers already detect roughly half the LOA-907 classes — they simply were not run. This adds no detector.
- **AC-2 — Coverage audit + extend the closest analyzer.** Run the existing analyzers against the LOA-907 diff fixture; for each verified gap, extend the nearest analyzer: `banned-casts-audit`→`as never` (#9; refinement verified zero coverage at HEAD), `sibling-auth-audit`→**budget + CSRF** guard parity (feature-flag parity is already emitted at `sibling-auth-audit.ts`:255, so only budget/CSRF are net-new), `stale-reference-audit`→diff-introduced comments (#14). **No parallel analyzers** — extend, don't duplicate.
- **AC-3 — The one new analyzer.** Add a declared-`PATTERN_SHAPE`-conformance analyzer (reverse of `trap-door-coverage-audit.ts`: "does the diff *violate* a documented trap door?") **and** the SQL `ON CONFLICT … DO UPDATE SET <col>=<const>` check, as plain modules under `citadel/` wired into `audit-runner.ts` (R-CCNW-2) → the existing `citadelFindingsToGateResult` rail. Diff-level; runs on scoped targets; the SQL check is **never** gated on a Drizzle _journal.json. Catches #6, #10, and any future documented constraint.
- **AC-4 — The one net-new eslint rule (the rest already exist).** Refinement verified that brace-free one-liner `if` and nested ternary are ALREADY caught by citadel's `banned-constructs-audit.ts` (`isBraceFreeIf`:85, `isNestedTernary`:74) — no work there. The single net-new win is adding `@typescript-eslint/no-unnecessary-type-assertion` (type-aware) to the target's flat eslint config; it catches the redundant-cast class (the `as never` family) at author time. Verify: a fixture with a redundant type assertion lints red, a clean fixture lints green.
- **AC-5 — Mechanism 2 report-only lens.** Add the skeptic dimension as prompt bullets on the existing citadel/anatomy analyzer; output goes to the report / PR comment (Council-directive style). It is **never** fed to the mechanical remediator and **never** used as a convergence signal. Surfaces #1, #2, #3, #7, #11, #13, #14 for a human/follow-up agent.
- **AC-6 — Fixture regression + no-wedge proof.** Reconstruct PR #1707's diff as a fixture; assert the invoked + extended analyzers surface **≥ #2, #3, #6, #7, #9, #10, #14**. Prove **G2** (clean diff → zero new findings) and **G1** (a finding-bearing run does not change the pipeline's terminal exit behavior vs today).
- **AC-7 — Flywheel + seeded record.** `docs/review-defect-taxonomy.md` is the append-only seed (already populated from the 2026 corpus); document that a missed-defect remediation adds a one-line taxonomy entry and, if declarable, a `PATTERN_SHAPE:` trap door (which AC-3's conformance analyzer then enforces). Worked examples: the two **proven** carry-forward cases `E2E_MOCK_AUTH` (PR#1585→#1649) and the stale-`module` JSDoc (PR#1586→#1602).
- **AC-8 — Net-complexity check ("what can we delete?").** Confirm the AC-3 conformance analyzer does **not** duplicate `banned-casts` / `banned-constructs` / `sibling-auth`; if it subsumes a bespoke analyzer, delete that one. Acceptance: analyzer count rises by **≤ 1** and total citadel LOC is **flat-or-down** — the B-HRP precedent (which net-deleted) and the B-GNXR doctrine (remove at the root), not net-add.

**Priority:** AC-1 first (free — half the value is an invocation fix, no new code), then AC-2 (extend existing), then AC-3 (the single new analyzer), AC-4 (eslint), AC-5 (M2 report-only), AC-6 (proof), AC-7 (flywheel), AC-8 (delete-check, runs throughout).

---

## Non-goals / guardrails

Drawn directly from this month's reliability ledger — every one of these is a failure mode the gates already inflicted on themselves:

- **No per-defect bespoke scanners.** Seven special-case finders are rejected (false-positive surface + maintenance rot). One new analyzer (AC-3), everything else is invoke/extend.
- **No new hard-stop / halt / abort.** Findings ride B-HRP's no-halt rail. (B-HRP v1.99.0 *removed* citadel's halt; do not add one back. Cf. B-SMAF / gitnexus-statdrift: gates that abort on tree state wedge launches.)
- **No new state field, schema bump, `exit_reason`, or config knob.** New persisted surface is new drift surface (cf. B-LASP, B-WSWA, and B-ORSR's near-miss on schema-neutrality). The analyzers are stateless and read the diff.
- **No tree mutation and no scope-based abort.** Analyzers are read-only over the diff. (B-SMAF aborted on out-of-scope churn; the gitnexus preflight mutated `CLAUDE.md` and self-bricked the pipeline — B-GNXR removed it entirely.)
- **M2 never feeds the mechanical remediator and never drives a convergence loop.** Fuzzy finders on an iterate-to-0 loop are the B-SJWT / R-SLLJ bug class. M2 is report-only.
- **Net complexity must not rise.** Prefer invoke → extend → delete over add (AC-8). The B-HRP and B-GNXR precedents both shipped quality by *removing* machinery, not adding it.
- **No SQL check buried in conditional Override 6** (journal-gated → skips the very targets this is about).
- **Dropped:** the standalone "missing-regression-test" scanner (#5/#8) as a blocking check — most false-positive-prone; folded into the flywheel (document it → AC-3 enforces it).

---

## Notes

- This is **not** an autonomy/recovery bug (cf. B-ORSR family, #100–104). The pipeline ran to completion and produced good work; the gap is **review efficacy** — what the finders are blind to, even on a single package with warm scope. The fix *preserves* autonomy: more finding-power, zero new places a pipeline can stop.
- It validates keeping a human reviewer in the loop for large/architectural PRs **and** gives the finders two general dimensions plus a flywheel, so the human reviews *taste*, not Critical-severity NaN-to-DB and leaked-pool defects — and every catch they do make becomes a permanent automated check. The 2026 corpus adds urgency: for a large fraction of PRs (octy 10/10, ~25% of loanlight-api) **there is no substantive human review at all** — the automated gate is the only reviewer, so its blind spots ship unfiltered.
- Seed record: **`docs/review-defect-taxonomy.md`** (the flywheel's append-only memory, populated from the 63-PR 2026 corpus). It is both the evidence base for this PRD and the live target for AC-6.
