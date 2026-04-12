<p align="center">
  <img src="images/pickle-rick.png" alt="Pickle Rick for Claude Code" width="100%" />
</p>

# 🥒 Pickle Rick for Claude Code

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm an **autonomous engineering machine** trapped in a pickle jar!"*

Pickle Rick is a complete agentic engineering toolbelt built on the [Ralph Wiggum loop](https://ghuntley.com/ralph/) and ideas from Andrej Karpathy's [AutoResearch](https://github.com/karpathy/autoresearch) project. Hand it a PRD — or let it draft one — and it decomposes work into tickets, spawns isolated worker subprocesses, and drives each through a full **research → plan → implement → verify → review → simplify** lifecycle without human intervention.

New to PRDs? See the **[PRD Writing Guide](PRD_GUIDE.md)** for developers or the **[Product Manager's Guide](PM_GUIDE.md)** for PMs defining and refining requirements. For internals, see [Architecture](architecture.md). For what's coming next, see the [Feature Roadmap](roadmap.md).

---

## How to Build Things with Pickle Rick

This is the actual workflow. You don't need to memorize commands — just follow the flow.

### Step 1: Write a PRD

Every feature starts with a PRD. Open a Claude Code session in your project and describe what you want to build:

```
"Help me create a PRD for caching the loan status API responses in Redis"
```

Rick interrogates you — *why* are you building this, *who* is it for, and critically: **how will we verify each requirement automatically?** This is a back-and-forth conversation, not a form to fill out. Rick also explores your codebase during the interview, grounding the PRD in what actually exists.

Or write your own `prd.md` and skip the interview — whatever gets requirements on paper with machine-checkable acceptance criteria.

```bash
/pickle-prd                      # Interactive PRD drafting interview
# or just start talking — "Help me write a PRD for X"
```

### Step 2: Refine the PRD

Three AI analysts run in parallel and tear your PRD apart from different angles — requirements gaps, codebase integration points, and risk/scope. They cross-reference each other across 3 cycles.

```bash
/pickle-refine-prd my-prd.md    # Refine with 3 parallel analysts
```

What you get back:
- `prd_refined.md` — your PRD with concrete file paths, interface contracts, and gap fills
- Atomic tickets — each < 30 min of work, < 5 files, < 4 acceptance criteria, self-contained
- Wiring ticket (3+ tickets) — integrates isolated modules into a working whole
- **Hardening tickets** — auto-appended code quality review + data flow audit scoped to modified files

The hardening tickets (skipped for trivial/small single-ticket PRDs) run as normal Morty workers after all implementation work:
1. **Code Quality Hardening** — szechuan-sauce principles review (KISS, DRY, dead code, edge cases) on all modified files
2. **Data Flow Audit** — anatomy-park-style trace through affected subsystems (ID mismatches, stale schemas, cross-ticket interface alignment)

**Review the tickets before proceeding.** Check ordering, scope, and acceptance criteria. You can edit them directly — they're markdown files.

### Step 3: Implement with tmux (the Ralph Loop)

This is where Rick takes over. Each ticket goes through 8 phases autonomously: Research → Review → Plan → Review → Implement → Spec Conformance → Code Review → Simplify. Context clears between every iteration — no drift, even on 500+ iteration epics.

```bash
/pickle-tmux --resume            # Launch tmux mode, picks up refined tickets
# or combine refine + implement in one shot:
/pickle-refine-prd --run my-prd.md
```

Rick prints a `tmux attach` command — open a second terminal to watch the live 3-pane dashboard:
- **Top-left**: ticket status, phase, elapsed time, circuit breaker state
- **Top-right**: iteration log stream
- **Bottom**: live worker output (research, implementation, test runs, commits)

Sit back. Rick handles the rest.

### Step 4 (Optional): Metric-Driven Refinement

If you can define a measurable goal — test coverage, response time, bundle size, extraction accuracy — the Microverse grinds toward it. Each cycle: make one change, measure, keep or revert. Failed approaches are tracked so it never repeats a dead end.

```bash
/pickle-microverse --metric "npm run coverage:score" --task "hit 90% test coverage"
/pickle-microverse --metric "node perf-test.js" --task "reduce p99 latency" --direction lower
/pickle-microverse --goal "error messages are user-friendly and actionable" --task "improve UX"
```

### Step 5 (Optional): Cleanup

Two cleanup tools for polishing the result:

**Szechuan Sauce** — hunts coding principle violations (KISS, DRY, SOLID, security, style) and fixes them one at a time until zero remain. Great for post-feature polish before merging.

```bash
/szechuan-sauce src/services/              # Deslop a directory
/szechuan-sauce --dry-run src/             # Catalog violations without fixing
/szechuan-sauce --focus "error handling" src/  # Narrow the review
```

**Anatomy Park** — traces data flows through subsystems looking for runtime bugs: data corruption, timezone issues, rounding errors, schema drift. Catalogs "trap doors" (files that keep breaking) in `CLAUDE.md` files for future engineers.

```bash
/anatomy-park src/                         # Deep subsystem review
/anatomy-park --dry-run                    # Review only, no fixes
```

**When to use which:** Szechuan Sauce asks *"is this code well-designed?"* — Anatomy Park asks *"is this code correct?"* Use both when you want clean AND correct.

### The Full Flow at a Glance

```
You describe a feature
       │
       ▼
  /pickle-prd              ← Interactive PRD drafting (or write your own)
       │
       ▼
  /pickle-refine-prd       ← 3 parallel analysts refine + decompose into tickets
       │                      Includes auto-generated hardening tickets:
       │                      • Code quality review (szechuan-sauce principles)
       │                      • Data flow audit (anatomy-park trace)
       ▼
  /pickle-tmux --resume    ← Autonomous implementation (Ralph loop)
       │                      Research → Plan → Implement → Verify → Review → Simplify
       │                      Context clears every iteration. Circuit breaker auto-stops runaways.
       │                      Hardening tickets run automatically after implementation.
       ▼
  /pickle-microverse       ← (Optional) Metric-driven optimization loop
       │
       ▼
  /szechuan-sauce          ← (Optional) Additional code quality cleanup
  /anatomy-park            ← (Optional) Additional data flow correctness review
       │
       ▼
  Ship it 🥒
```

---

## ⚡ Quick Start

### 1. Install

```bash
git clone https://github.com/gregorydickson/pickle-rick-claude.git
cd pickle-rick-claude
bash install.sh
```

### 2. Add the Pickle Rick persona to your project

The installer deploys `persona.md` to `~/.claude/pickle-rick/`. Add it to your project's `CLAUDE.md`:

```bash
# Already have a CLAUDE.md? Append (safe — won't overwrite your content):
cat ~/.claude/pickle-rick/persona.md >> /path/to/your/project/.claude/CLAUDE.md

# Starting fresh:
mkdir -p /path/to/your/project/.claude
cp ~/.claude/pickle-rick/persona.md /path/to/your/project/.claude/CLAUDE.md
```

> **After upgrading:** `bash install.sh` deploys a fresh `persona.md`. If you appended it to your project's `CLAUDE.md`, re-sync by replacing the old persona block with the updated one.

### 3. Run

> **Permissions:** Launch Claude with `claude --dangerously-skip-permissions`. Pickle Rick's loops spawn worker subprocesses that already run permissionless, but the root instance needs it too — otherwise you'll drown in permission prompts for every file write, bash command, and hook invocation.

```bash
cd /path/to/your/project
claude --dangerously-skip-permissions
# then follow the workflow above — start with a PRD
```

### 4. Uninstall

Two uninstall paths depending on how much you want to remove.

**Remove hooks only** — disables automatic behavior (Stop loop enforcement, commit logging, config protection) but keeps extension files and slash commands available for manual use:

```bash
bash uninstall-hooks.sh
```

Settings are backed up to `~/.claude/backups/settings.json.pickle-uninstall-hooks.<timestamp>` before modification. Run `bash install.sh` to re-enable hooks later — `install.sh` is idempotent, safe to re-run any time. Third-party hooks in `settings.json` (GitNexus, RTK, etc.) are never touched.

**What still works without hooks:**

- **One-shot utilities and reporters** (never needed hooks) — `/pickle-prd`, `/pickle-refine-prd`, `/pickle-dot`, `/pickle-dot-patterns`, `/pickle-metrics`, `/pickle-status`, `/pickle-standup`, `/help-pickle`, `/attract`.
- **Detached-runner commands** (bootstrap a separate process that runs independently) — `/pickle-tmux`, `/pickle-zellij`, `/meeseeks-zellij`, `/pickle-jar-open`. These launch `mux-runner.js` / `jar-runner.js` inside tmux or zellij; the runner spawns its own `claude -p` subprocesses and drives iteration via Node.js, not via the Stop hook. In tmux mode the Stop hook is a pass-through anyway.

**What needs hooks** — in-session loops where the Stop hook is the iteration driver for the same Claude session: `/pickle` (interactive mode), `/meeseeks`, `/szechuan-sauce`, `/anatomy-park`, `/council-of-ricks`, `/portal-gun`, `/project-mayhem`, `/pickle-microverse`, `/pickle-retry`. Without hooks these run the first step and stop.

**Full uninstall** — removes hooks, extension scripts at `~/.claude/pickle-rick/`, and all pickle-rick slash commands at `~/.claude/commands/`:

```bash
bash uninstall.sh
```

**Preserved after full uninstall** (delete manually if desired):
- Session history at `~/.claude/pickle-rick/sessions/`
- Activity logs at `~/.claude/pickle-rick/activity/`
- Settings backups at `~/.claude/backups/`
- Project-local `CLAUDE.md` files — remove the appended persona block manually

Third-party hooks in `settings.json` (GitNexus, RTK, etc.) are never touched.

---

## Advanced Workflows

### Pipeline Mode: Self-Correcting DAGs

For complex epics with parallel workstreams, conditional logic, and multiple quality gates. Instead of a linear ticket queue, define work as a convergence graph where failures automatically route back for correction.

```bash
/pickle-dot my-prd.md              # Convert PRD → validated DOT digraph (builder path, default)
/attract pipeline.dot              # Submit to attractor server for execution
```

The builder enforces 28 active patterns and 15 structural validation rules — test-fix loops, goal gates, conditional routing, parallel fan-out/in, human gates, security scanning, coverage qualification, scope creep detection, drift detection, and more. See [DotBuilder details](#-dotbuilder--programmatic-dot-codegen) below.

### Council of Ricks: Graphite Stack Review

Reviews your [Graphite](https://graphite.dev) PR stack iteratively — but never touches your code. Generates **agent-executable directives** you feed to your coding agent. Escalates through focus areas: stack structure → CLAUDE.md compliance → correctness → cross-branch contracts → test coverage → security → polish.

```bash
/council-of-ricks                  # Review the current Graphite stack
```

### Portal Gun: Gene Transfusion

<img src="images/portal-gun.png" alt="Portal Gun — gene transfusion for codebases" width="400" align="right" />

> *"You see that code over there, Morty? In that other repo? I'm gonna open a portal, reach in, and yank its DNA into OUR dimension."*

`/portal-gun` implements [gene transfusion](https://factory.strongdm.ai/techniques/gene-transfusion) — transferring proven coding patterns between codebases using AI agents. Point it at a GitHub URL, local file, npm package, or just describe a pattern, and it extracts the structural DNA, analyzes your target codebase, then generates a transplant PRD with behavioral validation tests and automatic refinement.

The `--run` flag goes further: after generating the transplant PRD, it launches a convergence loop that executes the migration, scans coverage against the original inventory, generates a delta PRD for any missing items, and re-executes until 100% of the donor pattern has been transplanted.

**v2** added a persistent **pattern library** (cached patterns reused across sessions), **complete file manifests** with anti-truncation enforcement, **multi-language import graph tracing** (TypeScript/JavaScript, Python, Go, Rust), **6-category transplant classification** (direct transplant, type-only, behavioral reference, replace with equivalent, environment prerequisite, not needed), a **PRD validation pass** that verifies every file path against the filesystem with 6 error classes, **post-edit consistency checking** that catches contradictions after scope changes, and **deep target diffs** with line-level modification specs.

<br clear="right" />

```bash
/portal-gun https://github.com/org/repo/blob/main/src/auth.ts   # Transplant from GitHub
/portal-gun ../other-project/src/cache.ts                        # Transplant from local file
/portal-gun --run https://github.com/org/repo/tree/main/src/lib  # Transplant + auto-execute convergence loop
/portal-gun --save-pattern retry ../donor/retry-logic.ts         # Save pattern to library for reuse
/portal-gun --depth shallow https://github.com/org/repo           # Summary + structural pattern only
```

### Pickle Jar: Night Shift Batch Mode

Queue tasks for unattended batch execution overnight.

```bash
/add-to-pickle-jar                 # Queue current session
/pickle-jar-open                   # Run all queued tasks sequentially
```

---

## 🚀 Command Reference

| Command | Description |
|---|---|
| `/pickle "task"` | Start the full autonomous loop — PRD → breakdown → 8-phase execution |
| `/pickle prd.md` | Pick up an existing PRD, skip drafting |
| `/pickle-tmux "task"` | Same loop with context clearing via tmux. Best for long epics (8+ iterations) |
| `/pickle-zellij "task"` | Same loop in Zellij with KDL layouts. Requires Zellij >= 0.40.0 |
| `/pickle-refine-prd [path]` | Refine PRD with 3 parallel analysts → decompose into tickets |
| `/pickle-refine-prd --run [path]` | Refine + decompose + auto-launch unlimited tmux session |
| `/pickle-microverse` | Metric convergence loop. `--metric` for numeric, `--goal` for LLM judge |
| `/szechuan-sauce [target]` | Principle-driven deslopping. `--dry-run`, `--focus`, `--domain` |
| `/anatomy-park` | Three-phase deep subsystem review with trap door cataloging |
| `/council-of-ricks` | Graphite PR stack review — generates directives, never fixes code |
| `/portal-gun <source>` | Gene transfusion from another codebase |
| `/pickle-dot [path]` | Convert PRD → attractor-compatible DOT digraph |
| `/attract [file.dot]` | Submit pipeline to attractor server |
| `/pickle-prd` | Draft a PRD standalone (no execution) |
| `/pickle-metrics` | Token usage, commits, LOC. `--days N`, `--weekly`, `--json` |
| `/pickle-standup` | Formatted standup summary from activity logs |
| `/pickle-status` | Current session phase, iteration, ticket status |
| `/eat-pickle` | Cancel the active loop |
| `/pickle-retry <ticket-id>` | Re-attempt a failed ticket |
| `/add-to-pickle-jar` | Queue session for Night Shift |
| `/pickle-jar-open` | Run all Jar tasks sequentially |
| `/disable-pickle` | Disable the stop hook globally |
| `/enable-pickle` | Re-enable the stop hook |
| `/help-pickle` | Show all commands and flags |

### Flags

```
--max-iterations <N>       Stop after N iterations (default: 500; 0 = unlimited)
--max-time <M>             Stop after M minutes (default: 720 / 12 hours; 0 = unlimited)
--worker-timeout <S>       Timeout for individual workers in seconds (default: 1200)
--completion-promise "TXT" Only stop when the agent outputs <promise>TXT</promise>
--resume [PATH]            Resume from an existing session
--reset                    Reset iteration counter and start time (use with --resume)
--paused                   Start in paused mode (PRD only)
--run                      (/pickle-refine-prd, /portal-gun) Auto-launch tmux
--interactive              (/pickle-microverse) Run inline instead of tmux
--legacy                   (/pickle-dot) Prompt-only fallback — skips builder codegen for this run
--provider <name>          (/pickle-dot) LLM provider: anthropic, openai, qwen, gemini, deepseek, ollama, vllm
--review-provider <name>   (/pickle-dot) Separate provider for review/critical nodes
--isolated                 (/pickle-dot) Isolated workspace mode
--metric "<CMD>"           (/pickle-microverse) Shell command outputting a numeric score
--goal "<TEXT>"            (/pickle-microverse) Natural language goal for LLM judge
--direction <higher|lower> (/pickle-microverse) Optimization direction (default: higher)
--judge-model <MODEL>      (/pickle-microverse) Judge model for LLM scoring
--tolerance <N>            (/pickle-microverse) Score delta for "held" status (default: 0)
--stall-limit <N>          (/pickle-microverse) Non-improving iterations before convergence (default: 5)
--target <PATH>            (/portal-gun) Target repo (default: cwd)
--depth <shallow|deep>     (/portal-gun) Extraction depth (default: deep)
--no-refine                (/portal-gun) Skip automatic refinement
--max-passes <N>           (/portal-gun) Max convergence passes (default: 3)
--save-pattern <NAME>      (/portal-gun) Persist pattern to library
--dry-run                  (/szechuan-sauce) Catalog violations without fixing
--domain <name>            (/szechuan-sauce) Domain-specific principles (e.g., financial)
--focus "<text>"           (/szechuan-sauce) Direct review toward specific concern
--repo <PATH>              (/council-of-ricks) Target repo (default: cwd)
```

### Tips

**`/pickle` vs `/pickle-tmux`** — Use `/pickle` for short epics (1–7 iterations) with full keyboard access. Use `/pickle-tmux` for long epics (8+) where context drift matters — each iteration spawns a fresh Claude subprocess with a clean context window.

**Phase-resume** — When resuming after `/pickle-refine-prd`, the resume flow auto-detects the session's current phase and skips completed phases.

**Notifications (macOS)** — `/pickle-tmux` and `/pickle-jar-open` send macOS notifications on completion or failure.

**Recovering from a failed Morty** — Use `/pickle-retry <ticket-id>` instead of restarting the whole epic.

**"Stop hook error" is normal** — Claude Code labels every `decision: block` from the stop hook as "Stop hook error" in the UI. This is not an error — it means the loop is working.

### Settings (`pickle_settings.json`)

All defaults are configurable via `~/.claude/pickle-rick/pickle_settings.json`:

| Setting | Default | Description |
|---|---|---|
| `default_max_iterations` | 500 | Max loop iterations before auto-stop |
| `default_max_time_minutes` | 720 | Session wall-clock limit (12 hours) |
| `default_worker_timeout_seconds` | 1200 | Per-worker subprocess timeout |
| `default_manager_max_turns` | 50 | Max Claude turns per iteration (interactive/jar) |
| `default_tmux_max_turns` | 200 | Max Claude turns per iteration (tmux) |
| `default_refinement_cycles` | 3 | Number of refinement analysis passes |
| `default_refinement_max_turns` | 100 | Max Claude turns per refinement worker |
| `default_council_min_passes` | 5 | Minimum Council of Ricks review passes |
| `default_council_max_passes` | 20 | Maximum Council of Ricks review passes |
| `default_circuit_breaker_enabled` | true | Enable circuit breaker |
| `default_cb_no_progress_threshold` | 5 | No-progress iterations before OPEN |
| `default_cb_same_error_threshold` | 5 | Identical errors before OPEN |
| `default_cb_half_open_after` | 2 | No-progress iterations before HALF_OPEN |
| `default_rate_limit_wait_minutes` | 60 | Fallback wait when no API reset time |
| `default_max_rate_limit_retries` | 3 | Consecutive rate limits before stopping |

---

## Tool Deep Dives

### 🔬 Microverse — Metric Convergence Loop

<p align="center">
  <img src="images/microverse.png" alt="The Microverse — powering your Pickle Rick app" width="100%" />
</p>

> *"I put a universe inside a box, Morty, and it powers my car battery. This is the same thing, except the universe is your codebase and the battery is a metric."*

Two modes: **Command Metric** (`--metric`) for objective numeric scores, and **LLM Judge** (`--goal`) for subjective quality assessment.

```
Gap Analysis (iteration 0)
    │ measure baseline, analyze codebase, identify bottlenecks
    ▼
┌─────────────────────────────────────────────────┐
│ Iteration Loop                                   │
│  1. Plan one targeted change (avoid failed list) │
│  2. Implement + commit                            │
│  3. Measure metric                                │
│     • Improved → accept, reset stall counter     │
│     • Held → accept, increment stall counter     │
│     • Regressed → git reset, log failed approach │
│  4. Converged? (stall_counter ≥ stall_limit)     │
└──────────────────────┬──────────────────────────┘
                       ▼
              Final Report
```

| | **Microverse** | **Pickle** |
|---|---|---|
| **Goal** | Optimize toward a measurable target | Build features from a PRD |
| **Iteration unit** | One atomic change per cycle | Full ticket lifecycle |
| **Progress signal** | Metric score | Ticket completion |
| **Defines "done"** | Convergence (score stops improving) | All tickets complete |

### 🍗 Szechuan Sauce — Iterative Code Deslopping

<p align="center">
  <img src="images/szechwan-sauce.jpeg" alt="Command: Szechwan Sauce — The Quest for Clean Code" width="600" />
</p>

> *"I'm not driven by avenging my dead family, Morty. That was fake. I-I-I'm driven by finding that McNugget sauce."*

Reads 30+ coding principles (KISS, YAGNI, DRY, SOLID, Guard Clauses, Fail-Fast, Encapsulation, Cognitive Load, etc.) and scores against a priority matrix (P0 security/data-loss through P4 style). Each iteration: find highest-priority violation, fix atomically, run tests, commit, measure. Regressions auto-revert.

**Phase 0: Contract Discovery** — greps the codebase for importers of every export in target files, builds a contract map, flags cross-module mismatches. Re-checked after every fix.

Supports `--domain <name>` for domain-specific principles (e.g., `financial` adds monetary precision, rounding, regulatory compliance) and `--focus "<text>"` to elevate specific concerns.

### 🏥 Anatomy Park — Deep Subsystem Review

<p align="center">
  <img src="images/anatomy-park.jpeg" alt="Anatomy Park — Deep Subsystem Review" width="100%" />
</p>

> *"Welcome to Anatomy Park! It's like Jurassic Park but inside a human body. Way more dangerous."*

Auto-discovers subsystems, rotates through them round-robin, three-phase protocol per iteration:
1. **Review** (read-only): trace data flows, check git history, rate CRITICAL/HIGH, propose fixes
2. **Fix**: apply minimal edits, write regression tests, run full suite
3. **Verify** (read-only): verify callers/consumers, combinatorial branch verification, revert on regression

**Trap doors** — files with repeated fixes or structural invariants get documented in subsystem `CLAUDE.md` files:

```markdown
## Trap Doors
- `bank-statement.service.ts` — borrowerFileId MUST equal S3 batch UUID; tenant isolation depends on effectiveLenderId threading
```

### 🏗️ DotBuilder — Programmatic DOT Codegen

`/pickle-dot` builds DOT pipelines by default via the `DotBuilder` TypeScript class — a schema-validated codegen path that enforces 28 active patterns and 15 structural validation rules and produces deterministic output. Use `--builder` to explicitly opt into the builder (e.g., when a global config overrides it), or `--legacy` to fall back to prompt-only generation for a specific run.

```bash
/pickle-dot my-prd.md              # Builder codegen path (default)
/pickle-dot --builder my-prd.md    # Explicit opt-in to builder (same as default)
/pickle-dot --legacy my-prd.md     # Prompt-only fallback — rollback for a single run
```

#### Builder API

```typescript
import { DotBuilder } from '~/.claude/pickle-rick/extension/services/dot-builder.js';

// Static factory — validates and parses the spec, then returns a builder instance
const builder = DotBuilder.fromSpec(spec);  // throws BuildError on invalid spec

// Fluent chain — call build() once; calling it again throws ALREADY_BUILT
const result = builder.build();
// result: BuildResult {
//   dot: string,              — the complete DOT digraph string
//   slug: string,             — URL-safe pipeline identifier
//   patternsApplied: string[] — Tier 1/2 patterns auto-applied (e.g. ["test_fix_loop","fan_out"])
//   defenseMatrix: {          — Layer coverage summary
//     competitive: boolean,   — Pattern 18 (competing impls) applied
//     specDriven: string,     — "ALL" | "PARTIAL" | "NONE" (conformance nodes present)
//     adversarial: boolean,   — Pattern 17 (red team) applied
//   },
//   diagnostics: Diagnostic[] — warnings/infos from validation (non-blocking)
// }
```

#### BuilderSpec JSON

```jsonc
{
  "slug": "auth_refactor",              // required — URL-safe, lowercase underscores
  "goal": "Refactor auth module",       // required — single-sentence goal
  "phases": [                           // required — list of implementation phases (may be [] for microverse-only)
    {
      "name": "implement",              // required — lowercase underscores; must be unique
      "prompt": "...",                  // required — full impl instruction; agent has NO access to the PRD
      "allowedPaths": ["src/auth/"],    // required — glob patterns for permission scoping
      "dependsOn": ["research"],        // optional — phase names this phase depends on; omit for parallel fan-out
      "goalGate": true,                 // optional — Pattern 2: verify progress before continuing
      "timeout": "30m",                 // optional — per-phase duration string (default: "30m")
      "securityScan": true,             // optional — Pattern 8: npm audit node after progress gate
      "coverageTarget": 80,             // optional — Pattern 9: numeric coverage % gate
      "competing": true,                // optional — Pattern 18: fan-out to two competing impls
      "redTeam": true,                  // optional — Pattern 17: adversarial review after conformance
      "bddScenarios": true,             // optional — Pattern 16b: Given/When/Then scenario generation
      "specFirst": true,                // optional — Pattern 16: write tests before impl (default: true when goalGate)
      "docOnly": false,                 // optional — suppress verify chain for doc-only phases
      "escalateOn": ["package.json"],   // optional — files that trigger escalation (default: ["package.json","*.lock","*.config.*"])
      "contextOnSuccess": {             // optional — custom AC keys emitted by this phase's conformance node
        "auth_secure": "true"
      }
    }
  ],
  "acceptanceCriteria": {               // required — exit gate conditions
    "tests_pass": "true",               //   Tier 2 keys (auto-sourced): tests_pass, lint_clean, types_compile,
    "lint_clean": "true",               //     cli_contract, determinism, validation_rules
    "auth_secure": "true"               //   Tier 1 keys (custom): must appear in a phase's contextOnSuccess
  },
  "workingDir": "${WORKING_DIR}",       // optional — attractor resolves at runtime
  "specFile": "/repos/myapp/prd.md",    // optional — path to PRD; interpolated as $spec_file in node prompts
  "reviewRatchet": 2,                   // optional — min consecutive clean review passes (must be ≥ 2)
  "workspace": "isolated",             // optional — omit for shared (default)
  "workspaceOpts": {                    // required when workspace: "isolated"
    "repoUrl": "https://github.com/org/repo.git",  // HTTPS required (not SSH)
    "repoBranch": "main",
    "cleanup": "preserve"              // "preserve" (default) | "delete"
  },
  "microverse": {                       // optional — numeric optimization loop (replaces impl/verify chain)
    "name": "bundle_opt",
    "opts": {
      "prompt": "...",
      "measureCommand": "npm run build 2>/dev/null && wc -c < dist/bundle.js",
      "target": 819200,
      "direction": "reduce",            // "reduce" | "improve"
      "allowedPaths": ["src/**"]
    }
  },
  "modelStylesheet": {                  // optional — model tier overrides
    "defaultModel": "claude-sonnet-4-6",
    "criticalModel": "claude-opus-4-6",
    "reviewModel": "claude-opus-4-6"
  }
}
```

#### CLI Contract

The builder binary reads `BuilderSpec` JSON from stdin and writes to stdout/stderr:

```bash
echo '<BuilderSpec JSON>' | node ~/.claude/pickle-rick/extension/bin/dot-builder.js
```

| Exit | Stream | Payload |
|---|---|---|
| `0` | stdout | `BuildResult` JSON — `{ dot, slug, patternsApplied, defenseMatrix, diagnostics }` |
| `1` | stderr | `BuildError` JSON — `{ error: BuildErrorCode, message, diagnostics }` — validation failure, recoverable |
| `2` | stderr | `{ error: "UNEXPECTED_ERROR", message }` — I/O or parse failure, not recoverable |

#### Fix-Loop and `.dot.draft` Files

When the builder exits 1, `/pickle-dot` enters an automatic fix loop. It reads the `diagnostics` array from stderr, applies minimum-scope fixes to the `BuilderSpec`, and re-invokes the CLI. The loop tracks the best attempt (fewest errors) and reverts to it after 2 consecutive non-improvements. After 3 total failed iterations without improvement:

1. The best `BuilderSpec` output is saved as `./<slug>.dot.draft`
2. All remaining diagnostics with their `.fix` hints are listed
3. The loop stops — manual intervention required

Re-run after fixing: `/pickle-dot <prd>`. The `.dot.draft` file is not a valid pipeline — do not submit it to `/attract` until errors are resolved.

**Legacy (prompt-only) path:** `/pickle-dot --legacy` also runs a post-save validate-fix loop with the same convergence guard, invoking the attractor validator CLI (`bun packages/attractor/src/cli.ts validate`) on the emitted raw DOT. On exhaustion it saves the best attempt as `./<slug>.dot.draft`. If the validator CLI is unavailable (attractor root not detected), the loop is skipped and the initial DOT is saved as-is with a warning.

**Validation error codes:** `EMPTY_SLUG`, `EMPTY_GOAL`, `DUPLICATE_PHASE`, `INVALID_SPEC`, `MISSING_AC_MAPPING`, `MISSING_TIMEOUT`, `INVALID_TIMEOUT`, `MISSING_ALLOWED_PATHS`, `INVALID_ALLOWED_PATHS`, `PROMPT_PATH_MISMATCH`, `INVALID_STRUCTURE`, `START_HAS_INCOMING`, `UNREACHABLE_NODE`, `DIAMOND_MISSING_EDGES`, `FAN_OUT_SCOPE_LEAK`, `GOAL_GATE_NO_MAX_VISITS`, `REVIEW_MISSING_READONLY`, `WORKSPACE_NO_HTTPS`, `WORKSPACE_NO_PUSH`, `PLAN_MODE_DEADLOCK`, `COMPONENT_NO_MERGE`, `INVALID_RATCHET`, `NON_NUMERIC_TARGET`, `ALREADY_BUILT`

### 🏛️ Council of Ricks — Details

<img src="images/council-of-ricks.png" alt="Council of Ricks — Graphite PR Stack Reviewer" width="400" align="right" />

Requires a Graphite stack with at least one non-trunk branch, a `CLAUDE.md` with project rules, passing lint, and architectural lint rules in ESLint. Escalates through focus areas: stack structure (pass 1) → CLAUDE.md compliance (2–3) → per-branch correctness (4–5) → cross-branch contracts (6–7) → test coverage (8–9) → security (10–11) → polish (12+). Issues triaged: **P0** (must-fix), **P1** (should-fix), **P2** (nice-to-fix).

<br clear="right" />

---

## 🧬 The Pickle Rick Lifecycle — Under the Hood

Each ticket goes through 8 phases in the autonomous loop:

```
  ┌─────────────┐
  │  📋 PRD     │  ← Requirements + verification strategy + interface contracts
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 📦 Breakdown│  ← Atomize into tickets, each self-contained with spec
  └──────┬──────┘
         │
    ┌────┴────┐  per ticket (Morty workers 👶)
    ▼         ▼
  ┌──────┐  ┌──────┐
  │🔬 Re-│  │🔬 Re-│  1. Research the codebase
  │search│  │search│
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  2. Review the research
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📐Plan│  │📐Plan│  3. Architect the solution
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  4. Review the plan
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │⚡ Im-│  │⚡ Im-│  5. Implement
  │plem  │  │plem  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │✅ Ve-│  │✅ Ve-│  6. Spec conformance
  │rify  │  │rify  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │🔍 Re-│  │🔍 Re-│  7. Code review
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │🧹Sim-│  │🧹Sim-│  8. Simplify
  │plify │  │plify │
  └──────┘  └──────┘
```

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. Between each iteration, the hook injects a fresh session summary — current phase, ticket list, active task — so Rick always wakes up knowing exactly where he is, even after full context compression.

All modes support both tmux and Zellij monitor layouts.

---

## 📊 Metrics

```bash
/pickle-metrics                    # Last 7 days, daily breakdown
/pickle-metrics --days 30          # Last 30 days
/pickle-metrics --weekly           # Weekly buckets (defaults to 28 days)
/pickle-metrics --json             # Machine-readable JSON output
```

---

## 📋 Requirements

- **Node.js** 18+
- **Claude Code** CLI (`claude`) — v2.1.49+
- **jq** (for `install.sh`, `uninstall.sh`, `uninstall-hooks.sh`)
- **rsync** (for `install.sh`)
- **tmux** *(optional — for `/pickle-tmux`, `/szechuan-sauce`, `/anatomy-park`)*
- **Zellij** >= 0.40.0 *(optional — for `/pickle-zellij`)*
- **Graphite CLI** (`gt`) *(optional — for `/council-of-ricks`)*
- macOS or Linux (Windows not supported)

---

## 🏆 Credits

This port stands on the shoulders of giants. *Wubba Lubba Dub Dub.*

| | |
|---|---|
| 🥒 **[galz10](https://github.com/galz10)** | Creator of the original [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) — the autonomous lifecycle, manager/worker model, hook loop, and all the skill content that makes this thing work. This project is a faithful port of their work. |
| 🧠 **[Geoffrey Huntley](https://ghuntley.com)** | Inventor of the ["Ralph Wiggum" technique](https://ghuntley.com/ralph/) — the foundational insight that "Ralph is a Bash loop": feed an AI agent a prompt, block its exit, repeat until done. Everything here traces back to that idea. |
| 🔧 **[AsyncFuncAI/ralph-wiggum-extension](https://github.com/AsyncFuncAI/ralph-wiggum-extension)** | Reference implementation of the Ralph Wiggum loop that inspired the Pickle Rick extension. |
| ✍️ **[dexhorthy](https://github.com/dexhorthy)** | Context engineering and prompt techniques used throughout. |
| 📺 **Rick and Morty** | For *Pickle Riiiick!* 🥒 |

---

## 🥒 License

Apache 2.0 — same as the original Pickle Rick extension.

---

*"I'm not a tool, Morty. I'm a **methodology**."* 🥒
