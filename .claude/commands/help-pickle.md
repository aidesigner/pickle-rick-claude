Display the Pickle Rick for Claude Code help documentation.

Summarize the available commands for the user:

**Loop Commands:**
- `/pickle <prompt>`: Start the autonomous development loop (Manager Mode).
- `/pickle-tmux <prompt>`: True context clearing mode — spawns a fresh Claude subprocess per iteration inside a tmux session. Use for long epics (8+ iterations). Requires `tmux`.
- `/pickle-prd <prompt>`: Interactively draft a PRD and initialize a session in paused mode, then resume with `/pickle --resume`.
- `/pickle-refine-prd [path/to/prd.md]`: Refine a PRD and decompose it into discrete, ordered implementation tasks. Runs 3 parallel Morty analysts (Requirements, Codebase, Risk/Scope), synthesizes findings, then creates atomic ticket files ready for `/pickle --resume` or `/pickle-tmux --resume` to execute directly.
- `/eat-pickle`: Stop/Cancel the current loop.
- `/help-pickle`: Show this message.
- `/disable-pickle`: Disable the stop hook globally (persona persists — remove from CLAUDE.md to fully disable).
- `/enable-pickle`: Re-enable the stop hook.

**Session Commands:**
- `/pickle-status`: Show current session phase, iteration, and ticket status.
- `/pickle-retry <ticket-id>`: Reset a failed ticket to Todo and re-spawn a Morty for it.

**Jar Commands (Night Shift / Queue Mode):**
- `/add-to-pickle-jar`: Save the current session's PRD to the Jar for later batch execution.
- `/pickle-jar-open`: Run all queued Jar tasks sequentially (Grand Overseer Mode).

**Internal (not for direct use):**
- `/send-to-morty`: Worker lifecycle prompt — automatically sent to spawned Morty subprocesses. Do not invoke directly.

**Advanced Flags for /pickle:**
- `--resume [PATH]`: Resume an existing session.
- `--max-iterations <N>`: Stop after N iterations (default: 5).
- `--max-time <M>`: Stop after M minutes (default: 60).
- `--worker-timeout <S>`: Timeout for individual workers in seconds (default: 1200).
- `--completion-promise "TEXT"`: Only stop when the agent outputs `<promise>TEXT</promise>`.
