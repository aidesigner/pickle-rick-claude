# Refactor Baseline

Date: 2026-04-26  
Analyst: Pickle Worker (Morty / Codex)

## Environment

- Git SHA: `88c1098473f8ac84eb31adf8a6dbacbfe3b56c76`
- Claude CLI: `2.1.119 (Claude Code)`

## Baseline Checks

- `cd extension && npx eslint src/ 2>&1 | grep -c 'warning'`: `59`
- `cd extension && npx eslint src/ --max-warnings=-1`: exit `0`
- `cd extension && npx tsc --noEmit`: exit `0`

## npm test

Command:

```bash
cd extension && npm test 2>&1 | tail -5
```

Observed clean rerun facts:

- A direct `npm test` run remained live for more than 4 minutes with its active child process pinned at `tests/mux-runner.test.js`.
- A controlled rerun with `timeout 180s npm test >/tmp/t0-npm-test.log 2>&1` exited `124`, so the suite does not currently reach a final `# pass <N>` line at this SHA.
- Last emitted failures before timeout were `tests/mux-runner.test.js` and `tests/timeout-happy-path.test.js`.

Captured `tail -5` from `/tmp/t0-npm-test.log`:

```text
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

Relevant last emitted lines from the same rerun:

```text
test at tests/mux-runner.test.js:1:1
✖ tests/mux-runner.test.js (88669.156ms)
  'Promise resolution is still pending but the event loop has already resolved'

test at tests/timeout-happy-path.test.js:25:1
✖ FR-B10: fixture manager sleeps 95% of worker_timeout budget, writes artifact, no SIGTERM (45024.261458ms)
  AssertionError [ERR_ASSERTION]: Artifact not written — subprocess was killed before completing (exit: 0, signal: null)
```

Baseline verdict: `FAIL` at `88c1098473f8ac84eb31adf8a6dbacbfe3b56c76` because `npm test` does not currently complete successfully, so there is no parseable pass-count baseline yet.
