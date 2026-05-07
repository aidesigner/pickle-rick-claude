## Trap Doors

- `../bin/log-commit.ts` — INVARIANT: every successful `PostToolUse` in an active session clears `last-tool-error.json` before commit parsing. BREAKS: old tool failures poison later worker spawns with stale retry-circuit guidance. ENFORCE: `extension/tests/log-commit.test.js`. PATTERN_SHAPE: PostToolUse hook resolves same-cwd active session and leaves `last-tool-error.json` untouched.
