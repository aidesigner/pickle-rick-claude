Display the Pickle Rick for Claude Code help documentation.

Summarize the available commands for the user:

**Loop Commands:**
- `/pickle <prompt>`: Start autonomous dev loop (Manager Mode)
- `/pickle-tmux <prompt>`: Context-clearing tmux mode — fresh subprocess per iteration. For long epics (8+ tasks). Requires `tmux`
- `/pickle-prd <prompt>`: Interactive PRD drafting, then resume with `/pickle --resume`
- `/pickle-refine-prd [path]`: Refine PRD via 3 parallel Morty analysts, decompose into atomic tickets. Resume with `/pickle --resume` or `/pickle-tmux --resume`
- `/pickle-dot [path | inline PRD]`: Convert PRD to strongdm/attractor-compatible DOT digraph
- `/meeseeks`: Launch iterative code review loop (Mr. Meeseeks)
- `/eat-pickle`: Stop/cancel current loop
- `/help-pickle`: This message
- `/disable-pickle`: Disable stop hook globally
- `/enable-pickle`: Re-enable stop hook

**Session:** `/pickle-status` (show status) | `/pickle-retry <ticket-id>` (retry failed ticket) | `/pickle-standup` (activity summary)

**Jar (batch queue):** `/add-to-pickle-jar` (queue PRD) | `/pickle-jar-open` (run all queued)

**Internal:** `/send-to-morty` — auto-sent to worker subprocesses, not for direct use

**Flags for /pickle:** `--resume [PATH]` | `--max-iterations <N>` (default:100) | `--max-time <M>` (default:720min) | `--worker-timeout <S>` (default:1200) | `--completion-promise "TEXT"`
