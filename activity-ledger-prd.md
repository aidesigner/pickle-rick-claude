# Activity Ledger & Standup Report PRD

| Activity Ledger & Standup Report |  | Append-only daily activity logs with a `/pickle-standup` skill for next-day recall |
| :---- | :---- | :---- |
| **Author**: Pickle Rick **Intended audience**: Engineering | **Status**: Draft **Created**: 2026-02-27 | **Visibility**: Internal |

## Introduction

Pickle Rick sessions produce significant work — tickets completed, meeseeks passes, commits, epics finished — but none of it is recorded in a queryable format. The only way to reconstruct what happened is to manually read `git log`, scan session directories, or remember. This is a Jerry-level approach to engineering accountability.

This PRD specifies a lightweight activity ledger that captures work events from three sources (Pickle infrastructure, git commit hooks, and persona-driven logging) into daily JSONL files, plus a `/pickle-standup` skill that reads them back as a formatted standup report.

Inspired by OpenClaw's `memory/YYYY-MM-DD.md` daily log pattern, but stripped down: no SQLite, no embeddings, no semantic search. Just structured JSONL and a skill that reads it.

## Problem Statement

**Current Process:** After a day of work, the only ways to see what happened are `git log`, reading `state.json` files across session directories, or relying on human memory.

**Primary Users:** Developers using Pickle Rick (automated or interactive) who want a next-day standup summary, work history, or audit trail.

**Pain Points:**
- No centralized record of what Pickle Rick sessions accomplished
- Regular (non-Pickle) Claude Code conversations produce no activity record at all
- Reconstructing yesterday's work requires manual git archaeology
- Failed attempts, retries, and meeseeks passes leave no trace outside session dirs
- No way to answer "what did I work on this week?" without digging

**Importance:** Activity visibility is table stakes for any iterative development tool. Without it, users lose track of multi-day efforts and can't report progress to teams.

## Objective & Scope

**Objective:** Automatically capture work activity into daily JSONL files from all three execution contexts (Pickle infrastructure, commit hooks, persona), and provide a `/pickle-standup` skill to query and summarize them.

**Ideal Outcome:** A user runs `/pickle-standup` the next morning and gets a formatted summary of everything that happened yesterday — tickets completed, commits made, meeseeks passes, research done — without any manual effort.

### In-scope

- `extension/src/services/activity-logger.ts` — core `logActivity()` function and event schema
- `extension/src/bin/log-activity.ts` — CLI entry point for persona-sourced events
- `extension/src/bin/log-commit.ts` — standalone PostToolUse handler for git commit detection *(refined: standalone bin module, NOT hooks/ directory)*
- `extension/src/bin/prune-activity.ts` — delete JSONL files older than 365 days
- `extension/src/bin/standup.ts` — helper script that pre-computes standup data as compact markdown *(refined: added per codebase analyst recommendation)*
- Instrumentation of `setup.ts`, `stop-hook.ts`, `tmux-runner.ts`, `jar-runner.ts` to emit events
- Claude Code `PostToolUse` hook registration in `settings.json` for git commit detection *(refined: correct event name)*
- CLAUDE.md persona instruction for best-effort logging in regular conversations
- `.claude/commands/pickle-standup.md` — skill that reads standup helper output
- `install.sh` update to deploy hook config, CLI scripts, and skill
- Tests for activity-logger, log-commit, prune-activity, and standup helper

### Out-of-scope

- Semantic search / embeddings over activity logs
- SQLite or any database
- Pre-compaction memory flush (we don't control Claude's context lifecycle)
- Web UI or dashboard
- Cross-machine sync (activity is local only)
- Ticket lifecycle events (`ticket_started`, `ticket_failed`) — requires new PromiseTokens, command template updates, stop-hook failure detection, and spawn-morty error reporting; deferred to v2 *(refined: removed from v1 per all-analyst consensus)*
- Structured meeseeks detail fields (`focus`, `issues_found`, `issues_fixed`) — requires extending State interface, `ALLOWED_KEYS` in `update-state.ts`, and `meeseeks.md` template; deferred to v2 *(refined: Option B — accept null for v1)*
- `files_changed`, `tests_added`, `tests_total` fields — no extraction mechanism exists at any emit point; deferred to v2 *(refined: removed per codebase analyst)*
- Direct terminal git usage (commits made outside Claude Code)
- "In Progress" and "Issues" standup sections — require state.json scanning and ticket_failed infrastructure respectively; deferred to v2 *(refined: per standup cascade analysis)*

## Architecture

### Storage Layout

```
~/.claude/pickle-rick/activity/
  2026-02-26.jsonl
  2026-02-27.jsonl
  ...
```

One file per day. Append-only. Each line is a self-contained JSON event. Files older than 365 days are pruned.

**Timezone convention**: Filename date routing uses local system timezone (`new Date().toLocaleDateString('en-CA')` → `YYYY-MM-DD`). The `ts` field remains ISO 8601 UTC for sort precision. Standup `--since`/`--days` flags also use local calendar dates. Pruning age calculation uses filename date (local) compared to today's local date. *(refined: added per requirements analyst)*

### Event Schema

```typescript
interface ActivityEvent {
  ts: string;              // ISO 8601 UTC timestamp
  event: ActivityEventType;
  session?: string;        // session ID (if from Pickle infrastructure)
  source: 'pickle' | 'hook' | 'persona';  // which layer emitted this

  // Event-specific fields (all optional)
  epic?: string;           // epic/task name
  ticket?: string;         // ticket ID
  title?: string;          // human-readable description
  step?: string;           // lifecycle phase (prd, implement, etc.)
  mode?: string;           // interactive, tmux, jar
  pass?: number;           // meeseeks pass number (= state.iteration)
  commit_hash?: string;
  commit_message?: string;
  duration_min?: number;   // tmux sessions only in v1
  error?: string;          // for failure events (future)
}

type ActivityEventType =
  | 'session_start'
  | 'session_end'
  | 'ticket_completed'
  | 'epic_completed'
  | 'meeseeks_pass'
  | 'commit'
  | 'research'
  | 'bug_fix'
  | 'feature'
  | 'refactor'
  | 'review'
  | 'jar_start'
  | 'jar_end';
```

*(refined: removed `ticket_started`, `ticket_failed`, `files_changed`, `tests_added`, `tests_total`, `focus`, `issues_found`, `issues_fixed` — none implementable in v1)*

**v1 field limitations:**
- `duration_min` — populated for tmux sessions only (`tmux-runner.ts:321`). Interactive/jar sessions: omitted.
- `pass` — meeseeks pass number from `state.iteration`. `focus`/`issues_found`/`issues_fixed` deferred to v2 (blocked by `ALLOWED_KEYS` whitelist).
- `title` — populated for persona events. Omitted from infrastructure events in v1 (requires ticket file I/O in stop-hook's hot path).

### Core Utility: `activity-logger.ts`

**Location**: `extension/src/services/activity-logger.ts` → compiles to `extension/services/activity-logger.js` → deploys to `~/.claude/pickle-rick/extension/services/activity-logger.js`

```typescript
export function logActivity(event: Partial<ActivityEvent> & { event: ActivityEventType; source: ActivityEvent['source'] }): void
```

- Resolves `~/.claude/pickle-rick/activity/` directory (creates via `mkdirSync({ recursive: true })` if missing)
- Computes filename from current local date: `new Date().toLocaleDateString('en-CA')` → `YYYY-MM-DD.jsonl` *(refined: local timezone)*
- Sets `ts` to `new Date().toISOString()` if not provided
- Appends one JSON line + `\n` via `fs.appendFileSync` (uses `O_APPEND` — POSIX guarantees atomic seek-to-end + write; events <1KB, well under APFS 4KB block size) *(refined: corrected atomicity justification)*
- Fails silently — wraps in try/catch, never throws (activity logging must never break the caller)
- File permissions: `mode: 0o600` on creation *(refined: per risk analyst)*

### Three Logging Sources

#### Source 1: Pickle Infrastructure (`source: 'pickle'`)

Deterministic. We control this code completely.

| Emit Point | Event | Fields & Data Source | Notes |
|---|---|---|---|
| `setup.ts` — **new-session branch only** (lines 215-250, AFTER `writeStateFile()` at line 249) | `session_start` | session=`state.session_dir`, epic=`state.original_prompt`, mode=`state.tmux_mode ? 'tmux' : 'interactive'` | **CRITICAL**: NOT emitted on resume branch (lines 149-214). In tmux, `setup.ts --resume` is called per-iteration by `tmux-runner.ts:77-78`. Emitting on resume would produce N events for an N-iteration session. *(refined: per codebase analyst P0)* |
| `stop-hook.ts` — `isTaskFinished && !isWorker` exit (lines 122-149) | `ticket_completed` | session=`path.basename(path.dirname(stateFile))`, ticket=`state.current_ticket`, step=`state.step` | Emit AFTER `approve()` at line 148. `title` omitted in v1 (requires ticket file I/O). |
| `stop-hook.ts` — `isEpicDone` exit (lines 122-149) | `epic_completed` | session=`path.basename(path.dirname(stateFile))`, epic=`state.original_prompt` | Emit AFTER `approve()`. |
| `stop-hook.ts` — `isExistenceIsPain` exit (lines 122-149) | `meeseeks_pass` | session=`path.basename(path.dirname(stateFile))`, pass=`Number(state.iteration)` | `focus`/`issues_found`/`issues_fixed` omitted in v1. Emit AFTER `approve()`. |
| `stop-hook.ts` — non-tmux exit where `state.active = false` (lines 144-149, 184-189, 192-197) | `session_end` | session=`path.basename(path.dirname(stateFile))`, duration_min=`Math.round((Date.now()/1000 - Number(state.start_time_epoch)) / 60)` | **NEW emit point** — call AFTER `approve()`. Only fires for non-worker, non-refinement-worker exits. Duration reflects current run (not total session lifetime). *(refined: per requirements analyst P0)* |
| `tmux-runner.ts` — loop exit (line 321) | `session_end` | session=`path.basename(sessionDir)`, duration_min=`Math.round(totalElapsed / 60)` | Duration = runner wall-clock time. |
| `jar-runner.ts` — batch start (line 111) | `jar_start` | session=`'jar-batch'` | Per-batch, not per-task. Fires once at jar-runner launch. *(refined: clarified granularity)* |
| `jar-runner.ts` — batch end (line 194) | `jar_end` | session=`'jar-batch'` | Per-batch. |

**Stop-hook branching**: The current exit block at `stop-hook.ts:123` is a single if-statement covering 6 tokens. Per-token event emission requires branching WITHIN this block, placed AFTER `approve()`:

```typescript
approve();
// Activity logging — AFTER decision output, never before
if (isExistenceIsPain) {
  logActivity({ event: 'meeseeks_pass', source: 'pickle',
    session: path.basename(path.dirname(stateFile)),
    pass: Number(state.iteration) || undefined });
} else if (isEpicDone) {
  logActivity({ event: 'epic_completed', source: 'pickle',
    session: path.basename(path.dirname(stateFile)),
    epic: state.original_prompt || undefined });
} else if (isTaskFinished && !isWorker) {
  logActivity({ event: 'ticket_completed', source: 'pickle',
    session: path.basename(path.dirname(stateFile)),
    ticket: state.current_ticket || undefined,
    step: state.step });
}
// isWorkerDone, isAnalysisDone, hasPromise → no activity events
```

`session_end` fires separately at the `state.active = false` sites (lines 144-149, 184-189, 192-197), also AFTER `approve()`, and only when `!state.tmux_mode`. *(refined: per codebase analyst)*

#### Source 2: Git Commit Hook (`source: 'hook'`) *(refined: entire section rewritten)*

Semi-deterministic. Fires after every Bash tool call via Claude Code's `PostToolUse` hook.

**settings.json registration** (added by `install.sh`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.claude/pickle-rick/extension/bin/log-commit.js",
            "async": true,
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

All three fields required: `async: true` (non-blocking — without this, handler blocks Claude for up to 600s default timeout), `timeout: 5` (fast-fail), `matcher: "Bash"` (tool filter).

**Stdin contract** (JSON received by log-commit.js):

```json
{
  "session_id": "abc123",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "git commit -m \"fix: something\"" },
  "tool_response": { "stdout": "[main 1a2b3c4] fix: something\n 1 file changed..." }
}
```

**Handler logic** (`extension/src/bin/log-commit.ts`):
1. Read JSON from stdin (`fs.readFileSync(0, 'utf8')` — same pattern as `stop-hook.ts:31`)
2. Check `tool_input.command` matches `/\bgit\s+(commit|cherry-pick|merge)\b/` (word boundary — handles multi-command chains like `npm test && git commit -m "..."`) *(refined: word boundary per codebase analyst P2)*
3. If no match → exit 0 immediately (fast path, <10ms)
4. Parse commit hash from `tool_response.stdout` via `/\[[\w\/-]+\s+([a-f0-9]{7,})\]\s+(.+)/`
5. Call `logActivity({ event: 'commit', source: 'hook', commit_hash, commit_message })`
6. Exit 0 with no stdout (PostToolUse hooks are observers, not decision-makers)

**Important**: Does NOT route through `dispatch.js` — PostToolUse hooks don't emit approve/block. Standalone bin module, same convention as all 14 other CLI entry points. *(refined: per codebase analyst P0)*

**Async event loss**: With `async: true`, in-flight handlers may receive SIGTERM on session exit. Commits near session end could be dropped. Git log fallback in standup catches these. *(refined: documented risk)*

#### Source 3: Persona Instruction (`source: 'persona'`)

Best-effort. Relies on the LLM following CLAUDE.md instructions.

**Addition to CLAUDE.md / persona.md:**

> After completing meaningful work (bug fix, feature, refactor, research, review), log the activity:
> ```bash
> node ~/.claude/pickle-rick/extension/bin/log-activity.js <event_type> "<description>"
> ```
> Event types: `bug_fix`, `feature`, `refactor`, `research`, `review`.
> Keep descriptions short (under 100 chars). Don't log trivial actions (reading files, answering questions).

*(refined: corrected path from `bin/` to `extension/bin/`)*

**CLI entry point** (`extension/src/bin/log-activity.ts`):
```
Usage: log-activity <event_type> "<title>"
```

**Validation rules** *(refined: added per requirements analyst P1)*:
- CLI guard: `path.basename(process.argv[1]) === 'log-activity.js'`
- Reject unknown event types (exit 1 with error message listing valid types)
- Reject `--` prefixed positional args (prevent flag confusion)
- Strip `\n`/`\r` from title
- Truncate title at 200 chars
- Require non-empty title (exit 1)
- Error handling: `err instanceof Error ? err.message : String(err)`

Calls `logActivity({ event, title, source: 'persona' })` and exits 0.

### Pruning: `prune-activity.ts`

- Scans `~/.claude/pickle-rick/activity/` for `*.jsonl` files
- Parses date from filename (`YYYY-MM-DD.jsonl`) — local timezone comparison
- Deletes files where date is more than 365 days ago
- Wraps `unlinkSync` in try/catch for ENOENT race between concurrent sessions *(refined: per codebase analyst P2)*
- Called from `setup.ts` on session init (cheap — just a readdir + stat)
- Also callable standalone: `node extension/bin/prune-activity.js`

### `/pickle-standup` Skill

**Input:** Optional `--since YYYY-MM-DD` or `--days N` (default: 1)

**Flag semantics** *(refined: added per requirements analyst P1)*:
- `--days N` (default: 1): Last N local calendar days, NOT including today. `--days 1` = yesterday. `--days 3` = 3 days before today through yesterday.
- `--days 0`: Today's events only ("what have I done so far today?").
- `--since YYYY-MM-DD`: Events from given date through today. Overrides `--days`.
- Both provided: `--since` takes precedence.
- Invalid values (negative `--days`, unparseable `--since`, future dates): reject with error.

**Architecture**: The skill calls `node ~/.claude/pickle-rick/extension/bin/standup.js` which pre-computes all standup data as compact markdown. This avoids burning context tokens on raw JSONL parsing (~5000+ tokens for a busy day). *(refined: added helper per codebase analyst recommendation)*

**Helper behavior** (`extension/src/bin/standup.ts`):
1. Parse `--since`/`--days` flags, compute date range
2. Read all `*.jsonl` files in date range from `~/.claude/pickle-rick/activity/`
3. Parse each line as JSON — skip lines that fail `JSON.parse()`. If >10% of lines in a file are corrupt, emit a warning *(refined: per requirements analyst P1)*
4. Group events by session and event type
5. Run `git log --after=<since> --oneline` from CWD to capture commits not logged via hooks
6. Deduplicate: hook-sourced commits take precedence over git-log. Persona-sourced events never deduplicated (lack `commit_hash`). Git-log fills gaps for commits not captured by hooks. *(refined: specified dedup rules)*
7. Sort all events by `ts` before grouping *(refined: per risk analyst P2)*
8. Output formatted standup markdown to stdout
9. If zero events in date range: output "No activity found for [date range]." *(refined: per requirements analyst P2)*

**Output format (v1):**

```markdown
## Standup — 2026-02-26

### Sessions
- [tmux] Epic "auth-refactor": 5 tickets completed (90 min)
  - TICK-001: ticket_completed (implement)
  - TICK-002: ticket_completed (implement)
- [meeseeks] 3 review passes on auth-refactor
- [interactive] Epic "cancel-fix": 1 ticket completed

### Commits
- 1d452a7 fix: distinguish new session vs resume in handoff summary
- 2bdc295 perf: compress all skill prompts for token efficiency

### Ad-hoc Activity
- [persona] research: "Investigated OAuth2 PKCE flow options"
- [persona] bug_fix: "Fixed race condition in cancel handler"
```

*(refined: removed unimplementable sections. v1 limitations noted below)*

**v1 limitations** *(refined: per standup cascade analysis)*:
- Duration shown for tmux sessions only (interactive/jar lack `session_end` timing)
- "In Progress" section deferred to v2 (requires `sessions/*/state.json` scanning — undeclared dependency on `collectTickets()` from `pickle-utils.ts:198`)
- "Issues" section deferred to v2 (requires `ticket_failed` infrastructure)
- Ticket titles not shown for infrastructure events (would require file I/O in stop-hook hot path)
- Meeseeks detail (focus area, issues found/fixed) not shown (blocked by `ALLOWED_KEYS`)

## Implementation Plan

### Ticket 1: Core activity logger utility
- Create `extension/src/services/activity-logger.ts` with `logActivity()` function
- Create `extension/src/bin/log-activity.ts` CLI entry point with validation rules
- Add `ActivityEvent` and `ActivityEventType` to `types/index.ts`
- **Acceptance criteria:**
  - [ ] `logActivity()` appends valid JSONL to `~/.claude/pickle-rick/activity/YYYY-MM-DD.jsonl`
  - [ ] Filename uses local timezone (`toLocaleDateString('en-CA')`)
  - [ ] `ts` field is ISO 8601 UTC
  - [ ] Creates `activity/` dir if missing (`mkdirSync({ recursive: true })`)
  - [ ] File permissions `0o600` on creation
  - [ ] Silently catches all errors (never throws)
  - [ ] CLI: rejects unknown event types (exit 1), strips newlines, truncates at 200 chars
  - [ ] CLI guard: `path.basename(process.argv[1]) === 'log-activity.js'`
  - [ ] Tests: write to temp dir, verify JSONL format, verify date-based filenames, verify silent failure on bad path, CLI validation edge cases
  - [ ] Added to `extension/package.json` test script
- **Depends on:** none

### Ticket 2: Instrument Pickle infrastructure
- Add `logActivity()` calls to `setup.ts` (new-session branch ONLY), `stop-hook.ts` (per-token branching AFTER `approve()`), `tmux-runner.ts` (loop exit), `jar-runner.ts` (batch start/end)
- **Acceptance criteria:**
  - [ ] `setup.ts` emits `session_start` ONLY in new-session branch (lines 215-250), NOT resume branch
  - [ ] `stop-hook.ts` emits `ticket_completed` for `isTaskFinished && !isWorker`, `epic_completed` for `isEpicDone`, `meeseeks_pass` for `isExistenceIsPain` — all AFTER `approve()`
  - [ ] `stop-hook.ts` emits `session_end` at non-tmux `state.active = false` sites (lines 144-149, 184-189, 192-197) AFTER `approve()`
  - [ ] `tmux-runner.ts` emits `session_end` at loop exit (line 321)
  - [ ] `jar-runner.ts` emits `jar_start` at batch start (line 111), `jar_end` at batch end (line 194)
  - [ ] `isWorkerDone`, `isAnalysisDone`, `hasPromise` do NOT emit activity events
  - [ ] All `logActivity()` calls in stop-hook placed AFTER `approve()`/decision output
  - [ ] Tests: verify events emitted at correct points (mock `logActivity`)
  - [ ] Added to `extension/package.json` test script
- **Depends on:** Ticket 1

### Ticket 3: Git commit hook
- Create `extension/src/bin/log-commit.ts` — standalone `PostToolUse` handler
- Register `PostToolUse` hook in `settings.json` via `install.sh`
- **Acceptance criteria:**
  - [ ] `PostToolUse` hook registered in `settings.json` with `matcher: "Bash"`, `async: true`, `timeout: 5`
  - [ ] Reads stdin JSON (same pattern as `stop-hook.ts:31`)
  - [ ] Fast-path exit (<10ms) for non-commit commands
  - [ ] Parses commit hash + message from `git commit`, `git cherry-pick`, `git merge` output
  - [ ] Handles multi-command chains (`npm test && git commit -m "..."`) via word-boundary regex
  - [ ] Writes no stdout (async PostToolUse hooks should not interfere)
  - [ ] `install.sh` updated with PostToolUse hook registration (idempotent jq merge) and `chmod +x`
  - [ ] CLI guard: `path.basename(process.argv[1]) === 'log-commit.js'`
  - [ ] Error handling: `err instanceof Error ? err.message : String(err)`
  - [ ] Tests: commit parsing, non-commit fast path, malformed stdin, cherry-pick, empty stdin, amend, multi-command chain
  - [ ] Added to `extension/package.json` test script
- **Depends on:** Ticket 1

### Ticket 4: Prune utility
- Create `extension/src/bin/prune-activity.ts`
- Integrate into `setup.ts` (run on new-session init, NOT on resume)
- **Acceptance criteria:**
  - [ ] Scans `activity/` for `*.jsonl` files, deletes those >365 days old
  - [ ] Date comparison uses local timezone (filename date vs today)
  - [ ] `unlinkSync` wrapped in try/catch for ENOENT race
  - [ ] Called from `setup.ts` new-session branch (not resume — avoid per-iteration pruning in tmux)
  - [ ] Also callable standalone: `node extension/bin/prune-activity.js`
  - [ ] Tests: create files with old dates, verify deletion, verify recent files preserved, verify ENOENT handling
  - [ ] Added to `extension/package.json` test script
- **Depends on:** Ticket 1

### Ticket 5: Standup helper and skill
- Create `extension/src/bin/standup.ts` — pre-computes standup data as markdown
- Create `.claude/commands/pickle-standup.md` — skill that calls the helper
- **Acceptance criteria:**
  - [ ] `standup.ts` reads JSONL files in date range, parses JSON, skips corrupt lines
  - [ ] Warns if >10% of lines in a file are corrupt
  - [ ] Groups events by session, sorts by `ts`
  - [ ] Runs `git log --after=<since> --oneline` for commit gap-filling
  - [ ] Deduplicates: hook commits > git-log; persona events never deduped
  - [ ] `--days N`: last N local calendar days (not including today). `--days 0` = today.
  - [ ] `--since YYYY-MM-DD`: overrides `--days`. Invalid values rejected.
  - [ ] Outputs formatted standup markdown matching v1 format (Sessions, Commits, Ad-hoc Activity)
  - [ ] Outputs "No activity found" for empty date ranges
  - [ ] Skill passes `$ARGUMENTS` to standup helper
  - [ ] Tests: mock JSONL files, verify report format, verify deduplication, verify flag parsing, verify corrupt line handling, verify no-activity output
  - [ ] Added to `extension/package.json` test script
- **Depends on:** Tickets 1-4 (needs JSONL files to exist for meaningful testing)

### Ticket 6: Persona instruction, install, and docs
- Add logging instruction to CLAUDE.md persona section
- Update `install.sh` to: (a) `mkdir -p "$EXTENSION_ROOT/activity"`, (b) `chmod +x` for `log-activity.js`, `prune-activity.js`, `log-commit.js`, `standup.js`, (c) PostToolUse hook registration (idempotent jq merge), (d) deploy `pickle-standup.md` skill
- Update `help-pickle.md` with `/pickle-standup` documentation
- **Acceptance criteria:**
  - [ ] CLAUDE.md persona includes logging instruction with correct path (`extension/bin/log-activity.js`)
  - [ ] `install.sh` creates `activity/` directory
  - [ ] `install.sh` registers PostToolUse hook (idempotent — no duplicates on re-install)
  - [ ] `install.sh` sets `chmod +x` on all 4 new bin files
  - [ ] `help-pickle.md` documents `/pickle-standup` with flag examples
  - [ ] `uninstall.sh` updated to remove activity dir, PostToolUse hook, and standup skill
  - [ ] All new test files added to `extension/package.json` test script (explicit list, not glob)
- **Depends on:** Tickets 1-5

## Success Metrics

- All Pickle Rick automated sessions (tmux, jar) produce activity events with zero user intervention
- Git commits during any Claude Code session are captured via hook
- `/pickle-standup` produces a useful summary within 5 seconds — contains all events from JSONL in date range, grouped by session, with commit deduplication *(refined: measurable metric)*
- Activity files auto-prune after 365 days
- Zero impact on existing Pickle Rick performance — `logActivity()` is append-only, fire-and-forget, always called AFTER `approve()` in stop-hook

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Persona forgets to log in regular conversations | Medium | Git commit hook + git log fallback cover most meaningful work |
| Concurrent JSONL writes interleave | Low | `appendFileSync` uses `O_APPEND` (POSIX atomic seek+write). Events <1KB, under APFS 4KB block |
| Activity dir fills disk over time | Low | 365-day auto-prune on session init; ~100 bytes/event |
| PostToolUse fires on ALL Bash calls (~500/session) | Medium | `async: true` + `timeout: 5` in hook config. Handler fast-path exits for non-commits in <10ms |
| Stop-hook logActivity() I/O on decision path | Low | All calls placed AFTER `approve()`, never before — decision latency unaffected |
| Sync PostToolUse blocks Claude if handler hangs | Medium | MUST use `async: true` + `timeout: 5`. Without these, default 600s timeout blocks Claude |
| Interactive/jar sessions lack session_end + duration | Medium | v1 limitation: duration tmux-only. Standup infers completion from last event timestamp |
| Async hook loses events on abrupt session exit | Low | Git log fallback in standup catches missed commits |

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Depends On |
|---|---|---|---|---|---|---|
| 10 | TBD | Core activity logger utility | High | None | `logActivity()` + CLI + types + tests | None |
| 20 | TBD | Instrument Pickle infrastructure | High | Ticket 1 complete | Events emitted from setup/stop-hook/tmux/jar + tests | Ticket 1 |
| 30 | TBD | Git commit hook | High | Ticket 1 complete | PostToolUse handler + install.sh registration + tests | Ticket 1 |
| 40 | TBD | Prune utility | Medium | Ticket 1 complete | Prune script + setup.ts integration + tests | Ticket 1 |
| 50 | TBD | Standup helper and skill | High | Tickets 1-4 complete | Helper + skill + tests | Tickets 1-4 |
| 60 | TBD | Persona instruction, install, and docs | Medium | Tickets 1-5 complete | CLAUDE.md + install.sh + help + uninstall | Tickets 1-5 |
