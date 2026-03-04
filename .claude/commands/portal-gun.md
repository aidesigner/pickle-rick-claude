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
| `--cycles <N>` | 3 | Number of refinement cycles (passed to spawn-refinement-team.js) |
| `--max-turns <N>` | 100 | Max turns per refinement worker (passed to spawn-refinement-team.js) |
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

## Step 7: Propagate (Pattern Persistence)

Save the extracted pattern for future reuse. This implements the "Propagate" step of gene transfusion — making patterns discoverable and reusable across projects.

### 7a: Pattern Library
Pattern library location: `~/.claude/pickle-rick/patterns/`

If `SAVE_PATTERN` is set OR prompt user: "Save this pattern to the library for future portal-gun sessions? (name suggestion: `[inferred-name]`)"

If saving:
1. Create `~/.claude/pickle-rick/patterns/` if it doesn't exist
2. Copy `${SESSION_ROOT}/portal/pattern_analysis.md` → `~/.claude/pickle-rick/patterns/${PATTERN_NAME}.md`
3. Append entry to `~/.claude/pickle-rick/patterns/index.md`:

```markdown
| [Name] | [Source URL/path] | [Date] | [Summary] |
```

Create `index.md` with header if it doesn't exist:
```markdown
# Pattern Library
Extracted patterns available for future `/portal-gun` sessions.

| Pattern | Source | Date | Summary |
|:---|:---|:---|:---|
```

If user declines or `--no-refine` was set with no `--save-pattern`: skip, but print: "Pattern available at `${SESSION_ROOT}/portal/pattern_analysis.md` — use `--save-pattern <name>` to persist."

### 7b: Project-Local Copy (always)
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
