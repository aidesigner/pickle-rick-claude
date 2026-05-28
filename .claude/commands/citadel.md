Post-implementation conformance audit against the PRD, branch diff, and known trap doors.

# /citadel

Run Citadel after implementation and before deeper review phases. The command audits the current branch against a PRD and reports branch-wide conformance findings.

## Usage

```bash
/citadel --prd <prd_path> [--diff <base..head>] [--strict] [--report <path>] [--print-stubs]
```

## Arguments

- `--prd <prd_path>`: Required unless invoked by a pipeline session with `state.prd_path`.
- `--diff <base..head>`: Diff range to audit. Defaults to `state.start_commit..HEAD` when available.
- `--strict`: Exit non-zero on High findings as well as Critical findings.
- `--report <path>`: Write the JSON report to this path. Pipeline invocations write `<session>/citadel_report.json`.
- `--print-stubs`: Print `node:test` skeletons for unguarded trap doors without modifying files.

## Audit Surface

Citadel reads the PRD, changed files, command/session state, and sibling phase artifacts when present. It reports labelled findings for PRD acceptance coverage, endpoint contract drift, trap-door coverage, sibling route divergence, state-machine drift, frontend prop drift, cross-phase findings, and diff-shape hygiene.

Reports are versioned JSON with `schema: "1.0"` plus a console summary grouped by Citadel section. The command surfaces findings only; it does not auto-edit source files.

## R-CLOSER-ADJACENCY-AUDIT

Run this 6-step checklist in every closer before committing. Each step takes under 60 seconds and catches adjacent-mode bugs (the class missed by R-WUWC, R-CCQF, R-PEDC, R-RIC-EXPLICIT closers).

**Step 1 — Adjacent-path enumeration**
```bash
rg -n '<patched-fn>\(' extension/src/ extension/tests/
```
List every callsite of the function you just changed. Are all callers covered by your fix?

**Step 2 — Adjacent-mode enumeration**
```bash
rg -nE 'throw |execFileSync|spawnSync|readFileSync' <patched-file>
```
List every I/O or throw path in the patched file. Does your fix cover each mode, or only the one that exhibited the symptom?

**Step 3 — Trap-door delta**
Paste the relevant trap-door invariant from `extension/CLAUDE.md`. Confirm:
- The symptom path is covered.
- Each adjacent mode from Step 2 is covered or explicitly excluded with a written reason.

**Step 4 — Cross-module importer check**
```bash
rg -n 'from .*<patched-module>' extension/src/
```
Identify every module that imports the patched file. Do any importers rely on behavior your fix changes?

**Step 5 — Stamp-pair parity**
Count `recordExitReason` vs `clearStale*` callsites in the patched file (or across the diff if multi-file). Confirm parity: every exit-reason stamp has a matching clear on the recovery path.

**Step 6 — Pre-flight context grep**
```bash
rg -n "execFileSync\(['\"]git['\"]" <patched-file>
```
For each `execFileSync('git', ...)` call, write one sentence describing the caller context and whether the fix accounts for it.

---
*Template added per R-AFCC-DEEP-2A (AC-AFCC-DEEP-02). Catches the adjacent-mode bug class first observed in R-AFCC-STAGE during R-RIC-EXPLICIT closer.*
