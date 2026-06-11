# Bug: readiness gate cannot see (forward-created) annotations in verify commands and test tables

**Filed**: 2026-06-10 (babysitter intervention, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle launch)
**Severity**: P2 — blocks creation-heavy bundle launches until the documented skip flag is applied
**Status**: Open

## Incident

First pickle-phase launch of the v2.0.0-beta.1 bundle halted in 16s: `READINESS HALT: check-readiness exited 2`. All 30 findings were false positives of two classes:

1. **file_path** (23): forward-created test files cited inside AC verify-command strings (`node --test tests/check-update-prerelease.test.js`) and Test Expectations table cells. The canonical `(forward-created)` annotation cannot live inside a command string, and the resolver does not consult the adjacent prose annotation or the bundle's other tickets' "Files to create" declarations.
2. **contract** (7): API symbols introduced BY the bundle (`CodegraphService.create`, `getSessionCounters()`, `PickleSettings.codegraph`) flagged as unresolvable, despite `(forward-created)`/`(created by ticket <hash>)` annotations on the defining citations.

## Recovery applied (documented downgrade, CLAUDE.md Step 0)

Bundle qualifies as creation-heavy (25 tickets, 17/25 forward-creating under `extension/tests/`) → set
`state.flags.skip_quality_gates_reason = "creation-heavy bundle: 25 tickets, 17/25 forward-creating under extension/tests/"`,
resumed session, relaunched. Readiness passed with breadcrumb; pipeline proceeding.

## Fix proposal (machine-checkable)

- `check-readiness.js` path resolver: before flagging a `tests/**` or `scripts/**` path, (a) check whether ANY ticket in the bundle declares it under "Files to modify/create" or cites it with a forward-reference annotation; (b) treat paths inside backticked COMMAND strings (`node --test …`, `bash scripts/…`) as covered by the nearest same-ticket annotated citation of the same path.
- Contract resolver: honor `(forward-created)` / `(created by ticket <hash>)` / `(introduced by ticket <hash>)` on symbol citations, cross-ticket within the bundle.
- AC: a fixture bundle with annotated forward-created files in verify commands + tables passes readiness with zero findings AND a control fixture with a genuinely phantom path still fails.

## Verification of recovery

- `mux-runner.log`: Iteration 2+ proceeded, manager spawned, ticket 931c492f in research.
