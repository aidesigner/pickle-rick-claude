Show a formatted standup summary from Pickle Rick activity logs.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Instructions

Run the standup helper with user arguments:

```bash
node ~/.claude/pickle-rick/extension/bin/standup.js $ARGUMENTS
```

Display the output as-is. If no arguments provided, defaults to `--days 1` (yesterday's activity).

### Common usage
- `/pickle-standup` — yesterday's activity
- `/pickle-standup --days 0` — today's activity
- `/pickle-standup --days 3` — last 3 days
- `/pickle-standup --since 2026-02-25` — everything since Feb 25
