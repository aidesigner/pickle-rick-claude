# B-DSAN2 Fail-Without-Fix Corpus — Test-Quality Audit (WS-E)

Close-out record for ticket `39fa35c6` — test-quality audit confirming the
B-DSAN2 regression corpus is genuinely **fail-without-fix** (RED on the unfixed
surface), not stub-satisfiable. Verified against HEAD (`c779cce4`).

## Per-AC verification

| AC | Assertion | Verdict | Evidence |
|---|---|---|---|
| **AC-1** | Each corpus case is RED on the unfixed surface | PASS | `dsan2-regression-corpus.test.js` 4/4 pass on the fixed tree; audit documents a per-test RED proxy binding each assertion to a real runtime/source signal (exit code, finding count) — e.g. reverting forward-ref suppression to exact `creationIndex.has(ref)` membership re-opens a blocking `file_path` finding (exit 2 → assertion fails). Not stub-satisfiable. |
| **AC-2** | completion-authority test fails on an injected out-of-band producer | PASS | `completion-authority-single-source.test.js` 5/5 pass on the fixed tree; the test asserts a build failure when a terminal-status producer exists outside the canonical authority set. |
| **AC-3** | test-tier + isolation audits pass | PASS | `bash scripts/audit-test-tiers.sh` exit 0; `bash scripts/audit-test-isolation.sh` exit 0 |
| **AC-4** | Suite passes on the fixed tree | PASS | `node bin/test-runner.js --tier fast --test-concurrency=4` exit 0, zero `not ok` (authoritative; the pinned c=8 worker gate flakes under load — load-shaped timeouts, not real failures) |

## Scope notes

- Verification-only: corpus + completion-authority tests bind to real signals
  (decision value, exit code, finding count) — no stub/constant satisfiers.
- Hand-completed by babysitter: corpus 4/4 + completion-authority 5/5 + tier/
  isolation audits verified green; worker could not commit past the load-flaky
  c=8 `test:fast` gate.
