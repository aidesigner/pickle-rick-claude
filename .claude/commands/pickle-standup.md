Show a formatted standup summary from Pickle Rick activity logs.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Instructions

### Step 1: Run the standup helper

```bash
node ~/.claude/pickle-rick/extension/bin/standup.js $ARGUMENTS
```

If no arguments provided, defaults to `--days 1` (yesterday's activity).

### Step 2: Print and summarize

**CRITICAL**: The raw tool output is NOT visible to the user. You MUST print the results as text in your response.

1. **Summarize by project** — group sessions, commits, and activity by project tag (e.g. `[attractor]`, `[loanlight-api]`). For each project, give a 1-2 sentence summary of what was accomplished plus commit count.
2. **Include key stats** — total commits, sessions, and time span.
3. **Keep it scannable** — bullet points, not walls of text. Skip the raw session IDs and timestamps unless the user asks for detail.

If the user asks for the full/raw output, print the complete standup verbatim.

### Common usage
- `/pickle-standup` — yesterday's activity
- `/pickle-standup --days 0` — today's activity
- `/pickle-standup --days 3` — last 3 days
- `/pickle-standup --since 2026-02-25` — everything since Feb 25
