---
title: P2 — Human-Review Parity: make automated review phases catch the issue categories that today only human review catches (B-HRP)
status: draft
filed: 2026-06-04
priority: P2
type: feature-bundle
code: B-HRP
composes:
  - "R-HRP-CIT (citadel deterministic analyzers + diff-hygiene PII content scan)"
  - "R-HRP-SZ (szechuan Override 8 deterministic scans + principles rows)"
  - "R-HRP-AP (anatomy-park Phase 1 / Phase 2.5 / Phase 3 checklist + shape augments)"
  - "R-HRP-RP (refine-prd negative-AC + external-dependency analyst checks)"
  - "R-HRP-WG (per-ticket worker gate: banned-construct + banned-cast audit scripts)"
distinct_from:
  - "#95 R-SJWT (B-SJWT, row 23) — szechuan judge SCOPE/SIZE axis (whole-tree vs allowed_paths). B-HRP is orthogonal: it adds NEW detection classes to the review phases, it does not touch the judge's scoring surface or timeout."
  - "project-mayhem — chaos/execution/mutation testing is out of scope here. B-HRP adds only STATIC detectors (audit scripts, AST/regex grep, judge-prompt rows); no runtime/fuzzing."
---

# B-HRP — Human-Review Parity for the automated review phases

## Trigger / Motivation

A retrospective gap analysis of recent product-repo PRs (loanlight-api, loanlight-app, loanlight-integrations, noneng-firstpass) found **16 recurring issue clusters** that the pickle-rick automated review pipeline (`pickle-tmux` per-ticket gate → `citadel` → `anatomy-park` → `szechuan-sauce`) let through, and which **only human review** caught. The clusters and their peak severities (representative findings cited as evidence):

- **Schema/contract drift** (11×, peak Critical) — Drizzle CHECK widened in migration but not in the TS schema (`appraisal-custom-rules.ts:67-69`); `CONDITION_ERROR_CODES` registry missing `days_must_be_positive_integer`; `Income1025UnitSchema` drift between API and app copies. Cross-artifact invariants no phase diffs directly.
- **Tenant/auth/feature-flag-guard parity** (9×, peak Critical) — cross-user chat bleed via shared idempotency key; `getComparison` bypasses the updated-appraisal feature flag (`portal-appraisal.service.ts:2657`); `client_user` can DELETE child runs where siblings are `client_admin`-only (`portal-appraisal.controller.ts:221`). citadel checks `@Roles` PRESENCE but not feature-flag/throttle parity or weaker-allowlist-on-destructive-verb.
- **Dead/duplicated/vestigial code** (31×, peak High) — `applyPartialNarrativeTruncation` hand-copies 4 calls from a sibling; unread interface props; dead barrel aliases. szechuan drops these to nits below the conf cut; eslint misses unused interface props and hand-copied call sequences.
- **Swallowed errors / fail-soft asymmetry** (12×, peak Critical) — `onParseOnce` throw aborts a 50-min Reducto job (Bull retry); shadow txn stuck in `ShadowProcessing` on failure; FK-violation 500 instead of 404. Error-path correctness with no exercising test.
- **Async ordering / non-idempotent retry / non-atomic multi-write** (13×, peak Critical) — `randomUUID()` feeding an idempotency key (non-idempotent on SQS re-delivery); fan-out inserts with no transaction; CAS-guarded UPDATE whose error-path rollback writes unconditionally.
- **Banned constructs** (9×, nit but 100% static) — nested ternaries, brace-free one-liner `if`s — **explicitly banned in CLAUDE.md**, recurring because target-repo eslint does not enforce `no-nested-ternary`/`curly` and szechuan is told to skip linter territory.
- **Tests that don't test shipped code** (8×, peak High) — `consolidate-portal-db.spec.ts` tests an inline copy of the helper, not the real script; vacuous type-name assertions. Every gate proves GREEN, never that the test asserts real behavior.
- **Stale comments/docs** (9×, peak Medium) — JSDoc naming a removed `appraisal_rules.module` column; CLAUDE.md trap-door entries for symbols deleted in the same diff.
- **Unsafe casts** (7×, peak Medium) — `(err as Error).message`, `as any`, `as EpcLoan` on a DB insert. Codified in CLAUDE.md (`err instanceof Error ? err.message : String(err)`), ungated.
- **Unvalidated/unbounded input** (9×, peak Medium) — `x-csrf-token` sent but never validated; arrays with no `.max()`; missing `@Throttle`.
- **Unvalidated LLM output / budget gate not enforced** (6×, peak Critical) — citations bypass the validator; `record()` called without `check()`.
- **AC contradicted / feature half-shipped** (5×, peak Critical) — canary Lambda reproduces the exact `deep_extract:true` pattern the PR exists to escape.
- **Logic correctness in domain rules** (11×, peak Critical) — `evaluateBranching` collapses any/all on a SKIPPED clause; signed-zero slips both abs guards.
- **Logging conventions** (6×, peak Medium) — same `event:` literal on a `.error` and a `.log`; raw SQS body with PII logged.
- **PII/secrets/transient artifacts** (3×, peak Critical) — real borrower PII (`MAYER UNGER`) in an e2e fixture; transient `continuation_plan.md` at repo root.
- **Performance shapes** (6×, peak Medium) — N+1 (`await`/SELECT inside a loop); unbounded in-memory Maps; per-render reallocation.
- **NestJS DI wiring** (1×, High) — a constructor gains an injected provider whose module isn't imported.
- **Over/under-broad error-envelope forwarding** (4×, peak Critical) — exception filter flipped allowlist→denylist; proxy routes forward 5xx bodies verbatim.

**Headline lesson:** the single biggest leak is **codified-but-ungated rules** (banned constructs + unsafe casts, ~25+ occurrences) — written in CLAUDE.md, 100% static, but enforced nowhere because target-repo eslint lacks the rule and szechuan is told to skip linter territory. The fix is **portable deterministic gates** (`scripts/audit-*.sh` wired into the worker gate / build gate), reserving judge-prompt augmentation for genuinely semantic defects (logic correctness, concurrency, error-path asymmetry) that have no greppable oracle.

This bundle adds detection for the **mechanically checkable subset** of every cluster, grounded in real extension points, and accepts that pure algorithmic/semantic correctness stays partly LLM-bound (judge-prompt rows are the realistic lever, prioritized last for ROI).

## Design — improvements grouped by target phase

Each improvement names the **gap**, the **concrete detection**, and the **real extension point**. New deterministic detectors are `extension/scripts/audit-*.sh` or `extension/src/services/citadel/*.ts` analyzers — never state/schema/settings writers (Worker Forbidden Ops respected: see Notes).

### Phase: citadel (deterministic analyzers — no LLM, auto-wiring enforced)

Citadel is 100% deterministic; new analyzers export `{ findings: CitadelFinding[] }`, are wired into `audit-runner.ts:buildCitadelAuditReport` via `safeRunAnalyzer(...)`, and wiring is auto-enforced by `extension/scripts/audit-citadel-wiring.js` + `extension/tests/citadel/citadel-analyzer-wiring.test.js` (R-CCNW-2). Project-shape gating uses the `{ analyzerCompatibility: [...], projectShapes }` 3rd arg (the established `endpoint-contract-conformance`/`frontend-prop-drift` pattern).

| Gap | Detection to add | Extension point |
|---|---|---|
| Schema/registry drift (11×) — no phase diffs migration CHECK vs Drizzle enum vs sibling TS registry | NEW `schema-registry-drift-audit.ts`: parse Drizzle `pgEnum` members + CHECK-constraint string literals, diff against (a) latest migration SQL CHECK and (b) named TS registry objects (e.g. `CONDITION_ERROR_CODES`); emit Critical on a member present in one artifact but absent in its declared mirror | `audit-runner.ts` `safeRunAnalyzer` block + new analyzer module |
| Auth/flag/throttle parity (9×) — citadel checks `@Roles` presence only | EXTEND `sibling-auth-audit.ts`: under one controller prefix, diff sibling routes for (a) feature-flag-guard parity (`@RequireFeature`/`isXEnabled`), (b) `@Throttle` parity (High when one route omits a guard the majority carry); add Critical when a destructive verb (`@Delete`/`@Post apply`) has a strictly weaker `@Roles` allowlist than its destructive siblings | `sibling-auth-audit.ts:buildFindings` (reuse its prefix-grouping) |
| Tests-don't-test-shipped-code, mechanical subset (8×) | NEW `test-authenticity-audit.ts`: flag (a) a changed `*.spec/test` file that declares a function/const whose name matches an exported symbol in a sibling module but never imports from it (inline-copy, High); (b) assertions referencing a TS type identifier inside a runtime `Object.keys(...).toContain(...)` (vacuous-type-assertion, Medium). Diff-scoped to changed test files | `audit-runner.ts` + new analyzer |
| Stale comment/doc reference to a symbol deleted in this diff (9×, mechanical subset) | NEW `stale-reference-audit.ts` (or extend `trap-door-coverage-audit.ts`): grep changed comment/JSDoc/CLAUDE.md lines for backticked identifiers + column-ish tokens, resolve each against HEAD via `git grep`; Medium when absent from the source tree, High when the diff deleted it | new analyzer reusing the readiness contract-resolver pattern |
| Input-guard presence/parity (9×, parity subset) | NEW `input-guard-presence-audit.ts` (gated `nestjs-api`): (a) route whose paired client sends `x-csrf-token` but handler never calls `validateCsrf` (Medium); (b) cost/LLM-tagged endpoint missing `@Throttle` siblings carry (Medium); (c) Zod array/string DTO field with no `.max`/`.length`/`.refine` feeding a budget/LLM path (Medium) | `audit-runner.ts` + new analyzer, `analyzerCompatibility:['nestjs-api']` |
| Paired-call invariant orphans (6×, Critical) — `record()` without `check()`; persist citations without `validateAndRewriteCitations` | EXTEND `rule-set-invariant-audit.ts`: read declared paired-call invariants from a target-repo CLAUDE.md `## Paired-Call Invariants` block, grep the diff for the orphan half, emit Critical. Declarative — no hardcoded app knowledge | `rule-set-invariant-audit.ts` |
| NestJS DI wiring drift (1×, High) | NEW `nest-di-wiring-audit.ts` (gated `nestjs-api`): for each changed `*.service.ts` constructor collect injected provider types, resolve the owning `@Module` providers + imported-module exports, emit High when an injected provider has no resolvable provider/export and the `*.module.ts` was not in the diff. Pure AST/graph, no app boot | `audit-runner.ts` + new analyzer |
| PII-in-fixture / unredacted content (3×, Critical) — diff-hygiene scans file SHAPE only, not content | EXTEND `diff-hygiene.ts`: add a `DiffHygieneRule` content-scan for added fixture/JSON files — grep values of known PII keys (`borrower_name`, `owner_of_public_record`, `ssn`) for non-placeholder data, emit Critical `pii-in-fixture`; surname-in-filename as a signal | `diff-hygiene.ts:ruleMatchesForAddedFile` + `DiffHygieneRule` union + `citadelSeverityForRule` |

### Phase: szechuan-sauce (deterministic Override 8 scans + principles rows that survive the conf cut)

Deterministic Override scans emit at a fixed P-tier so they survive the conf<80 drop (the established Override 4/5/6 pattern in `.claude/commands/szechuan-sauce.md` WORKER MODE). Genuinely-judged classes get a `szechuan-sauce-principles.md` Anti-Pattern Quick Reference row so confident hits score P1, not nit (the source principles file at `extension/szechuan-sauce-principles.md`, deployed via `bash install.sh`).

| Gap | Detection to add | Extension point |
|---|---|---|
| Dead/duplicated code, mechanical subset (31×) | NEW Override 8 (dead-symbols) AST/grep scan: declared-but-unread interface/`Props` members; exported barrel symbols with zero non-test importers (`git grep`); `?? ''`/`as any` fallbacks on values a prior filter guarantees non-null. Emit P2 **deterministically** so they survive the conf cut | `.claude/commands/szechuan-sauce.md` WORKER MODE (Override 8) |
| Duplication-drift (high-severity subset) | Principles row: "N hand-copied calls/fields from a sibling function => extract shared helper (two-place-edit trap door)" so the judge scores P1 | `extension/szechuan-sauce-principles.md` Anti-Pattern Quick Reference |
| Logging hygiene (6×) | Override 8 (logging) deterministic grep: (a) identical `event:` literal on both a `.error` and a `.log` in one function; (b) `.log` whose message arg !== structured `event` field; (c) ≥2 logger calls in a method sharing a context key (BoundLogger rule); (d) logger arg matching a PII token. P2/P3, emitted deterministically (mirrors Override 4) | `.claude/commands/szechuan-sauce.md` WORKER MODE |
| Performance shapes (6×) | Principles section "Resource/perf shapes": N+1 (`await`/SELECT inside a loop over rows => batch), unbounded `Map`/`Set` field with no TTL/LRU, function/object literal in a component body closing over only module-scope (=> hoist). Optional Override grep `for.*await|\.map\(.*await` and `new Map\(\)` class fields. P2 perf tier | `extension/szechuan-sauce-principles.md` |

### Phase: anatomy-park (judge-prompt + Phase 2.5 PATTERN_SHAPE for semantic/cross-subsystem defects)

Anatomy-park is LLM-worker-driven with a deterministic per-iteration regression gate. The lever is the Phase 1 "Review checklist — check ALL" bullets (`anatomy-park.md:343-351`), the Phase 2.5 `PATTERN_SHAPE` replay (399-420), and the Phase 3 self-verify (422-443), paired with `szechuan-sauce-principles.md` rows so confident hits survive conf≥80.

| Gap | Detection to add | Extension point |
|---|---|---|
| Error-path asymmetry (12×) | Phase 1 bullet: "for any try/catch or awaited callback, find sibling callbacks/handlers in the same module; flag when one is fail-soft-wrapped and the other propagates, or one reconciles terminal state on error and the other leaves a non-terminal row." Phase 2.5 shape `await .*on[A-Z]\w+\?\.` unwrapped vs try-wrapped sibling. + principles "error-path asymmetry" row | `anatomy-park.md:343-351` + `:399-420` + principles |
| Async/idempotency/CAS shapes (13×) | Phase 1 bullet + Phase 2.5 class: "`randomUUID()`/`Date.now()` flowing into an insert with `ON CONFLICT`/dedup key; CAS WHERE-guard followed by an unconditional rollback write on the same column; `pg advisory_xact_lock` held across an `await` of a network/LLM call." Static greps a worker can confirm | `anatomy-park.md:343-351` + `:399-420` |
| Logic correctness in verdict/count functions (11×) | Strengthen the Phase 3 2^N branch-matrix into a decision-table check: for any function returning an enum verdict (PASS/FAIL/SKIPPED) or accumulating a count, enumerate the cartesian of input states (incl. boundary -0, empty array, null sibling), assert each maps to exactly one outcome with a regression test; flag directional rules lacking else-if mutual exclusion. + principles "verdict/count functions need a mutually-exclusive decision table + boundary regression test" row. Accept this stays partly LLM-bound | `anatomy-park.md:422-443` + principles |
| Error-envelope contract (4×) | Phase 1 bullet: "when an exception filter or proxy route forwards `responseBody`, trace every throw site feeding it (grep `ConflictException`/`BadRequestException` with object payloads) and verify the forward policy covers exactly the fields consumers read and excludes stack/sql/query." Phase 2.5 shape `err\.body ??`/`...responseBody` forwarded without a `statusCode >= 500` sanitize guard | `anatomy-park.md:343-351` + `:399-420` |

### Phase: refine-prd (negative-AC + external-dependency analyst checks)

Refinement is the place to convert "this PR exists to escape pattern X" into a greppable negative AC, and to surface unstated external dependencies as a blocking gap. The lever is the analyst `roleInstructions` in `spawn-refinement-team.ts:buildWorkerPrompt` and the Step 7e hardening-ticket templates.

| Gap | Detection to add | Extension point |
|---|---|---|
| AC contradicted / feature half-shipped (5×, Critical) — anti-pattern reappears; AC depends on an unmerged sibling | risk-scope analyst checklist line: "For each AC, name the anti-pattern the ticket exists to ELIMINATE and add a negative AC that fails if that pattern reappears in the diff." + external-dependency check: "does any AC silently depend on an unmerged sibling PR/ticket?" surfaced as a blocking P0 gap. The negative-AC becomes an `llm-conformance` criterion citadel/send-to-morty can re-run | `spawn-refinement-team.ts:buildWorkerPrompt` `roleInstructions` (risk-scope role) |

### Phase: pickle-tmux per-ticket worker gate (portable deterministic audit scripts — the highest-ROI win, and the highest-blast-radius)

The codified-but-ungated leak (banned constructs + unsafe casts) is fixed with portable `scripts/audit-*.sh` wired into `runWorkerGate` in `spawn-morty.ts` alongside the eslint/tsc/test steps. These run **diff-scoped, on the worker's touched files only** — never whole-tree.

> ⚠️ **Meta-tool blast radius (R-WSRC).** This gate runs *inside the runtime it gates*. A single false positive does not merely annoy — it **hard-blocks every future worker completion commit and the release gate**, wedging all pipelines on this repo. Therefore these two scripts ship **advisory-first**: they default to **warn-only** (log the finding, exit 0) behind a kill-switchable env flag, and only graduate to commit-blocking after a clean precision baseline is proven (see Safety section + the WG promotion AC). A blocking false positive on a meta-tool is a worse outcome than the leak it closes.

| Gap | Detection to add | Extension point |
|---|---|---|
| Banned constructs (9×) — nested ternary, brace-free if | NEW `scripts/audit-banned-constructs.sh`: ripgrep for nested `? :` and brace-free `if`/`for`/`while` one-liners in touched files; non-zero exit blocks the commit, message cites the CLAUDE.md style rule | `spawn-morty.ts:runWorkerGate` + the build gate command in `extension/CLAUDE.md` |
| Unsafe casts (7×) | NEW `scripts/audit-banned-casts.sh`: ripgrep for `(\w+ as Error)\.`, `} as any`, `as unknown as`, and `as <Type>` on a DB-insert/repository call argument; message prescribes `err instanceof Error ? err.message : String(err)` | `spawn-morty.ts:runWorkerGate` + the build gate command |

## Safety, Precision & Staged Rollout (design constraint — applies to EVERY ticket)

The point of B-HRP is to catch *more* real defects without introducing *any* new failure mode of its own. A detector that false-positives on a meta-tool is a regression, not a feature. The following constraints are **non-negotiable acceptance gates** layered on top of each ticket's functional AC. A ticket that closes its functional AC but fails any of these is **not Done**.

### S1 — Precision-first: advisory before blocking (severity is the control surface)
**Ground truth (`reporter.ts:exitCodeFor`):** `return critical + (strict ? high : 0) + (strict ? decisions.length : 0) > 0 ? 1 : 0`. So **any `Critical` finding makes citadel exit non-zero in every mode**, and `High` does so under `--strict`; `Medium`/`Low` never affect the exit code. Per the `R-PHC-6` trap door, citadel is the ONE phase whose non-zero exit halts the pipeline (`shouldHaltAfterPhase` returns `false` for pickle/anatomy/szechuan but citadel's severity-threshold halt is unchanged). Therefore **emitting `Critical`/`High` IS block authority** — "advisory" is a function of severity, not of being a citadel analyzer.
- **New/extended citadel analyzers (R-HRP-CIT-1..7) emit at `Medium` in the shipping release.** `Medium` is structurally below the `exitCodeFor` trigger, so the finding appears in the audit report (operator value) but **cannot halt the pipeline or fail any gate**. Promotion of a specific detector to `Critical`/`High` (i.e. granting it halt authority) is a deferred per-detector follow-up, allowed ONLY after that detector's S2 negative-corpus assertion is green. This is the citadel analogue of the WG `warn`→`block` split.
- **CIT-8 (PII) is the single explicitly-accepted `Critical` surface in this bundle** — PII in a committed fixture is worth halting for, and its pattern is tightly bounded (S4). Because `Critical` = halt authority, CIT-8 ships its `Critical`/`exitCodeFor` escalation ONLY behind a passing S2 negative-corpus assertion + S3-style dogfood (zero findings on the current tree); until both are green it emits `Medium`.
- **Worker-gate scripts** (R-HRP-WG-1/2) ship **warn-only**: wired into `runWorkerGate` but gated by a per-script env flag (`PICKLE_GATE_BANNED_CONSTRUCTS` / `PICKLE_GATE_BANNED_CASTS`, values `off|warn|block`, **default `warn`**). In `warn` they log the finding and **exit 0** (commit proceeds). Promotion to `block` is a separate, explicit decision recorded after S3 passes — never the default in the shipping release.
- **Prompt detectors** (szechuan Override 8, anatomy bullets, refine-prd lines) only bias an LLM phase; they carry no hard-fail authority and must not be wired to a deterministic block.
- **Net effect for the shipping release: nothing B-HRP adds has pipeline-halt authority** (every citadel detector at `Medium`, every WG script at `warn`, CIT-8 at `Medium` until its corpus is proven). Halt authority is granted later, one detector at a time, only after precision is demonstrated.

### S2 — Real-corpus precision validation (not just toy fixtures)
Every detector's test, in addition to its positive/negative unit fixtures, MUST include a **corpus assertion** proving it does not fire on known-good code:
- **Negative corpus:** the detector runs over the **current `pickle-rick-claude` tree at HEAD** (the meta-repo dogfoods itself) and the relevant subset, and asserts **zero findings** (or, where pre-existing debt is real, an explicitly enumerated allowlist with a `# baseline:` comment citing why each is acceptable — no silent caps).
- **Positive corpus (where feasible):** the detector replays against the **true-positive findings** lifted from the 20 source PRs (captured as redacted fixtures under `extension/tests/fixtures/hrp-corpus/`) and asserts it flags them. This proves recall on real defects, not just hand-built straw fixtures.
- A detector that cannot achieve **zero false positives on the negative corpus** does not ship blocking; it ships advisory (or not at all) and the gap is logged. Recall is secondary to precision for anything with block authority.

### S3 — Dogfood baseline (worker-gate scripts specifically)
Before either worker-gate script may be wired (even in `warn` mode), it MUST produce **zero findings** when run over the entire current `pickle-rick-claude` `extension/**` + `.claude/**` tree. If the meta-repo's own code trips the script, the script is too broad — tighten the pattern until the baseline is clean. This is a hard precondition: a gate that flags the very bundle introducing it cannot reach its own closer.

### S4 — Bounded scope & tight patterns
- Every detector is **diff-scoped** (touched/changed files only) except the explicitly whole-tree-by-design analyzers, which are read-only and advisory.
- Regex/AST patterns target the **specific** anti-shape with anchoring (e.g. CIT-8 fires only on non-placeholder values of an enumerated PII key allowlist, never on any string that "looks like a name"; banned-casts targets `(\w+ as Error)\.` and `} as any`, not every `as`). Each ticket states its precision rationale.
- `analyzerCompatibility` project-shape gating is mandatory for shape-specific analyzers (CIT-5/CIT-7 → `nestjs-api`) so they `{skipped:'project_shape_mismatch'}` rather than mis-fire on this repo or non-Nest repos.

### S5 — Fail-open & isolation (wrapped vs UNwrapped analyzers — verified hazard)
- **NEW analyzers (CIT-1/3/4/5/7) are added as fresh `safeRunAnalyzer(...)` calls** in `audit-runner.ts`. `safeRunAnalyzer` catches a throw and records the analyzer as skipped — it does **not** crash the audit. Each new analyzer's test asserts fail-open on a malformed-input fixture.
- **EXTENDED analyzers (CIT-2 `sibling-auth-audit.ts`, CIT-6 `rule-set-invariant-audit.ts`, CIT-8 `diff-hygiene.ts`) run UNWRAPPED by `safeRunAnalyzer`** — confirmed by the `services/CLAUDE.md` trap-door set ("audit-runner unwrapped set: ac-shape, diff-hygiene fileSize, sibling-auth, rule-set-invariant, divergence, project-shape, diff-walker, parseWithComposes"). A throw in added code there **crashes the entire Citadel audit**. Therefore every new filesystem/parse read in these three extensions MUST be individually `try/catch`-guarded (return `[]`/`0`/`''` on failure), exactly as the existing `readManifestText` / `fileSize` / `changedLineEvidence` trap doors mandate. Each extension ticket's test MUST assert the audit still completes (no throw) when its new read hits an unreadable/TOCTOU-removed/malformed input. This is a hard AC, not a nicety — it is the single most likely way B-HRP could crash a pipeline.
- Worker-gate scripts must `exit 0` (warn) on their own internal error (e.g. ripgrep absent), logging a diagnostic — a broken detector must never block a commit. Asserted by a test that runs the script with a corrupt/empty argument.
- No ticket shares mutable state; each is independently revertable by deleting its analyzer module + wiring line (or its prompt block) with no cross-ticket coupling. The closer verifies a clean revert path exists per ticket.

### S6 — Kill-switches (operator escape hatch)
- Each worker-gate script honors its `off|warn|block` env flag (precedent: `PLUMBUS_GENERATIVE_AUDIT`), documented in `extension/CLAUDE.md` Environment Variables. `off` fully bypasses (no scan, no log).
- A single master flag `PICKLE_HRP_DETECTORS=off` disables all B-HRP-added detection surfaces at once, so a bad release can be neutralized without a rollback. Asserted by a test that confirms `off` produces zero B-HRP findings across all surfaces.

### S7 — Sequencing (surgical, lowest-risk-first)
Implement and verify in risk order so a regression surfaces on a cheap ticket before an expensive one: **(1)** prompt-only tickets (SZ-2, AP-1, AP-2, RP-1 — no block authority) → **(2)** advisory citadel analyzers (CIT-1..7) → **(3)** CIT-8 + SZ-1 → **(4)** the worker-gate scripts (WG-1/2) **last**, warn-only. The closer never promotes WG to `block`.

## Acceptance criteria (machine-checkable)

Every new detector ships with (a) a `*.test.js` fixture proving it fires on a positive fixture and stays silent on a negative fixture, (b) for analyzers, the auto-wiring guard, **and (c) the S2 negative-corpus assertion (zero findings on the pickle-rick-claude tree at HEAD, or an enumerated `# baseline:` allowlist)**. All audit scripts are wired into the documented `## Build & Test` gate command in `extension/CLAUDE.md` (and `ci.yml`/`release.yml` where the `audit-trap-door-enforcement.sh` precedent applies). No detector with block authority ships without a passing S2 negative-corpus assertion and (for WG) a passing S3 dogfood baseline.

> **Severity reconciliation (governs every AC below):** where a CIT ticket's AC says a detector "emits a `Critical`/`High` finding", that is the detector's *eventual* (promoted) severity and the severity its positive-fixture test asserts. Per **S1**, the *shipping release* clamps every new/extended citadel detector to `Medium` (below the `exitCodeFor` halt trigger) until that detector's S2 negative-corpus assertion is green; promotion to the AC's stated severity is the deferred per-detector follow-up. So each CIT test asserts BOTH (a) the detector fires on its positive fixture at the stated logical severity, AND (b) in the shipped wiring the emitted severity is `Medium` (no `exitCodeFor` impact) — proven by a citadel-exit-code assertion on a fixture containing the finding.

**R-HRP-CIT-1 — schema-registry-drift analyzer.**
- NEW `extension/src/services/citadel/schema-registry-drift-audit.ts` exporting `{ findings: CitadelFinding[] }`, wired into `audit-runner.ts:buildCitadelAuditReport` via `safeRunAnalyzer('citadel-schema-registry-drift', ...)`.
- AC: `extension/tests/citadel/schema-registry-drift-audit.test.js` asserts the analyzer emits a Critical finding on a fixture where a `pgEnum`/CHECK member is absent from its declared TS registry mirror, and zero findings when they match. `node extension/scripts/audit-citadel-wiring.js` exits 0 (analyzer imported by audit-runner). `extension/tests/citadel/citadel-analyzer-wiring.test.js` passes (R-CCNW-2).

**R-HRP-CIT-2 — sibling-auth parity extension (flag/throttle/weaker-allowlist).**
- EXTEND `sibling-auth-audit.ts:buildFindings`: feature-flag-guard parity (High), `@Throttle` parity (High), and Critical when a destructive verb has a strictly weaker `@Roles` allowlist than its destructive siblings.
- AC: `extension/tests/citadel/sibling-auth-parity.test.js` (new cases) asserts a High finding when one sibling route omits a feature-flag guard the majority carry, a Critical when a `@Delete` route's `@Roles` allowlist is a strict subset of its destructive siblings', and no regression on the existing `@Roles`-presence cases.

**R-HRP-CIT-3 — test-authenticity analyzer.**
- NEW `test-authenticity-audit.ts`, diff-scoped to changed test files, wired via `safeRunAnalyzer`.
- AC: `extension/tests/citadel/test-authenticity-audit.test.js` asserts (a) High `inline-copy-not-real-code` on a spec declaring a function whose name matches a sibling export it never imports; (b) Medium `vacuous-type-assertion` on `Object.keys(schema).toContain('<TypeName>')`; (c) silent on a spec that imports and asserts the real symbol. Wiring guard exits 0.

**R-HRP-CIT-4 — stale-reference analyzer.**
- NEW `stale-reference-audit.ts` (or `trap-door-coverage-audit.ts` extension), resolving backticked identifiers/columns in changed comment/JSDoc/CLAUDE.md lines against HEAD via `git grep`.
- AC: `extension/tests/citadel/stale-reference-audit.test.js` asserts Medium `stale-reference` when a commented identifier is absent from the tree and High when the same diff deletes it; silent when the identifier resolves at HEAD.

**R-HRP-CIT-5 — input-guard-presence analyzer (nestjs-api shape).**
- NEW `input-guard-presence-audit.ts`, gated `analyzerCompatibility:['nestjs-api']`, wired via `safeRunAnalyzer`.
- AC: `extension/tests/citadel/input-guard-presence-audit.test.js` asserts Medium findings for (a) `x-csrf-token`-sending client + handler with no `validateCsrf`; (b) a cost-tagged endpoint missing `@Throttle` siblings carry; (c) a Zod array field with no `.max`/`.length`. Asserts `{skipped:'project_shape_mismatch'}` on a non-nestjs fixture. Wiring guard exits 0.

**R-HRP-CIT-6 — declarative paired-call-invariant gate.**
- EXTEND `rule-set-invariant-audit.ts` to read a target-repo CLAUDE.md `## Paired-Call Invariants` block and emit Critical on a diff containing the orphan half (e.g. `record()` without `check()`; persist-citations without `validateAndRewriteCitations`).
- AC: `extension/tests/citadel/paired-call-invariant.test.js` asserts a Critical finding when a fixture diff calls `budgetGuard.record(...)` on a feature key with no `budgetGuard.check(...)` on the same path, given a CLAUDE.md `## Paired-Call Invariants` declaring the pairing; silent when both halves are present; silent when no `## Paired-Call Invariants` block exists.

**R-HRP-CIT-7 — nest-di-wiring analyzer (nestjs-api shape).**
- NEW `nest-di-wiring-audit.ts`, gated `analyzerCompatibility:['nestjs-api']`, wired via `safeRunAnalyzer`.
- AC: `extension/tests/citadel/nest-di-wiring-audit.test.js` asserts High when a changed `*.service.ts` constructor injects a provider with no resolvable provider/export in the owning `@Module` graph and the `*.module.ts` is absent from the diff; silent when the module imports/declares the provider. Shape-skip asserted on a non-nestjs fixture. Wiring guard exits 0.

**R-HRP-CIT-8 — diff-hygiene PII content scan.**
- EXTEND `diff-hygiene.ts`: add a content-scan `DiffHygieneRule` for added fixture/JSON files emitting Critical `pii-in-fixture` on non-placeholder values of an **enumerated PII-key allowlist** (`borrower_name`, `owner_of_public_record`, `ssn`, `tax_id` — explicit set, not heuristic name-detection). A value matching a placeholder allowlist (`John Doe`, `Jane Doe`, `XXX-XX-XXXX`, `000-00-0000`, `test`, `example`, `redacted`, `<...>`) is never flagged.
- Precision rationale (S4): scoped to (a) added files only, (b) under a fixture/test path, (c) exact PII-key match, (d) non-placeholder value. This is the one block-authority citadel rule; its `exitCodeFor`-non-zero escalation ships **only after** its S2 negative-corpus assertion proves zero findings on the pickle-rick-claude tree.
- AC: `extension/tests/citadel/diff-hygiene-pii.test.js` asserts Critical on an added test-path fixture with a real-looking `borrower_name`/`ssn` value; silent on placeholder values; silent on a non-fixture source file containing the same string; **silent across the entire current pickle-rick-claude tree (S2 negative corpus)**. `reporter.ts:exitCodeFor` returns non-zero only on the `pii-in-fixture` Critical, with no change to thresholds for other finding classes.

**R-HRP-SZ-1 — Override 8 deterministic dead-symbol + logging-hygiene scans.**
- ADD Override 8 to `.claude/commands/szechuan-sauce.md` WORKER MODE: a deterministic per-pass scan emitting P2/P3 findings for (a) declared-but-unread interface/`Props` members, exported barrel symbols with zero non-test importers, non-null-guaranteed `?? ''`/`as any` fallbacks; (b) duplicate `event:` literal across `.error`/`.log`, message≠event mismatch, ≥2 BoundLogger-violating logger calls, PII-token logger args.
- AC: `extension/tests/szechuan-sauce.test.js` (new cases) asserts the deployed `~/.claude/commands/szechuan-sauce.md` (post-`install.sh` parity) contains an `Override 8` heading with the dead-symbol and logging-hygiene scan text and the explicit "emit P2 deterministically" instruction (grep-anchored, mirroring how the Override 4 text is asserted).

**R-HRP-SZ-2 — principles rows (duplication-drift, perf shapes, verdict decision-table).**
- ADD to `extension/szechuan-sauce-principles.md` Anti-Pattern Quick Reference: the duplication-drift row, the Resource/perf-shapes section, and the verdict/count decision-table row.
- AC: `extension/tests/szechuan-principles-rows.test.js` (new) asserts the source `extension/szechuan-sauce-principles.md` contains each new anchor string (`two-place-edit trap door`, `Resource/perf shapes`, `mutually-exclusive decision table`); a parity assertion confirms the deployed copy matches after `install.sh` (reuse the existing principles-deploy-parity test pattern).

**R-HRP-AP-1 — anatomy-park error-path + async-shape + envelope checklist bullets.**
- ADD the error-path-asymmetry, idempotency/CAS/advisory-lock, and error-envelope Phase 1 bullets to `.claude/commands/anatomy-park.md:343-351`, plus the corresponding Phase 2.5 PATTERN_SHAPE replay text at `:399-420`.
- AC: `extension/tests/anatomy-park-checklist.test.js` (new) asserts the deployed `~/.claude/commands/anatomy-park.md` Phase 1 checklist contains each new bullet anchor (`Error-path symmetry`, `idempotency-key`, `Error-envelope contract`) and the Phase 2.5 section contains the `await .*on[A-Z]` and `advisory_xact_lock` shape anchors (post-`install.sh` parity grep).

**R-HRP-AP-2 — anatomy-park Phase 3 decision-table check.**
- STRENGTHEN the Phase 3 2^N branch-matrix at `anatomy-park.md:422-443` into a decision-table enumeration check for verdict/count functions (cartesian incl. boundary -0/empty/null + regression test + else-if mutual-exclusion flag).
- AC: `extension/tests/anatomy-park-checklist.test.js` asserts the Phase 3 section contains the `decision-table` and boundary-enumeration anchors.

**R-HRP-RP-1 — refine-prd negative-AC + external-dependency analyst checks.**
- ADD to the risk-scope analyst `roleInstructions` in `spawn-refinement-team.ts:buildWorkerPrompt`: the negative-AC line ("name the anti-pattern the ticket exists to ELIMINATE; add a negative AC that fails if it reappears") and the external-dependency P0 check ("does any AC silently depend on an unmerged sibling PR/ticket?").
- AC: `extension/tests/spawn-refinement-team.test.js` (new case) asserts the built risk-scope worker prompt contains both anchors (`negative AC`, `unmerged sibling`); other roles' prompts are unchanged. Source↔compiled parity is covered by the existing build step.

**R-HRP-WG-1 — banned-constructs worker gate audit script (warn-only, advisory).**
- NEW `extension/scripts/audit-banned-constructs.sh` (ripgrep for nested `? :` and brace-free `if`/`for`/`while`), **diff-scoped to touched files**, wired into `spawn-morty.ts:runWorkerGate` AND into the `## Build & Test` gate command in `extension/CLAUDE.md`. Honors `PICKLE_GATE_BANNED_CONSTRUCTS=off|warn|block`, **default `warn`** (logs findings, exits 0). On internal error (e.g. ripgrep absent) exits 0 with a diagnostic (S5).
- **S3 dogfood precondition:** the script produces **zero findings** over the current `extension/**` + `.claude/**` tree before wiring. The PR that adds it tightens the pattern until this is clean.
- AC: `extension/tests/audit-banned-constructs.test.js` asserts: non-zero/finding-emitted on a fixture with a nested ternary + brace-free `if`; clean on a compliant fixture; **zero findings over the pickle-rick-claude tree (S3 baseline)**; `mode=warn` exits 0 even with a finding; `mode=block` exits non-zero on a finding; `mode=off` does not scan. `extension/tests/integration/worker-lint-gate.test.js` (new case) asserts `runWorkerGate` does **not** block in default `warn` mode and **does** block only under `block`. `grep "audit-banned-constructs.sh" extension/CLAUDE.md` matches (gate wiring); `PICKLE_GATE_BANNED_CONSTRUCTS` documented in the Environment Variables table.

**R-HRP-WG-2 — banned-casts worker gate audit script (warn-only, advisory).**
- NEW `extension/scripts/audit-banned-casts.sh` (ripgrep for `(\w+ as Error)\.`, `} as any`, `as unknown as`, DB-insert-arg `as <Type>`), **diff-scoped**, wired into `runWorkerGate` + the gate command. Honors `PICKLE_GATE_BANNED_CASTS=off|warn|block`, **default `warn`**; fail-open on internal error (S5).
- **S3 dogfood precondition:** zero findings over the current meta-repo tree before wiring (the codebase uses the prescribed `err instanceof Error ? err.message : String(err)` pattern per CLAUDE.md, so a clean baseline is achievable; any real hit is fixed in this ticket, not allowlisted).
- AC: `extension/tests/audit-banned-casts.test.js` asserts non-zero/finding on a fixture with `(err as Error).message` + `} as any`; clean on a fixture using the prescribed pattern; **zero findings over the pickle-rick-claude tree (S3 baseline)**; the same `off|warn|block` mode assertions as WG-1. `grep "audit-banned-casts.sh" extension/CLAUDE.md` matches; `PICKLE_GATE_BANNED_CASTS` documented.

**R-HRP-WG-PROMOTE — (follow-up, NOT in this bundle) promote worker-gate scripts to `block`.**
- Out of scope here by design. After B-HRP ships warn-only and several pipelines run with zero false-positive warnings logged, a one-line follow-up flips the defaults `warn`→`block`. This is recorded as a deferred decision, not implemented in B-HRP, so the bundle's own closer is never at risk of being blocked by its own newest gate.

**R-HRP-TD — trap doors.**
- Each new analyzer/script pins an `extension/CLAUDE.md` `## Trap Doors` entry (INVARIANT/BREAKS/ENFORCE/PATTERN_SHAPE), enforced by its `*.test.js` and (for scripts) `bash extension/scripts/audit-trap-door-enforcement.sh`. The two new worker-gate scripts additionally pin a PATTERN_SHAPE asserting the script name appears in the gate command in `extension/CLAUDE.md` (mirroring the `audit-subprocess-heavy-tests.sh` precedent).
- AC: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 with all new PATTERN_SHAPE anchors present at HEAD.

## Ticket classes

- **R-HRP-CIT-1** (tier: medium) — `schema-registry-drift-audit.ts` analyzer + wiring + fixture test + trap door.
- **R-HRP-CIT-2** (tier: medium) — `sibling-auth-audit.ts` flag/throttle/weaker-allowlist parity extension + tests.
- **R-HRP-CIT-3** (tier: medium) — `test-authenticity-audit.ts` analyzer + wiring + fixture test + trap door.
- **R-HRP-CIT-4** (tier: medium) — `stale-reference-audit.ts` analyzer + wiring + fixture test + trap door.
- **R-HRP-CIT-5** (tier: medium) — `input-guard-presence-audit.ts` (nestjs-api) analyzer + wiring + shape-skip test + trap door.
- **R-HRP-CIT-6** (tier: medium) — `rule-set-invariant-audit.ts` declarative paired-call-invariant extension + tests.
- **R-HRP-CIT-7** (tier: medium) — `nest-di-wiring-audit.ts` (nestjs-api) analyzer + wiring + shape-skip test + trap door.
- **R-HRP-CIT-8** (tier: small) — `diff-hygiene.ts` PII content-scan rule + `exitCodeFor` gating + fixture test.
- **R-HRP-SZ-1** (tier: small) — `szechuan-sauce.md` Override 8 (dead-symbol + logging-hygiene) + grep-anchored test.
- **R-HRP-SZ-2** (tier: small) — `szechuan-sauce-principles.md` rows + parity test. Run `bash install.sh` at the closer.
- **R-HRP-AP-1** (tier: small) — `anatomy-park.md` Phase 1 bullets + Phase 2.5 shapes + parity test.
- **R-HRP-AP-2** (tier: small) — `anatomy-park.md` Phase 3 decision-table check + parity test.
- **R-HRP-RP-1** (tier: small) — `spawn-refinement-team.ts` risk-scope analyst negative-AC + external-dep lines + prompt test.
- **R-HRP-WG-1** (tier: small) — `audit-banned-constructs.sh` + `runWorkerGate` wiring + gate-command wiring + tests + trap door.
- **R-HRP-WG-2** (tier: small) — `audit-banned-casts.sh` + `runWorkerGate` wiring + gate-command wiring + tests + trap door.
- **C-HRP-CLOSER** (tier: small, owner: manager) — recompile `.ts`→`.js` parity for all touched modules, run `bash install.sh` (deploys `szechuan-sauce.md`/`anatomy-park.md`/principles + new scripts), run the full gate (tsc/eslint/all audit scripts/test:fast/test:integration/RUN_EXPENSIVE_TESTS=1 test:expensive). **Safety verification before bump:** confirm (a) every detector's S2 negative-corpus assertion passes (the meta-repo's own full gate is itself the live dogfood — the new analyzers run during citadel on this very diff and must emit zero spurious Criticals; the new worker-gate scripts ran in `warn` on every R-HRP-* ticket and logged zero false positives), (b) both worker-gate flags default to `warn` in the shipped source, (c) `PICKLE_HRP_DETECTORS=off` cleanly disables all surfaces. Only then version bump **MINOR** (new analyzers, new Override, new flags, new gate scripts = features, schema-neutral), `gh release create`. **The closer does NOT promote WG to `block`** (R-HRP-WG-PROMOTE is a separate follow-up).

## Notes

- **Worker Forbidden Ops respected.** No ticket writes `state.json`/`pickle_settings.json`/schema or bumps `LATEST_SCHEMA_VERSION`. All new deterministic detection is `extension/scripts/audit-*.sh` invoked from the documented gate command or `extension/src/services/citadel/*.ts` analyzers consumed by `audit-runner.ts`. `bash install.sh` runs only at the closer (manager-owned), never from a worker.
- **Schema-neutral → MINOR.** No state-schema change; the bump is MINOR because it adds new detection surfaces (citadel findings classes, a new Override, two worker-gate scripts, refinement prompt lines), per the `extension/CLAUDE.md` versioning rule (Minor = features/flags/prompts).
- **Distinct from #95 R-SJWT (row 23).** B-HRP adds detection classes; it does not touch the szechuan judge's scoring scope (`allowed_paths`) or `timeout_seconds`. The two are independent and can ship in either order.
- **Target-repo CLAUDE.md dependency.** R-HRP-CIT-6 (paired-call invariants) and the schema-registry sibling-registry diff (R-HRP-CIT-1) are declarative — they read a `## Paired-Call Invariants` block the target repo must author; absent the block, the analyzer is a no-op (silent), never a false positive. Authoring those blocks in the product repos is a follow-up outside this bundle.
- **Recommended Drain Queue row (do NOT edit MASTER_PLAN here):** add as **row 24**, P2, `B-HRP`, source `prds/p2-feature-bundle-b-hrp-human-review-parity-automated-detection.md`, size ~16, gated after B-SJWT (row 23) clears so no two pipelines run concurrently on this repo (R-CSI serialization rule).
- **Semantic residue accepted.** Pure algorithmic correctness (cluster: logic in domain rules) and concurrency remain partly LLM-bound; R-HRP-AP-2 and the Phase 2.5 shapes are the realistic levers, prioritized last for automation ROI. This bundle does not claim to close those clusters fully — only their mechanically-checkable subsets.
- **New environment variables (documented in `extension/CLAUDE.md`):** `PICKLE_GATE_BANNED_CONSTRUCTS` and `PICKLE_GATE_BANNED_CASTS` (`off|warn|block`, default `warn`), and the master `PICKLE_HRP_DETECTORS` (`on|off`, default `on`) kill-switch. These are detection-surface flags, not state/settings writes — adding them is a MINOR feature, not a schema change.
- **Prompt-detector no-regression rule (S2 for the LLM phases).** SZ-1/SZ-2/AP-1/AP-2 add bullets/rows that bias a judge; their tests assert the deployed-doc anchors AND that the existing szechuan/anatomy fixture suites still pass unchanged (no new false P1s on known-clean fixtures). A prompt change that makes the judge noisier on clean code is a regression even though it can't hard-block.
- **Why advisory-first is the whole point.** B-HRP exists because human review caught real defects the pipeline missed. The failure mode to avoid is *over-correcting* into a pipeline that blocks good commits. Every block-authority surface (WG scripts, CIT-8) ships behind a precision gate (S2/S3) and a kill-switch (S6); everything else is advisory by construction. Effectiveness is measured by true-positive recall on the S2 positive corpus, not by how loudly it can fail.
