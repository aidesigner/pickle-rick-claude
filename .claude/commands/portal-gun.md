Open a portal to another codebase, extract its patterns, and generate a PRD to transplant them into your project.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Step 0: Parse Flags

Scan `$ARGUMENTS`:

| Flag | Default | Effect |
|------|---------|--------|
| `--run` | false | Auto-launch `/pickle-tmux` after PRD is ready |
| `--meeseeks` | false | Chain Meeseeks review after execution (implies `--run`) |
| `--target <path>` | cwd | Target repo/directory for the transplant |
| `--depth <shallow\|deep>` | `deep` | `shallow` = summary, structural pattern, and invariants only; `deep` = full structural analysis |
| `--no-refine` | false | Skip the automatic refinement cycle (Step 6) |
| `--cycles <N>` | 3 | Number of refinement cycles (ignored if `--no-refine`) |
| `--max-turns <N>` | 100 | Max turns per refinement worker (ignored if `--no-refine`) |
| `--save-pattern <name>` | — | Save extracted pattern to persistent library for future reuse |

Remaining text = `${EXEMPLAR}` (the portal destination — a GitHub URL, local file/dir path, npm/PyPI package name, or plain-text description of a pattern).

Store: `AUTO_RUN`, `CHAIN_MEESEEKS`, `TARGET_DIR`, `DEPTH`, `SKIP_REFINE`, `CYCLES`, `MAX_TURNS`, `SAVE_PATTERN`, `EXEMPLAR`.

If `EXEMPLAR` is empty → ask user: "Where should I open the portal? Give me a GitHub URL, file path, package name, or describe the pattern you want to steal."

## Step 1: Initialize Session

```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "Portal Gun: ${EXEMPLAR}"
```
Extract `SESSION_ROOT=<path>`. Extension root: `$HOME/.claude/pickle-rick` (`${EXTENSION_ROOT}`).

## Step 2: Open the Portal (Acquire Exemplar)

Detect exemplar type and acquire source:

### GitHub URL
Patterns: `github.com/`, `raw.githubusercontent.com/`, `gist.github.com/`

- **Single file**: `gh api` or WebFetch to retrieve raw content
- **Directory/tree**: `gh api repos/{owner}/{repo}/contents/{path}` — list files, fetch key source files (prioritize implementation over tests/docs, max 10 files)
- **Full repo**: clone sparse or fetch README + key source dirs. Use `gh repo view` for overview, then target specific paths
- **Gist**: `gh gist view <id>`
- **PR**: `gh pr diff <url>` to see the changes as the exemplar

Save all fetched source to `${SESSION_ROOT}/portal/donor/` preserving relative paths.

### Local Path
- File: copy to `${SESSION_ROOT}/portal/donor/`
- Directory: copy key source files (same prioritization — implementation > tests > docs, max 15 files)

### Package Name
- npm: `npm info <pkg>` for repo URL → treat as GitHub URL. If no repo, `npm pack <pkg> | tar xf` to extract source
- PyPI: `pip show <pkg>` for home-page → treat as GitHub URL

### Plain-Text Description
- No source to fetch. Agent must synthesize the pattern from its training knowledge
- Write a `${SESSION_ROOT}/portal/pattern_description.md` capturing the user's intent
- Skip to Step 4 (no donor code to analyze)

Announce what was acquired: file count, languages detected, estimated complexity.

**Error handling**: If acquisition fails (gh api error, file not found, npm pack failure, network timeout):
1. Print what failed and why
2. Ask user to provide an alternative source or fix the issue
3. Do NOT proceed to Step 3 with empty/missing donor code

## Step 3: Scan the Other Side (Pattern Extraction)

Analyze the donor code. Produce `${SESSION_ROOT}/portal/pattern_analysis.md`:

```markdown
# Pattern Analysis: [Name]

## Source
[URL/path/package]

## Pattern Summary
[1-2 paragraph description of what this code does and WHY it works]

## Structural Pattern
[The abstract pattern — independent of language/framework]
- Entry points
- Data flow
- Key abstractions
- State management approach
- Error handling strategy

## Invariants
[Rules that MUST hold for this pattern to work correctly]
- [Invariant 1]
- [Invariant 2]

## Edge Cases & Gotchas
[Things that break if you're not careful]

## Key Implementation Details
[Specific techniques worth preserving]
- [Detail 1 with code reference]
- [Detail 2 with code reference]

## Dependencies & Prerequisites
[What the pattern requires to function]

## Anti-Patterns
[What NOT to do when implementing this — common mistakes]

<!-- [Improvement B: File Manifest -- START] -->
## File Manifest

MANDATORY: Use Glob to enumerate ALL donor files. Do not truncate, summarize with "...", or omit files you consider unimportant. Completeness is the entire point of this manifest.

### Root files ([count from Glob])
[List EVERY file in donor root — one per line with brief purpose]
- filename.ext (brief purpose)

### Subdirectories
[For each subdirectory, list ALL files:]
- dirname/ ([count] files)
  - filename.ext (brief purpose)
<!-- [Improvement B: File Manifest -- END] -->

<!-- [Improvement C: Import Graph -- START] -->
### Import Graph (entry: [entry point file])

Trace imports from the entry point(s) using Grep tool. Cover ALL import patterns:
- ES static: `import ... from '...'`
- CJS: `require('...')`
- Dynamic: `import('...')`
- Re-exports: `export * from '...'`
- Barrel files: `index.ts` that re-exports

For each file, classify:
- **Required**: reachable from entry point
- **Unused by pipeline**: exists in donor but not imported
- **External dep**: npm/pip package (not local file)

Language scope: TypeScript and JavaScript only. If donor is another language, write: "Import graph skipped -- [language] not supported. See File Manifest for complete inventory."

[Import graph here -- trace from entry point, show dependency tree]
(files NOT reachable from entry -- classify as Unused)
<!-- [Improvement C: Import Graph -- END] -->

<!-- [Improvement D: Transplant Classification -- START] -->
### File Classification

Classify each donor file based on import graph reachability and content analysis:

| File | Classification | Rationale |
|:---|:---|:---|
| [file] | [category] | [why] |

Categories and detection heuristics:
- **Direct transplant**: Reachable from entry point AND target has no equivalent file
- **Type-only transplant**: Exports only `interface`/`type`/`enum` -- no runtime code
- **Behavioral reference**: UI/framework-specific code in a different stack than target (e.g., vanilla JS -> React)
- **Replace with equivalent**: Grep target for similar function names/exports -- match found
- **Environment prerequisite**: Contains `process.env`, config objects, or infrastructure references
- **Not needed**: NOT reachable from entry point import graph
<!-- [Improvement D: Transplant Classification -- END] -->
```

For `--depth shallow`: focus on Summary, Structural Pattern, and Invariants only.
For `--depth deep`: complete all sections with code-level detail.

## Step 4: Survey This Side (Target Analysis)

Analyze the target codebase at `${TARGET_DIR}`. Produce `${SESSION_ROOT}/portal/target_analysis.md`:

```markdown
# Target Codebase Analysis

## Tech Stack
[Languages, frameworks, build tools, test frameworks]

## Relevant Existing Patterns
[Code that does something similar or adjacent to the donor pattern]

## Conventions
- Naming: [conventions]
- File structure: [conventions]
- Error handling: [conventions]
- Testing: [conventions]

## Integration Points
[Where the transplanted pattern would connect to existing code]
- [File/module 1]: [how it connects]
- [File/module 2]: [how it connects]

## Conflicts & Constraints
[Existing patterns that might clash with the donor]

## Adaptation Requirements
[What must change to make the donor pattern fit]
- Language: [source] → [target]
- Framework: [source] → [target]
- Conventions: [adaptations needed]
```

Use GitNexus (`mcp__gitnexus__query`) if indexed, otherwise Glob/Grep/Read.

## Step 5: Synthesize the PRD

Cross-reference `pattern_analysis.md` and `target_analysis.md`. Write `${SESSION_ROOT}/prd.md`:

Use the standard PRD template but tailor it for pattern transplantation:

```markdown
# [Pattern Name] Transplant PRD
| [Pattern Name] Transplant PRD | | [Summary] |
|:---|:---|:---|
| **Author**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: [Date] | **Visibility**: Internal |

## Completion Checklist
- [ ] Introduction - [ ] Problem Statement - [ ] Objective & Scope - [ ] CUJs - [ ] Functional Requirements - [ ] Assumptions - [ ] Risks & Mitigations - [ ] Business Impact

## Introduction
Transplanting [pattern] from [source] into [target codebase].
Source: [URL/path]. Analysis: `portal/pattern_analysis.md`.

## Problem Statement
**Current Process**: [What the target codebase does today without this pattern]
**Primary Users**: [Who benefits]
**Pain Points**: [Why the current approach is insufficient]
**Importance**: [Why transplant this specific pattern vs. build from scratch]

## Objective & Scope
**Objective**: Replicate the behavioral semantics of [donor pattern] adapted to [target] conventions.
**Ideal Outcome**: Functionally equivalent implementation that passes behavioral validation tests.

### In-scope / Goals
[Specific behaviors to transplant]

### Not-in-scope / Non-Goals
[Parts of the donor that are NOT being transplanted and why]

## Product Requirements

### Critical User Journeys (CUJs)
[Map donor pattern's user journeys to target context]

### Functional Requirements
| Priority | Requirement | Donor Reference | Adaptation Notes |
|:---|:---|:---|:---|
| P0 | [Invariant-preserving requirement] | [donor file:line] | [what changes for target] |

### Behavioral Validation Tests
Require at least one test per invariant from pattern_analysis.md.

| Priority | Test | Invariant | Donor Behavior | Expected Target Behavior |
|:---|:---|:---|:---|:---|
| P0 | [Test 1] | [Which invariant this validates] | [What donor does] | [What target should do — same semantics, different implementation] |

## Assumptions
- Donor pattern is correct and battle-tested
- [Target-specific assumptions]

## Risks & Mitigations
| Risk | Severity | Mitigation |
|:---|:---|:---|
| Pattern doesn't translate to [target language/framework] | High | [Adaptation strategy from target_analysis.md] |
| Semantic drift from donor | Medium | Behavioral validation tests |

## Business Benefits/Impact/Metrics
| Metric | Current | Target | Impact |
|:---|:---|:---|:---|

## Portal Artifacts
- Pattern analysis: `portal/pattern_analysis.md`
- Target analysis: `portal/target_analysis.md`
- Donor source: `portal/donor/`
```

Mark checkboxes as sections are drafted.

<!-- [Improvement A: PRD Validation -- START] -->
## Step 5.5: PRD Validation Pass

Before refinement, validate all file paths referenced in the PRD against the actual filesystem. This catches wrong prefixes, stale line numbers, incomplete directory listings, and hallucinated paths before they propagate into tickets.

### 5.5a: Extract Paths
Scan `${SESSION_ROOT}/prd.md` for all backtick-quoted strings containing `/`. These are candidate file paths. Exclude:
- URLs (strings starting with `http://`, `https://`, `git://`)
- Shell variables without a path component (e.g., `${SESSION_ROOT}` alone)
- Glob patterns used as examples (e.g., `**/*.ts`)

### 5.5b: Classify Each Path
For each extracted path, apply detection in this order (stop at first match):

1. **To-create**: Path appears under a "New Files", "Files to Create", or "Files to Add" heading in the PRD → `TO-CREATE: {path} (skipped)`. Skip further checks.
2. **Exists (valid or shifted)**: `Read(path)` succeeds → file exists. If a line number is referenced (e.g., `path:42`), read that line. If content at the stated line doesn't match what the PRD describes, search the file for the expected content → `SHIFTED: {path}:{stated} -> actual :{found}`. If line content matches or no line number is referenced → `VALID: {path}`.
3. **Wrong prefix**: `Read(path)` fails → `Glob(**/${basename})`. If 1+ matches found → `INVALID: {path} -- found at {match}`. If multiple matches, list all.
4. **Incomplete directory**: Path references a directory (no file extension, or PRD lists directory contents). Run `Glob({dir}/*)` and compare count to PRD-listed count → `INCOMPLETE: {dir} -- PRD lists {n}, found {actual}. Missing: {list}`.
5. **Hallucinated**: `Read(path)` fails AND `Glob(**/${basename})` returns 0 matches → `NOT FOUND: {path} -- no match in codebase`.
6. **Stale reference**: `Read(path)` succeeds (file exists) but the referenced symbol, function, or export (e.g., `export function foo`) is not found anywhere in the file → `STALE: {path} -- referenced content "{snippet}" not found in file`.

### 5.5c: Write Validation Report
Write `${SESSION_ROOT}/portal/validation_report.md`:

```markdown
# PRD Validation Report
Generated: [timestamp]
Source PRD: ${SESSION_ROOT}/prd.md

## Summary
- Total paths extracted: [N]
- Valid: [N]
- To-create (skipped): [N]
- Shifted line numbers: [N]
- Invalid prefix: [N]
- Incomplete directory: [N]
- Not found: [N]
- Stale reference: [N]

## Details
[One line per path with classification, e.g.:]
VALID: src/index.ts
TO-CREATE: src/new-module.ts (skipped)
SHIFTED: src/db/index.ts:29 -> actual :47
INVALID: pdfjs-pipeline/adapter.ts -- found at src/pdfjs-pipeline/adapter.ts
INCOMPLETE: src/schema/ -- PRD lists 4, found 8. Missing: e.ts, f.ts, g.ts, h.ts
NOT FOUND: src/phantom/ghost.ts -- no match in codebase
STALE: src/auth.ts -- referenced content "export function validateToken" not found in file
```

### 5.5d: Update PRD
Apply corrections to `${SESSION_ROOT}/prd.md` based on the validation report:

- **SHIFTED**: Update line numbers in the PRD to actual locations.
- **INVALID** (with matches): Replace wrong paths with correct paths found by Glob.
- **INCOMPLETE**: Add a `<!-- INCOMPLETE: {dir} has {N} additional files not listed -->` comment in the PRD near the directory reference.
- **NOT FOUND**: Mark with `[UNVERIFIED]` suffix (e.g., `` `src/phantom/ghost.ts` [UNVERIFIED] ``).
- **STALE**: Mark with `[STALE]` suffix and note the referenced content was not found.
- **TO-CREATE** and **VALID**: No changes needed.

Do NOT use bash commands (`stat`, `ls`, `grep`, `find`). Use Read, Glob, Grep tools only.
<!-- [Improvement A: PRD Validation -- END] -->

## Step 6: Refinement Cycle (unless `--no-refine`)

If `SKIP_REFINE` is true → skip to Step 7.

The portal artifacts give the refinement team extra context a normal PRD wouldn't have. The analysts cross-reference donor patterns against target constraints to catch transplant-specific risks.

### 6a: Launch Refinement Monitor (if tmux available)
Check `tmux -V`. If available:
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
REFINE_SESSION="refine-${REFINE_HASH}"
tmux new-session -d -s "$REFINE_SESSION" -c "$(pwd)"
tmux send-keys -t "$REFINE_SESSION" "node ${EXTENSION_ROOT}/extension/bin/refinement-watcher.js ${SESSION_ROOT}" Enter
```
Print: `Monitor: tmux attach -t $REFINE_SESSION`

If tmux NOT available: print tip, skip monitor.

### 6b: Spawn Refinement Team
```bash
node "${EXTENSION_ROOT}/extension/bin/spawn-refinement-team.js" --prd "${SESSION_ROOT}/prd.md" --session-dir "${SESSION_ROOT}"
```
Optional: `--timeout <sec>` | `--cycles <n>` (default:3) | `--max-turns <n>` (default:100). Pass `CYCLES` and `MAX_TURNS` if user specified them.

Wait for `REFINEMENT_DIR=` and `MANIFEST=` output.

The 3 parallel analysts per cycle:
- **Requirements Analyst** → `analysis_requirements.md` — validates functional requirements against donor invariants
- **Codebase Context** → `analysis_codebase.md` — checks integration points, convention alignment, conflict detection
- **Risk & Scope** → `analysis_risk-scope.md` — evaluates transplant risks, semantic drift potential, test coverage gaps

Cycle 2+ cross-references all prior analyses + portal artifacts (`pattern_analysis.md`, `target_analysis.md`).

### 6c: Cleanup Monitor
```bash
REFINE_HASH="$(basename "${SESSION_ROOT}" | sed 's/.*\(.\{8\}\)$/\1/')"
tmux kill-session -t "refine-${REFINE_HASH}" 2>/dev/null || true
```

### 6d: Audit Reports
Read `${SESSION_ROOT}/refinement_manifest.json`. For failed workers: warn, note gaps, continue with available reports. Read all `analysis_*.md` + original PRD + portal artifacts.

### 6e: Synthesize Refined PRD
Write `${SESSION_ROOT}/prd_refined.md`. Rules:
1. Preserve original transplant PRD structure
2. Additive — append `*(refined: [source])*` after additions
3. P0 gaps first (especially invariant violations or missing behavioral tests)
4. No invention — only content from analyses + portal artifacts
5. Preserve Portal Artifacts section — append refinement summary
6. Strengthen Behavioral Validation Tests table based on analyst findings
7. Update Risks & Mitigations with transplant-specific risks from Risk & Scope analyst
8. Add `## Refinement Notes` section at end summarizing what changed and why

Copy refined PRD back to `${SESSION_ROOT}/prd.md` (original preserved as `prd_pre_refinement.md`).

### 6f: Refinement Summary
Write `${SESSION_ROOT}/refinement_summary.md`: timestamp, per-analysis changes, risk flags, failed workers if any.

Announce: refinement complete, key findings, risk level.

<!-- [Improvement F: Post-Edit Consistency -- START] -->
### 6g: Post-Edit Consistency Check

When the user requests scope changes to the PRD (e.g., "remove XML support", "change upload limit to 25MB", "drop the LLM budget feature"), run a consistency scan BEFORE confirming the edit is complete.

#### Check 1: Contradictory Numeric Values
Scan for numeric values associated with the same concept appearing with different values.

**IS a contradiction (flag):**
- "Maximum upload size: 50MB" (CUJ-2) + "Upload limit: 25MB" (Risk Mitigations) → same concept, different values → FLAG
- "7 sections in findings display" (CUJ-1) + "15 sections in schema definition" when schema drives display → FLAG
- "Timeout: 30s" (Functional Requirements) + "Timeout: 120s" (Acceptance Criteria for the same requirement) → FLAG

**IS NOT a contradiction (skip):**
- "S3 max object size: 5GB" + "Upload limit: 25MB" → different concepts (infrastructure capacity vs application limit) → SKIP
- "Poll every 1s during active processing" + "Poll every 60s during idle timeout" → same metric but explicitly different operational contexts → SKIP

#### Check 2: Stale Feature References
After removing or renaming a feature, search for ALL terms related to that feature throughout the PRD. Report each occurrence with its section and surrounding context.

**Example**: User says "remove XML support". Search for: `XML`, `MISMO`, `parser`, `xpath`, and any feature-specific terms that appeared near XML references. Each hit is a potential stale reference.

#### Check 3: Section Count Alignment
Verify structural consistency:
- Number of CUJs matches number of requirement groups (each CUJ has a corresponding functional requirements section)
- Every CUJ has at least one functional requirement row
- Every functional requirement maps to at least one acceptance criterion
- Every behavioral validation test maps to a declared invariant

#### Check 4: Report
List all findings BEFORE confirming the edit is complete:
```
CONFLICT: {concept} = {value1} (section {s1}) vs {value2} (section {s2})
STALE: "{term}" in {section}: "{surrounding context}"
ORPHAN: CUJ-{n} has no corresponding requirements
ORPHAN: FR-{n} has no acceptance criteria
OK: No inconsistencies found
```

If any CONFLICT or STALE findings exist, present them to the user and ask whether each is intentional before finalizing the edit.
<!-- [Improvement F: Post-Edit Consistency -- END] -->

## Step 7: Propagate (Pattern Persistence)

Save the extracted pattern for future reuse. This implements the "Propagate" step of gene transfusion — making patterns discoverable and reusable across projects.

### 7a: Pattern Library
Pattern library location: `~/.claude/pickle-rick/patterns/`

Derive `PATTERN_NAME`: use `SAVE_PATTERN` value if set, otherwise infer from exemplar (repo name, file basename without extension, or slugified description). Fallback: `pattern-<date>`.

**Decision tree:**
1. `--save-pattern <name>` set → `PATTERN_NAME = SAVE_PATTERN`. Save immediately, no prompt.
2. `--save-pattern` not set AND `--no-refine` not set → prompt user: "Save this pattern to the library for future portal-gun sessions? (name suggestion: `${PATTERN_NAME}`)"
   - User accepts → save with suggested or user-provided name
   - User declines → skip, no further action
3. `--save-pattern` not set AND `--no-refine` set → skip with hint: "Pattern available at `${SESSION_ROOT}/portal/pattern_analysis.md` — use `--save-pattern <name>` to persist."

**When saving:**
1. Create `~/.claude/pickle-rick/patterns/` if it doesn't exist. If creation fails, warn and skip (non-fatal).
2. Copy `${SESSION_ROOT}/portal/pattern_analysis.md` → `~/.claude/pickle-rick/patterns/${PATTERN_NAME}.md`
3. Create or append to `~/.claude/pickle-rick/patterns/index.md`:

If `index.md` doesn't exist, create with header:
```markdown
# Pattern Library
Extracted patterns available for future `/portal-gun` sessions.

| Pattern | Source | Date | Summary |
|:---|:---|:---|:---|
```

Append entry:
```markdown
| [Name] | [Source URL/path] | [Date] | [Summary] |
```

If `index.md` exists but doesn't contain the expected table header, warn "Pattern library index may be corrupted" but still append.

### 7b: Project-Local Copy
Runs only if `PATTERN_NAME` was set (i.e., pattern was saved in 7a or `--save-pattern` was provided).
Copy `${SESSION_ROOT}/portal/pattern_analysis.md` → `${TARGET_DIR}/.patterns/${PATTERN_NAME}.md` if `.patterns/` dir exists. If not, skip silently.

## Step 8: Advance State & Handoff

```bash
node "${EXTENSION_ROOT}/extension/bin/update-state.js" step breakdown "${SESSION_ROOT}"
```

Verify: `prd.md` exists AND state.json has `step: breakdown`.

**Note**: State advances to `breakdown`. When the user runs `/pickle --resume` or `/pickle-tmux --resume`, pickle.md Phase 2 (Ticket Manager) will decompose the PRD into atomic tickets before entering the orchestration loop. This is the standard Pickle Rick lifecycle — portal-gun handles PRD creation, pickle handles decomposition and execution.

**If `AUTO_RUN` is false**:
Print results: PRD path, pattern summary, donor → target mapping, refinement status, pattern library status.
Offer next steps:
- `/pickle --resume ${SESSION_ROOT}` — decompose into tickets + execute interactively
- `/pickle-tmux --resume ${SESSION_ROOT}` — decompose + execute in tmux (recommended for 4+ tickets)
- Edit `${SESSION_ROOT}/prd.md` to adjust before executing

**If `AUTO_RUN` is true**: Proceed to Step 9.

## Step 9: Auto-Launch (AUTO_RUN=true only)

### 9a: Check multiplexer
`tmux -V`. If present → set MUX=tmux, proceed to 9b.

If tmux missing, check Zellij:
```bash
ZELLIJ_VER=$(zellij --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
```
If Zellij present and >= 0.40.0 → set MUX=zellij, proceed to 9b-zellij.

If neither available: suggest install, note PRD is ready for manual resume. Stop.

### 9b: Re-initialize (tmux)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
If CHAIN_MEESEEKS: append `--chain-meeseeks`.

### 9b-zellij: Re-initialize (Zellij)
```bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --tmux --resume "${SESSION_ROOT}" --max-iterations 0 --max-time 0
```
If CHAIN_MEESEEKS: append `--chain-meeseeks`.
Then create Zellij session per /pickle-zellij Steps 3-4.

### 9c: tmux Session (MUX=tmux only)
Session name: `portal-<hash>` from SESSION_ROOT basename.
```bash
tmux new-session -d -s <name> -c <working_dir>
sleep 1
```
Print attach command: `tmux attach -t <name>`.

### 9d: Launch Runner
```bash
tmux send-keys -t <name>:0 "node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js ${SESSION_ROOT}; echo ''; echo 'Portal closed. Pattern transplanted.'; read" Enter
```

### 9e: Monitor (3-pane via canonical script)
```bash
bash "$HOME/.claude/pickle-rick/extension/scripts/tmux-monitor.sh" <name> ${SESSION_ROOT} pickle
```

### 9f: Report
Print: session name, attach command, window layout, cancel/kill commands.
If CHAIN_MEESEEKS: note auto-transition to Meeseeks review.

Output: `<promise>TASK_COMPLETED</promise>`
