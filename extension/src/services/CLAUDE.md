## Trap Doors

- `backend-spawn.ts` — INVARIANT: `resolveBackendFromStateFileWithSource(cliBackend)` must honor CLI override before reading persisted `state.backend`. BREAKS: relaunch/spawn callers silently route to stale session backend instead of the operator-selected backend. ENFORCE: `backend-spawn.test.js` CLI override precedence coverage. PATTERN_SHAPE: exported resolver with `cliBackend?: Backend` and `source: 'cli-flag-override'`.
