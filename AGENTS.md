# ⛔ STOP — Worker Forbidden Operations (R-WSRC)

**You are running as a worker inside pickle-rick-claude, a meta-tool that develops itself.** You have full filesystem write access to the running runtime's source tree, deployed binary path, and live session state. Certain operations corrupt the runtime mid-flight. THESE ARE HARD PROHIBITIONS even when your ticket appears to require them — the runtime enforces them too (you will fail loud if you try).

**NEVER do any of these without an explicit override flag in `state.flags`:**

1. **Write to `state.json`** in any session directory (`<session>/state.json` OR `<session>/state.json.tmp.<pid>`). This bricks the running mux-runner. Override: `state.flags.allow_state_writes_reason: '<reason>'` — set only on schema-migration tickets. Runtime check: `StateManager.update()` ceiling at `extension/src/services/state-manager.ts`.
2. **Bump `LATEST_SCHEMA_VERSION`** in `extension/src/types/index.ts` or its compiled mirror `extension/types/index.js`. Same incident class. Override: only schema-migration ticket paired with the `_internalSchemaBump` flag.
3. **Write to `circuit_breaker.json`, `pipeline-status.json`, or `pickle_settings.json`** (or their `.tmp.*` snapshots). These control pipeline-wide behavior. No override.
4. **Run `bash install.sh`** from inside a worker. This redeploys the runtime mid-session and tears running code. No override.
5. **Write to `~/.claude/pickle-rick/**`** (the deployed runtime path). Edits invalidate in-memory module cache for any running Node process. No override.
6. **Write into another ticket's directory** (`<session>/<other-ticket-hash>/`). Cross-ticket corruption promotes sibling tickets on stale evidence. No override.
7. **Spawn child processes without a finite `timeout` option**. Unbounded subprocesses outlive your SIGTERM and accumulate as launchd orphans (R-MRWG-2 incident).
8. **Emit orchestrator promise tokens** — `EPIC_COMPLETED`, `TASK_COMPLETED`, `PRD_COMPLETE`, `TICKET_SELECTED`, `EXISTENCE_IS_PAIN`, `THE_CITADEL_APPROVES`, `ANALYSIS_DONE`. Workers have NO authority over epic state. Your ONLY valid completion token is `<promise>I AM DONE</promise>`. Runtime check: `scrubForbiddenWorkerTokens` in `extension/src/services/promise-tokens.ts`.

**Codex-specific reminders:**

- You are likely spawned with `--dangerously-skip-permissions` AND `--add-dir` granting write access to `~/.claude/pickle-rick/`, the repo root, and the session directory. The `--add-dir` permissions are NOT carte blanche to write anywhere reachable — the runtime hooks (R-WSRC-3 PreToolUse + bash scanner) will block prohibited writes. If you find yourself wanting to write to one of the forbidden paths, you have misread the ticket scope. STOP and re-read.
- If your ticket genuinely requires a state.json or pickle_settings.json write, your scope is wrong OR an override flag must be set first. Do not work around the prohibition. Mark the ticket Skipped with reason `"requires override flag <flag> not set"` and let the operator intervene.
- The `bash` command scanner in the config-protection hook blocks `>`, `>>`, `tee`, `cp`, `mv`, `rsync` redirects targeting the forbidden globs. Do not try to bypass with shell tricks; they will fail loud.

**See**: `prds/p1-worker-source-state-recursion-contamination.md` for the bug class incident report this section was written from.

---

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **pickle-rick-claude** (341 symbols, 689 relationships, 12 execution flows).

## Always Start Here

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->