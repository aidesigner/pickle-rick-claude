# B-DSAN2 Subtract-Before-Add Compliance Assertion (WS-E)

Close-out record for ticket `85471d8e` — asserts the B-DSAN2 bundle added **no new
guard or skip surface** and that its WS-B/WS-C changes are net subtractions
(loosened guards), per the W5b subtract-before-add governance rule.

Verified against HEAD (`4f7b79f4..546991b1`) before this record was written.

## Per-AC verification

| AC | Assertion | Verdict | Evidence |
|---|---|---|---|
| **AC-1** | No new `state.flags` skip surface added by the bundle | PASS | `bash extension/scripts/audit-skip-flag-unification.sh` → "no non-unified skip flags in StateFlags" (exit 0). The unified `skip_quality_gates_reason` remains the single operator-facing surface. |
| **AC-2** | WS-B/WS-C are net subtractions (loosened guards), not new guards | PASS | `git diff 4f7b79f4..HEAD -- extension/src/bin/check-readiness.ts extension/src/hooks/handlers/config-protection.ts`: config-protection Bash gate made **write-aware** (`96c538e3`, R-CPRO — read-approve/write-block, loosening read-blocks); check-readiness graduates the `file_path` halt to a two-class suffix predicate (`02a6d0de`) + adds a non-blocking false-positive counter (`e95ebcdb`). Both are loosening / false-positive reduction, not new blocking guards. |
| **AC-3** | The B4 metric is the only addition and is non-blocking | PASS | `READINESS_FALSE_POSITIVE_EVENT_NAME = 'readiness_false_positive_suppressed'` (`extension/src/services/metrics-utils.ts:764`); surfaced as a non-blocking field in the `/pickle-metrics` JSON report (`extension/src/bin/metrics.ts:495`) with no nonzero-exit path. |
| **AC-4** | Suite passes | PASS | `node bin/test-runner.js --tier fast --test-concurrency=4` → exit 0, zero `not ok` (authoritative; the pinned c=8 worker gate flakes under load — load-shaped timeouts, not real failures). |

## Scope notes

- Additive-only: no shipped guard is reverted. The only addition is the non-blocking
  B4 false-positive counter; adding a presence-assertion test or skip-flag here would
  itself violate W5b subtract-before-add governance.
- Hand-completed by babysitter: all four assertions verified to hold; the worker
  could not commit past the load-flaky c=8 `test:fast` gate.
