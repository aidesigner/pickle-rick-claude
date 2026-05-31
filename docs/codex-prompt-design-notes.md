# Codex Backend — Prompt Design Notes

Institutional knowledge for authors of skills, worker prompts, and PRDs that will run on the `codex` backend. Surfaced from the v1.56.x stall sessions (god-fn epic) and the v1.59.x stall hardening sessions. Source-of-truth for codex-specific quirks; **not** an active plan.

## 1. Codex is a literalist

Any `ONLY` / `NEVER` / `MUST NOT` rule is read absolutely, even when context makes the intended scope obvious.

- v1.56.1 incident: the worker prompt said "Write ONLY to `${TICKET_DIR}`". Codex obeyed and refused to commit any change to the project working tree, stalling the entire pipeline.
- **Rule for prompt authors**: enumerate scopes explicitly. If a worker is allowed to write to two scopes, list both. Avoid `ONLY` as a hard constraint unless the constraint is genuinely absolute.

## 2. Codex bleeds context across nearby instructions

When two prompts are accessible (e.g. `pickle.md` manager + `send-to-morty.md` worker, both in `addDirs`), codex can use the wrong one.

- v1.56.3 incident: workers leaked orchestrator promise tokens upstream because both prompts defined completion tokens.
- **Mitigation now in place**: per-context forbidden lists in worker prompts; runtime token scrub in `spawn-morty.ts` finalize-time (`FORBIDDEN_WORKER_TOKENS`).
- **Rule for prompt authors**: keep manager-only tokens out of worker prompts entirely. Don't share completion-marker tokens across roles.

## 3. Codex confuses scope levels

Per-ticket completion vs. epic completion both look like "I finished" to codex.

- v1.56.4 incident: 18 `MANAGER_FALSE_EPIC_COMPLETED` markers logged during T0 alone. Each was a hallucinated epic completion that would have killed the pipeline pre-fix.
- **Mitigation now in place**: `evaluateEpicCompletion()` in mux-runner — 4-arm decision (genuine / recover_advance / recover_retry / persistent_hallucination); counter persisted in `state.false_epic_completed_count`.
- **Rule for prompt authors**: never trust a model claim of "epic done" without verifying ticket statuses. Manager-side recovery state machines are mandatory, not optional.

## 4. Codex stalls on large refactors (FM-1..FM-4)

Iteration budgets sized for "implement one helper extraction" don't cover "implement six". Four failure modes were classified during the god-fn epic; all four are mitigated as of v1.59.x.

| FM | Symptom | Fix |
|---|---|---|
| FM-1 stall-on-judgment | codex loops on AC contradiction without descoping | P0 contract addendum (v1.59.0) — descope + `DEFERRED:` note |
| FM-2 stall-on-abstraction | codex explores harness internals (setup.js, mux-runner.js) instead of ticket scope | P0 contract addendum + worker prompt rule |
| FM-3 commit-skip | codex produces edits but never commits, work orphaned at breaker trip | P0 contract addendum + post-flush guard (commit-pending probe) |
| FM-4 stall-on-imaginary-worker | codex narrates a non-existent worker subprocess, polling forever | `--ignore-rules --ignore-user-config` (v1.59.1) — bypasses stale `~/.codex/skills/pickle*` registry |

- **Codex 4h subprocess wall**: codex CLI session ceiling kills long-running managers. `bf4a002` shipped auto-relaunch (≤5 retries) for `mux-runner.ts`. `microverse-runner.ts` was extended in v1.63.0 (T2 of overnight bundle, commit `c5cdb6e`).
- **Rule for prompt authors**: tier-aware iteration budgets. The default `claude:100, codex:80` is from v1.59.0 and assumes "extract one helper per ticket". For large/multi-helper tickets, raise per-ticket; for trivial, lower.

## 5. Codex tests are load-fragile

Wall-clock-bounded tests with `{ timeout: 15_000 }` flake when codex runs them concurrent with its own tool calls.

- v1.56.2 incident: 38 timing-sensitive tests bumped 3-5x to survive load. Verified under 2x concurrent runs.
- **Rule for test authors**: don't bound timing-sensitive tests to a tight ceiling. Either use deterministic mocks for time, or set the timeout high enough to absorb a 3x concurrency multiplier.

## 6. Worker isolation from `~/.codex/`

Codex picks up parallel-universe `~/.codex/skills/pickle*` registry files that misdirect mid-iteration with stale paths. The unblocker for the god-fn epic resume.

- **Mitigation now in place**: `--ignore-rules --ignore-user-config` added to `buildCodexInvocation` (v1.59.1).
- **Rule for prompt authors**: never assume the user's home-dir codex config is empty. Always pass these flags when spawning codex from pickle-rick.

## 7. Codex-required PRDs

Some pipelines (citadel + hardening bundle) are codex-required because they exercise codex-specific contract paths. AC-BUNDLE-18 (v1.62.x) added a frontmatter-driven check: `pipeline-runner` reads `backend: codex-required` from bundle PRDs at startup and rejects non-codex invocations with an actionable error.

- **Rule for PRD authors**: if a PRD is codex-required, set `backend: codex-required` in the frontmatter. Don't bury it in prose.

## 8. Behavioral changes worth flagging in release notes

- `max_iterations: 0` is valid in mux-runner (v1.59.x, commit `8105845`) — treated as "unlimited sentinel". Backward-compatible.
- Fractional numeric CLI flags now error (v1.59.x, commit `aba7369`) — was silent truncation via `parseInt`, now `Number.isInteger` rejects. Users round to whole numbers.

## 9. Iteration-completion reclassifier — detectManagerMaxTurnsExit (R-ICDM-1)

`mux-runner.ts` contains a claude-only reclassification path (line ~2582) that converts `completion: 'continue'` → `completion: 'error'` when `detectManagerMaxTurnsExit(...)` returns `true`. The helper is named for max-turns detection.

### Which call sites use this helper and why

| Site | File | Purpose | Semantics correct? |
|---|---|---|---|
| `~line 2139` | `mux-runner.ts:classifyManagerRelaunchExit` | Determine whether a manager's clean exit was caused by hitting the turn cap, to decide if the manager should be relaunched. | Intended use. Clean exit at `num_turns >= maxTurns` is a legitimate "relaunch" signal. |
| `~line 2582` | `mux-runner.ts:runIteration` reclassifier | Convert `continue` → `error` when claude finishes cleanly at the turn budget (to drive the relaunch path). | Correct post-R-ICDM-1. Pre-fix: the helper checked only `end_turn + completed + is_error=false`, which matches **every** cleanly-finished claude iteration, causing false reclassification. |

### Pre-fix bug (R-ICDM incident)

The line-1721 site was added to handle "claude hit the manager turn cap and exited cleanly, but with no promise token because the template forbids them." Without the `num_turns >= maxTurns` check, the helper returned `true` for every clean claude exit. Combined with `anatomy-park.md` and `szechuan-sauce.md` instructing workers to NOT emit promise tokens, every clean anatomy-park / szechuan-sauce iteration on claude backend was misclassified as `error`. Session `2026-05-13-e58dcc1d` hit this on iteration 1 (gap-analysis phase), tearing down the loop immediately.

### Post-fix contract

`detectManagerMaxTurnsExit(outcome, logFile, maxTurns: number | null)` now additionally requires `num_turns >= maxTurns`. `null` maxTurns → conservative `false`. Callers pass the real settings-derived budget. Templates emit `<promise>TASK_COMPLETED</promise>` at iteration end so the classifier can mark a clean boundary regardless of the reclassifier.

---

## Appendix: validation evidence — codex backend production-grade as of v1.59.1

| Metric | Pre-v1.59.x | Post-v1.59.1 |
|---|---|---|
| T1 outcome | Stalled at iter 5, **zero edits** in 50 min | Done in 14 min, 463 LOC + 116 LOC tests |
| Tickets shipped autonomously | 0 | 19 (T0–T19, god-fn epic) |
| Manual interventions during run | constant | zero |
| Wall time for full implementation phase | n/a (never finished) | 3h 41m |
| Self-correction commits | 0 | 2 (T3 complexity cleanup, T5 state-ownership fix) |

The 75-ticket Citadel + Hardening Bundle (v1.62.x) and the 9-ticket overnight bundle (v1.63.0) shipped on the same codex backend with the same prompt design rules above. The class is closed for now; reopen this file if a new failure mode surfaces.
