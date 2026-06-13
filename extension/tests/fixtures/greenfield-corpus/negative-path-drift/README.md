# Class (N3) — real path-drift, un-annotated (PAIRED-NEGATIVE)

A ticket citing the backticked path
`extension/src/services/this-path-does-not-exist-greenfield-negative.ts` that does NOT
exist in `git ls-files`, is NOT declared under a `## Files to create` section, and
carries NO forward-create annotation. This is a genuine bundle defect.

**Invariant**: `audit-ticket-bundle.js <session>` MUST exit 1 with a fatal `path-drift`
finding. The runner writes the session `state.json` with `working_dir` pointed at the
real repo root so `git ls-files` runs. If the path-drift check ever lost its teeth, this
fixture would pass (exit 0) and CI would go red.
