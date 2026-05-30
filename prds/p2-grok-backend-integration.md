---
title: P2 — Add Grok Build as a fourth pickle-rick worker/manager backend
status: Draft
filed: 2026-05-15
priority: P2
type: feature
r_code_prefix: R-GBK
backend_constraint: any
related:
  - prds/p2-mcp-forwarding-to-workers.md          # R-MFW — MCP forwarding affects whichever backends are wired
  - prds/hermes-integration.md                    # R-HMS — most recent backend addition, closest structural template
  - prds/deepseek-integration.md                  # prior 4th-backend exploration; superseded by this PRD if Grok wins
---

# P2 — Add `grok` backend to the worker/manager dispatch

## Motivation

xAI shipped `grok` (a.k.a. Grok Build), a CLI with a `claude -p`-style one-shot mode and a `--output-format streaming-json` flag. Per the operator (2026-05-15): when grok is installed locally and OAuth-authenticated once via its TUI, no API key threading is needed — the credential sits in grok's own config dir the same way `claude` does its own. That makes grok the smallest possible fourth backend to add: spawn shape mirrors hermes/codex, auth becomes a precondition (not code), and pickle-rick gets a third worker option to spread load across when one provider is rate-limited or weekly-quota-exhausted.

Concrete near-term value:
- The 2026-05-13 b54f2143 bundle ran codex backend and burned ~80 min/ticket × 3-4 tickets on `MANAGER_FALSE_EPIC_COMPLETED` strike loops (slot G R-CCPL).
- The 2026-05-13-e58dcc1d session forced a codex→claude swap after codex weekly-quota exhaustion mid-anatomy-park, which then tripped R-ICDM (slot 10b/17).
- Adding a third worker backend reduces the "one provider down → pipeline stops" failure mode without re-litigating R-CCPL/R-ICDM. Workers stay the same; the spawn just routes elsewhere.

## Current backend dispatch (what changes)

`extension/src/types/index.ts:144` defines:

```ts
export type Backend = 'claude' | 'codex' | 'hermes';
export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'hermes'] as const;
```

`extension/src/services/backend-spawn.ts` dispatches at three sites:
- `buildWorkerInvocation(backend, opts)` at line 271-275 — branches on `backend === 'codex'` and `backend === 'hermes'`; default claude.
- `buildManagerInvocation(backend, opts)` at line 277-281 — same shape.
- `buildJudgeInvocation(backend, opts)` at line 378 — branches on `backend === 'codex'` and routes everything else through `claude`. Per the `microverse-runner.ts` R-SCJM-5 trap door, the judge MUST always go through claude regardless of `state.backend` — grok inherits this without change.

The closest analog is hermes at `buildHermesWorkerInvocation` (line 341-357): it passes `chat -q <prompt> -Q --ignore-rules --ignore-user-config`, optional `--max-turns`, optional `--toolsets <csv>`, optional `--provider <name>`, optional `-m <model>`, and returns `{ cmd: 'hermes', args, backend: 'hermes' }`. R-GBK ships an equivalent `buildGrokWorkerInvocation`.

## Open question (must be measured first, not assumed)

Per Working Rule 8: do NOT assume the grok CLI surface from training data. R-GBK-1 is a diagnostic-only ticket whose sole deliverable is `prds/research-r-gbk-cli-surface-2026-05-15.md` with verbatim `grok --help` / `grok -p --help` / `grok inspect` output and the answers to:

- Is `-p "<prompt>"` the canonical one-shot flag, or is it `--prompt` / positional / something else?
- Is `--output-format streaming-json` the exact spelling, and what does the stream-json envelope look like? (Specifically: does `mux-runner.ts`'s `extractAssistantContent` need a grok-aware fallback the same way R-CCPL-4 added a codex-aware one?)
- Is there a `--mcp-config <path>` equivalent for forwarding operator MCPs to a grok subprocess? (Hard prereq for R-MFW once R-GBK lands.)
- Is there a `--model <name>` flag, and what are the supported model strings?
- Is there an `--ignore-user-config` / rule-isolation flag equivalent? Pickle-rick MUST be able to isolate the worker prompt from any `~/.grok/` rule files for the same FM-4 reason hermes/codex use `--ignore-rules`.
- Does `grok -p` exit 0 cleanly on completion, or does it stream until SIGINT?
- What's the auth-required failure mode? (Stderr message, exit code — `mux-runner.ts` needs to map this so a missing `grok login` doesn't look like a code-3 cap-exit.)

If R-GBK-1 finds the CLI does NOT support one or more of those shapes, the subsequent tickets are re-scoped or dropped. The PRD ships even if grok turns out to be Hermes-flavored vs Claude-flavored — the dispatch site mechanics are identical; only the per-flag wiring shifts.

## Functional requirements

- **FR-1**: `Backend` type at `extension/src/types/index.ts:144` extends to `'claude' | 'codex' | 'hermes' | 'grok'`; `BACKENDS` constant extends in parallel. `BackendResolutionSource` and `WorkerBackendResolutionSource` types unchanged.
- **FR-2**: `extension/src/services/backend-spawn.ts` gains `buildGrokWorkerInvocation(opts: WorkerInvocationOptions): SpawnInvocation` returning `{ cmd: 'grok', args, backend: 'grok' }`. Args derived from R-GBK-1 findings; minimum: prompt, optional model, optional `--add-dir` for each `opts.addDirs` entry (only if the directory exists, per existing claude/codex/hermes guard).
- **FR-3**: `buildWorkerInvocation` and `buildManagerInvocation` add a `backend === 'grok'` branch dispatching to `buildGrokWorkerInvocation`. Manager and worker share the same invocation builder (same pattern as hermes today at lines 273 + 279).
- **FR-4**: `buildJudgeInvocation` does NOT add a grok branch. The R-SCJM-5 trap door at `src/bin/microverse-runner.ts` mandates the judge spawn through claude regardless of `state.backend`. R-GBK MUST NOT change that contract.
- **FR-5**: CLI flag `--backend grok` propagates through `spawn-morty.ts`, `mux-runner.ts`, `pipeline-runner.ts`, `microverse-runner.ts`, and `jar-runner.ts`. `PICKLE_BACKEND=grok` env var is honored at the same resolution layer as `PICKLE_BACKEND=codex` / `PICKLE_BACKEND=hermes` today.
- **FR-6**: New `state.grok_model` optional field (mirrors `state.codex_model` invariant at `state-field-invariants.test.js`); resolver `resolveGrokModel(state)` mirrors `resolveCodexModel(state)` at `spawn-morty.ts` with precedence `state.grok_model` → `pickle_settings.default_grok_model` → undefined (no flag emitted; grok CLI default applies).
- **FR-7**: `pickle_settings.json` schema gains `default_grok_model` alongside `default_codex_model`. Migration in `state-manager.ts::migrateState` is additive-only — absent field is fine.
- **FR-8**: Per-spawn auth precondition. `spawn-morty.ts` MUST check `which grok` returns 0 before spawning a grok worker; missing-binary failure mode emits `worker_backend_unavailable` (existing activity event, see `VALID_ACTIVITY_EVENTS`) with `{ backend: 'grok', reason: 'cli_missing' }` and aborts spawn cleanly rather than letting the OS exec error bubble into the iteration-classifier's `MANAGER_PERSISTENT_HALLUCINATION` path. **Auth itself (logged in vs not) is NOT probed at spawn time** — the cost of a `grok auth status` per spawn is too high; instead, grok's own first-call stderr ("not authenticated, run `grok login`") is captured into the worker log and surfaced via the existing per-ticket review artifacts. R-GBK-1 confirms grok's exact auth-failure stderr shape.
- **FR-9**: All slash command prompts that document `--backend` (`/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, `/pickle-pipeline`) update their flag table to list `grok` alongside `codex` / `hermes` / `claude`. Each command's prompt MUST NOT instruct the worker about grok-specific behavior — backend transparency is the rule; only the dispatcher knows the difference.
- **FR-10**: MCP forwarding for grok is OUT OF SCOPE for R-GBK and explicitly deferred to a `R-MFW-grok-followup` ticket that lands AFTER both R-MFW and R-GBK ship. R-GBK-1 captures whether grok exposes a `--mcp-config`-equivalent flag so the follow-up has the data; R-GBK itself ships without MCP plumbing — pickle workers on the grok backend get the same MCP isolation as codex workers do today (none, with R-MFW Option D snapshot as the fallback).

## Machine-checkable acceptance criteria

- **AC-1**: `extension/tests/types/backend-enum.test.js` asserts `BACKENDS.includes('grok')` and the `Backend` union accepts `'grok'`. Type: unit.
- **AC-2**: A new test under `extension/tests/services/backend-spawn-grok.test.js` invokes `buildGrokWorkerInvocation({prompt: 'x', addDirs: ['/tmp/exists-by-fixture']})` and asserts the returned `cmd === 'grok'`, `backend === 'grok'`, and `args` array contains the prompt-passing flag(s) as determined by R-GBK-1. Type: unit.
- **AC-3**: Same test asserts `buildWorkerInvocation('grok', opts)` and `buildManagerInvocation('grok', opts)` both dispatch to `buildGrokWorkerInvocation`. Type: unit.
- **AC-4**: A test under `extension/tests/services/backend-spawn-grok.test.js` asserts `buildJudgeInvocation('grok', opts)` returns `{ cmd: 'claude', ..., backend: 'claude' }` — grok backend MUST NOT route through itself for the judge spawn. Type: unit (regression guard for R-SCJM-5).
- **AC-5**: `extension/tests/integration/spawn-morty-backend-resolution.test.js` extends its existing matrix to include `backend: 'grok'` with `state.grok_model = 'grok-code-fast-1'` (or whatever R-GBK-1 confirms as the smoke-safe model string) — asserts the resolver emits `-m grok-code-fast-1` (or the R-GBK-1-confirmed flag spelling) and stamps a `worker_spawn_backend_resolved` activity event with `{ resolved: 'grok' }`. Type: integration.
- **AC-6**: `extension/tests/integration/grok-cli-missing.test.js` runs `spawn-morty.ts --backend grok` against a `PATH` that excludes `grok`. Asserts the spawn aborts cleanly (no orphan process), emits `worker_backend_unavailable` with `{ backend: 'grok', reason: 'cli_missing' }`, and surfaces a stderr line matching `/grok CLI not found on PATH — run `grok login` after installing/` (operator runbook hint). Type: integration. Gated only on POSIX (`PATH` manipulation portability).
- **AC-7**: `extension/tests/integration/grok-smoke.test.js` invokes a real `grok -p "echo done"` subprocess (or whatever the R-GBK-1-confirmed one-shot shape is) gated on `RUN_EXPENSIVE_TESTS=1` AND `command -v grok` exits 0 AND `grok auth status` (or equivalent) reports authenticated. Asserts the subprocess exits 0 within a 60s wall-clock budget and stdout contains the echoed token. **Skips gracefully** (not fails) if any precondition is unmet — keeps CI green on machines without grok. Type: integration, expensive-tier.
- **AC-8**: A new trap door in `extension/src/services/CLAUDE.md` for `backend-spawn.ts` documents the invariant: when a fourth backend is added (`grok`), `buildWorkerInvocation` / `buildManagerInvocation` MUST gain a parallel `if (backend === '<name>')` branch BEFORE the default claude fallback; the judge dispatch MUST NOT add a parallel branch (R-SCJM-5 parity). ENFORCE points at AC-2/AC-3/AC-4. PATTERN_SHAPE: `if (backend === 'grok') return buildGrok` in `buildWorkerInvocation` and `buildManagerInvocation` bodies. Type: test (covered by `extension/tests/audit-trap-door-enforcement` audit).
- **AC-9**: `state.grok_model` is added to the `state.json` field invariant test at `extension/tests/state-field-invariants.test.js` alongside the existing `codex_model` invariant — asserts the field is optional, accepts trimmed non-empty strings, and rejects non-string types. Mirrors the codex_model line exactly. Type: unit.
- **AC-10**: Release gate passes — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Type: test.

## Proposed approach

Single-PRD ≤8-ticket bundle (per Working Rule 5). The bundle is structurally trivial — it adds a fourth case to existing 3-case branches in well-tested files. The risk is concentrated in R-GBK-1: if the grok CLI doesn't have the shape we expect, the dispatch shape changes but the patch surface stays small.

No design alternatives worth ranking — there is one obvious shape (mirror hermes). Rejected variants:

- **Build a generic "any-backend" runtime registry** — over-engineering. Three concrete branches today, four with grok is still a `switch`, not a registry. The R-MBSR (Refinement Scale) PRD already covers the only generalization that has measurable demand, and R-MBSR is gated on actual 3+ PRD bundle pressure. Don't pre-build.
- **Wrap grok behind hermes' `--provider` flag instead of adding a new backend** — rejected. Hermes uses its own auth path and rule isolation; routing grok through hermes ties grok's availability to hermes installation and obscures the spawn shape in operator-facing logs. Operators reading `state.backend = 'hermes'` would have no signal that the actual worker is grok.
- **Auto-detect installed backends and offer them in `/pickle` interactively** — rejected. UX expansion, not a runtime requirement. Operators who want grok will type `--backend grok`. Detection can land later as a follow-up.

## Non-goals

- MCP forwarding for grok workers (see FR-10; deferred to `R-MFW-grok-followup` after both R-MFW and R-GBK ship).
- Spawning grok as the judge backend (FR-4; the judge stays claude per R-SCJM-5).
- Adding grok to the refinement team (`spawn-refinement-team.ts` is force-claude via `PICKLE_REFINEMENT_LOCK=1`; that contract holds — refinement quality is too load-bearing on claude's specific behavior to risk a cross-backend swap before a separate PRD measures equivalence).
- Adding grok-specific prompt instructions to slash command files. Backend transparency is the rule.
- Solving codex weekly-quota exhaustion via grok auto-fallback. That's a separate ergonomic question (which backend to pick when one is rate-limited) and warrants its own PRD if the demand materializes.
- Documenting `grok auth` setup in `README.md` beyond a one-line pointer. Grok's own docs are the source of truth; pickle-rick documents only how to invoke the backend, not how to authenticate to xAI.

## Risks / concerns

- **R-GBK-1 measurement risk**: if `grok -p` doesn't exist (e.g. the CLI uses `grok run` or some other one-shot shape), the rest of the tickets re-scope. Mitigation: R-GBK-1 produces a forensic deliverable BEFORE any source change; R-GBK-2 onward block on its findings.
- **Streaming-json envelope drift**: `mux-runner.ts:extractAssistantContent` has codex-aware and claude-aware fallbacks (R-CCPL-4 trap door). If grok's stream-json envelope shape differs from both, a grok-aware fallback is needed. R-GBK-1 captures the envelope; if drift is detected, R-GBK-3 grows a sub-ticket for the classifier update.
- **Auth-failure spawn loop**: if `grok -p` exits non-zero with "please run `grok login`" when unauthenticated, the iteration classifier could misread that as a normal failure and burn manager turns retrying. FR-8 mitigates with a pre-spawn `which grok` check and the existing `worker_backend_unavailable` event; the stderr-shape capture in R-GBK-1 confirms the auth-failure phrasing for a tighter classifier path if needed.
- **MCP gap propagation**: until R-MFW ships, grok workers have the same Linear-blindness pathology as the LOA-789 codex failure documented in R-MFW. Operators must understand grok inherits this. The R-MFW-grok-followup is the proper closure; this PRD does NOT block on R-MFW.
- **Cross-backend leak audit**: `audit-worker-backends.ts` audits cross-backend resolution mismatches. Adding `'grok'` to `Backend` may surface as a phantom-leak finding if the audit's allowed-set isn't updated. R-GBK-6 covers this.
- **Stale persisted state**: pre-R-GBK state files don't have `grok_model`. State-manager migration is additive (no field rename, no removal), so older sessions resume cleanly with `grok_model = undefined`. No backward-compat shim required.
- **`--ignore-user-config` parity**: if grok has NO equivalent flag, pickle workers cannot isolate from `~/.grok/` rule files, reintroducing FM-4 risk on the grok backend. R-GBK-1 captures this; if missing, the bundle either ships with a documented operator caveat (no `~/.grok/` directory permitted) OR drops grok manager support and ships worker-only.

## Why P2 (not P1 or P3)

- **Not P1**: no witnessed pipeline-killer failure mode. R-GBK is purely additive — the existing 3 backends keep working unchanged whether R-GBK ships or not. P1 is reserved for active regressions.
- **Not P3**: throughput value is real. Codex weekly-quota exhaustion has already forced one mid-pipeline backend swap (2026-05-13-e58dcc1d). A third worker backend buys the operator a parallel escape hatch. P3 is reserved for cosmetic / observability work; this is a capability expansion.
- **P2 + open-bug-ceiling Working Rule 1**: at 2026-05-15 the open-bug count is below the ≤ 3 P1/P2 ceiling for the queued bundles (R-CCPM is the active bundle; R-FRA/R-QGSK/R-PIWG-3/R-MFW are queued). R-GBK is a feature, not a bug — it does NOT count against the ceiling, but it should land AFTER R-CCPM ships (codex manager stability) so the existing 3-backend matrix is healthy before a fourth is added.

## Implementation order

- **R-GBK-1**: Measure grok CLI surface. Run `grok --help`, `grok -p --help` (and equivalents per discovery), `grok inspect`, `grok login --help`, and `grok auth status --help`. Capture verbatim into `prds/research-r-gbk-cli-surface-2026-05-15.md`. Answer the seven open questions in the PRD's `## Open question` section. Document the auth-failure stderr shape and exit code. NO source changes. Deliverable: research markdown file + decision matrix for each downstream ticket.
- **R-GBK-2**: Extend `Backend` type and `BACKENDS` constant in `extension/src/types/index.ts:144,148`. Update `extension/types/index.js` deployed mirror. Update `state.backend` field-invariant test at `extension/tests/state-field-invariants.test.js` to accept `'grok'`. AC-1.
- **R-GBK-3**: Implement `buildGrokWorkerInvocation` in `extension/src/services/backend-spawn.ts` mirroring `buildHermesWorkerInvocation` (lines 341-357) with R-GBK-1-confirmed flag spellings. Add `backend === 'grok'` branches in `buildWorkerInvocation` (line 271-275) and `buildManagerInvocation` (line 277-281). Do NOT add a grok branch to `buildJudgeInvocation` (R-SCJM-5 parity). AC-2, AC-3, AC-4.
- **R-GBK-4**: Add `state.grok_model` field, `pickle_settings.default_grok_model` setting, and `resolveGrokModel(state)` helper in `spawn-morty.ts` mirroring `resolveCodexModel(state)`. State-field-invariant test. AC-9.
- **R-GBK-5**: Wire `--backend grok` CLI flag and `PICKLE_BACKEND=grok` env var through `spawn-morty.ts`, `mux-runner.ts`, `pipeline-runner.ts`, `microverse-runner.ts`, `jar-runner.ts`. Reuse existing resolution layer; no new layers added. AC-5.
- **R-GBK-6**: Pre-spawn `which grok` check in `spawn-morty.ts` emitting `worker_backend_unavailable` on missing binary. Update `audit-worker-backends.ts` allowed-set if needed. AC-6.
- **R-GBK-7**: Trap door pin in `extension/src/services/CLAUDE.md` per AC-8. Update PATTERN_SHAPE anchors.
- **R-GBK-8**: Integration smoke test gated on `RUN_EXPENSIVE_TESTS=1` + grok-installed + grok-authenticated. AC-7. Skip gracefully when preconditions unmet.
- **R-GBK-9** (closer): Update slash command flag tables (`/pickle.md`, `/pickle-tmux.md`, `/pickle-microverse.md`, `/anatomy-park.md`, `/szechuan-sauce.md`, `/pickle-pipeline.md`) to list `grok` as an accepted `--backend` value. Update `pickle-rick-claude/CLAUDE.md` env-var/settings table. Version bump per Versioning policy. AC-10 release gate.
- **R-MFW-grok-followup** (separate PRD, files after R-GBK ships): if R-GBK-1 confirmed grok has an MCP-config-equivalent flag, wire it into `buildGrokWorkerInvocation` parallel to R-MFW's claude/codex changes. Otherwise inherit R-MFW Option D session-root snapshot for any Linear-bearing pipeline run on the grok backend.

## References

- [`extension/src/types/index.ts:144`](../extension/src/types/index.ts) — `Backend` union and `BACKENDS` constant.
- [`extension/src/services/backend-spawn.ts:271-357`](../extension/src/services/backend-spawn.ts) — three dispatch sites + four invocation builders; `buildHermesWorkerInvocation` is the structural template.
- [`extension/src/services/backend-spawn.ts:378-423`](../extension/src/services/backend-spawn.ts) — judge dispatch; R-SCJM-5 parity guard.
- [`extension/src/bin/spawn-morty.ts`](../extension/src/bin/spawn-morty.ts) — `resolveCodexModel` pattern that R-GBK-4's `resolveGrokModel` mirrors.
- `prds/p2-mcp-forwarding-to-workers.md` — R-MFW. R-GBK-1 captures grok's MCP support but does not block on it.
- `prds/hermes-integration.md` — R-HMS shipped 2026-04-XX; closest structural template for a fourth-backend addition.
- Grok Build docs: `https://docs.x.ai/build/overview` — operator-provided pointer. R-GBK-1 supersedes any assumed CLI shape with measured output.
- Working Rule 5 (one PRD per pipeline session) and Working Rule 8 (measure, don't assume) — applied throughout.
