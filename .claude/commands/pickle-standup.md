Show a formatted standup summary from Pickle Rick activity logs.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Instructions

### Step 1: Run the standup helper

```bash
node ~/.claude/pickle-rick/extension/bin/standup.js $ARGUMENTS
```

If no arguments provided, defaults to `--days 1` (yesterday's activity).

### Step 2: Format as Slack standup

**CRITICAL**: The raw tool output is NOT visible to the user. You MUST print the results as text in your response.

Format the output as a Slack-ready standup post:

```
Gregory Dickson [8:14 AM] *<date or date range>*
**Y:**
- **[project-name]** Concise summary of accomplishment
- **[project-name]** Another item
...

**T:**
- **[project-name]** What's planned next
```

**Rules:**
1. Every bullet gets a **[project-tag]** prefix (e.g. `[attractor]`, `[loanlight-api]`, `[Pickle Rick]`)
2. Consolidate related commits/activities into single human-readable bullets — don't list every commit or session ID
3. Keep it concise like a real Slack standup — no raw timestamps, session IDs, or commit hashes
4. Multi-day standups get combined into one post with a date range
5. **Y:** = what was accomplished, **T:** = what's planned next (infer from trajectory of recent work)
6. If the user asks for the full/raw output, print the complete standup verbatim instead
7. `## Teammate PRs merged` from the helper is informational only — NEVER attribute those commits to the user in **Y:** bullets. If worth mentioning, append a single footer line after **T:** like `Team shipped: <brief one-liner each, with author name>`. Default is to omit unless the user asks.
8. **Translate jargon before writing Y:**. For each of the user's own commits with a PR ref (`(#\d+)` suffix), if the subject matches the jargon heuristic, run `gh pr view <N> --json title,body` and rewrite in user-impact language (what changed for a user / admin / operator — not what code or internal component was touched). One line per PR. Jargon heuristic (any of): title matches `/szechuan|anatomy-park|anatomy park|csplit|SSE|DB-backed|dry-run|trap door|microverse|plumbus|meeseeks|pickle|morty|council of ricks|szechuan-sauce/i`; title shorter than 25 chars; title is a bare kebab-case branch slug with no prose.

**Example:**

```
Gregory Dickson [8:14 AM] *Mar 14–16*
**Y:**
- **[document-ocr-prototypes]** New project to benchmark OCR across approaches. Docling appraisal extraction prototype: microverse convergence loop hit 100% extraction accuracy (96.8% → 100%) across 12 iterations — spatial proximity heuristics, checkbox detection, field defaults
- **[Pickle Rick]** pickle-dot v1.15.0 + v1.16.0: lint/typecheck/conformance gates, multi-provider model routing, "Reviews Are Dead" patterns (spec-first TDD, adversarial red team, competing impls), review convergence ratchet, retry target scoping fix
- **[attractor]** ESLint flat config with TS strict + import boundaries, fixed 49 errors
- **[attractor]** Stream-json live activity monitor, pipeline queue + orphan cleanup, non-root Docker, PM Guide
- **[Pickle Rick]** Fixed microverse infinite loop, Mastra dynamic→static imports, spawn-morty tests

**T:**
- App.loanlight.com integration, support any issues coming from John.
- **[attractor]** Test and fix cycles
- SOC audit prep
- develop ideas for devops automation with John (possibly tomorrow)
- Support new UI development approaches for Encompass UI.
- Review Bank Statement Analyzer (today or tomorrow)
```

### Common usage
- `/pickle-standup` — yesterday's activity
- `/pickle-standup --days 0` — today's activity
- `/pickle-standup --days 3` — last 3 days
- `/pickle-standup --since 2026-02-25` — everything since Feb 25
