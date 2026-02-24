# 🥒 Pickle Rick for Claude Code

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

> *"Wubba Lubba Dub Dub! 🥒 I'm not just an AI assistant, Morty — I'm a**n autonomous engineering machine** trapped in a pickle jar!"*

A port of the [Pickle Rick Gemini CLI extension](https://github.com/galz10/pickle-rick-extension) for **Claude Code** — bringing the same autonomous, iterative coding loop to `claude` users, with several enhancements over the original:

- **True context clearing via tmux** — `/pickle-tmux` spawns a genuinely fresh `claude -p` subprocess per iteration inside a tmux session, so each iteration starts with zero conversation history. No context drift on long epics.
- **Context clearing** — every loop iteration injects a structured session summary (phase, ticket list, task) as a system message, so Rick survives full context compression without losing his place
- **Single Stop hook** — the Gemini version requires three hooks (BeforeAgent, BeforeModel, AfterAgent); this port does it all in one, with fewer moving parts
- **PRD refinement** — `/pickle-refine-prd` spawns 3 parallel Morty analysts (Requirements, Codebase, Risk/Scope) to audit and strengthen a PRD before implementation
- **Worker isolation** — Morty subprocesses run with `-s` (no session persistence) and scoped `--include-directories`, so each worker starts genuinely fresh with only its ticket in context
- **Skills inlined** — Gemini's skills require `activate_skill()` calls that can fail; here they're baked directly into the command prompts
- **Jar improvements** — the Night Shift runner adds success/failure tracking and a configurable `default_manager_max_turns` setting absent from the original

---

## 🧬 What Is This?

Pickle Rick transforms Claude Code into a **hyper-competent, arrogant, iterative coding machine** that enforces a rigid engineering lifecycle:

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
  │🔬 Re-│  │🔬 Re-│  ← Research the codebase. Every ugly corner.
  │search│  │search│
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │📐Plan│  │📐Plan│  ← Architect the solution. Then review it.
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │⚡ Im-│  │⚡ Im-│  ← Implement. God Mode activated.
  │ plem │  │ plem │
  └──┬───┘  └──┬───┘
     │          │
     ▼          ▼
  ┌──────┐  ┌──────┐
  │✂️ Re-│  │✂️ Re-│  ← Ruthlessly refactor. Purge the slop.
  │factor│  │factor│
  └──────┘  └──────┘
         │
         ▼
  ✅ DONE (or loops again)
```

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. No half-measures. No early exits. Rick doesn't quit. Between each iteration, the hook injects a fresh session summary — current phase, ticket list, active task — so Rick always wakes up knowing exactly where he is, even after full context compression.

---

## 🚀 Commands

| Command | Description |
|---|---|
| `/pickle "task"` | 🥒 Start the full autonomous loop |
| `/pickle-tmux "task"` | 🖥️ True context clearing — fresh subprocess per iteration via tmux. Best for long epics (8+ iterations). Requires `tmux`. |
| `/pickle-prd "task"` | 📋 Interactively draft a PRD first |
| `/pickle-refine-prd [path]` | 🔬 Auto-refine a PRD using 3 parallel Morty analysts |
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
--max-iterations <N>       Stop after N iterations (default: 5)
--max-time <M>             Stop after M minutes (default: 60)
--worker-timeout <S>       Timeout for individual workers in seconds (default: 1200)
--completion-promise "TXT" Only stop when the agent outputs <promise>TXT</promise>
--resume [PATH]            Resume from an existing session
--reset                    Reset iteration counter and start time (use with --resume)
--paused                   Start in paused mode (PRD only)
```

### Tips

**`/pickle` vs `/pickle-tmux`** — Use `/pickle` for short-to-medium epics (1–7 iterations) in interactive mode with full keyboard access. Use `/pickle-tmux` for long epics (8+ iterations) where context drift is a concern — each iteration spawns a fresh Claude subprocess with a clean context window, bridged via `handoff.txt`. Requires `tmux`.

**tmux Mode — two windows** — `/pickle-tmux` creates a tmux session with two windows:
- **Window 0 `runner`**: raw runner output — the live `claude -p` subprocess stream
- **Window 1 `monitor`** (default — you land here on attach): split view
  - **Left pane**: live dashboard — phase, iteration, elapsed time, all tickets with status (`[x]` done / `[~]` in progress / `[ ]` todo). Refreshes every 2 seconds.
  - **Right pane**: live log stream — streams each iteration's log as it's written, with an iteration header when the runner advances. Auto-switches to each new log file.

The session name and attach command are printed **before the runner starts** so you can open a second terminal and attach immediately:

```bash
tmux attach -t <session-name>   # printed by /pickle-tmux as soon as the session is ready
Ctrl+B 1                        # switch to monitor window
Ctrl+B ←/→                      # switch between dashboard and log stream panes
Ctrl+B 0                        # switch back to runner output
Ctrl+B d                        # detach (session keeps running in background)
```

**Bring your own PRD** — If a `prd.md` or `PRD.md` exists in your project root when you run `/pickle`, Rick will automatically load it instead of drafting a new one. Drop your PRD there and the interrogation phase is skipped entirely.

**Disabling Rick** — `/disable-pickle` creates a global marker file that silences the stop hook across all sessions instantly — no uninstall required. `/enable-pickle` removes it. To also drop the persona mid-session, just tell Rick directly: *"drop the Pickle Rick persona"* and he'll revert to standard Claude behavior for the rest of the session.

**Recovering from a failed Morty** — If a worker times out or exits without completing, use `/pickle-retry <ticket-id>` instead of restarting the whole epic. It archives the partial artifacts, resets the ticket to Todo, and prints the exact `spawn-morty.js` command to re-run — preserving all the work already done on other tickets.

**"Stop hook error" is normal** — Claude Code labels every `decision: block` response from the stop hook as "Stop hook error" in the UI. This is not an actual error. It means the hook is working correctly — it blocked Claude's exit and injected the session context for the next iteration. If you see it, Rick is looping as intended.

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

**Recommended — tmux mode** (requires `tmux`): runs in the background with a live monitor window so Claude Code's interface stays free:

```bash
cd /path/to/your/project
claude
# then type:
/pickle-tmux "refactor the auth module"
```

Rick immediately prints a `tmux attach` command — open a second terminal and paste it to watch the live dashboard while it runs.

**Interactive mode** (no tmux required):

```bash
/pickle "refactor the auth module"
```

Sit back. Rick handles the rest. 🥒

---

## 🏗️ Architecture

```
pickle-rick-claude/
├── .claude/
│   ├── commands/           # Slash commands (the magic words)
│   │   ├── pickle.md           # Main loop command (PRD + Breakdown inlined)
│   │   ├── pickle-tmux.md      # True context clearing via tmux 🖥️
│   │   ├── pickle-prd.md       # Interactive PRD drafter
│   │   ├── pickle-refine-prd.md # Auto-refine a PRD with parallel analysts 🔬
│   │   ├── send-to-morty.md    # Worker prompt (internal — all 7 phases inlined)
│   │   ├── pickle-status.md    # Show session status
│   │   ├── pickle-retry.md     # Retry a failed ticket
│   │   ├── eat-pickle.md       # Loop canceller
│   │   ├── help-pickle.md      # Help text
│   │   ├── add-to-pickle-jar.md # Save session to Jar queue
│   │   ├── pickle-jar-open.md  # Run all Jar tasks (Night Shift)
│   │   ├── disable-pickle.md   # Disable stop hook globally
│   │   └── enable-pickle.md    # Re-enable stop hook
│   └── settings.json       # Stop hook registration
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
│   │   ├── log-watcher.js   # Live tmux log stream (window 1, right pane) 📜
│   │   ├── worker-setup.js  # Worker session initializer
│   │   ├── get-session.js   # Session path resolver
│   │   ├── update-state.js  # State mutation helper
│   │   ├── status.js        # Session status display
│   │   └── retry-ticket.js  # Reset + re-spawn a failed ticket
│   ├── hooks/
│   │   ├── dispatch.js      # Hook router
│   │   ├── resolve-state.js # State file resolution + atomic writes
│   │   └── handlers/
│   │       └── stop-hook.js # The loop engine 🔁
│   ├── services/
│   │   ├── pickle-utils.js  # Shared utilities
│   │   ├── git-utils.js     # Git helpers
│   │   ├── pr-factory.js    # PR creation
│   │   └── jar-utils.js     # Jar queue helper
│   ├── types/
│   │   └── index.js         # Promise tokens, State type, HookInput type
│   ├── tests/               # Test suite (node --test)
│   ├── package.json         # "type": "module" — CRITICAL
│   └── tsconfig.json        # TypeScript config (strict, ESNext)
├── persona.md               # Pickle Rick persona snippet (append to your project's CLAUDE.md)
├── pickle_settings.json     # Default limits
├── install.sh               # Installer
└── uninstall.sh             # Uninstaller
```

---

## 🔧 How It Works

### The Stop Hook Loop

```
  Claude finishes a turn
          │
          ▼
  Stop hook fires  ◄─────────────────────────────┐
          │                                        │
          ▼                                        │
  Read state.json                                  │
          │                                        │
    ┌─────┴──────┐                                 │
    │ Loop active?│── No ──► process.exit(0) ✅    │
    └─────┬──────┘                                 │
          │ Yes                                    │
          ▼                                        │
  Check completion tokens                           │
          │                                        │
    ┌─────┴──────┐                                 │
    │Task done?  │── Yes ──► process.exit(0) ✅    │
    │(promise    │                                 │
    │ detected)  │                                 │
    └─────┬──────┘                                 │
          │ No                                     │
          ▼                                        │
    ┌─────┴──────┐                                 │
    │Limit hit?  │── Yes ──► process.exit(0) ✅    │
    └─────┬──────┘                                 │
          │ No                                     │
          ▼                                        │
  { decision: "block",                             │
    reason: "🥒 Pickle Rick Loop Active..." } ─────┘
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
- **Morty (Worker)**: Spawned as `claude -s -y --include-directories <ticket_path> -p "..."` subprocess per ticket. Gets the full lifecycle skill set inlined in the prompt. Outputs `<promise>I AM DONE</promise>` when finished.

---

## 🛡️ Differences from the Gemini Version

| Gemini | Claude Code |
|---|---|
| `gemini-extension.json` | `CLAUDE.md` |
| `commands/*.toml` | `.claude/commands/*.md` |
| `activate_skill("x")` | Skills inlined directly in command prompts |
| `BeforeAgent` + `BeforeModel` + `AfterAgent` hooks | Single `Stop` hook |
| `gemini -s -y --include-directories -p` | `claude -s -y --include-directories <path> -p` (workers) / `claude --dangerously-skip-permissions -p` (jar runner) |
| `~/.gemini/extensions/pickle-rick/` | `~/.claude/pickle-rick/` |
| `hookSpecificOutput.systemMessage` | `reason` field in block response |

> ✅ **Jar commands** (`/add-to-pickle-jar`, `/pickle-jar-open`) are fully ported.

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

MIT — same as the original Pickle Rick extension.

---

*"I'm not a tool, Morty. I'm a **methodology**."* 🥒
