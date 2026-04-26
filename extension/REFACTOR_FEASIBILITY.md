# Refactor Feasibility

Date: 2026-04-26  
Analyst: Pickle Worker (Morty / Codex)

## Scope

This document captures a speculative pre-refactor split for the two ticketed hotspots without changing any production function body under `extension/src/`.

## DotBuilder `_emitDot`

Current source range: `extension/src/services/dot-builder.ts:1237-2260`

### First-cut split

Scratch file: `extension/.tmp/t0-dot-feasibility.ts`

| Candidate helper | Source range | Scratch range | ESLint `complexity <= 15` |
| --- | --- | --- | --- |
| `computeTopologyFlagsAndDefenseMatrix` | `1252-1278` | `2-20` | PASS |
| `buildGraphAttrsAndEmitPrimitives` | `1280-1312` | `22-32` | PASS |
| `emitSetupBaselineAndVerifyContext` | `1380-1402` | `34-44` | PASS |
| `emitEndgameChainCandidate` | `1404-1522` | `46-55` | PASS |
| `emitPrimaryTopologyCandidate` | `1524-2128` | `57-161` | FAIL: complexity `83` |
| `emitStandalonePatternsCandidate` | `2130-2189` | `163-180` | PASS |
| `workspaceCommitPushPostPass` | `2191-2231` | `182-195` | PASS |
| `finalizeTerminalAndRender` | `2234-2260` | `197-202` | PASS |

Observed ESLint output:

```text
$ cd extension && npx eslint .tmp/t0-dot-feasibility.ts .tmp/t0-mux-feasibility.ts -c .tmp/eslint-feasibility.config.mjs

/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/.tmp/t0-dot-feasibility.ts
  57:1  error  Function 'emitPrimaryTopologyCandidate' has a complexity of 83. Maximum allowed is 15  complexity

✖ 1 problem (1 error, 0 warnings)
```

### Redesign attempts

Scratch files:

- `extension/.tmp/t0-dot-feasibility-redesign.ts`
- `extension/.tmp/t0-dot-feasibility-redesign-2.ts`

Observed ESLint output:

```text
$ cd extension && npx eslint .tmp/t0-dot-feasibility-redesign.ts .tmp/t0-dot-feasibility-redesign-2.ts -c .tmp/eslint-feasibility.config.mjs

/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/.tmp/t0-dot-feasibility-redesign-2.ts
   2:1  error  Function 'resolveConvergenceOverrides' has a complexity of 22. Maximum allowed is 15  complexity
  17:1  error  Function 'emitConvergenceBodyChain' has a complexity of 19. Maximum allowed is 15     complexity

/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/.tmp/t0-dot-feasibility-redesign.ts
  18:1  error  Function 'emitConvergenceTopology' has a complexity of 22. Maximum allowed is 15          complexity
  96:1  error  Function 'emitDiagnosticsAndTerminalRoute' has a complexity of 23. Maximum allowed is 15  complexity

✖ 4 problems (4 errors, 0 warnings)
```

### Redesign required before T1/T2

The six-helper `_emitDot` split described in the ticket is not yet cyclomatic-15-safe. The failing branches are concentrated in these source slices:

- Convergence topology and post-chain setup: `1576-1813`
- Sequential per-phase emission and diagnostics: `1814-2128`
- Terminal diagnostics and deliverables coverage: `2095-2128`

Feasible redesign direction:

1. Split convergence setup into separate helpers for override resolution, body-node emission, mechanical-gate emission, and fp/repro post-chain emission.
2. Split sequential non-convergence work into fan-out/competing/convergence dispatch, per-phase gate wiring, diagnostics, and terminal-route helpers.
3. Keep catastrophic recovery (`2130-2134`), microverse (`2136-2168`), review ratchet (`2170-2189`), isolated-workspace rewiring (`2191-2231`), and render/finalize (`2234-2260`) as independent post-passes.

Conclusion: `_emitDot` is refactorable, but not with the initial six-helper cut. T1/T2 should open with the redesign above instead of assuming the first split is complexity-safe.

## `mux-runner.ts` outer loop

Current source range: `extension/src/bin/mux-runner.ts:847-1375`

Scratch file: `extension/.tmp/t0-mux-feasibility.ts`

| Candidate helper | Source range | Scratch range | ESLint `complexity <= 15` |
| --- | --- | --- | --- |
| `readLoopStateAndGuardExit` | `969-1032` | `2-26` | PASS |
| `initializeIterationRun` | `1040-1056` | `28-37` | PASS |
| `reconcileTicketTransition` | `1064-1093` | `39-52` | PASS |
| `handleRateLimitExit` | `1095-1182` | `54-86` | PASS |
| `recordTimeoutAndCircuitBreaker` | `1186-1293` | `88-107` | PASS |
| `resolveCompletionOrContinue` | `1295-1375` | `109-132` | PASS |

Observed ESLint output:

```text
$ cd extension && npx eslint .tmp/t0-mux-feasibility.ts -c .tmp/eslint-feasibility.config.mjs

[no output, exit 0]
```

Conclusion: the `mux-runner.ts` outer loop is already feasible as a six-helper split under a cyclomatic ceiling of `15`.
