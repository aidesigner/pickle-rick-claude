## Trap Doors

- `../bin/log-commit.ts` — INVARIANT: every successful `PostToolUse` in an active session clears `last-tool-error.json` before commit parsing. BREAKS: old tool failures poison later worker spawns with stale retry-circuit guidance. ENFORCE: `extension/tests/log-commit.test.js`. PATTERN_SHAPE: PostToolUse hook resolves same-cwd active session and leaves `last-tool-error.json` untouched.
- `handlers/config-protection.ts` — INVARIANT: Bash config guards must match shell-expanded protected basenames, not only raw tokens. BREAKS: wildcard or brace commands can bypass protected-file blocking. ENFORCE: `extension/tests/config-protection.test.js`. PATTERN_SHAPE: `tool_name==='Bash'` token with shell glob or brace chars matching a protected config basename.
