# v2.0.0-beta.7 — Reliability + Honesty Increment (GA migration note)

**Status:** prerelease. This is the first shippable cut of the v2.0.0 reliability line.
Tests-green earns `beta.7`; **field-proof earns GA** (the `-beta` drop to `2.0.0` is a
separate downstream step, explicitly NOT this release). Source PRD:
`prds/p1-ga-readiness-drop-beta-v2.0.0.md`.

## What this release is

The v2.0.0 cut is gated on **reliability first, capability second** — all-tier unattended
autonomy plus honest documentation, and nothing else. Capability expansion (codegraph
default-on) is deferred to v2.1 (`prds/p2-codegraph-default-on-capability-v2.1.md`).

### Reliability (WS-2 — recovery hardening)

- **AC-GA-REC-2 — R-WPEX large-tier autonomy fallback** landed and reconciled to the
  confirmed 600s-ceiling mechanism. Headless-mux managers no longer silently die on
  >600s large-tier workers; the routing fallback is the documented path.
- **AC-GA-REC-1 — clean-tree converged recovery** recovers the clean-tree converged case
  via plan RE-EXECUTION (a clean tree has no artifacts to stage, so recovery re-runs the
  plan rather than attempting to commit nothing).
- **AC-GA-REC-3 — typecheck + lint clean** across the modified surface (code-quality,
  data-flow, test-quality, and cross-reference hardening passes).

### Honesty (WS-1 — codegraph opt-in is now the truth)

Source, deployed, and docs now all agree: **codegraph ships opt-in / disabled by default.**

- **AC-GA-CG-1** — source `pickle_settings.json` reconciled to `codegraph.enabled=false`,
  `index_at_setup=false` (matching deployed reality). Kill-switch `PICKLE_CODEGRAPH=off`
  remains.
- **AC-GA-CG-2** — `CLAUDE.md` and `README.md` reconciled: the false "Default-ON since
  beta.4" claim is excised; `expose_mcp_to_workers` (the separate interactive MCP lane)
  is documented as a distinct, also-default-off gate.
- **AC-GA-CG-3** — CGH-2 injection telemetry gated across all three invariants as a
  regression guard.

**Why opt-in at GA, not default-on:** the efficacy probe is still a stub
(`runProbe` → `loadCorpus` only), so we cannot yet honestly claim a measured net-positive
context delta. Default-on without that evidence would violate reliability-first. The
default-on flip, the efficacy harness, and the staged-default-on soak all move to v2.1.
**GA only makes codegraph honestly opt-in.**

### Policy (WS-3)

- **AC-GA-POL-1** — R-ONPD / R-PDUP / R-SFRS dispositions cited as RESOLVED (v1.102.0).

## Beta-session compatibility

A `beta.6` session resumes clean under the GA (`beta.7`) runtime — proven by
`extension/tests/beta6-ga-session-resume.test.js` (ticket 2cc238c4, AC-GA-EXIT-4).
State schema stays at **5** (schema-neutral release); no migration is required to move a
live `beta.6` session onto this runtime.

## Deploy precondition — codegraph native dependency (FATAL on non-resolution)

`install.sh` installs `@colbymchenry/codegraph@0.9.9` **unconditionally** and self-probes
that the deployed extension root can resolve it; if it cannot, the deploy **aborts loudly
at install time** (`install.sh` self-probe → `exit 1`, "FATAL: @colbymchenry/codegraph
does not resolve"). This install is **NOT gated on the opt-in setting** — the runtime
dependency must always resolve even when the feature is disabled. Operators deploying GA
must ensure the host platform binding for `@colbymchenry/codegraph` is installable
(npm installs only the host-matching one of six platform optionalDependencies). A host
that cannot resolve the package cannot deploy this runtime.

## Known manual-recovery limits (operator runbook)

These remain operator-assisted, not yet fully autonomous (documented, not silent):

- **Headless-mux + >600s large-tier workers** — foreground killed at the 600s Bash
  ceiling; background + Monitor can be reaped on turn end → 0-byte-log silent death.
  Hand-build large tickets inline; small/medium flow normally. (R-WPEX #108.)
- **Silent worker death under contention** — detached `claude -p` workers can die with a
  0-byte log under multi-way pipeline contention; recover by checking artifact mtimes /
  git status before respawning, ff-only reattach any orphaned commit.
- **Manager-only closer ship** — the manager_only closer reliably needs babysitter
  takeover for the version bump / `install.sh` / push / release mechanics; this is the
  documented handoff (`docs/closer-ticket-manager-handoff.md`).
- **CI red is not a release gate** — R-CIFB #115 (c=8 fast-tier load-flake + Linux/node24
  env-only failures) is open and de-prioritized hygiene; the **local** gate is
  authoritative for ship decisions.

## Verification at ship

Full release gate (from `extension/`) green on a clean tree with compiled JS matching TS,
plus the `install.sh` MD5 parity gate. Gate confirmed GREEN before the version bump —
never batched with the tag.
