## Public Exports

Exports enumerated from `grep -E '^export ' extension/src/hooks/*.ts` (top-level files only; `handlers/` sub-directory is covered under Handler Invariants below).

### `resolve-state.ts`
- `sameWorkingDir(a, b)` — compare canonical realpaths for hook cwd matching
- `selectScannedStateFile(stateFiles, cwd)` — choose the best matching state file from a scanned list
- `resolveStateFile(dataDir)` — resolve a single authoritative state file path
- `loadActiveState(stateFile)` — load and validate a `State` object from disk
- `approve()` — emit the hook approve response to stdout

### `dispatch.ts`
CLI entry point — no named exports. Spawns the appropriate handler subprocess based on hook event type.

---

## Handler Invariants

Summary of security-critical invariants for each handler. Full detail is in the `## Trap Doors` entries below; cross-references are noted per handler.

### `handlers/config-protection.ts`
- **Bash config-guard**: glob, brace (`{}`), bracket (`[]`), and `?` patterns in shell commands must be matched against protected config basenames to prevent bypass. See trap-door entry for `handlers/config-protection.ts` (glob/brace invariant).
- **`PROTECTED_WRITE_GLOBS` state-file write blocking**: `Write`/`Edit` tools and bash output-redirects (`>`, `>>`, `tee`, `cp`, `mv`, `rsync`) targeting state files are blocked unless `state.flags.allow_state_writes_reason` is set. See trap-door entry for `handlers/config-protection.ts` (R-WSRC-3).
- **R-WSRC-GR git-verb blocker** (`detectProhibitedGitVerb`): `git reset`, `switch`, `stash`, `rebase`, `pull`, `push`, `checkout-with-ref`, `commit --amend`, and `fetch --prune` are blocked in worker Bash. See trap-door entry for `handlers/config-protection.ts` (R-WSRC-GR).

### `handlers/stop-hook.ts`
- **tmux passthrough APPROVE**: when `state.tmux_mode === true`, the hook approves unconditionally so launcher conversations do not block tmux-owned loops. See trap-door entry for `src/hooks/handlers/stop-hook.ts` (tmux passthrough).
- **Idle-backoff progression**: after 3 consecutive degenerate wait-pattern manager turns, nudges are suppressed until state mtime / worker artifact mtime / liveness changes or the bounded fallback timer fires. See trap-door entry for `stop-hook.ts (idle backoff)`.
- **Update-cadence conversion**: `update_check_interval_hours` is multiplied by `3600` before rate-limit comparison — not divided. See trap-door entry for `stop-hook.ts (update cadence)`.
- **`Decision` type**: always `'approve' | 'block'` — the string `'allow'` is never a valid decision value. See trap-door entries and `Decision` type at `handlers/stop-hook.ts:66`.

### `handlers/tsc-gate.ts`
- Gate fires **only on git-commit-class Bash commands** (`isGitCommitCommand`). Non-commit commands are passed through without a tsc check.
- `allow_tsc_failed_reason` override is **consumed on the next clean commit** — the flag auto-clears via `tsc_gate_override_consumed`.
- See trap-door entry for `handlers/tsc-gate.ts`.

---

## Trap Doors

- `../bin/log-commit.ts` — INVARIANT: every successful `PostToolUse` in an active session clears `last-tool-error.json` before commit parsing. BREAKS: old tool failures poison later worker spawns with stale retry-circuit guidance. ENFORCE: `extension/tests/log-commit.test.js`. PATTERN_SHAPE: PostToolUse hook resolves same-cwd active session and leaves `last-tool-error.json` untouched.
- `handlers/config-protection.ts` — INVARIANT: Bash config guards must match shell-expanded protected basenames across `*`, `?`, `[]`, and `{}` patterns. BREAKS: glob, bracket, or brace commands can bypass protected-file blocking. ENFORCE: `extension/tests/config-protection.test.js`. PATTERN_SHAPE: `tool_name==='Bash'` token with shell pattern chars matching a protected config basename.
- `handlers/config-protection.ts` (R-WSRC-3) — INVARIANT: PreToolUse hook MUST block `Write`/`Edit` tool calls AND bash output-redirects targeting `**/state.json*`, `**/circuit_breaker.json*`, `**/pipeline-status.json*`, `~/.claude/pickle-rick/**`, and `pickle_settings.json*` UNLESS `state.flags.allow_state_writes_reason` (or `allow_settings_writes_reason` for settings) is a non-empty trimmed string (which emits `state_write_override_used` per bypass). Hook fails open on scanner crash per dispatch.js contract. BREAKS: workers retain ad-hoc write access to runtime state files, enabling R-WSRC corruption class. ENFORCE: `extension/tests/config-protection-state-files.test.js`. PATTERN_SHAPE: `PROTECTED_WRITE_GLOBS` constant in source MUST include the named globs; `PROTECTED_BASH_CANDIDATES` extended scanner MUST match `>`, `>>`, `tee`, `cp`, `mv`, `rsync` targets against the same globs.
- `handlers/tsc-gate.ts` — INVARIANT: only git-commit-class Bash commands trigger the gate; blocking failures emit `tsc_gate_failed`, override bypasses emit `tsc_gate_override_used`, and clean flagged commits auto-clear `allow_tsc_failed_reason` with `tsc_gate_override_consumed` via `StateManager.update`. BREAKS: broken-tsc commits slip through or the manager override persists past the next clean commit. ENFORCE: `extension/tests/tsc-gate.test.js`. PATTERN_SHAPE: `isGitCommitCommand`
- `resolve-state.ts` — INVARIANT: hook cwd matching must compare canonical realpaths via the `sameWorkingDir` helper, not raw `path.resolve()` strings. BREAKS: `/var` vs `/private/var` aliases make active sessions look foreign, so config-protection/tool-error fail open and stop-hook exits early. ENFORCE: `extension/tests/resolve-state.test.js`, `extension/tests/stop-hook.test.js`. PATTERN_SHAPE: `sameWorkingDir(` on hook/session lookup paths.
- `resolve-state.ts` (lookup precedence) — INVARIANT: the exported helpers compose a strict order — `selectScannedStateFile` → `resolveStateFile` → `loadActiveState` — and `loadActiveState` is the single authority feeding the hook `approve` decision shape. Stale-map / dead-pid / wrong-cwd / inactive sessions must demote BELOW a live same-cwd fallback before `approve` returns. BREAKS: skipping any helper makes config-protection / tsc-gate / stop-hook fail open or attach to dead owners. ENFORCE: `extension/tests/resolve-state.test.js`, `extension/tests/config-protection.test.js`, `extension/tests/stop-hook.test.js`. PATTERN_SHAPE: `selectScannedStateFile|resolveStateFile|loadActiveState|approve`.
