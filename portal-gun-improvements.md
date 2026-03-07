# Portal Gun PRD Quality: Validation, Manifests, and Consistency

| Portal Gun PRD Quality | | Improve portal-gun PRD output accuracy by adding validation, complete file manifests, import graph tracing, transplant classification, and consistency checking |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: 2026-03-05 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem Statement - [x] Objective & Scope - [x] CUJs - [x] Functional Requirements - [x] Assumptions - [x] Risks & Mitigations - [x] Business Impact

## Introduction

Based on a real session transplanting the pdfjs-agentic pipeline from `noneng-firstpass/appraisal-review-agent/` into `loanlight-app/`, the portal-gun skill produced a PRD that required 4 rounds of manual correction (25+ edits) before it was implementation-ready. This PRD specifies improvements to eliminate those failure modes.

Source: `.claude/commands/portal-gun.md` (391 lines). Session artifacts archived for regression testing.

## Problem Statement

**Current Process**: Portal-gun synthesizes PRDs from memory/analysis without verifying file paths, enumerating complete file inventories, tracing import graphs, classifying transplant types, or checking post-edit consistency.

**Primary Users**: Engineers using `/portal-gun` to transplant patterns between codebases.

**Pain Points**:
1. File paths plausible but wrong (FM1) — `pdfjs-pipeline/adapter.ts` vs actual `src/pdfjs-pipeline/adapter.ts`
2. Incomplete file inventories (FM2) — listed 4 of 17 root files, 4 of 8 schema files
3. Irrelevant files included, relevant files missed (FM3) — no import graph analysis
4. Post-edit inconsistency (FM4) — 7 stale references after scope changes
5. Vague modification specs (FM5) — "Modified" without line-level detail
6. Ambiguous transplant semantics (FM6) — unclear what "import" means for UI code
7. Security flows not traced (FM7) — single-file analysis misses cross-file data flows

**Importance**: Manual correction of a portal-gun PRD took 4 rounds. Each round risks introducing new inconsistencies. Automated validation eliminates the feedback loop.

## Objective & Scope

**Objective**: Reduce portal-gun PRD manual corrections from 25+ to <5 by adding validation, complete manifests, import graphs, and consistency checks to the portal-gun lifecycle.

**Ideal Outcome**: A portal-gun PRD that passes automated validation with zero INVALID paths, complete file inventories, and internally consistent numeric/feature references.

### In-scope / Goals

#### V1: Foundation (ship together as dependency chain)
- **B**: Donor file manifest in `pattern_analysis.md` — complete file enumeration, no truncation
- **A**: PRD Validation Pass (Step 5.5) — validates path existence with error taxonomy
- **F**: Post-edit consistency checker — inline prompt instructions after user edits

**V1 Known Limitations** *(refined: Risk Auditor)*:
- A validates that paths EXIST but not that they're RELEVANT. Irrelevant-but-existing paths pass validation. Full fix requires V2 (C+D).
- F runs as inline instructions in the same conversation. In very long sessions, F may underperform.
- All validation assumes local filesystem. Remote donors: validation reports "SKIP: remote donor."

#### V2: Graph + Classification (ship together)
- **C**: Import graph tracing from entry points — TypeScript/JavaScript only (ES modules + CommonJS)
- **D**: Transplant classification (Direct transplant / Behavioral reference / Type-only / Not needed / Replace with equivalent / Environment prerequisite)
- **E**: Deep target diff for files marked "Modified"
- **H**: Refinement workers get portal artifacts via `--add-dir` fix

#### Deferred (requires separate design)
- **G-full**: Cross-file taint analysis — research-grade, separate PRD
- **G-lite** (optional P2): 4-line prompt addition for manual data flow annotation in Step 4

### Not-in-scope / Non-Goals
- Remote/GitHub-hosted donor validation
- Non-TypeScript/JavaScript import graph tracing
- Changes to `dispatch.ts`, `mux-runner.ts`, or `VALID_STEPS`
- New subprocess spawner scripts
- Automated prompt regression testing framework (needed but separate project)
- Changes to the `State` interface (use filesystem convention: detect `${session_dir}/portal/` directory) *(refined: Codebase Context)*

## Execution Model *(refined: Risk Auditor)*

### When each improvement executes

| Improvement | Execution Point | Context Type | State Available |
|:---|:---|:---|:---|
| B | Step 3 (inline) | Parent conversation | DONOR_DIR, Glob/Read tools |
| C | Step 3 (inline, after B) | Parent conversation | B's file manifest |
| D | Step 3 (inline, after C) | Parent conversation | C's import graph |
| E | Step 4 (inline) | Parent conversation | TARGET_DIR, Read tool |
| A | Step 5.5 (NEW, inline) | Parent conversation | Steps 3-5 context + PRD on disk |
| F | Post-user-edit (inline) | Parent conversation | Full history + edited PRD on disk |
| G-lite | Step 4 (inline, after E) | Parent conversation | E's file inventory |
| H | Step 6 (code change) | Worker subprocesses | Only `buildWorkerPrompt()` inputs + `--add-dir` filesystems |

### Key architectural constraint
Steps 3-5.5 and F run in the PARENT Claude conversation (full context). Step 6 runs in CHILD Claude subprocesses (isolated, explicit inputs only). Improvements targeting parent = prompt template changes to `portal-gun.md`. Targeting children = TypeScript changes to `extension/src/bin/spawn-refinement-team.ts`.

## Critical User Journeys (CUJs)

### CUJ-1: Validated PRD Paths (Improvements A + B)
1. User runs `/portal-gun ~/loanlight/noneng-firstpass/appraisal-review-agent/ --target ~/loanlight/loanlight-app/`
2. Step 3 produces `pattern_analysis.md` with complete file manifest (all 17 root files, all 5 subdirectories, all files within)
3. Step 5 synthesizes PRD referencing donor and target file paths
4. Step 5.5 extracts all backtick-quoted paths from PRD
5. For each path: Read to verify existence, on failure Glob for nearest match
6. Validation report written to `${SESSION_ROOT}/portal/validation_report.md`
7. PRD updated: invalid paths corrected, shifted line numbers updated, incomplete directories flagged
8. User receives PRD with zero INVALID paths (wrong prefix, hallucinated) and warnings for SHIFTED/INCOMPLETE

### CUJ-2: Import-Aware Classification (Improvements C + D)
1. Step 3 traces imports from donor entry point (`adapter.ts`)
2. Import graph covers: ES `import`, CJS `require()`, dynamic `import()`, re-exports `export * from`, barrel files
3. Each donor file classified: Direct transplant / Behavioral reference / Type-only / Not needed / Replace with equivalent / Environment prerequisite *(refined: Requirements Analyst)*
4. Files unreachable from entry point classified as "Not needed" with rationale
5. PRD synthesis uses classification to determine scope — "Not needed" files excluded

### CUJ-3: Deep Target Modification Specs (Improvement E)
1. Step 4 reads each existing target file that will be modified (scoped by D's classification — only "Behavioral reference" and "Direct transplant to existing target" trigger deep diff) *(refined: Requirements Analyst)*
2. For each file: current behavior, specific lines to change, required changes
3. PRD contains line-level checklist per modified file (e.g., "Line 17: `validateXmlFile()` -> `validatePdfFile()`")

### CUJ-4: Post-Edit Consistency (Improvement F)
1. User reviews refined PRD, requests scope change: "remove XML support"
2. Inline consistency check triggers (same conversation, after user edit)
3. Scans for: contradictory numeric values, stale feature references, section count mismatches, CUJ coverage gaps
4. Reports stale references: "STALE: 'XML' at line 200", contradictions: "CONFLICT: upload size 50MB (line 45) vs 25MB (line 112)"
5. User fixes flagged items. No automated rewrites.

### CUJ-5: Large Donor (100+ files) *(refined: Requirements Analyst)*
1. Donor has 150+ files across 20+ directories
2. Step 3 produces FULL file manifest (all files listed — no truncation)
3. Import graph traces from entry point, classifies 47 as Required, 103 as Not needed
4. If manifest exceeds 200 files: summary prepended (top 20 by import count, directory-level counts)
5. Refinement workers receive summary (first 50 lines of `pattern_analysis.md`) with instruction to Read full manifest on demand

### CUJ-6: Portal-Aware Refinement (Improvement H)
1. Portal-gun completes Steps 1-5.5, session dir contains `portal/` directory
2. Step 6 spawns refinement workers via `spawn-refinement-team.ts`
3. `main()` detects `${sessionDir}/portal/` directory existence
4. `spawnWorker()` adds `sessionDir` to `--add-dir` includes array
5. Codebase analyst worker receives portal artifact PATHS in prompt (not content)
6. Worker Reads `pattern_analysis.md`, cross-references with PRD
7. Worker Reads specific donor files from `portal/donor/` as needed
8. Non-portal refinement runs: worker behavior identical to current (backward-compatible)

## Functional Requirements

### Improvement B: Donor File Manifest

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-B1 | P0 | Step 3 SHALL produce a `## File Manifest` section in `pattern_analysis.md` listing ALL donor files returned by Glob. No truncation, no summarization with `...` |
| FR-B2 | P0 | Manifest SHALL include: root files with count, subdirectories with file counts and per-file entries |
| FR-B3 | P1 | Manifest SHALL include anti-truncation instruction: "List ALL files. Do not truncate or omit files you consider unimportant. Completeness is the entire point." *(refined: Requirements Analyst)* |

**Implementation target**: `portal-gun.md:72-107` (Step 3 `pattern_analysis.md` template) — add File Manifest section *(refined: Codebase Context)*

### Improvement A: PRD Validation Pass (Step 5.5)

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-A1 | P0 | Step 5.5 SHALL extract all backtick-quoted paths containing `/` from the synthesized PRD |
| FR-A2 | P0 | For each extracted path, SHALL classify into error classes using ordered detection (see Error Taxonomy) |
| FR-A3 | P0 | SHALL write `${SESSION_ROOT}/portal/validation_report.md` with per-path status entries |
| FR-A4 | P0 | Paths under "New Files" / "Files to Create" headings SHALL be classified as TO-CREATE and skip existence checks |
| FR-A5 | P1 | Stale line numbers SHALL be detected by reading the file and searching ±5 lines for expected content |
| FR-A6 | P1 | Incomplete directories SHALL be detected by comparing Glob output count vs PRD-listed file count |

**Implementation target**: `portal-gun.md` between line 220 (end of Step 5 template) and line 222 (Step 6 header) *(refined: Codebase Context)*

#### Validation Error Taxonomy *(refined: Requirements Analyst)*

Detection runs in order: to-create check first (skip early), then Read, then Glob fallback, then hallucinated if Glob also fails.

| Class | Detection | Remediation | Report Entry |
|:---|:---|:---|:---|
| To-create path | Path under "New Files" heading | Skip existence check | `TO-CREATE: {path} (skipped)` |
| Wrong prefix | `Read(path)` fails; `Glob(**/${basename})` returns 1+ matches | Suggest closest Glob match | `INVALID: {path} -- found at {match}` |
| Stale line number | `Read(path)` succeeds; content at stated line differs from expected | Search file for expected string | `SHIFTED: {path}:{stated} -> actual :{found}` |
| Incomplete dir | `Glob(dir/*)` count > PRD-listed count | List missing files | `INCOMPLETE: {dir} -- missing: {list}` |
| Hallucinated path | `Read(path)` fails; `Glob(**/${basename})` returns 0 | Flag for manual review | `NOT FOUND: {path} -- no near match` |
| Stale reference | Removed feature term found in PRD | Flag with context | `STALE: "{term}" at line {n}` |

### Improvement C: Import Graph Tracing (V2)

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-C1 | P1 | Step 3 SHALL trace imports from donor entry point(s) using Grep tool (NOT bash grep) |
| FR-C2 | P1 | SHALL support 5 import patterns: ES static `import`, CJS `require()`, dynamic `import()`, re-exports `export * from`, barrel `index.ts` re-exports *(refined: Codebase Context)* |
| FR-C3 | P1 | SHALL classify each file as: Required (reachable), Unused (not reachable), External dep (npm) |
| FR-C4 | P1 | Language scope: TypeScript and JavaScript only. Other languages: manifest produced, import graph skipped with notice *(refined: Risk Auditor)* |

**Implementation target**: `portal-gun.md:68-111` (Step 3 instructions) *(refined: Codebase Context)*

### Improvement D: Transplant Classification (V2)

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-D1 | P1 | Step 3 SHALL classify each donor file using 6-category scheme *(refined: Requirements Analyst)* |
| FR-D2 | P1 | Classification table SHALL include detection heuristic per category |

**Classification scheme** *(refined: Requirements Analyst)*:

| Classification | Detection Heuristic |
|:---|:---|
| Direct transplant | Reachable from entry point AND target has no equivalent |
| Type-only transplant | Exports only `interface`/`type`/`enum` -- no runtime code |
| Behavioral reference | UI/framework-specific code in different stack than target |
| Replace with equivalent | Grep target for similar function names/exports -- match found |
| Environment prerequisite | Contains `process.env`, config objects, or infra references |
| Not needed | NOT reachable from entry point import graph |

**Implementation target**: `portal-gun.md:72-107` (Step 3 template) *(refined: Codebase Context)*

### Improvement E: Deep Target Diff (V2)

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-E1 | P1 | Step 4 SHALL produce per-file modification specs for existing target files classified as "Modified" by D |
| FR-E2 | P1 | Each spec SHALL include: current behavior, specific lines/patterns to change, required changes |

**Implementation target**: `portal-gun.md:112-144` (Step 4 template) *(refined: Codebase Context)*

### Improvement F: Post-Edit Consistency Checker

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-F1 | P0 | After user-requested scope changes, SHALL scan PRD for contradictory numeric values on same concept |
| FR-F2 | P0 | SHALL scan for terms related to removed features |
| FR-F3 | P0 | SHALL verify CUJ count matches requirements group count |
| FR-F4 | P1 | SHALL provide worked examples in prompt to distinguish real contradictions from intentional context variations *(refined: Requirements Analyst)* |

**Execution**: Inline prompt instructions in parent conversation after user edits. NOT a subagent (no ad-hoc subagent spawner exists). NOT a re-run of Step 6 (stale cross-references problem). *(refined: Risk Auditor, Codebase Context)*

**Implementation target**: `portal-gun.md:264-271` (Step 6e synthesis rules) — add consistency check instructions *(refined: Codebase Context)*

### Improvement H: Refinement Workers Get Portal Artifacts (V2)

| ID | Priority | Requirement |
|:---|:---|:---|
| FR-H1 | P1 | `spawnWorker()` SHALL add `sessionDir` to `--add-dir` includes when portal artifacts detected |
| FR-H2 | P1 | `buildWorkerPrompt()` SHALL accept optional `portalContext` parameter |
| FR-H3 | P1 | Codebase role instructions SHALL include portal artifact PATHS (not content) when portalContext provided |
| FR-H4 | P1 | Non-portal refinement runs SHALL be unaffected (backward-compatible) |
| FR-H5 | P1 | Total worker prompt SHALL NOT exceed 8,000 lines *(refined: Codebase Context)* |

**Implementation target**: `extension/src/bin/spawn-refinement-team.ts` — lines 21-28 (buildWorkerPrompt signature), 167-176 (spawnWorker signature), 186 (includes array), 284 (sessionDir in main) *(refined: Codebase Context)*

#### Context Budget for Refinement Workers *(refined: Codebase Context)*

| Component | Max Lines | Strategy if exceeded |
|:---|:---|:---|
| Persona + role instructions | ~60 | Fixed |
| PRD content | 3,000 | Truncate to P0 requirements only |
| Cross-ref (cycle 2+) | 2,000 | Summarize each prior analysis to 200 lines |
| Portal artifact PATHS | ~10 | Paths only; workers Read on demand |
| Output instructions | ~40 | Fixed |
| **Total ceiling** | **8,000** | Hard limit; truncate with marker |

## Implementation Dependencies *(refined: Requirements Analyst, Codebase Context, Risk Auditor)*

### Dependency Edges
```
B -> A (validation needs file inventory)
B -> C (import tracing needs file list)
B -> E (deep diff needs file knowledge)
C -> A (validation needs import context for relevance -- V2 only)
C -> D (classification needs reachability)
D -> E (deep diff scoped by classification)
A -> F (consistency runs on validated PRD)
E -> H (refinement needs diffs)
```

### Critical Path
B -> C -> D -> E -> H (5 sequential phases)

### Recommended Phasing

| Phase | Improvements | Rationale |
|:---|:---|:---|
| 0 (V1) | B (file manifest) | Zero deps. Foundation for everything. |
| 1 (V1) | A (validation) | Needs B. Validates existence only (not relevance). |
| 2 (V1) | F (consistency) | Needs A. Inline prompt instructions. |
| 3 (V2) | C (import graph) | Needs B. Enables D and enriches A. |
| 4 (V2) | D (classification) | Needs C. Scopes E. |
| 5 (V2) | E + H (parallel) | E needs D. H needs --add-dir fix. Independent of each other. |
| Deferred | G | Separate design. |

## Acceptance Criteria Framework *(refined: Requirements Analyst, Risk Auditor)*

### For prompt-behavioral improvements (A-G)
Each criterion tested across 3 runs against archived reference session (donor: `noneng-firstpass/appraisal-review-agent/`, target: `loanlight-app/`). Pass threshold: >= 2 of 3 runs.

**Tier 1 -- Structural (deterministic):** Verify the prompt template contains required sections. Testable by reading `portal-gun.md`.

**Tier 2 -- Behavioral (probabilistic):** Verify execution against reference session produces expected results. Tolerance: >= 2 of 3 runs.

**Tier 3 -- Negative (deterministic):** Verify the change does NOT violate conventions or introduce regressions. Testable by reading or running.

### For code-behavioral improvements (H)
Standard unit test assertions. 100% pass rate required. Tests in `extension/tests/spawn-refinement-team.test.js`.

## Prompt Change Convention *(refined: Risk Auditor)*

Each improvement's additions to `portal-gun.md` MUST be wrapped in HTML comment delimiters:
```
<!-- [Improvement X: Name -- START] -->
[prompt instructions]
<!-- [Improvement X: Name -- END] -->
```
Enables independent revert, visual identification, future toggle tooling. Maximum `portal-gun.md` size: 600 lines (lint check recommended).

## Assumptions
- Portal-gun session artifacts are on local filesystem (not remote)
- Donor and target repos are accessible via Read/Glob/Grep tools
- Import graph tracing (C) is TypeScript/JavaScript only
- Reference session exists for regression testing
- `portal-gun.md` prompt changes execute in parent Claude conversation with full tool access

## Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|:---|:---|:---|:---|:---|
| R1 | Validation (A) flags to-create paths as errors | Certain | Medium | Classify by PRD section heading. "New Files" = skip. *(refined: Risk Auditor)* |
| R2 | Import tracing (C) misses CJS/dynamic/alias imports | Certain | High | Specify 5 import patterns. Test against reference donor (CJS). *(refined: Risk Auditor)* |
| R3 | Prompt additions (115-185 lines) cause instruction conflicts | Likely | High | Golden test: archive donor/target, run after each change, diff outputs. Delimit prompt blocks. 600-line ceiling. *(refined: Risk Auditor)* |
| R4 | Context overflow in refinement workers | Likely | High | 8K-line ceiling. Embed paths not content. Workers Read on demand. Requires --add-dir fix. *(refined: Codebase Context)* |
| R5 | A-without-C validates irrelevant paths | Certain | Medium | Document as V1 known limitation. V2 (C+D) completes the fix. *(refined: Risk Auditor)* |
| R6 | Consistency checker (F) execution point undefined | Certain | High | Inline-after-edit in parent conversation. *(refined: Risk Auditor)* |
| R7 | Effort underestimates cause overruns (A, C, H provably wrong) | Certain | Medium | Revised effort estimates below. *(refined: Risk Auditor)* |

## Business Benefits/Impact/Metrics

| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Manual PRD corrections per session | 25+ edits, 4 rounds | <5 edits, 1 round | 80% reduction in post-generation effort |
| Invalid file paths in PRD | ~30% wrong | 0% wrong (V1) | Eliminates most common failure mode |
| File inventory completeness | ~25% of files listed | 100% listed | Eliminates incomplete inventories |
| Post-edit consistency | 7+ stale references | 0 stale references | Eliminates cascading inconsistencies |

## Revised Priority/Effort Table *(refined: Risk Auditor, Codebase Context)*

| Improvement | Impact | Effort (Revised) | Priority | Depends On | Change Type |
|:---|:---|:---|:---|:---|:---|
| B. Donor file manifest | High | Low (prompt insert, ~20 lines) | P0 | None | Prompt |
| A. PRD Validation Pass | High | Medium (prompt insert, ~35 lines, 6 error classes) | P0 | B | Prompt |
| F. Post-edit consistency | High | Medium (prompt insert, ~25 lines + worked examples) | P0 | A | Prompt |
| C. Import graph tracing | Medium | High (prompt, 5 import patterns + resolution logic) | P1 | B | Prompt |
| D. Transplant classification | Medium | Low (prompt insert, ~15 lines + table) | P1 | C | Prompt |
| E. Deep target diff | High | Medium (prompt insert, ~25 lines) | P1 | D | Prompt |
| H. Refinement portal artifacts | Medium | Medium (~80 LOC TS + 3 tests) | P1 | E | Code |
| G-lite. Data flow annotation | Low | Low (4 lines prompt) | P2 | E | Prompt |

## Portal Artifacts
- Pattern analysis: `portal/pattern_analysis.md`
- Target analysis: `portal/target_analysis.md`
- Validation report: `portal/validation_report.md` (NEW)
- Donor source: `portal/donor/`

## Session Reference
Target: `~/loanlight/loanlight-app/`
Donor: `~/loanlight/noneng-firstpass/appraisal-review-agent/`

## Implementation Task Breakdown

| Order | ID | Title | Priority | Depends On | Exit State |
|:---|:---|:---|:---|:---|:---|
| 10 | 6fa559c8 | Add donor file manifest section to portal-gun Step 3 template | P0 | none | `portal-gun.md` has File Manifest section with anti-truncation |
| 20 | fe068f9b | Add PRD validation pass (Step 5.5) to portal-gun with error taxonomy | P0 | 6fa559c8 | `portal-gun.md` has Step 5.5 with 6 error classes |
| 30 | 943eef9e | Add post-edit consistency checker to portal-gun with worked examples | P0 | fe068f9b | `portal-gun.md` has consistency check with worked examples |
| 40 | f9312391 | Add import graph tracing instructions to portal-gun Step 3 | P1 | 6fa559c8 | `portal-gun.md` Step 3 has import graph for 5 patterns |
| 50 | 91378181 | Add transplant classification table to portal-gun Step 3 template | P1 | f9312391 | `portal-gun.md` Step 3 has 6-category classification |
| 60 | 266f5b39 | Add deep target diff and portal artifact access for refinement workers | P1 | 91378181 | `portal-gun.md` Step 4 + `spawn-refinement-team.ts` updated + 3 tests |

## Refinement Notes

### Cycle 3 Summary
Three parallel analysts x 3 cycles = 9 analysis reports. All workers succeeded. Key findings:

**Cross-analyst convergences:**
1. Dependency graph is a DAG with critical path B->C->D->E->H. Original priority table (A+B+F independent P0s) contradicted by all three analysts.
2. Improvement A needs complete respec: error taxonomy (6 classes), tiered acceptance criteria, no subagent needed.
3. Prompt-behavioral vs code-behavioral split: 6 prompt changes to `portal-gun.md`, 2 code changes to `spawn-refinement-team.ts`.
4. Effort estimates provably wrong for A (Low->Medium), C (Medium->High), H (Low->Medium).
5. V1 (B+A+F) solves FM1+FM4 but only partially addresses FM3. V2 (C+D+E+H) completes the fix.
6. G splits into G-lite (P2, 4-line prompt) and G-full (deferred, separate PRD).
7. Portal detection via filesystem convention (`${session_dir}/portal/` existence) preferred over State interface changes.

**Novel Cycle 3 findings:**
- D->E dependency: classification determines which target files need deep diffs
- State interface lacks portal fields, requiring filesystem-based detection
- Existing pattern library artifact (`pdfjs-agentic-extraction.md`) confirms file manifest gap persists
- Context compounding in refinement workers grows exponentially across cycles (0 -> 600 -> 1800 lines)
