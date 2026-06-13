# greenfield-corpus

A standing fixture corpus proving the W1a–W1d gate loosenings stay HONEST:
real greenfield/refined bundles that historically false-blocked must now PASS the
gates with **zero skip-flags**, while genuinely-unready bundles must still FAIL.
The runner is `extension/tests/greenfield-corpus.test.js`.

A new false-positive regression in any loosened gate makes a POSITIVE fixture fail
CI; a new no-op regression (a loosened gate that stopped having teeth) makes a
PAIRED-NEGATIVE fixture pass — both surface as a red test.

## Positive corpus (historically-blocking, now-ready — must PASS, zero skip-flags)

| Class | Dir | Gate | Loosening proven |
|---|---|---|---|
| a | `loa727-ac-shape/` | AC-shape (refiner `evaluateAcShapeEnforcement`) | LOA-727 cross-field parametrized recognition |
| b | `fra-forward-create/` | readiness + ticket-audit | R-FRA forward-created path honored via `(created by ticket <hash>)` + bundle-creation index |
| c | built in-test (forced-budget) | readiness `--max-wall-ms 1` | R-RHFP wall-budget `performance` finding is non-blocking (indeterminate, not fail) |
| d | built in-test (fresh repo) | readiness | R-RTRC-4 deep bare-basename path resolves via `git ls-files` suffix-match |

## Paired-negative corpus (N = 3 — genuinely-unready, must still FAIL)

| Class | Dir | Gate | Teeth proven |
|---|---|---|---|
| N1 | `negative-contract-drift/` | readiness | unresolved, UN-annotated symbol contract still fails (exit 2) |
| N2 | `negative-ac-shape/` | AC-shape (refiner) | unparametrized 3-target enumeration still violates |
| N3 | `negative-path-drift/` | ticket-audit | unannotated nonexistent path still fatal `path-drift` (exit 1) |

Classes (c) and (d) are built in the test body (they need a forced budget / a fresh
temp git repo, not a static session dir). The deterministic-data classes (a, b, N1,
N2, N3) are static fixtures here. The forced-budget case uses `--max-wall-ms 1`, NOT a
real large repo.
