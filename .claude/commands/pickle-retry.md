You are retrying a failed or timed-out Pickle Rick ticket.

Run the retry script with the ticket ID:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/retry-ticket.js" $ARGUMENTS
```

After the script runs:
1. Read the printed `spawn-morty.js` command from the output.
2. Run `git status` — if there are uncommitted changes, stash them with `git stash`.
3. Execute the printed spawn-morty command exactly as shown.
4. After Morty outputs `<promise>I AM DONE</promise>`, proceed with the standard validation and commit flow (audit docs, check git diff, run tests, commit if passing, mark ticket Done).
