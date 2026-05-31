---
title: P2 — CLI-backend integration pattern — one contract for native-CLI worker/manager backends; first instances grok + kimi
status: Draft — consolidation PRD (supersedes p2-grok-backend-integration.md). Deferred-integration bucket; not drain-slotted.
filed: 2026-05-31
priority: P2
type: feature
code: R-CBI
bundle: B-CBI
supersedes:
  - prds/p2-grok-backend-integration.md   # R-GBK absorbed as the `grok` instance below (PRD deleted; substance folded in)
related:
  - prds/deepseek-integration.md          # B-DSEK — the Shape-A *shim* variant (rides the `claude` binary); NOT a native CLI; cross-referenced, not absorbed
  - prds/hermes-integration.md            # R-HMS — shipped native-CLI backend; the structural template this contract generalizes
  - prds/p2-mcp-forwarding-to-workers.md  # R-MFW — MCP forwarding; per-instance follow-up after R-CBI + R-MFW both ship
  - prds/p1-refinement-scale-monster-bundle-throughput.md  # R-MBSR — refinement clustering; ORTHOGONAL (the grok PRD misattributed this as a backend-registry PRD; it is not)
instances:
  - grok   # xAI Grok Build — absorbed from R-GBK
  - kimi   # MoonshotAI kimi-cli — https://github.com/MoonshotAI/kimi-cli
---

# R-CBI — CLI-backend integration pattern

## Why this exists (consolidation rationale)

Pickle-rick has accumulated backend-addition pressure: `hermes` shipped, `deepseek` is queued (B-DSEK), `grok` was drafted (R-GBK), and `kimi` is now a candidate. Each native-CLI backend is a ~50-LOC variation on **one** pattern — add a `Backend` enum value, add a `buildXWorkerInvocation` mirroring `buildHermesWorkerInvocation`, wire the `--backend X` flag, add a `state.X_model` field. Authoring a fresh full PRD per backend is exactly the duplication the persona is supposed to merge.

The standalone grok PRD (R-GBK) explicitly **rejected** generalization (its "Proposed approach" §) — but on a stated threshold: *"R-MBSR … is gated on actual 3+ PRD bundle pressure. Don't pre-build."* Two corrections make generalization correct now:

1. **The threshold is met.** grok + kimi + deepseek = three backend PRDs in flight. The grok PRD's own gating condition ("3+ PRD bundle pressure") is satisfied.
2. **R-MBSR is not the backend-registry PRD.** `p1-refinement-scale-monster-bundle-throughput.md` (R-MBSR) is *refinement clustering* — reasoning scope per refinement cycle — and is orthogonal to backend dispatch. There is no pre-existing backend-generalization PRD; R-CBI is it.

**What R-CBI generalizes — and what it deliberately does NOT.** R-CBI unifies the *specification and process*, not the runtime code. The grok PRD's anti-over-engineering point stands: **the code keeps explicit per-backend `if (backend === 'X')` branches** (the existing audit-enforced trap door in `extension/src/services/CLAUDE.md` mandates this; a runtime "any-backend registry" is still over-engineering and is a non-goal). R-CBI's leverage is: one contract, one set of cross-cutting invariants, one reusable measurement gate, instantiated per backend instead of re-derived per PRD.

## Scope boundary: native CLI (Shape B) only

| Shape | Mechanism | Backends | Owner |
|---|---|---|---|
| **A — Anthropic-compat shim** | Spawn the `claude` binary with `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` overlay; honest identity in state/logs | `deepseek` | **B-DSEK** (separate; cross-referenced, NOT absorbed) |
| **B — native third-party CLI** | Spawn a provider's own CLI with a `claude -p`-style one-shot mode | `codex`, `hermes`, **`grok`**, **`kimi`** | **R-CBI (this PRD)** |
| C — native HTTP loop | OpenAI-style `tool_calls` against a raw endpoint | (none) | rejected — largest blast radius |
| — text-only gateway | chat-completions, **no tool use** | ~~openrouter~~ | **deleted 2026-05-30** — useless to a tool-using lifecycle |

R-CBI owns Shape B. Shape A (deepseek) has a genuinely different spawn contract (no third-party binary; env overlay) and stays B-DSEK.

## The native-CLI-backend contract (defined once)

A CLI qualifies as a Shape-B backend iff it provides all of the following. Each instance's measurement ticket fills this table with verbatim `--help` output; a missing capability re-scopes or drops that instance (it does NOT change the contract).

| # | Capability | `claude` baseline | Why pickle-rick needs it |
|---|---|---|---|
| C1 | **Headless one-shot** prompt mode | `claude -p "<prompt>"` | Workers/managers are spawned non-interactively by `backend-spawn.ts` |
| C2 | **Structured/streamable output** | `--output-format stream-json` | `mux-runner.ts:extractAssistantContent` + the iteration classifier + circuit-breaker parse an NDJSON/stream-json envelope |
| C3 | **Auto-approve / no-prompt** execution | `--dangerously-skip-permissions` | A headless worker has no human to approve tool calls |
| C4 | **Model selection** flag | `--model <name>` | `state.X_model` → flag; precedence mirrors `resolveCodexModel` |
| C5 | **User-config / rule isolation** | (hermes `--ignore-rules --ignore-user-config`) | Pickle MUST isolate the worker from `~/.<tool>/` rule files (FM-4 class) |
| C6 | **Clean exit** on completion | exit 0, not stream-until-SIGINT | The classifier must distinguish completion from a cap-exit |
| C7 | **Auth as a precondition**, not code | OAuth/login into the tool's own config dir | No API-key threading through pickle; `which <cli>` preflight only |

## Shared cross-cutting invariants (defined once; every instance inherits)

- **INV-JUDGE** — `buildJudgeInvocation` MUST route through `claude` regardless of `state.backend` (R-SCJM-5 trap door in `microverse-runner.ts`). No instance adds a judge branch.
- **INV-REFINE** — the refinement team stays force-claude (`PICKLE_REFINEMENT_LOCK=1`). No instance touches `spawn-refinement-team.ts`.
- **INV-EXPLICIT-BRANCH** — `buildWorkerInvocation`/`buildManagerInvocation` gain an explicit `if (backend === '<name>')` branch before the default-claude fallback (audit-enforced trap door; NO runtime registry).
- **INV-TRANSPARENT** — slash-command prompts list the new `--backend` value but give workers ZERO backend-specific instructions; only the dispatcher knows the difference.
- **INV-UNAVAILABLE** — `spawn-morty.ts` runs a `which <cli>` preflight; a missing binary emits the existing `worker_backend_unavailable` activity event `{ backend, reason: 'cli_missing' }` and aborts cleanly (never bubbles an OS exec error into the classifier's hallucination path). Auth state is NOT probed per-spawn — the tool's own first-call stderr is captured into the worker log.
- **INV-MIGRATE** — `state.<name>_model` and `pickle_settings.default_<name>_model` are additive; `state-manager.ts::migrateState` needs no rename/removal; no `LATEST_SCHEMA_VERSION` bump.
- **INV-MCP-DEFER** — MCP forwarding is out of scope; each instance inherits the codex-level MCP isolation (none / R-MFW Option-D snapshot) until a per-instance `R-MFW-<name>-followup` lands after both R-MFW and R-CBI ship. The measurement ticket records whether the CLI exposes a `--mcp-config` equivalent so the follow-up has data.

## Per-instance measurement gate (reusable template — the R-GBK-1 pattern)

Per Working Rule 8 (measure, don't assume): **every instance's first ticket is diagnostic-only**, producing `prds/research-r-cbi-<name>-cli-surface-<date>.md` with verbatim `--help` output and answers to the contract questions C1–C7 plus:
- Exact one-shot flag spelling (`-p` / `--prompt` / `--print -p` / positional?).
- Exact stream-json envelope shape — does `extractAssistantContent` need a `<name>`-aware fallback (as R-CCPL-4 added for codex)?
- Auth-failure stderr text + exit code (so the classifier maps it, not misreads it as a cap-exit).
- Presence of a `--mcp-config` / `--model` / config-isolation equivalent.

A FAIL on C1/C2/C3/C6 drops or re-scopes that instance; the contract and the other instance are unaffected.

---

## Instance: `grok` (xAI Grok Build) — absorbed from R-GBK

Operator-reported (2026-05-15): `grok` ships a `claude -p`-style one-shot mode with `--output-format streaming-json`; OAuth'd once via its TUI, credential lives in grok's own config dir (no API-key threading). Structural template = `buildHermesWorkerInvocation`. Near-term value: a third worker backend to spread load when codex/claude hit weekly-quota exhaustion (witnessed: `2026-05-13-e58dcc1d` forced a mid-anatomy-park codex→claude swap that tripped R-ICDM). **All seven R-GBK-1 measurement questions** (one-shot flag, stream-json envelope spelling, `--mcp-config` equiv, `--model` strings, `--ignore-user-config` equiv, exit semantics, auth-failure stderr) are captured by R-CBI-GROK-1. Smoke model candidate: `grok-code-fast-1` (confirm in measurement). Docs pointer: `https://docs.x.ai/build/overview` (measurement supersedes any assumed shape).

## Instance: `kimi` (MoonshotAI kimi-cli) — new

Source: `https://github.com/MoonshotAI/kimi-cli`. Confirmed from docs (measurement to verify exact spellings against C1–C7):
- **C1 one-shot:** `kimi --print -p "<prompt>"` or stdin pipe (`echo "…" | kimi --print`); also `--prompt`/`--command`/`-c` non-interactive single prompt that exits after processing.
- **C2 output:** `--output-format text|stream-json`, `--input-format text|stream-json`, `--final-message-only`, `--quiet` (= `--print --output-format text --final-message-only`). A dedicated "wire mode" exists (`moonshotai.github.io/kimi-cli/.../wire-mode.html`) — measurement confirms which is the stable machine envelope.
- **C3 auto-approve:** print mode **implicitly enables `--yolo`** (auto-approve all actions).
- **C7 auth:** `/login` (OAuth-style, Moonshot/Kimi models).
- **Runtime:** Python + `uv` (a non-Node host-tool precondition, like codex's binary). **MCP supported** (`kimi mcp` subcommand; HTTP + stdio).
- Real agentic tool use (read/edit code, run shell, web fetch) — clears the tool-use bar OpenRouter failed. Docs pointers: `print-mode.html`, `reference/kimi-command.html`.

`kimi`'s surface looks like the closest structural match to `claude -p` of any instance (stream-json in/out + final-message-only + yolo) — the per-instance wiring may be the smallest of the set, pending measurement.

---

## Atomic ticket scope

**Shared (land once):**
- **R-CBI-0** — This consolidation PRD + delete `p2-grok-backend-integration.md` (done at authoring). Establish the contract, invariants, and measurement template above as the source of truth for all future Shape-B backends.

**Per instance `<name>` ∈ {grok, kimi} — identical shape (mirrors the absorbed R-GBK ticket order):**
- **R-CBI-`<name>`-1** — Measurement (diagnostic-only). Deliverable: `prds/research-r-cbi-<name>-cli-surface-<date>.md` (forward-created). Answers C1–C7 + envelope/auth/MCP questions. NO source changes.
- **R-CBI-`<name>`-2** — Extend `Backend` union + `BACKENDS` in `extension/src/types/index.ts:160,164` + deployed mirror; extend the `state.backend` field-invariant test.
- **R-CBI-`<name>`-3** — `build<Name>WorkerInvocation` in `backend-spawn.ts` (mirror `buildHermesWorkerInvocation`); add `backend === '<name>'` branches to `buildWorkerInvocation` + `buildManagerInvocation`. **No** judge branch (INV-JUDGE).
- **R-CBI-`<name>`-4** — `state.<name>_model` + `pickle_settings.default_<name>_model` + `resolve<Name>Model` (mirror `resolveCodexModel`); additive migration.
- **R-CBI-`<name>`-5** — Wire `--backend <name>` + `PICKLE_BACKEND=<name>` through `spawn-morty.ts`, `mux-runner.ts`, `pipeline-runner.ts`, `microverse-runner.ts`, `jar-runner.ts` at the existing resolution layer.
- **R-CBI-`<name>`-6** — `which <name>` preflight + `worker_backend_unavailable`; update `audit-worker-backends.ts` allowed-set.
- **R-CBI-`<name>`-7** — Stream-json envelope fallback in `extractAssistantContent` **only if** measurement found drift from claude/codex/hermes shapes.
- **R-CBI-`<name>`-8** (closer) — Slash-command `--backend` flag tables (`/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, `/pickle-pipeline`) + `pickle-rick-claude/CLAUDE.md` env/settings table + `README.md`; version bump; release gate.

## Machine-checkable acceptance criteria

| ID | Criterion | Evidence | Owner |
|---|---|---|---|
| AC-CBI-01 | `prds/p2-grok-backend-integration.md` no longer exists; its R-GBK substance is present in this PRD's grok instance. | `git ls-files prds/p2-grok-backend-integration.md` empty + grep. | R-CBI-0 |
| AC-CBI-02 | Per instance: measurement file exists with verbatim `--help` + C1–C7 answers before any source change. | `prds/research-r-cbi-<name>-cli-surface-*.md` (forward-created). | R-CBI-`<name>`-1 |
| AC-CBI-03 | `BACKENDS.includes('<name>')` and the `Backend` union accepts `'<name>'`. | `extension/tests/types/backend-enum.test.js`. | R-CBI-`<name>`-2 |
| AC-CBI-04 | `build<Name>WorkerInvocation({prompt,addDirs})` returns `{cmd:'<name>', backend:'<name>', args:[…measured flags…]}`; `buildWorkerInvocation('<name>')` + `buildManagerInvocation('<name>')` dispatch to it. | `extension/tests/services/backend-spawn-<name>.test.js` (forward-created). | R-CBI-`<name>`-3 |
| AC-CBI-05 | `buildJudgeInvocation('<name>')` returns `{cmd:'claude', backend:'claude'}` (INV-JUDGE regression guard). | same test. | R-CBI-`<name>`-3 |
| AC-CBI-06 | `state.<name>_model` resolver precedence `state → settings → undefined`; field-invariant test accepts trimmed non-empty string, rejects non-string. | `extension/tests/state-field-invariants.test.js`. | R-CBI-`<name>`-4 |
| AC-CBI-07 | `spawn-morty.ts --backend <name>` against a `PATH` excluding `<name>` aborts cleanly, emits `worker_backend_unavailable {backend:'<name>', reason:'cli_missing'}`, surfaces an operator-runbook stderr line. | `extension/tests/integration/<name>-cli-missing.test.js` (forward-created). | R-CBI-`<name>`-6 |
| AC-CBI-08 | Expensive-tier smoke: a real `<name>` one-shot exits 0 within 60s and echoes a token; **skips gracefully** when the CLI is absent/unauthenticated. | `extension/tests/integration/<name>-smoke.test.js` (forward-created), `RUN_EXPENSIVE_TESTS=1`. | R-CBI-`<name>`-8 |
| AC-CBI-09 | Schema-neutral: no `LATEST_SCHEMA_VERSION` bump in the bundle diff (additive fields only). | `git diff` on the schema constant = empty. | R-CBI-`<name>`-4 |
| AC-CBI-10 | Full release gate green. | CLAUDE.md release-gate command, exit 0. | R-CBI-`<name>`-8 |

## Trap doors
- **R-CBI-EXPLICIT-BRANCH** — the existing `backend-spawn.ts` trap door (explicit `if (backend === 'X')` before default claude; NO registry) is extended to cover each instance; the judge dispatch MUST NOT gain a parallel branch (INV-JUDGE / R-SCJM-5 parity). Enforced by AC-CBI-04/05 + `audit-trap-door-enforcement`.
- **R-CBI-MEASURE-FIRST** — every instance's source tickets (R-CBI-`<name>`-2..8) block on the measurement deliverable (R-CBI-`<name>`-1); no flag spelling is assumed from training data.
- **R-CBI-NO-REGISTRY** — R-CBI must NOT introduce a generic runtime backend registry; consolidation is at the PRD/spec layer only (honors the R-GBK over-engineering rejection).

## Non-goals
- A runtime "any-backend" registry (explicitly rejected — INV-EXPLICIT-BRANCH stands).
- Routing grok/kimi as the judge (INV-JUDGE) or in the refinement team (INV-REFINE).
- MCP forwarding (INV-MCP-DEFER; per-instance follow-up after R-MFW).
- Backend auto-fallback on quota exhaustion (separate ergonomic PRD if demand materializes).
- Absorbing DeepSeek (Shape A shim — stays B-DSEK).
- Documenting provider auth beyond a one-line pointer (each tool's own docs are the source of truth).
- Backend-specific worker prompt instructions (INV-TRANSPARENT).

## Risks
| # | Risk | Mitigation |
|---|---|---|
| 1 | Measurement finds a CLI lacks C1/C2/C3/C6 | R-CBI-`<name>`-1 is diagnostic-first; a FAIL drops/re-scopes that instance only — contract + sibling instance unaffected. |
| 2 | stream-json envelope drift vs claude/codex/hermes | R-CBI-`<name>`-1 captures the envelope; R-CBI-`<name>`-7 adds a `<name>`-aware `extractAssistantContent` fallback only if drift is real. |
| 3 | Auth-failure spawn loop misread as cap-exit | INV-UNAVAILABLE preflight + measured auth-failure stderr shape for a tighter classifier path. |
| 4 | Non-Node host-tool deps (kimi = Python/`uv`; grok binary) | Documented as an operator precondition (like codex); `which` preflight; never bundled. |
| 5 | Consolidation contradicts the grok PRD's "don't generalize" call | Addressed in §Why: the grok PRD's own 3-PRD threshold is met and R-MBSR was misattributed; code-level registry remains a non-goal so the anti-over-engineering intent is preserved. |
| 6 | MCP-blind workers (Linear-blindness pathology) | INV-MCP-DEFER; per-instance R-MFW follow-up; operators told grok/kimi inherit codex-level MCP isolation. |

## Supersession
This PRD supersedes `prds/p2-grok-backend-integration.md` (R-GBK), which is deleted at authoring with its substance folded into the grok instance + the shared contract/invariants/measurement template. Future Shape-B backends are added as new `instances:` entries here, not as new standalone PRDs.

## Proposed plan placement (operator to slot)
**Deferred-integration bucket** (the canonical native-CLI-backend PRD), alongside `hermes-integration.md`. Feature → drains after the bug bundles. B-DSEK (Shape-A shim) remains its own drain row. If active demand materializes (e.g. another quota-exhaustion incident), promote a single instance (`grok` or `kimi`) to the drain queue — not the whole pattern at once.
