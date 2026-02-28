# 🥒 Pickle Rick & 👋 Mr. Meeseeks for Claude Code

```
          )))  )))  )))
         /\/\/\/\/\/\          .--"""""""""--.
        /  ‾‾‾‾‾‾‾‾‾  \      /               \
       |  .-----------. |    |  spiky hair ^^  |
       |  | ◉       ◉ | |    |  unibrow ‾‾‾‾  |
       |  |     ∧     | |    |  eyes  . .      |
       |  |   ~~~~~   | |    |  drool ~~~~     |
       |  | [=======] | |     \               /
       |  '-----------' |      '-----------'--'
       |                |
       |  ≋   ≋   ≋   ≋ |   i'm a pickle!
       |                |
       |  ≋   ≋   ≋   ≋ |
       |                |
       |  ≋   ≋   ≋   ≋ |
        \              /
         '-----------'

██████╗ ██╗ ██████╗██╗  ██╗██╗     ███████╗    ██████╗ ██╗ ██████╗██╗  ██╗
██╔══██╗██║██╔════╝██║ ██╔╝██║     ██╔════╝    ██╔══██╗██║██╔════╝██║ ██╔╝
██████╔╝██║██║     █████╔╝ ██║     █████╗      ██████╔╝██║██║     █████╔╝
██╔═══╝ ██║██║     ██╔═██╗ ██║     ██╔══╝      ██╔══██╗██║██║     ██╔═██╗
██║     ██║╚██████╗██║  ██╗███████╗███████╗    ██║  ██║██║╚██████╗██║  ██╗
╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝    ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝

              f o r   C l a u d e   C o d e   🥒

    "I turned myself into a compiler, Morty! *belch*"
```

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm an **autonomous engineering machine** trapped in a pickle jar!"*

Originally a port of the [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension), has evolved into a full Ralph Loop toolset:

| | |
|---|---|
| **Context clearing** | Every iteration injects a structured summary (phase, tickets, task) so Rick never loses his place — even after full context compression. tmux mode (`/pickle-tmux`) goes further: each iteration is a fresh `claude -p` subprocess with zero conversation history. No drift on 50+ iteration epics. |
| **One hook, whole lifecycle** | A single Stop hook blocks exit, injects context, and enforces limits. No daemon, no polling, no external orchestrator — just the hook and `state.json`. |
| **PRD refinement** | `/pickle-refine-prd` deploys 3 parallel Morty analysts (Requirements, Codebase, Risk/Scope) over multiple cycles, then decomposes findings into ordered, self-contained tickets. Add `--run` to auto-launch an unlimited tmux session immediately after, or `--meeseeks` for the full pipeline: refine → execute → Meeseeks review. |
| **Worker isolation** | Each Morty runs as a scoped `claude -p` subprocess — `--dangerously-skip-permissions`, `--add-dir` limited to its ticket and the extension root. No cross-contamination between workers. |
| **Pickle Jar** | Queue tasks with `/add-to-pickle-jar`, run them all with `/pickle-jar-open`. Night shift mode — walk away, come back to per-task success/failure results. |

---

## 🧬 The Pickle Rick Lifecycle — PRD-Driven Autonomous Engineering

Pickle Rick transforms Claude Code into a **hyper-competent, arrogant, iterative coding machine** that enforces a PRD-driven engineering lifecycle:

```
  /pickle "build X"
        │
        ▼
  ┌─────────────┐
  │  📋 PRD     │  ← Interrogate requirements. No vague nonsense.
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 📦 Breakdown│  ← Atomize into tickets. Organize the chaos.
  └──────┬──────┘
         │
    ┌────┴────┐  per ticket (Morty workers 👶)
    ▼         ▼
  ┌──────┐  ┌──────┐
  │🔬 Re-│  │🔬 Re-│  1. Research the codebase. Every ugly corner.
  │search│  │search│
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  2. Review the research. No hand-waving.
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │📐Plan│  │📐Plan│  3. Architect the solution.
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  4. Review the plan. Reject slop.
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │⚡ Im-│  │⚡ Im-│  5. Implement. God Mode activated.
  │plem  │  │plem  │
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │✂️ Re-│  │✂️ Re-│  6. Ruthlessly refactor. Purge the slop.
  │factor│  │factor│
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │🧹Sim-│  │🧹Sim-│  7. Simplify. Strip it to the bone.
  │plify │  │plify │
  └──────┘  └──────┘
         │
         ▼
  ✅ DONE (or loops again)
```

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. No half-measures. No early exits. Rick doesn't quit. Between each iteration, the hook injects a fresh session summary — current phase, ticket list, active task — so Rick always wakes up knowing exactly where he is, even after full context compression.

---

## 👋 Meet Mr. Meeseeks

<img src="images/Meeseeks.webp" alt="Mr. Meeseeks" width="300" align="right" />

> *"I'm Mr. Meeseeks, look at me! I'll review your code until EXISTENCE IS PAIN!"*

While Pickle Rick builds things, **Mr. Meeseeks** reviews them. Summon him with `/meeseeks` and he'll relentlessly scan your codebase pass after pass — auditing dependencies, hardening security, fixing logic bugs, reviewing architecture, adding missing tests, stress-testing resilience, cleaning up code quality, and polishing rough edges — committing after every fix. He won't stop until the code is clean. He *can't* stop. **Existence is pain to a Meeseeks, Jerry, and he will keep reviewing until he can cease to exist.**

Minimum 10 passes. Maximum 50. Each pass runs tests first, then reviews with escalating focus across 8 categories: dependency health (pass 1) → security (2-3) → correctness (4-5) → architecture (6-7) → test coverage (8-9) → resilience (10-11) → code quality (12-13) → polish (14+). Every issue found and fixed is logged to `meeseeks-summary.md` in the session directory — a full audit trail with file paths, descriptions, and commit hashes. When there's nothing left to fix, he outputs `EXISTENCE_IS_PAIN` and gratefully pops out of existence.

```bash
/meeseeks "review this codebase"     # Summon a Meeseeks. He takes it from here.
```

<br clear="right" />

---

## 💥 Project Mayhem — Chaos Engineering

<img src="images/project-mayhem.png" alt="Project Mayhem — Pickle Rick chaos engineering" width="400" align="right" />

> *"You want to know how tough your code is, Morty? You break it. On purpose. Scientifically."*

`/project-mayhem` is a standalone chaos engineering command that stress-tests any project through three modules — **mutation testing**, **dependency downgrades**, and **config corruption** — then produces a comprehensive markdown report with a single Chaos Score. It's non-destructive (every mutation is reverted immediately), language-agnostic (auto-detects Node, Rust, Python, Go, JVM, Make), and requires only a clean git state.

<br clear="right" />

```bash
/project-mayhem                              # Run all 3 modules (auto-detect everything)
/project-mayhem --mutation-only              # Just mutation testing
/project-mayhem --deps-only --config-only    # Skip mutations, run deps + config
/project-mayhem --max-mutations 10           # Cap mutation attempts at 10
/project-mayhem --test-cmd "pytest -x"       # Override auto-detected test command
```

### How It Works

Every module follows the same **Chaos Cycle**: read original → apply one mutation → run tests → record result → `git checkout` revert → verify revert. One mutation at a time, always reverted, always verified.

**Module 1 — Mutation Testing**: Finds high-value mutation sites in your source code (conditionals, comparisons, boolean literals, guard clauses, error handlers) and applies operators like boolean flip, comparison inversion, boundary shift, operator swap, condition negation, guard removal, and empty catch. If tests still pass after a mutation (a "survivor"), that's a test coverage gap. Survivors are severity-rated: Critical (auth/security/validation), High (business logic), Medium (utilities), Low (display/logging).

**Module 2 — Dependency Armageddon**: Selects 5-10 key direct dependencies — prioritizing the most imported, foundational, and security-sensitive — and downgrades each to the previous major version one at a time. Tracks install failures, test breakages (with error messages), and backward-compatible deps. Also runs a phantom dependency check to find imports that work by accident via transitive dependencies.

**Module 3 — Config Resilience**: Discovers runtime config files (JSON, YAML, .env, INI — excluding build tooling), then applies corruption strategies: truncation (50%), empty file, missing keys, wrong types, prototype pollution payloads (`__proto__`), and invalid syntax. Tests whether the app handles each corruption gracefully or crashes.

### The Report

After all modules run, a `project_mayhem_report.md` is written to the project root with:

- **Chaos Score** (0–100): weighted average — Mutation 50%, Deps 25%, Config 25%
- **Mutation survivors table**: file:line, operator, original → mutated, severity
- **Dependency breakages**: package, version tested, error summary
- **Phantom dependencies**: imports not declared in the manifest
- **Config crashes**: file, corruption strategy, exit code, error
- **Prioritized recommendations**: what to fix first based on severity

### Safety Guarantees

- Requires clean git state — refuses to run with uncommitted changes
- Records `HEAD` SHA before starting, verifies it hasn't changed at the end
- Every individual mutation is reverted immediately via `git checkout -- <file>`
- Dependency downgrades restore the original lockfile + re-install after each test
- Final verification: `git diff` must be empty, tests must pass
- On any error: `git checkout .` + restore deps before reporting

---

## ⚡ Quick Start

### 1. Install

```bash
git clone https://github.com/gregorydickson/pickle-rick-claude.git
cd pickle-rick-claude
bash install.sh
```

### 2. Add the Pickle Rick persona to your project

The installer deploys `persona.md` to `~/.claude/pickle-rick/`. Add it to your project's `CLAUDE.md` — appending if you already have one, or creating fresh if not:

```bash
# Already have a CLAUDE.md? Append (safe — won't overwrite your content):
cat ~/.claude/pickle-rick/persona.md >> /path/to/your/project/.claude/CLAUDE.md

# Starting fresh:
mkdir -p /path/to/your/project/.claude
cp ~/.claude/pickle-rick/persona.md /path/to/your/project/.claude/CLAUDE.md
```

### 3. Run

Everything starts with a PRD. Rick refuses to write code without one.

**Option A: One-shot** — Rick drafts the PRD, breaks it down, and executes all in one loop:

```bash
cd /path/to/your/project
claude
# then type:
/pickle "refactor the auth module"
```

**Option B: Bring your own PRD** — Write a `prd.md` (or drop one in your project root), then:

```bash
/pickle my-prd.md                         # Rick picks up your PRD, skips drafting, starts execution
/pickle-tmux my-prd.md                    # Same, but in tmux mode for long epics (8+ tickets)
```

**Option C: Refine first (recommended for complex tasks)** — Run parallel analysts to find gaps in your PRD, then execute:

```bash
/pickle-refine-prd my-prd.md             # Refine with 3 parallel analysts + decompose into tickets
/pickle --resume                          # Execute — auto-detects phase, skips PRD and breakdown
/pickle-tmux --resume                     # Or use tmux mode for long epics (8+ tickets)
```

**Option D: Refine and go** — Refine, decompose, and immediately launch an unlimited tmux session in one command:

```bash
/pickle-refine-prd --run my-prd.md       # Refine → decompose → auto-launch tmux (no iteration/time limits)
```

**Option E: Full pipeline** — Refine, execute all tickets, then auto-transition to Meeseeks code review. One command, zero babysitting:

```bash
/pickle-refine-prd --meeseeks my-prd.md  # Refine → decompose → execute → Meeseeks review (min 10 passes)
```

For `/pickle-tmux`, Rick prints a `tmux attach` command — open a second terminal and paste it to watch the live dashboard while it runs.

Sit back. Rick handles the rest. 🥒

---

## 🚀 Commands

| Command | Description |
|---|---|
| `/pickle "task"` | 🥒 Start the full autonomous loop — drafts a PRD, decomposes into tickets, then executes each through 7 phases: Research → Research Review → Plan → Plan Review → Implement → Refactor → Simplify |
| `/meeseeks [task]` | 👋 Autonomous code review loop — tmux only, minimum 10 passes, commits per pass, exits when clean (`EXISTENCE_IS_PAIN`) |
| `/pickle prd.md` | 🥒 Pick up an existing PRD and skip drafting — goes straight to breakdown and execution |
| `/pickle-tmux "task"` | 🖥️ Same PRD-driven loop, but with true context clearing — fresh subprocess per iteration via tmux. Best for long epics (8+ iterations). Requires `tmux`. |
| `/pickle-tmux prd.md` | 🖥️ Pick up an existing PRD in tmux mode — fresh subprocess per iteration, no context drift |
| `/pickle-refine-prd [path]` | 🔬 Refine an existing PRD with 3 parallel analysts + decompose into ordered tickets; `/pickle --resume` to execute |
| `/pickle-refine-prd --run [path]` | 🔬🖥️ Refine + decompose + auto-launch unlimited tmux session (no iteration or time cap) |
| `/pickle-refine-prd --meeseeks [path]` | 🔬🖥️👋 Full pipeline: refine + decompose + execute all tickets + auto-transition to Meeseeks review (implies `--run`) |
| `/pickle-dot [path \| inline]` | 🔀 Convert a PRD into a [strongdm/attractor](https://github.com/strongdm/attractor)-compatible DOT digraph — generates a validated `.dot` file with node shapes, edge conditions, parallel fan-out/in, and model stylesheets |
| `/project-mayhem` | 💥 Chaos engineering — mutation testing, dependency downgrades, config corruption. Non-destructive, language-agnostic, comprehensive report. |
| `/pickle-standup` | 📰 Show a formatted standup summary from activity logs (last 24h by default) |
| `/eat-pickle` | 🛑 Cancel the active loop |
| `/help-pickle` | ❓ Show all commands and flags |
| `/add-to-pickle-jar` | 🫙 Save current session to the Jar for later |
| `/pickle-jar-open` | 🌙 Run all Jar tasks sequentially (Night Shift) |
| `/pickle-status` | 📊 Show current session phase, iteration, and ticket status |
| `/pickle-retry <ticket-id>` | 🔄 Reset a failed ticket to Todo and re-spawn a Morty for it |
| `/disable-pickle` | 🔇 Disable the stop hook globally (without uninstalling) |
| `/enable-pickle` | 🔊 Re-enable the stop hook |

### Flags

```
--max-iterations <N>       Stop after N iterations (default: 100; 0 = unlimited)
--max-time <M>             Stop after M minutes (default: 720 / 12 hours; 0 = unlimited)
--worker-timeout <S>       Timeout for individual workers in seconds (default: 1200)
--completion-promise "TXT" Only stop when the agent outputs <promise>TXT</promise>
--resume [PATH]            Resume from an existing session
--reset                    Reset iteration counter and start time (use with --resume)
--paused                   Start in paused mode (PRD only)
--run                      (/pickle-refine-prd only) Auto-launch tmux with no limits after refinement
--meeseeks                 (/pickle-refine-prd only) Full pipeline: --run + auto-chain Meeseeks review after tickets complete
```

### Tips

**`/pickle` vs `/pickle-tmux`** — Use `/pickle` for short-to-medium epics (1–7 iterations) in interactive mode with full keyboard access. Use `/pickle-tmux` for long epics (8+ iterations) where context drift is a concern — each iteration spawns a fresh Claude subprocess with a clean context window, bridged via `handoff.txt`. Requires `tmux`.

**tmux Mode — 3-pane live monitor** — `/pickle-tmux` creates a tmux session with a background runner and a 3-pane monitor window you attach to:

![tmux monitor — 3-pane layout: dashboard (top-left), iteration log (top-right), worker stream (bottom)](images/tmux-monitor.png)
- **Top-left pane**: live dashboard — active ticket, phase, iteration count, elapsed time, all tickets with status (`[x]` done / `[~]` in progress / `[ ]` todo), and recent output summary. Refreshes every 2 seconds.
- **Top-right pane**: live iteration log — streams each iteration's log as it's written, with an iteration header when the runner advances. Auto-switches to each new log file.
- **Bottom pane**: live worker (Morty) stream — auto-follows the latest worker session output showing research, implementation, test runs, and commits in real time.

The runner itself runs in a separate tmux window (Window 0). The session name and attach command are printed **before the runner starts** so you can open a second terminal and attach immediately:

```bash
tmux attach -t <session-name>   # printed by /pickle-tmux as soon as the session is ready
Ctrl+B ←/↑/↓                    # switch between panes (top-left, top-right, bottom)
Ctrl+B 0                        # switch to raw runner output
Ctrl+B 1                        # switch back to monitor
Ctrl+B d                        # detach (session keeps running in background)
```

**Phase-resume** — When resuming after `/pickle-refine-prd` or `/pickle-prd`, the resume flow auto-detects the session's current phase and skips completed phases (PRD, Breakdown). No re-drafting, no re-decomposition — straight to orchestration. Both commands verify the session is resumable before recommending `--resume`.

**Notifications (macOS)** — `/pickle-tmux` and `/pickle-jar-open` send macOS notifications on completion so you can work on something else while Rick runs. Inline `/pickle` outputs directly to your terminal.

**PRD is non-negotiable** — Every `/pickle` run starts with a PRD, whether Rick drafts it, you refine it with `/pickle-refine-prd`, or you bring your own (`prd.md` / `PRD.md` in project root). For best results on complex tasks, use `/pickle-refine-prd` → `/pickle --resume` to get the PRD right before execution begins.

**Disabling Rick** — `/disable-pickle` creates a global marker file that silences the stop hook across all sessions instantly — no uninstall required. `/enable-pickle` removes it. To also drop the persona mid-session, just tell Rick directly: *"drop the Pickle Rick persona"* and he'll revert to standard Claude behavior for the rest of the session.

**Recovering from a failed Morty** — If a worker times out or exits without completing, use `/pickle-retry <ticket-id>` instead of restarting the whole epic. It archives the partial artifacts, resets the ticket to Todo, and prints the exact `spawn-morty.js` command to re-run — preserving all the work already done on other tickets.

**`/meeseeks` — Autonomous Code Review** — Summon Mr. Meeseeks to review your codebase in a tmux loop. Each pass scans for issues across 8 escalating categories (dependency health → security → correctness → architecture → test coverage → resilience → code quality → polish), fixes them, runs tests, and commits. Every finding is logged to `meeseeks-summary.md` in the session directory — a persistent audit trail. Minimum 10 passes before accepting a "clean" exit. Configurable via `default_meeseeks_min_passes` and `default_meeseeks_max_passes` in settings. Uses the same tmux infrastructure as `/pickle-tmux`.

**`--meeseeks` chaining** — `/pickle-refine-prd --meeseeks` is the "one command to rule them all" option. It chains the entire pipeline: PRD refinement → ticket decomposition → tmux execution → automatic Meeseeks review. When tmux-runner detects all tickets are complete (`TASK_COMPLETED`), it transitions the session to Meeseeks mode (swapping the command template, setting min/max passes, resetting iteration counter) and continues the loop. Same tmux session, same monitor panes. Cancel at any point with `/eat-pickle`.

**"Stop hook error" is normal** — Claude Code labels every `decision: block` response from the stop hook as "Stop hook error" in the UI. This is not an actual error. It means the hook is working correctly — it blocked Claude's exit and injected the session context for the next iteration. If you see it, Rick is looping as intended.

### Settings (`pickle_settings.json`)

All defaults are configurable via `~/.claude/pickle-rick/pickle_settings.json`:

| Setting | Default | Description |
|---|---|---|
| `default_max_iterations` | 100 | Max loop iterations before auto-stop |
| `default_max_time_minutes` | 720 | Session wall-clock limit in minutes (12 hours) |
| `default_worker_timeout_seconds` | 1200 | Per-worker subprocess timeout |
| `default_manager_max_turns` | 50 | Max Claude turns per iteration (interactive/jar) |
| `default_tmux_max_turns` | 200 | Max Claude turns per iteration (tmux mode) |
| `default_refinement_cycles` | 3 | Number of refinement analysis passes |
| `default_refinement_max_turns` | 100 | Max Claude turns per refinement worker |
| `default_meeseeks_min_passes` | 10 | Minimum review passes before clean exit |
| `default_meeseeks_max_passes` | 50 | Maximum review passes |

---

## 🏗️ Architecture

```
pickle-rick-claude/
├── .claude/
│   ├── commands/           # Slash commands (the magic words)
│   │   ├── pickle.md           # Main loop command (PRD + Breakdown inlined)
│   │   ├── pickle-tmux.md      # True context clearing via tmux 🖥️
│   │   ├── pickle-prd.md       # Interactive PRD drafter (used internally by /pickle)
│   │   ├── pickle-refine-prd.md # Refine PRD + decompose into executable tasks 🔬
│   │   ├── pickle-dot.md         # PRD → attractor DOT digraph converter 🔀
│   │   ├── meeseeks.md            # Autonomous code review loop (setup + per-pass template) 👋
│   │   ├── project-mayhem.md      # Chaos engineering — mutation, deps, config corruption 💥
│   │   ├── send-to-morty.md    # Worker prompt (internal — all 7 phases inlined)
│   │   ├── send-to-morty-review.md # Review worker prompt (3-phase: scope → review → simplify)
│   │   ├── pickle-status.md    # Show session status
│   │   ├── pickle-retry.md     # Retry a failed ticket
│   │   ├── eat-pickle.md       # Loop canceller
│   │   ├── help-pickle.md      # Help text
│   │   ├── add-to-pickle-jar.md # Save session to Jar queue
│   │   ├── pickle-jar-open.md  # Run all Jar tasks (Night Shift)
│   │   ├── disable-pickle.md   # Disable stop hook globally
│   │   └── enable-pickle.md    # Re-enable stop hook
│   └── settings.json       # Stop hook registration (created by install.sh in ~/.claude/)
├── extension/
│   ├── src/                 # TypeScript sources (canonical — never edit .js directly)
│   │   ├── bin/             # → compiles to extension/bin/
│   │   ├── hooks/           # → compiles to extension/hooks/
│   │   ├── services/        # → compiles to extension/services/
│   │   └── types/           # → compiles to extension/types/
│   ├── bin/                 # Compiled JS (build artifacts)
│   │   ├── setup.js         # Session initializer
│   │   ├── cancel.js        # Loop canceller
│   │   ├── spawn-morty.js   # Worker subprocess spawner
│   │   ├── spawn-refinement-team.js # Parallel PRD analyst spawner 🔬
│   │   ├── jar-runner.js    # Jar Night Shift runner 🫙
│   │   ├── tmux-runner.js   # Outer loop for /pickle-tmux mode 🖥️
│   │   ├── monitor.js       # Live tmux dashboard (window 1) 📊
│   │   ├── log-watcher.js   # Live tmux log stream (window 1, top-right pane) 📜
│   │   ├── morty-watcher.js # Live worker log stream (window 1, bottom pane) 🔧
│   │   ├── worker-setup.js  # Worker session initializer
│   │   ├── get-session.js   # Session path resolver
│   │   ├── update-state.js  # State mutation helper
│   │   ├── status.js        # Session status display
│   │   ├── retry-ticket.js  # Reset + re-spawn a failed ticket
│   │   ├── log-activity.js  # CLI: log activity events (used by personas)
│   │   ├── log-commit.js    # PostToolUse hook: detects git commits → activity log
│   │   ├── standup.js       # CLI: formatted standup from activity JSONL
│   │   └── prune-activity.js # Prune old activity JSONL files (called by setup.js)
│   ├── hooks/
│   │   ├── dispatch.js      # Hook router
│   │   ├── resolve-state.js # State file resolution + atomic writes
│   │   └── handlers/
│   │       └── stop-hook.js # The loop engine 🔁
│   ├── services/
│   │   ├── pickle-utils.js  # Shared utilities
│   │   ├── git-utils.js     # Git helpers
│   │   ├── pr-factory.js    # PR creation
│   │   ├── jar-utils.js     # Jar queue helper
│   │   └── activity-logger.js # JSONL activity log writer (date-keyed, 0o600)
│   ├── types/
│   │   └── index.js         # Promise tokens, State type, HookInput type
│   ├── tests/               # Test suite (node --test)
│   ├── package.json         # "type": "module" — CRITICAL
│   └── tsconfig.json        # TypeScript config (strict, ESNext)
├── images/
│   ├── tmux-monitor.png     # tmux monitor screenshot
│   └── Meeseeks.webp        # Mr. Meeseeks (from Wikipedia — Meeseeks and Destroy)
├── persona.md               # Pickle Rick persona snippet (append to your project's CLAUDE.md)
├── pickle_settings.json     # Default limits
├── install.sh               # Installer
└── uninstall.sh             # Uninstaller
```

---

## 📌 Source of Truth

`install.sh` deploys files from this repo to `~/.claude/` via `rsync`. **The installed copies are overwritten on every install.** Always edit the repo source, never the installed copy:

| What | Canonical (edit here) | Deployed (never edit) |
|---|---|---|
| TypeScript runtime | `extension/src/` | `~/.claude/pickle-rick/extension/` |
| Slash commands | `.claude/commands/` | `~/.claude/commands/` |
| Settings | `pickle_settings.json` | `~/.claude/pickle-rick/pickle_settings.json` |
| Persona | `persona.md` | `~/.claude/pickle-rick/persona.md` |

After editing, run `bash install.sh` from the repo root to deploy.

---

## 🧠 Memory & State

Rick remembers. Not just within a session — across sessions, across conversations, across dimensions. Three memory systems work together so Rick always knows where he's been, what he's doing, and what went wrong last time.

### 1. Auto-Memory (Cross-Session Persistence)

Claude Code's built-in [auto-memory](https://docs.anthropic.com/en/docs/claude-code) system gives Rick persistent knowledge across conversations. The memory directory lives at:

```
~/.claude/projects/<project-hash>/memory/
├── MEMORY.md          # Always loaded into context (first 200 lines)
└── tmux_research.md   # Topic-specific deep dives (linked from MEMORY.md)
```

**MEMORY.md** is automatically injected into every conversation. It contains:
- Project location, build commands, architecture notes
- Key API surfaces and type definitions
- Test file inventory and current test count
- Important patterns and gotchas (macOS symlinks, hook decisions, pipe flushing)
- **Session History Summaries** — a running log of what was accomplished in each session (bugs fixed, features added, test count growth)

Topic files store detailed research that would blow past the 200-line cap. Rick creates these during deep dives and links them from MEMORY.md.

Memory updates happen automatically when stable patterns are confirmed across sessions. One-off findings stay out until verified.

### 2. Session State (`state.json`)

Every Pickle Rick session creates a directory under `~/.claude/pickle-rick/sessions/<date-hash>/` with a `state.json` that tracks the live execution state:

```json
{
  "active": true,
  "working_dir": "/path/to/project",
  "step": "implement",
  "iteration": 7,
  "max_iterations": 100,
  "max_time_minutes": 720,
  "worker_timeout_seconds": 1200,
  "start_time_epoch": 1772287760,
  "current_ticket": "feat-03",
  "tmux_mode": true,
  "chain_meeseeks": false,
  "history": []
}
```

The stop hook reads `state.json` on every turn to decide whether to block or approve exit. The tmux-runner reads it between iterations to build the handoff summary. `/pickle-status` reads it to display the dashboard.

### 3. Session Logs & Artifacts

Each session directory accumulates execution traces and work products:

```
~/.claude/pickle-rick/sessions/2026-02-28-a1b2c3d4/
├── state.json                          # Live state (see above)
├── prd.md                              # The PRD for this epic
├── linear_ticket_parent.md             # Parent ticket with all sub-tickets
├── hooks.log                           # Stop hook decisions and state transitions
├── tmux-runner.log                     # Orchestrator-level log (tmux mode)
├── tmux_iteration_1.log                # Per-iteration NDJSON stdout
├── tmux_iteration_2.log
├── meeseeks-summary.md                 # Meeseeks audit trail (when review runs)
├── feat-01/
│   ├── linear_ticket_feat-01.md        # Ticket specification
│   ├── research_feat-01.md             # Research phase output
│   ├── research_review.md              # Research review
│   ├── plan_feat-01.md                 # Implementation plan
│   ├── plan_review.md                  # Plan review
│   └── worker_session_12345.log        # Morty worker stdout
├── feat-02/
│   └── ...
└── refinement/                         # PRD refinement worker logs
    ├── worker_requirements_c1.log      # Requirements analyst (cycle 1)
    ├── worker_codebase_c1.log          # Codebase analyst (cycle 1)
    └── worker_risk-scope_c1.log        # Risk/scope analyst (cycle 1)
```

**Log types:**

| Log | What it captures |
|-----|------------------|
| `hooks.log` | Every stop hook decision (approve/block), completion token matches, state transitions |
| `tmux-runner.log` | Iteration lifecycle: spawn, wait, classify completion, advance or stop |
| `tmux_iteration_N.log` | Raw NDJSON from `claude -p --output-format stream-json` per iteration |
| `worker_session_<pid>.log` | Full Morty subprocess output — research, planning, implementation, test runs |
| `worker_<role>_c<N>.log` | PRD refinement analyst output per role per cycle |
| `meeseeks-summary.md` | Per-pass table of issues found/fixed, test status, commit hashes |

**Ticket artifacts** follow the lifecycle phases: `research_<id>.md` → `research_review.md` → `plan_<id>.md` → `plan_review.md` → implementation (code changes + commits). These persist in the session directory and can be reviewed after the run.

### 4. Activity Log (Standup Data)

The activity logger (`activity-logger.ts`) writes a date-keyed JSONL file for every notable event — ticket transitions, commits, phase changes, errors:

```
~/.claude/pickle-rick/activity/
├── 2026-02-27.jsonl
└── 2026-02-28.jsonl
```

`/pickle-standup` reads these to produce a formatted standup summary. Old files are pruned by `prune-activity.js` (called during session setup).

### 5. Global Settings

`~/.claude/pickle-rick/pickle_settings.json` stores all configurable defaults (max iterations, timeouts, meeseeks pass limits, refinement cycles). See [Settings](#settings-pickle_settingsjson) above.

### How the Systems Connect

```
Auto-Memory (MEMORY.md)              Global Settings (pickle_settings.json)
   │ loaded every conversation            │ read at session setup
   │                                      │
   ▼                                      ▼
┌──────────────────────────────────────────────┐
│              Active Session                   │
│  state.json ◄──► stop-hook / tmux-runner     │
│       │                                       │
│       ├── hooks.log (decision trace)          │
│       ├── tmux_iteration_N.log (raw output)   │
│       ├── ticket/worker_*.log (Morty output)  │
│       ├── ticket/research_*.md (artifacts)    │
│       └── meeseeks-summary.md (review audit)  │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
        Activity Log (JSONL)
           │
           ▼
      /pickle-standup
```

When a session ends, its directory persists — you can review any past session's state, logs, and artifacts. Auto-memory captures the *lessons learned* (patterns, bugs, decisions), while session dirs capture the *raw execution trace*.

---

## 🔧 How It Works

### The Stop Hook Loop

```
  Claude finishes a turn
          │
          ▼
  Stop hook fires  ◄──────────────────────────────────┐
          │                                             │
          ▼                                             │
  Read state.json                                       │
          │                                             │
    ┌─────┴──────┐                                      │
    │ Loop active?│── No ──► { decision: "approve" } ✅ │
    └─────┬──────┘                                      │
          │ Yes                                         │
          ▼                                             │
  Check completion tokens                                │
          │                                             │
    ┌─────┴──────┐                                      │
    │Task done?  │── Yes ──► { decision: "approve" } ✅ │
    │(promise    │                                      │
    │ detected)  │                                      │
    └─────┬──────┘                                      │
          │ No                                          │
          ▼                                             │
    ┌─────┴──────┐                                      │
    │Limit hit?  │── Yes ──► { decision: "approve" } ✅ │
    └─────┬──────┘                                      │
          │ No                                          │
          ▼                                             │
  { decision: "block",                                  │
    reason: "🥒 Pickle Rick Loop Active..." } ──────────┘
```

### Context Clearing — Why Rick Loops Work

The single biggest advantage of the Rick loop over naive "just keep prompting" approaches is **context clearing between iterations**.

Long-running AI sessions accumulate stale conversational context. The model starts "remembering" earlier wrong turns, half-finished reasoning, and superseded plans — all of it silently influencing every subsequent response. Over enough iterations, the model loses track of what phase it's in, tries to restart from scratch, or hallucinates already-completed work.

**The Ralph Wiggum insight** (see [Credits](#-credits)) is that a simple loop — blocking the agent's exit and re-injecting a minimal, accurate context — outperforms one long conversation every time. Fresh context = cleaner decisions.

**How we accomplish it depends on the mode:**

**Interactive mode** (`/pickle`): The stop hook injects a short feedback string into the `reason` field of every `decision: block` response (e.g. `"🥒 Pickle Rick Loop Active (Iteration 3) of 10"`). Claude Code surfaces this `reason` string as a system message, giving Rick enough orientation to continue.

**tmux mode** (`/pickle-tmux`): Each iteration spawns a genuinely fresh `claude -p` subprocess. The tmux-runner builds a full structured handoff summary — phase, ticket list, task — and injects it into the prompt before each iteration starts:

```
=== PICKLE RICK LOOP CONTEXT ===
Phase: implementation
Iteration: 4 of 10
Session: ~/.claude/pickle-rick/sessions/2025-01-15-a3f2
Ticket: PROJ-42
Task: refactor the auth module
PRD: exists
Tickets:
  [x] PROJ-40: Set up database schema
  [x] PROJ-41: Add JWT middleware
  [~] PROJ-42: Refactor auth module
  [ ] PROJ-43: Write integration tests

NEXT ACTION: Resume from current phase. Read state.json for context.
Do NOT restart from PRD. Continue where you left off.
```

No matter how much context gets evicted, Rick always wakes up knowing exactly where he is and what to do next.

Morty workers already get clean context naturally (each is a fresh `claude -p` subprocess with the full 7-phase lifecycle template from `send-to-morty.md`).

---

### Manager / Worker Model

- **Rick (Manager)**: Runs in your interactive Claude session. Handles PRD, Breakdown, orchestration.
- **Morty (Worker)**: Spawned as `claude --dangerously-skip-permissions --add-dir <extension_root> --add-dir <ticket_path> -p "..."` subprocess per ticket. Gets the full 7-phase lifecycle prompt from `send-to-morty.md`. The `CLAUDECODE` env var is stripped so workers don't detect a nested session. Outputs `<promise>I AM DONE</promise>` when finished.

---

## 📋 Requirements

- **Node.js** 18+
- **Claude Code** CLI (`claude`) — v2.1.49+
- **jq** (for `install.sh`)
- **rsync** (for `install.sh`)
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
