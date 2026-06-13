# Class (a) — LOA-727 AC-shape false-reject (POSITIVE)

A correctly-parametrized refiner ticket the AC-shape gate USED to wrongly reject.
The universal quantifier ("All handlers") lives in `title`; the parametrization
(`describe.each([...])`) lives in `acceptance_test`. The pre-fix gate read each token
in a single hard-coded field and missed the cross-field shape (LOA-727 incident:
~30 min + ~9 worker quotas burned per false-reject).

**Invariant**: `evaluateAcShapeEnforcement(manifest)` MUST return `[]` (no violation),
with NO skip-flag. If the cross-field recognition regresses, this fixture starts
producing a violation and CI goes red.
