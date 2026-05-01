# Hermes Backend Integration PRD

| Hermes Backend Integration PRD | | Add `hermes` as a fourth backend by spawning the first-party `hermes chat -q` CLI in headless mode, with toolset routing and honest backend identity throughout state, logs, and metrics |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Pickle Rick | **Status**: Ready (research complete) **Created**: 2026-05-01 **Research**: `prds/hermes-research.md` | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add `hermes` as a first-class backend value alongside `claude`, `codex`, and (in flight) `deepseek`. Unlike deepseek (which rides the `claude` CLI through an Anthropic-compat shim), Hermes ships its own CLI binary with a headless mode (`hermes chat -q "..."`) plus toolset selection (`-t terminal,file,code_execution`) and provider override (`--provider`). Integration shape is closer to codex than deepseek: dispatch a real binary with its own arg shape, capture stdout/stderr, parse output, classify completion.

Source: hermes-agent skill section "Spawning Additional Hermes Instances" (referenced for the `hermes -w` interactive headless pattern, not used here).

## Problem Statement

**Current Process**: Pickle Rick supports two production backends (`claude`, `codex`) plus deepseek-in-flight. Each integration follows a consistent dispatch contract via `buildWorkerInvocation(backend)` returning `{ cmd, args, backend, env? }`. Adding hermes is the third instance of this pattern, and the second one with a first-party CLI binary (after codex).

Three integration shapes considered:
- **Shape A** (this PRD): First-party `hermes chat -q` CLI, parallel to codex's `codex exec` pattern. Toolset selection via `-t` is honored as a Pickle-side flag.
- **Shape B**: Use `hermes -w` interactive headless sessions (long-lived). Higher complexity (would need a session-pool manager); doesn't fit the per-iteration spawn contract.
- **Shape C**: Skip CLI entirely, hit Hermes' API directly. Out of scope; we don't add native HTTP loops without a clear reason.

**Users**: Pickle Rick loop runners (mux-runner, microverse-runner, jar-runner) and the humans who select backends per epic. Toolset-aware users who want to constrain hermes to specific capabilities per task tier.

**Pain Points**:
- No way to run a Pickle epic on Hermes today
- Codex and Hermes have different strengths per task class (Hermes excels at multi-step terminal workflows; codex at large refactors); no toolchain-level A/B option
- Toolset routing is a Hermes-specific lever that other backends lack — Pickle currently has no way to express "this ticket needs only file+code_execution, not network"

**Importance**: Hermes' multi-tool agentic loop is qualitatively different from codex's tool-call shape. Some bug-class tickets (especially CLI-tooling-heavy ones — the v1.62.x sprint had several) are better fits for Hermes. Adding it gives operators a third real choice rather than the current binary "claude vs codex" axis.

## Objective & Scope

**Objective**: Add `'hermes'` to the `Backend` type and dispatch system. Spawn the first-party `hermes chat -q` CLI in headless mode, optionally pass through toolset/provider/model overrides, persist truthful backend identity throughout state and logs, and reuse the existing codex-manager-relaunch primitive (T2 in flight) if hermes has a session timeout.

**Ideal Outcome**: `setup.js --backend hermes --task "..."` works exactly like `--backend codex` from the user's perspective. State, jar queue, mux-runner logs, and metrics all show `'hermes'`. Refinement still forces claude (existing constraint). Output parser gets a third branch if hermes' stdout shape differs from claude/codex.

### In-scope

- Extend `Backend = 'claude' | 'codex' | 'deepseek' | 'hermes'` in `extension/src/types/index.ts`
- Add `buildHermesInvocation()` in `extension/src/services/backend-spawn.ts` (worker, manager, judge variants)
- Extend `resolveBackend()` and `isBackend()` to accept the new value
- Wire all four spawn sites (`spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts`) to dispatch hermes correctly
- Pre-flight guard in `setup.ts`: `--backend hermes` requires the `hermes` binary on PATH AND a smoke check that `hermes --version` succeeds; fail fast with actionable error
- New CLI flag `--hermes-toolsets terminal,file,code_execution` in `setup.ts` → persisted as `state.hermes_toolsets: string[]`
- Optional `--hermes-provider <name>` flag → persisted as `state.hermes_provider: string`
- Hermes version smoke check pinned via `engines.hermes` in `extension/package.json` (parallel to existing `engines.codex`)
- Extend the existing `--teams + codex` conflict guard to also reject `--teams + hermes`
- Extend `evaluateCodexManagerRelaunch` (newly extracted as `services/codex-manager-relaunch.ts` per T2 in current bundle) to be **backend-aware** — rename to `manager-relaunch.ts` and accept `backend: 'codex' | 'hermes'` parameter; share the same cap (10) and counter shape
- Output classifier extension in `mux-runner.ts:extractAssistantContent` and `mux-runner.ts:classifyCompletion` for hermes' stdout shape (third mode if needed; mode-1 if hermes emits Anthropic-shaped stream-json)
- Update command docs (`pickle.md`, `pickle-jar-open.md`, `pickle-microverse.md`) to list `--backend <claude|codex|deepseek|hermes>` and document `--hermes-toolsets` / `--hermes-provider`
- Tests mirroring existing codex coverage in `extension/tests/backend-spawn.test.js` (~12 cases)
- Hermes version smoke test mirroring `extension/tests/codex-version-smoke.test.js`

### Not-in-scope

- Per-token cost reporting in metrics. Pickle Rick tracks total tokens and LOC, not $/token.
- Long-lived `hermes -w` interactive sessions. Out per Shape B rejection — doesn't fit per-iteration spawn contract.
- Toolset auto-selection per ticket tier (e.g. "small tier → only file+code_execution"). Toolsets stay session-level for v1; per-ticket routing is a follow-up.
- Hermes model selection beyond default. Users can pass `--hermes-model` if needed; no per-tier mapping.
- Refinement support. `PICKLE_REFINEMENT_LOCK=1` already forces claude; hermes inherits the same constraint.
- Teams mode support. Teams primitives are harness-bound; hermes inherits codex's incompatibility.
- Promise token translation. `EPIC_COMPLETED` / `TASK_COMPLETED` / `WORKER_DONE` / `EXISTENCE_IS_PAIN` are prompt-driven and model-agnostic.
- Hermes-specific rate-limit handling beyond what mux-runner already does.
- DeepSeek's env-overlay shape (Shape A pattern). Hermes has its own CLI; no shim needed.

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Run an epic on Hermes**

User runs `node ~/.claude/pickle-rick/extension/bin/setup.js --backend hermes --task "scaffold CI/CD for ~/myapp"`. Setup verifies `hermes --version` matches `engines.hermes` pin, writes `state.backend = 'hermes'` to `state.json`. The first iteration spawns `hermes chat -q "<prompt>" -Q [-t <toolsets>]` with `PICKLE_BACKEND=hermes` in the child env. stdout is captured, classifier extracts assistant content (mode-3 if hermes shape differs from claude/codex), promise tokens detected normally. `state.json` and `tmux-runner.log` show `'hermes'` for the duration of the epic.

**CUJ-2: Missing or wrong-version hermes binary fails fast**

User runs `--backend hermes` without `hermes` on PATH. Setup exits non-zero before any session directory is created, with stderr: `Error: --backend hermes requires the 'hermes' CLI on PATH. Install via <docs link>.` Same fail-fast for version mismatch: `Error: hermes version mismatch: hermes --version returned "X.Y.Z", expected engines.hermes "^A.B.C". Update or pin.` (mirrors the existing codex smoke check at `extension/src/bin/setup.ts:355`).

**CUJ-3: Toolset routing per epic**

User runs `--backend hermes --hermes-toolsets terminal,file,code_execution`. setup.js parses the comma list, persists as `state.hermes_toolsets: ['terminal','file','code_execution']`. Every spawn passes `-t terminal,file,code_execution` to `hermes chat -q`. Toolsets persist across resume; `--hermes-toolsets` on resume errors with "toolsets locked at session creation; use a fresh session to change."

**CUJ-4: Mixed-backend jar batch**

User queues four tasks: claude, codex, deepseek, hermes. `pickle-jar-open` walks the queue, reading `state.backend` per task. Each task spawns the right CLI. `jar-runner.log` shows four distinct backend values. ENOENT handling for the `hermes` binary applies as a per-task failure (does NOT fail the batch — task is marked failed and queue advances).

**CUJ-5: Hermes session timeout + relaunch**

If hermes has a session-timeout wall like codex's 4h subprocess limit (TBD — Open Question 1), `evaluateCodexManagerRelaunch` (renamed `evaluateManagerRelaunch` per T2 follow-up) honors `state.backend === 'hermes'` and triggers the same relaunch evaluator with the same cap (10). Counter shared at `state.manager_relaunch_count`. Activity event remains `codex_manager_relaunch` for backward-compat OR renamed to `manager_relaunch` (decision in §Open Questions).

**CUJ-6: Refinement still uses claude**

User runs `/pickle-refine-prd` from a session where `state.backend = 'hermes'`. `spawn-refinement-team.ts` logs `"Parent backend was hermes but PRD refinement forces backend=claude"`, sets `REFINEMENT_BACKEND='claude'`, spawns the claude CLI. Refinement workers run on real Anthropic API.

### Functional Requirements

**FR-1**: `Backend` type accepts the literal `'hermes'`. `BACKENDS` constant array includes it. `isBackend(value)` returns `true` for `'hermes'`.

**FR-2**: `resolveBackend(source)` returns `'hermes'` when `state.backend === 'hermes'` or `PICKLE_BACKEND === 'hermes'`, with the same priority order as existing backends. The `PICKLE_REFINEMENT_LOCK=1` sentinel still forces claude.

**FR-3**: `buildHermesInvocation(opts)` returns:
- `cmd: 'hermes'`
- `args: ['chat', '-q', opts.prompt, '-Q', '--ignore-rules', '--ignore-user-config', ...(opts.maxTurns ? ['--max-turns', String(opts.maxTurns)] : []), ...(opts.toolsets ? ['-t', opts.toolsets.join(',')] : []), ...(opts.provider ? ['--provider', opts.provider] : []), ...(opts.model ? ['-m', opts.model] : [])]`
- `backend: 'hermes'`
- `env: undefined` (no overlay needed; hermes uses its own config)

`--ignore-rules --ignore-user-config` is mandatory: it skips `~/.hermes/AGENTS.md`, `~/.hermes/SOUL.md`, the user `config.yaml`, and preloaded skills. This defends against the same literal-bleed class codex hit in v1.59.1 (`~/.hermes/skills/pickle*` would otherwise be auto-loaded). Per Q19 of `prds/hermes-research.md`.

`--max-turns` defaults to `state.max_iterations` when `opts.maxTurns` is unset (Q16: hermes' built-in default is 90, which is incoherent with our per-iteration semantics).

Manager and judge variants follow the same pattern. Hermes has no built-in read-only mode (Q15) — the **judge variant** restricts toolsets to read-only retrieval only (`search`, `web`) and explicitly omits `terminal`, `file`, `write_file`, `patch`, `code_execution`. The same `--ignore-rules --ignore-user-config` flags carry through.

**FR-4**: `buildWorkerInvocation`, `buildManagerInvocation`, and `buildJudgeInvocation` all dispatch to the hermes builder when `backend === 'hermes'`.

**FR-5**: All four spawn sites — `spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts` — handle `backend === 'hermes'` correctly. No changes needed to the env-spread logic added for deepseek (hermes returns `env: undefined`).

**FR-6**: `setup.ts` validates that `hermes --version` succeeds and matches `engines.hermes` from `extension/package.json` when `--backend hermes` is parsed. The version regex is `v(\d+\.\d+\.\d+)` — matches the actual hermes shape `Hermes Agent v0.12.0 (2026.4.30)` (Q11). When `--hermes-provider` is set, smoke check ALSO verifies the corresponding API key env var is present (mapped via a small lookup: `openai → OPENAI_API_KEY`, `anthropic → ANTHROPIC_API_KEY`, `openrouter → OPENROUTER_API_KEY`, etc.) — Q20 confirms hermes has no single `HERMES_API_KEY` and Q25 confirms missing keys produce mid-stream API failures (exit 0) without `--ignore-user-config`. On any failure, exit non-zero before creating session state, with a single-line stderr message. Reuses the same smoke-check helper pattern as `resolveCodexVersionForSetup` at `extension/src/bin/setup.ts:355`.

**FR-7**: `setup.ts` parses `--hermes-toolsets <comma-list>`, `--hermes-provider <name>`, `--hermes-model <name>`, and `--hermes-max-turns <N>` flags. Validates the toolset list is non-empty. `--hermes-max-turns` is an optional positive integer; when unset, hermes invocation defaults to `state.max_iterations`. Persists all four to State as optional fields (`state.hermes_toolsets`, `state.hermes_provider`, `state.hermes_model`, `state.hermes_max_turns`). Resume rejects re-passing these flags with "locked at session creation."

**FR-8**: `setup.ts` extends the existing `--teams + codex` conflict guard to also reject `--teams + hermes` with the same error wording.

**FR-9**: `extension/package.json` gains `engines.hermes` pin (initial value pinned to current hermes version at PRD acceptance time; bumped per the same pattern as `engines.codex`).

**FR-10**: Output parsing in `mux-runner.ts:extractAssistantContent` and `mux-runner.ts:classifyCompletion` gets a third mode-branch. Confirmed shape (Q6–Q10): stdout = plain assistant content only, no interleaved tool calls, no ANSI in `-Q` mode. The new mode-3 path treats stdout as-is (no ANSI strip needed for stdout). Promise tokens detected via the same regex set — Q10 confirms no `[tool:...]` markers leak through.

Mode-3 ALSO scans **stderr** for failure markers because Q3 documents that hermes returns exit code 0 even on non-retryable API errors (HTTP 400/404, bad provider). The wrapper greps stderr for `WARNING`, `ERROR`, and known fail strings (after stripping ANSI from stderr — Q9), and promotes those to a worker failure even when exit was 0. Without this, a model-API-misconfigured hermes invocation looks identical to a successful one. This is **NEW behavior** Pickle hasn't needed for codex/claude.

**FR-11**: `evaluateCodexManagerRelaunch` is renamed to `evaluateManagerRelaunch`. The hermes branch is a **no-op early-return** — Q2 confirms hermes has no wall-clock session-timeout in headless `-q` mode, so the relaunch path is never exercised for hermes:

```ts
export function evaluateManagerRelaunch(state: State, hasPendingWork: boolean): RelaunchEvaluation {
  if (state.backend === 'hermes') {
    return { should_relaunch: false, reason: 'hermes_no_timeout', current_count: 0, cap: CAP };
  }
  if (state.backend !== 'codex') {
    return { should_relaunch: false, reason: 'wrong_backend', current_count: 0, cap: CAP };
  }
  // ... existing codex logic unchanged
}
```

State field stays at schema v3: canonical name is `manager_relaunch_count`; `codex_manager_relaunch_count` is accepted as an alias at read time (Open Question 3 resolved as alias-only — no migration). Activity event: emit `manager_relaunch` with `gate_payload.backend` field; `codex_manager_relaunch` accepted in `VALID_ACTIVITY_EVENTS` and deprecated for one minor cycle (Open Question 4 resolved per PRD recommendation).

**FR-12**: `extension/CLAUDE.md` trap-door catalog gets a new entry for `services/manager-relaunch.ts` (renamed from codex-manager-relaunch.ts) documenting the backend-asymmetric invariant and the test ENFORCE clause.

### Non-Functional Requirements

**NFR-1**: Compilation correctness. Adding `'hermes'` to the `Backend` enum must produce TS errors at every dispatch site that currently switches on backend, ensuring no silent fall-through to claude. Switch statements in `backend-spawn.ts`, `spawn-morty.ts`, and `mux-runner.ts` must explicitly handle the new variant.

**NFR-2**: Honest identity. `state.backend`, `tmux-runner.log` per-iteration banners, `jar-runner.log` per-task banners, and `metrics.js` session attribution must all report `'hermes'` — never `'claude'` or `'codex'` — when the hermes backend is selected.

**NFR-3**: Failure isolation. A missing `hermes` binary at setup time must not corrupt the session state directory; it must fail before any file is written.

**NFR-4**: Toolset list integrity. Empty or malformed `--hermes-toolsets` must be rejected at parse time. Whitespace trimmed; duplicates collapsed; invalid toolset names (not in a known allowlist) emit a warning but pass through (hermes' `-t` flag is the source of truth for valid names).

**NFR-5**: Renamed-helper backward compat. `evaluateCodexManagerRelaunch` (just shipped via T2 in v1.63.0) gets a deprecation alias for one minor cycle before removal. Callers in `mux-runner.ts` and `microverse-runner.ts` updated; old name re-exports for any out-of-tree callers.

## Technical Design

### Type & Constant Changes

`extension/src/types/index.ts:53-55`:
```ts
export type Backend = 'claude' | 'codex' | 'deepseek' | 'hermes';
export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'deepseek', 'hermes'] as const;
```

State extension:
```ts
export interface State {
  // ... existing fields ...
  hermes_toolsets?: string[];      // NEW — set at session creation when --backend hermes
  hermes_provider?: string;        // NEW — optional provider override
  hermes_model?: string;           // NEW — optional model override
  manager_relaunch_count?: number; // RENAMED from codex_manager_relaunch_count (or kept as alias)
}
```

### New Builder

`extension/src/services/backend-spawn.ts`:
```ts
function buildHermesInvocation(opts: WorkerOpts): SpawnInvocation {
  const args = ['chat', '-q', opts.prompt, '-Q'];
  if (opts.toolsets?.length) args.push('-t', opts.toolsets.join(','));
  if (opts.provider) args.push('--provider', opts.provider);
  if (opts.model) args.push('-m', opts.model);
  return { cmd: 'hermes', args, backend: 'hermes' };
}
```

Manager and judge variants follow the same pattern. Judge variant restricts toolsets to read-only equivalents (TBD — see Open Question 2).

### Spawn Site Wiring

The four spawn sites already dispatch via `buildWorkerInvocation(backend)` (or its variants) and spread `invocation.env` per the deepseek FR-6 contract. Hermes returns `env: undefined`, so no spread changes are needed at the spawn sites.

### Output Parser Extension

Mode-3 in `mux-runner.ts:extractAssistantContent` (only added if hermes' stdout shape differs):
```ts
if (backend === 'hermes') {
  // hermes -q -Q emits plain text on stdout; strip ANSI, treat as assistant content
  return stripAnsi(stdout);
}
```

`classifyCompletion` regex set unchanged — promise tokens are prompt-driven.

### Manager Relaunch Generalization

`extension/src/services/codex-manager-relaunch.ts` (just shipped via T2) renamed to `extension/src/services/manager-relaunch.ts`. Function `evaluateCodexManagerRelaunch` renamed `evaluateManagerRelaunch`. Internal logic adds:

```ts
export function evaluateManagerRelaunch(state: State, hasPendingWork: boolean): RelaunchEvaluation {
  if (state.backend !== 'codex' && state.backend !== 'hermes') {
    return { should_relaunch: false, reason: 'wrong_backend', current_count: 0, cap: CAP };
  }
  // ... rest unchanged
}
```

Backward-compat shim:
```ts
// codex-manager-relaunch.ts (kept as re-export for one minor cycle)
export { evaluateManagerRelaunch as evaluateCodexManagerRelaunch } from './manager-relaunch.js';
```

### CLI Surface (setup.ts additions)

```
--hermes-toolsets terminal,file,code_execution    Comma-separated toolset list passed to hermes -t
--hermes-provider openai                          Forces hermes provider via --provider
--hermes-model gpt-5-pro                          Overrides hermes model via -m
```

Validation:
- `--hermes-toolsets` value cannot be empty after split+trim
- All three flags require `--backend hermes`; conflict otherwise
- All three flags rejected on resume (locked at session creation)

## Verification

### Test Plan

`extension/tests/backend-spawn-hermes.test.js` (NEW):
- T1: `buildHermesInvocation` returns `{cmd: 'hermes', args: ['chat', '-q', <prompt>, '-Q']}` for minimal opts
- T2: Toolsets present → args include `-t terminal,file,code_execution`
- T3: Provider present → args include `--provider openai`
- T4: Model present → args include `-m gpt-5-pro`
- T5: All three present → all flags in args, in correct order
- T6: Empty toolsets array → no `-t` flag emitted
- T7: Manager variant matches worker shape with manager-specific prompt
- T8: Judge variant restricts to read-only toolsets (per Open Question 2 resolution)

`extension/tests/setup-hermes.test.js` (NEW):
- T9: `--backend hermes` without hermes on PATH → exit non-zero, no session dir created
- T10: `--backend hermes` with version mismatch → exit non-zero, actionable error
- T11: `--backend hermes --hermes-toolsets terminal,file` → state.hermes_toolsets persisted
- T12: `--backend hermes --hermes-toolsets ""` → reject with parse error
- T13: `--backend hermes` + `--teams` → conflict error matching codex pattern

`extension/tests/hermes-version-smoke.test.js` (NEW, mirrors `codex-version-smoke.test.js`):
- T14: `engines.hermes` pin enforces caret semantics
- T15: Missing `engines.hermes` → die with named error

`extension/tests/manager-relaunch.test.js` (RENAMED from codex-manager-relaunch.test.js):
- Existing codex tests preserved
- T16: `state.backend === 'hermes'`, count below cap → should_relaunch=true
- T17: `state.backend === 'hermes'`, at cap → should_relaunch=false
- T18: Old `evaluateCodexManagerRelaunch` re-export still works (backward compat)

`extension/tests/mux-runner-hermes.test.js` (NEW, conditional on FR-10 mode-3):
- T19: stdout with ANSI → stripped, content extracted
- T20: Promise tokens detected in hermes output

### Acceptance Criteria

- [ ] `Backend` type accepts `'hermes'` — Verify: `npx tsc --noEmit` clean — Type: typecheck
- [ ] `BACKENDS` array includes `'hermes'` — Verify: `node --test extension/tests/backend-spawn-hermes.test.js` — Type: test
- [ ] `buildHermesInvocation` returns correct shape — Verify: same — Type: test
- [ ] `setup.ts` rejects missing hermes binary — Verify: `node --test extension/tests/setup-hermes.test.js` — Type: test
- [ ] `setup.ts` enforces `engines.hermes` version pin — Verify: `node --test extension/tests/hermes-version-smoke.test.js` — Type: test
- [ ] `--hermes-toolsets` parsed and persisted — Verify: same — Type: test
- [ ] `--teams + hermes` conflict rejected — Verify: same — Type: test
- [ ] `evaluateManagerRelaunch` honors hermes backend — Verify: `node --test extension/tests/manager-relaunch.test.js` — Type: test
- [ ] Backward-compat re-export works — Verify: same — Type: test
- [ ] Output classifier handles hermes stdout — Verify: `node --test extension/tests/mux-runner-hermes.test.js` (if mode-3 needed) — Type: test
- [ ] Full test suite passes — Verify: `npm test` — Type: test
- [ ] Type checker clean — Verify: `npx tsc --noEmit` — Type: typecheck
- [ ] ESLint clean — Verify: `npx eslint src/ --max-warnings=-1` — Type: lint

### Manual Verification (CUJs)

1. Run a Pickle epic with `--backend hermes` on a small ticket; confirm `state.backend === 'hermes'` and worker output captured
2. Mixed-backend jar batch with all four backends in sequence; confirm each task spawns the right CLI and ENOENT on hermes binary fails-the-task-not-the-batch
3. (If hermes has a session timeout) Verify codex-manager-relaunch (now manager-relaunch) fires for hermes the same way it fires for codex

## Assumptions

- A1: `hermes chat -q "<query>" -Q` exits cleanly when the query completes (deterministic stdout termination, not a streaming TUI). If hermes streams indefinitely, FR-10 needs revision.
- A2: `hermes chat -q -Q` returns assistant output on stdout (not stderr or a separate file). If output goes elsewhere, capture path needs adjustment.
- A3: Hermes version string is parseable by the same caret semver helper used for codex (`parseCodexVersion` → likely promote to `parseSemverVersion` for reuse).
- A4: Hermes' tool-call shape does NOT need to be parsed by Pickle — promise tokens (`<promise>TASK_COMPLETED</promise>`) are sufficient for completion detection. If hermes interrupts its own emit-token sequence with tool-call rendering, FR-10 needs a tool-call-aware extractor.
- A5: `bash install.sh` deploy parity check (`assertSchemaVersionDeployParity`) does NOT need to extend to backend-specific binaries — the user is responsible for ensuring `hermes` is on PATH on every machine.
- A6: T2 (codex-manager-relaunch extraction) ships in v1.63.0 before this PRD starts; `services/codex-manager-relaunch.ts` exists at HEAD when this work begins.

## Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Hermes' `-q` mode is actually streaming with no terminator → mux-runner hangs waiting for exit | High | Pre-PRD smoke test: run `hermes chat -q "say hello" -Q; echo $?` and confirm clean exit. If streaming, add `--max-wall` flag pass-through or stdin-close trigger. |
| R2 | Hermes binary not available on all developer machines | Low | Pre-flight check (FR-6) fails fast with install instructions. CI never runs hermes (mocked). |
| R3 | `evaluateCodexManagerRelaunch` rename breaks the v1.63.0 trap-door entry shipped via T2 | Medium | Keep the old name as a re-export for one minor cycle. Update trap-door entry to reference both names with the deprecation timeline. |
| R4 | Adding `'hermes'` to `Backend` type breaks downstream switch statements that don't handle it (TS exhaustiveness) | Low (intentional) | NFR-1 — TS will error at every dispatch site. Fix-all-call-sites is the goal. |
| R5 | Toolset list locked at session creation may surprise users who change their mind mid-epic | Low | CUJ-3 documents the lock; resume error is actionable. Future PRD can lift the lock if requested. |
| R6 | Mode-3 stdout classifier diverges from claude/codex shapes; tested behavior drifts as hermes evolves | Medium | Pin `engines.hermes` and require explicit version bump on every CI run. Smoke test covers known stdout patterns. |
| R7 | Hermes' `--provider` flag may interact unexpectedly with `-m` (model override). For example, `--provider openai -m claude-sonnet-4-7` is incoherent | Low | Pre-flight validation: if `--provider` AND `-m` both present, log a warning and pass through anyway. Hermes is the source of truth for valid combinations. |
| R8 | The `state.flags.skip_readiness_reason` bypass shipped in v1.63.0 (BMAD P0.6) may be misused if hermes integration tickets reference NEW symbols that the readiness gate doesn't recognize. Same trap that v1.63.0 hit. | Medium | New tickets for this PRD MUST follow Agent B's PATH_RE-aware authoring style (no `extension/` prefix on NEW files; no backticks on NEW symbols). T9 (OBB-symbol-audit) when shipped will mechanize this. |
| R9 | **Hermes returns exit code 0 even on non-retryable API errors** (HTTP 400/404, bad provider, unknown toolset — Q3, Q14, Q24, Q25). A misconfigured hermes invocation looks identical to a successful one. | High | FR-10 mode-3 mandatorily scans stderr for `WARNING`/`ERROR` markers and promotes them to worker failure; FR-6 smoke check requires `--ignore-user-config` + provider-specific API key env var BEFORE first invocation; provider validation happens at session creation, not mid-iteration. |
| R10 | Hermes' SQLite session DB (`~/.hermes/sessions/sessions.db`) uses `threading.Lock()` + WAL mode (Q21). Heavy concurrent writes from jar-batch parallelism can hit `database is locked`. | Medium | NFR-3 caps hermes-backend jar-batch concurrency at ≤4 workers until benchmarked. Future PRD can lift the cap once SQLite contention is empirically characterized. |
| R11 | Hermes' `terminal` tool spawns subprocesses in a hidden shell, NOT the user's tmux pane (Q23). Operators won't see hermes' shell output the way they do for codex. | Low | Document in command docs (`pickle-jar-open.md`, `pickle-microverse.md`); attribute hermes-issued commits via timing or injected `[hermes]` prefix in the worker prompt (Q30). |

## Resolved Design Decisions

All four high-level design questions are resolved by `prds/hermes-research.md`. Summary:

1. **Session-timeout wall?** **No** (Q2). Hermes has only an inactivity-based backend timeout that does not fire mid-task in headless `-q` mode. FR-11's hermes branch is a no-op early-return. The rename `evaluateCodexManagerRelaunch` → `evaluateManagerRelaunch` still ships for naming honesty.

2. **Built-in read-only mode for the judge variant?** **No** (Q15). Hermes has no `--readonly` flag. Judge variant restricts toolsets to read-only retrieval (`search`, `web`) and explicitly omits `terminal`, `file`, `write_file`, `patch`, `code_execution`. The same `--ignore-rules --ignore-user-config` flags carry through to keep the judge isolated from user config / preloaded skills.

3. **State-schema migration v3 → v4 for the rename?** **No.** Stay at schema v3. Canonical field name becomes `manager_relaunch_count`; `codex_manager_relaunch_count` is accepted as an alias at read time for one minor cycle. Recommendation in PRD draft confirmed.

4. **Activity event naming?** Emit `manager_relaunch` with `gate_payload.backend`. `codex_manager_relaunch` accepted in `VALID_ACTIVITY_EVENTS` and deprecated for one minor cycle. Recommendation in PRD draft confirmed.

## Research Questions — Hermes Behavior (ANSWERED)

✅ All 30 research questions below are answered against **Hermes Agent v0.12.0 (2026.4.30)** in `prds/hermes-research.md`. The questions are kept here for traceability — the answers and resulting FR adjustments live in the research artifact and the §Resolved Design Decisions section above.

### Process lifecycle (Q1-Q5 → drives FR-10, FR-11, R1)

1. Does `hermes chat -q "<query>" -Q` exit cleanly (deterministic stdout terminator + exit code 0) when the query completes, or does it keep streaming/idle?
2. Is there a session-timeout wall like codex's 4-hour subprocess limit? If so, what's the trigger (idle? wall-clock? token cap?) and what's the exit signal?
3. What's the exit code on success vs different failure classes (network error, tool failure, model-side refusal, malformed query)?
4. Does `hermes` honor SIGTERM / SIGINT cleanly, or does it leak child processes (e.g. for tool execution)?
5. Does `hermes -Q` actually suppress the spinner reliably under non-TTY stdout (i.e. when our spawnSync redirects to a pipe)?

### Output format (Q6-Q10 → drives FR-10 mode-3 decision)

6. Does `hermes chat -q -Q` write assistant content to stdout, stderr, or both? If both, what's on which?
7. Is the stdout shape plain text, JSON-stream (Anthropic-style), tool-call interleaved, or something else?
8. Are tool calls and tool results interleaved with assistant text in stdout, or filtered out by `-Q`?
9. Does the output include ANSI escape sequences when stdout is a pipe (not a TTY)? If so, do we strip or accept?
10. Are there structured markers (e.g. `[tool:terminal]`) that survive into the stdout stream that our promise-token regex (`<promise>TASK_COMPLETED</promise>`) might collide with?

### CLI flags (Q11-Q17 → drives FR-3, FR-7, FR-9)

11. What does `hermes --version` output exactly? Format `hermes-cli X.Y.Z`, or just `X.Y.Z`, or something else? Drives the smoke-check regex (parallel to codex's `parseCodexVersion`).
12. Is `-t terminal,file,code_execution` the canonical toolset list, or is it a superset/subset? What's the full enumerated allowlist?
13. Does `--provider <name>` accept a closed set (`openai`, `anthropic`, `local`, ...) or an open string? What happens with unknown providers?
14. Does `-m <model>` semantics depend on the active `--provider`? Is `-m gpt-5-pro --provider anthropic` a hard error or a no-op?
15. Is there a `--readonly` / `--no-write` / sandbox flag for the judge variant?
16. Is there a `--max-turns` or `--max-tools` budget flag for the headless mode (analogous to codex's `--max-iterations`)?
17. Does `-w` interactive mode share state with `-q` headless mode (e.g. shared session history file)?

### Configuration & environment (Q18-Q20 → drives R2, defends against codex `v1.59.1` literal-bleed class)

18. Does `hermes` read a config file (`~/.hermes/config`, `~/.config/hermes/`, env-driven path)? What's the precedence order between config-file values, env vars, and CLI flags?
19. Are there `--ignore-rules` / `--ignore-user-config` equivalents (like codex `v1.59.1` needed)? Could a stale `~/.hermes/skills/pickle*` registry misdirect mid-iteration the way codex did?
20. Which env vars does `hermes` read? (`HERMES_API_KEY`? `HERMES_PROVIDER`? `OPENAI_API_KEY` pass-through?)

### Concurrency & sandbox (Q21-Q23 → drives jar-batch behavior, NFR-3)

21. Can multiple `hermes chat -q` processes run concurrently against the same working directory without locking each other out (e.g. via a session DB)?
22. Does `hermes` respect `cwd` set by the parent process (Node's `spawn({cwd})`), or does it `chdir` to its own discovered project root?
23. When `-t terminal,code_execution` is enabled, does hermes spawn its own subprocesses in our session's tmux pane (visible to the user) or in a hidden subshell?

### Failure modes (Q24-Q27 → drives error-handling design, NFR-3)

24. What happens when a toolset listed in `-t` is unrecognized? Hard error (exit nonzero) or silent skip with warning?
25. What happens when `--provider` is set but the corresponding API key env var is unset? Pre-flight error or runtime mid-stream failure?
26. What's the rate-limit behavior on the underlying provider? Does `hermes` retry internally, or does the call return a partial response with a marker?
27. When stdin is closed (EOF before query response), does hermes exit cleanly or hang?

### Comparison vs codex (Q28-Q30 → informs prompt design, defends against v1.56.x bug class)

28. Does hermes have an equivalent of codex's `MANAGER_FALSE_EPIC_COMPLETED` failure pattern (model claims completion when artifacts disagree)? If yes, the `evaluateEpicCompletion()` recovery state machine (shipped in v1.56.4) needs to be backend-agnostic.
29. Does hermes interpret prompt rules literally the way codex does (`v1.56.1` "ONLY"/"NEVER" trap)? Affects worker-prompt phrasing — if yes, `send-to-morty.md` rule rewrites apply to hermes too.
30. Are hermes-emitted commit messages structurally distinguishable in `git log` output (e.g. `[hermes]` prefix), or do we need to attribute via timing? Affects metrics attribution.

## Session Context (for resuming after `/clear`)

This PRD was drafted on 2026-05-01 during the v1.63.0 overnight bundle run. Relevant context for picking up the work:

### Why this PRD exists

- Pickle Rick currently supports two production backends: `claude` (default) + `codex`
- A third backend `deepseek` is queued at `prds/deepseek-integration.md` (Draft, not started — uses Anthropic-compat shim, rides `claude` CLI)
- This PRD adds a fourth: `hermes` — first-party CLI, more like codex than deepseek
- User invocation pattern provided: `hermes chat -q "query" -Q [-t toolsets] [--provider X] [-m model]`

### Current state of the codebase (relevant fragments)

- `Backend` type at `extension/src/types/index.ts:87` is currently `'claude' | 'codex'`
- `BACKENDS` array on next line
- Backend dispatch in `extension/src/services/backend-spawn.ts` has `buildClaudeWorkerInvocation` and `buildCodexInvocation`
- Codex version smoke check at `extension/src/bin/setup.ts:355` — `resolveCodexVersionForSetup`
- `engines.codex` pin in `extension/package.json` (currently `^0.125.0` after engine-pin bump in commit `80d9c05`)
- `evaluateCodexManagerRelaunch` extracted as `extension/src/services/codex-manager-relaunch.ts` per **T2 of the v1.63.0 bundle** (just shipped at session `2026-04-30-bc104e78`, ticket `8ad7c134`, commit `c5cdb6e`). FR-11 of this PRD generalizes that helper to be backend-aware.

### Key dependencies between this PRD and v1.63.0

- T2 (codex-manager-relaunch extraction) MUST be in main before this PRD starts
- FR-11 renames the just-extracted helper to `manager-relaunch.ts` and parameterizes by backend
- Backward compat: keep `codex-manager-relaunch.ts` as a re-export shim for one minor cycle

### Lessons from v1.63.0 (that this PRD must heed)

- **PATH_RE word-boundary trap**: the readiness gate at `extension/src/bin/check-readiness.ts` scans tickets for paths and treats NEW files (not yet on disk) as phantom symbols. Agent B's analysis: `\b` word-boundary strips the leading dot from `.claude/commands/...` paths. Workaround for tickets in this PRD: don't prefix NEW file paths with `extension/`; use plain prose instead. R8 in §Risks captures this.
- **`--skip-readiness <reason>` flag** shipped in v1.63.0 (Agent A, commit `deac6c5`); set via `state.flags.skip_readiness_reason`. This PRD's tickets should follow Agent B's authoring style and NOT need the flag.
- **T9 (OBB-symbol-audit)** in current bundle, when shipped, will mechanize the symbol-grounding check during refinement — protects future bundles from authoring phantom-symbol tickets.

### What user asked for explicitly

- "could pickle loops support invoking hermes agent? here is how hermes is invoked: ..."
- Then: "draft it"
- Then: "give me a list of open questions for the prd in a list"
- Then: "give me the specific questions about hermes behavior to research"
- Then: "save all the hermes context and questions in the prd so I can clear context"

### Recommended next action when resumed

1. ✅ ~~Run the 30 research questions above as a structured hermes smoke test; capture answers in `prds/hermes-research.md`~~ — DONE (2026-05-01)
2. ✅ ~~Resolve Open Questions 1-4 based on research findings~~ — DONE; see §Resolved Design Decisions
3. ✅ ~~Update FR-3, FR-10, FR-11 as needed based on actual hermes shape~~ — DONE; FR-3, FR-6, FR-7, FR-10, FR-11 all updated; FR-9 version regex specified; new R9, R10, R11 added.
4. **NEXT**: Refine PRD into atomic tickets via `/pickle-refine-prd` and bundle into the next overnight run after v1.63.0 ships.

## Impact

- **State schema**: 3 new optional fields (`hermes_toolsets`, `hermes_provider`, `hermes_model`) + 1 renamed (`manager_relaunch_count` aliased). No migration if Open Question 3 resolved as alias-only.
- **CLI surface**: 3 new flags on `setup.js`. Documented in pickle command docs.
- **Trap doors**: 1 new entry in `extension/CLAUDE.md` for `services/manager-relaunch.ts`.
- **Tests**: ~20 new tests across 4 new test files + 1 renamed file.
- **LOC estimate**: ~350-450 LOC source + ~250 LOC tests = **~600-700 LOC total**.
- **Backward compat**: Existing `codex_manager_relaunch_count` field, `evaluateCodexManagerRelaunch` function, and `codex_manager_relaunch` activity event all preserved as aliases for one minor cycle.

## Stakeholders

- **Author/Implementer**: Pickle Rick (autonomous via /pickle-pipeline)
- **Reviewer**: Gregory Dickson
- **Affected systems**: `mux-runner`, `microverse-runner`, `jar-runner`, `spawn-morty`, `setup`, `metrics`, `pickle-jar-open`
- **Documentation owners**: pickle command authors (commands in `.claude/commands/`)

## Rollout

1. Land in a follow-up bundle PRD (post-v1.63.0). Estimated 2-3 day overnight run.
2. Smoke test: a single small ticket with `--backend hermes` on a real hermes binary before promoting to default jar batch use.
3. Post-rollout: collect metrics on hermes vs codex on the same ticket class for 2 weeks; report findings.
4. If hermes stalls or hangs reproducibly → roll back via `--backend hermes` ENOENT (hermes isn't required for the existing claude/codex workflows).

## Reference Links

- Hermes invocation pattern (from user): `hermes chat -q "query" -Q [-t toolsets] [--provider X] [-m model]`
- Existing deepseek-integration PRD (Shape A pattern): `prds/deepseek-integration.md`
- T2 codex-manager-relaunch extraction (in flight): session `2026-04-30-bc104e78` ticket `8ad7c134`
- Backend type definition: `extension/src/types/index.ts:87`
- Backend dispatch site: `extension/src/services/backend-spawn.ts`
- Setup smoke check pattern: `extension/src/bin/setup.ts:355` (`resolveCodexVersionForSetup`)
