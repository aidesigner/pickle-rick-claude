# Class (N2) — genuinely-unparametrized AC-shape (PAIRED-NEGATIVE)

A single-ticket collapse of an AC-shape smell that enumerates 3 distinct endpoint
targets WITHOUT a universal-quantifier title and WITHOUT a `describe.each([...])`
acceptance test. This is exactly the shape the AC-shape gate is SUPPOSED to reject —
it is NOT parametrized, just three hard-coded targets.

**Invariant**: `evaluateAcShapeEnforcement(manifest)` MUST return a NON-empty violation
(reason: "single-ticket collapse lacks a universal-quantifier title or
describe.each([...]) acceptance test"). If the gate ever stopped having teeth (became a
no-op after the W1a loosening), this fixture would pass and CI would go red.
