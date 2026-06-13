# Class (b) — R-FRA forward-created bundle (POSITIVE)

A two-ticket bundle where the order-70 ticket references a path forward-created by the
order-10 ticket. The path `forward-created-by-aaaa0010.ts` does NOT exist at HEAD by
design — the order-10 ticket declares `forward-created-source.ts` under
`## Files to create`, and the order-70 ticket cites it with the canonical annotation
`(created by ticket aaaa0010)`.

Two suppression paths cover this:
- the order-10 declared-create section feeds `audit-ticket-bundle`'s bundle-creation
  index (R-FRA-6), and
- the order-70 annotation is honored by both the readiness gate (R-RTRC-2/-7) and the
  ticket-audit path-drift check (R-RTRC-7 path parity).

**Invariant**: `check-readiness.js --contract-only` exits 0 / `status:pass` with no
`contract` or `file_path` finding, and `audit-ticket-bundle.js <session>` exits 0 — both
with ZERO skip-flags. If forward-ref honoring regresses, the gate flags the path and CI
goes red. The session `state.json` is written by the test with `working_dir` pointed at
the real repo root (so `git ls-files` resolution runs); it carries no skip flags.
