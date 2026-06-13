# Class (N1) — unresolved, un-annotated contract ref (PAIRED-NEGATIVE)

A ticket citing the in-repo symbol contract `PhantomGreenfieldNegativeSymbol.resolveNothing()`
that does NOT exist at HEAD and carries NO `(forward-created)` / `(created by ticket <hash>)`
annotation. This is a genuine readiness defect, not a false positive.

**Invariant**: `check-readiness.js --contract-only` MUST exit 2 / `status:fail` with a
`contract` finding. The runner runs it against a FRESH EMPTY temp git repo as
`--repo-root` so the symbol genuinely cannot resolve. If readiness ever stopped flagging
unresolved un-annotated contracts (became a no-op), this fixture would pass and CI would
go red.
