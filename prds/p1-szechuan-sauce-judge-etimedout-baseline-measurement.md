---
title: P1 — szechuan-sauce judge baseline-measurement deterministically ETIMEDOUTs on `spawnSync claude` × 4, breaks szechuan/plumbus/microverse iteration loops
status: Draft
filed: 2026-05-17
priority: P1
type: bug-infrastructure
finding: 47
code: R-SJET
related:
  - prds/p1-bug-fix-bundle-2026-05-08-mega.md  # R-MJCP origin (Finding #14, closed v1.73.0) — same family, different code path
  - prds/p1-szechuan-sauce-session-dir-firewall-conflict.md  # R-SSDF (Finding #46, filed 2026-05-17 AM) — sibling on same session, different layer
  - prds/p1-codex-manager-hallucinated-wedge-self-terminate.md  # R-CCPM-1b (Finding #45, filed 2026-05-17 AM)
  - prds/p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md  # R-CTSF (Finding #44, closed v1.75.2)
recurrence:
  - "2026-05-17 15:09:17Z — session 2026-05-17-0fca029f, szechuan-sauce run 1 on loanlight-api LOA-753 deslop. `measureLlmMetric` ETIMEDOUT × 4 attempts. 22m 4s wall, 1 iteration, exit_reason=judge_timeout. Worker DID iterate before the failure — produced partial `gap_analysis.md` (30 lines) and committed one slop fix `a6abeb8d1` on the LOA-753 branch (`payload.error` vs `payload.status` parsing in `comment-chat-panel.tsx`)."
  - "2026-05-17 15:42:35Z — same session relaunched after R-SSDF unblock. Same exact failure shape: `Resuming from failed state — resetting status to gap_analysis` → 4 attempts → ETIMEDOUT. 27m 0s wall, 1 iteration, exit_reason=judge_timeout. 27m vs 22m is per-attempt timing variance, not a different error class."
---

<!-- R-CTSF compliant -->

# R-SJET — szechuan-sauce judge baseline-measurement deterministically ETIMEDOUTs on `spawnSync claude` × 4

**Author**: pickle-rick session 2026-05-17 PM
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

## Symptom

szechuan-sauce / plumbus / microverse all share the same baseline-measurement path: after the worker completes its first iteration (gap-analysis), the runner calls `measureLlmMetricWithBackoff` → `measureLlmMetricAttempt` → `execFileSync('claude', [...])` to score the codebase against the goal. On this environment (2026-05-17, gregory@loanlight.com, macOS arm64, claude CLI installed and responding to `--version`), that spawn deterministically hangs and ETIMEDOUTs at the 180-second per-attempt cap, four times in a row, exhausting the backoff schedule and exiting with `exit_reason=judge_timeout`.

Two consecutive launches in the same session hit it identically — same 4 attempts, same exit reason, ~22-27 min wasted each.

### Verbatim runner log — run 1 (session `2026-05-17-0fca029f`, 22m 4s)

```
[2026-05-17T15:09:17.464Z] microverse-runner started
[2026-05-17T15:09:17.590Z] Starting gap analysis phase
[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=codex, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT
[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=codex, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT
[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=codex, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT
[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=codex, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT
[2026-05-17T15:31:22.045Z] ERROR: Could not measure LLM baseline (judge_timeout) after 4 attempt(s): spawnSync claude ETIMEDOUT
[2026-05-17T15:31:22.046Z] microverse-runner exit: judge_timeout (spawnSync claude ETIMEDOUT)
[2026-05-17T15:31:22.049Z] microverse-runner finished. 1 iterations, 22m 4s, exit: judge_timeout
```

### Verbatim runner log — run 2 (same session, 33 min later, 27m 0s)

```
[2026-05-17T15:42:35.167Z] microverse-runner started
[2026-05-17T15:42:35.254Z] Resuming from failed state — resetting status to gap_analysis
[2026-05-17T15:42:35.302Z] Starting gap analysis phase
[2026-05-17T16:09:35.783Z] ERROR: Could not measure LLM baseline (judge_timeout) after 4 attempt(s): spawnSync claude ETIMEDOUT
[2026-05-17T16:09:35.785Z] microverse-runner exit: judge_timeout (spawnSync claude ETIMEDOUT)
[2026-05-17T16:09:35.787Z] microverse-runner finished. 1 iterations, 27m 0s, exit: judge_timeout
```

This is a 100% reproducible failure on this environment. Not a flake. Not a one-off. Two clean launches, same failure, no environmental drift between them.

### Discriminator — anatomy-park works fine on the same branch

Same session morning: anatomy-park ran on the same LOA-753 branch (session `2026-05-17-e8cffa10`), converged cleanly in 6 iterations / 33m 48s, found 1 HIGH bug, fixed it, cataloged 1 trap door. Anatomy-park uses **worker-managed convergence** — the worker writes `anatomy-park.json` and the runner reads it. There is no LLM-judge baseline-measurement step. It never touches the broken code path.

The bug class is therefore: **LLM-judge-driven convergence modes only.** Every mode that calls `measureLlmMetricWithBackoff` (szechuan-sauce, plumbus, microverse) is broken on this environment until R-SJET lands. Every mode that doesn't (anatomy-park, pickle / pickle-tmux build phase) is unaffected.

### Important nuance — the worker DID produce work before the judge failed

Tempting to assume the whole iteration is dead. It isn't. The worker side ran first and made real progress on run 1:

- Read the LOA-753 PRD + contracts.
- Produced a partial `gap_analysis.md` — 30 lines, contract map of comment-chat slice, two dropped extraction candidates, a small violations section.
- Found a contract mismatch in `comment-chat-panel.tsx`: payload was being read as `payload.error` when the API contract returns `payload.status`.
- Fixed it and committed: `a6abeb8d1` on the LOA-753 branch (`gregory/loa-753-appraisal-free-form-textcomments`).

Then `executeGapAnalysis` (microverse-runner.ts:2180) called `measureLlmBaseline` (line 2216), which called `measureLlmMetricWithBackoff` (line 2144), which hit the broken `execFileSync('claude', …)` path and burned the next 22 minutes producing nothing.

The bug is structurally located **AFTER the worker's first iteration commits, INSIDE the baseline-score measurement, BEFORE the iteration loop can advance.** Subsequent iterations never start. The worker's good commit is in `git log` and would survive a rebase, but the iteration loop that would produce more such commits is dead.

## Root cause

The structurally-suspect call: `extension/src/bin/microverse-runner.ts:1589-1596`:

```typescript
try {
  const output = _deps.execFileSync(cmd, args, {
    cwd,
    timeout: timeout * 1000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...backendEnvOverrides('claude') },
  }).trim();
```

Three structural issues, ranked by likelihood:

### Hypothesis 1 (most likely): stdin pipe held open with no writer, claude CLI in non-interactive mode awaits stdin closure

`stdio: ['pipe', 'pipe', 'pipe']` opens a pipe for the child's stdin and never writes to it or closes it. Many CLI tools — claude included, in some invocation modes — read stdin until EOF before producing output, even when the prompt is supplied via `-p <prompt>`. With stdin held open by the parent and no `end()` call, the child waits forever, then the 180s per-attempt timeout fires.

`execFileSync` does not expose a way to close stdin separately; the fix is either `stdio: ['ignore', 'pipe', 'pipe']` (closes the descriptor immediately, child sees EOF on stdin) or replacing `execFileSync` with `execFile` (async) and explicitly `.stdin.end()` before awaiting.

This hypothesis is testable in 60 seconds: run `claude --allowedTools Read,Glob,Grep --no-session-persistence -p "echo ok" --add-dir <cwd>` from a shell where stdin is `/dev/null`. If the call returns promptly, hypothesis 1 is confirmed. The probe at `probeJudgeCliAvailability` (line 1631-1650) does NOT exercise this path — it only calls `claude --version`, which doesn't open the full prompt-processing pipeline, so the probe returns ok and the runner proceeds into the broken main spawn.

### Hypothesis 2: claude CLI in nested-claude context — auth state contention

If the operator is running this from inside a Claude Code session (the runner was launched as a tool call from a parent claude process), the spawned claude CLI may be probing for or contending with a parent session's auth state, terminal state, or tmux pane association. `--no-session-persistence` should defuse this but there is no positive integration test confirming it actually does. The `CLAUDE_CODE` / `CLAUDE_API_KEY` / `ANTHROPIC_API_KEY` env vars all pass through `backendEnvOverrides('claude')` unchanged (`backend-spawn.ts:485-488` only sets `PICKLE_BACKEND`), which means the parent's session state is leaking into the child.

This hypothesis is also testable: log the full inherited env at spawn time, diff against a known-good standalone-shell invocation.

### Hypothesis 3: output stream backpressure on long judge responses

`stdio: ['pipe', 'pipe', 'pipe']` with default high-water marks can cause the child to block on a full stdout buffer if the judge response is large and the parent doesn't drain it concurrently. `execFileSync` does drain stdout to a string, but the implementation buffers up to `maxBuffer` (default 1MB) and may stall if the child writes faster than the parent reads under certain libuv schedules. The 180-second timeout still fires, so this is observationally indistinguishable from hypotheses 1/2.

Less likely than hypothesis 1 — the judge prompt + response should be under 100KB for a small slice like comment-chat. But not impossible.

### Why R-MJCP (Finding #14, closed v1.73.0) doesn't cover this

R-MJCP closed the *misclassification* path: when the probe ETIMEDOUTs, classify it as `judge_timeout`, not as `judge_cli_missing`. That fix landed in `probeJudgeCliAvailability` (line 1645-1648 — the explicit "judge probe timed out … falling back to measurement loop" branch).

R-SJET is downstream of that fix: the probe returns `ok` (claude --version works), the runner enters the measurement loop, and **the measurement loop itself hangs the same way**. R-MJCP's diagnostic branch never runs because the failure is not in the probe, it's in the actual scoring call. The classification is correct (`failureKind: 'timeout'` at line 1610); the underlying spawn is just broken.

If you read the R-MJCP closure notes in v1.73.0 carefully ("Microverse judge probe ETIMEDOUT misclassification"), the closure scope was explicitly limited to misclassification. The underlying spawn-hang was left for a successor. R-SJET is that successor.

## Cost of the bug

| Metric | Value |
|---|---|
| Session `2026-05-17-0fca029f` run 1 wall | 22m 4s |
| Session `2026-05-17-0fca029f` run 2 wall | 27m 0s |
| Total wasted on this session alone | 49m 4s |
| Useful work landed before the hang | 1 commit (`a6abeb8d1`, comment-chat payload contract fix) |
| Iterations attempted | 2 (one per run; neither advanced past baseline) |
| Iterations completed | 0 (zero) |
| Tokens spent (worker side, run 1) | ~14k (worker did produce output) |
| Tokens spent (judge side, both runs) | unknown — claude CLI hung before any prompt was delivered or response received |
| Operator overhead | Session decode + this PRD; ~45 min |

The structural cost is broader than this one session:

- **Every LLM-judge-driven convergence mode is broken on this environment.** szechuan-sauce, plumbus, microverse all share the same `measureLlmMetricWithBackoff` path. The deslopping tool is the third phase of `/pickle-pipeline`, so the project's principal cleanup phase is dead.
- **R-SSDF (Finding #46, sibling bug filed earlier today) breaks the codex-worker side of szechuan-sauce on firewalled repos.** R-SJET breaks the claude-judge side regardless of repo. Both have to land before szechuan-sauce can run end-to-end again.
- **The 4-attempt × 180s = 12 min minimum failure latency is operationally toxic.** Operators see the runner working, watch it for 10-15 min, then it dies. That's the worst failure mode — long enough to look like progress, short enough that retrying is tempting, deterministic enough that retrying is hopeless.
- **Working Rule 1 ceiling breached.** Open P1 count: B-QSRC + B-CCPM-1b + B-SSDF + B-SJET = 4 open P1 bundles vs ≤3 ceiling. Operator triage required before queueing more.

## Why it matters specifically now

- **szechuan-sauce is the project's principal deslopping tool.** Without it, the `/pickle-pipeline` third phase is dead, anatomy-park is the only cleanup phase, and szechuan-style violation-ledger judging is offline indefinitely.
- **Two consecutive PRDs filed today** target failure modes on the same szechuan-sauce session: R-SSDF (codex-worker side, firewall conflict) and R-SJET (claude-judge side, spawn timeout). Both must ship before szechuan-sauce is functional again on codex-backend repos.
- **B-CTSF and B-CCPM-1b already queued P1.** With B-SJET pushing the queue to **4 open P1 bundles** (B-QSRC + B-CCPM-1b + B-SSDF + B-SJET), the queue is **over the ≤3 ceiling stated in Working Rule 1**. Per that rule, operator must triage before new features or non-P1 bundles can be queued. Recommend operator launch B-SJET first — broadest impact (all LLM-judge modes), most-deterministic failure, least dependencies.
- **The worker side IS still working.** This bug is unusual in that the worker can land useful commits before it fires. If we leave it unfixed, operators will accidentally accumulate single-commit szechuan slop fixes that look like progress, miss the iteration-loop death, and ship partial slop cleanups. Cleaner to fix the iteration loop than to rely on the operator catching the silent-stop.
- **Anatomy-park escapes**, which means operators can route around this with `/pickle-pipeline --skip-szechuan-sauce` or `/anatomy-park <prd>` directly. But that's a workaround, not a fix, and anatomy-park doesn't perform szechuan's specific work (allowlist-driven slop violation scoring).

## Reproducer

1. Any repo with a `prd.md` and a non-trivial slice to score. (Use `loanlight-api` LOA-753 if available; any sufficiently-sized monorepo PRD works.)
2. Fresh session:
   ```bash
   /szechuan-sauce <prd-path>
   ```
   or via the pipeline:
   ```bash
   /pickle-pipeline <prd-path> --skip-pickle --skip-anatomy-park
   ```
3. Watch the runner log. After the worker's gap-analysis iteration completes (~5-10 min), the baseline-measurement phase begins. Within 12-13 minutes of that point, the runner exits with `exit_reason=judge_timeout` and 4 stderr `[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=*, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT` lines.

Total observed time-to-failure: ~22-27 min from runner start. Lower bound: ~17 min (10s+30s+60s backoff + 4×180s timeout + worker iteration). Upper bound: variable per environment, capped by the worker iteration's own timeout.

The fastest available reproducer is a script that bypasses the worker iteration and invokes `measureLlmMetric` directly:

```bash
node --input-type=module -e "
  import { measureLlmMetric } from '$HOME/.claude/pickle-rick/extension/bin/microverse-runner.js';
  const start = Date.now();
  const result = measureLlmMetric(
    'echo back the literal string \"hello\" and a numeric score',
    180,
    process.cwd(),
    'claude-sonnet-4-6',
    [],
    undefined,
    undefined,
    'claude',
    [],
  );
  console.log('result:', result, 'elapsed_ms:', Date.now() - start);
"
```

Expected on broken environment: hangs 180s, then ETIMEDOUT. Expected after R-SJET-1: returns within 30s with a real score, OR errors cleanly within the configured timeout.

## Proposed fix (R-SJET-1..6, ranked bandage → structural)

### R-SJET-1 — Close stdin on the judge spawn (`stdio: ['ignore', 'pipe', 'pipe']`)

Edit `microverse-runner.ts:1594` and `microverse-runner.ts:1638` to use `stdio: ['ignore', 'pipe', 'pipe']` instead of `stdio: ['pipe', 'pipe', 'pipe']`. The prompt is already passed as a CLI arg via `-p <prompt>`; nothing is ever written to the child's stdin, so closing it immediately should be safe and should defuse hypothesis 1 (the most likely cause).

**Effort**: ≤30 min (1-line change × 2 call sites + 1 unit test confirming stdio shape).
**Class**: bandage. Doesn't fix the structural design of using sync spawn for a 180-second LLM call, but if hypothesis 1 is correct it ends the production failure today.
**Risk**: Low. If hypothesis 1 is wrong, this is a no-op; the call still ETIMEDOUTs. Worth shipping regardless because `['pipe', 'pipe', 'pipe']` with no writer is a footgun and should not be in the codebase.

### R-SJET-2 — Replace `execFileSync` with async `execFile` + Promise.race against a hard timer

`execFileSync` is the wrong primitive for a multi-minute LLM call. Switch to `execFile` (Node's promisified `child_process.execFile`) and race the resulting promise against a hard timer. On timer expiry, send SIGTERM, then SIGKILL after a 2s grace, and reject with a `JudgeMeasurementTimeout` typed error that is distinct from `JudgeCliMissing` (R-MJCP's residual ambiguity).

Update:
- `extension/src/bin/microverse-runner.ts:1558` — `measureLlmMetricAttempt` becomes async; the call to it in `measureLlmMetric` (line 1503) and `measureLlmMetricWithBackoff` (line 1681) becomes `await`.
- New typed error classes for `JudgeMeasurementTimeout` and `JudgeMeasurementSpawnFailed`.
- `classifyJudgeError` (line 1552) updated to recognize the new error classes by `instanceof`, not just by stringy regex on `.message`.

**Effort**: ≤1h (call-site changes are mechanical; the test surface changes only in failure-class assertions).
**Class**: structural. Replaces the wrong primitive with the right one and improves classification simultaneously.

### R-SJET-3 — Detect nested-claude context and route the judge through a different path

When `process.env['CLAUDE_CODE']` is set (or `ANTHROPIC_API_KEY` is present and `CLAUDECODE` markers are visible), the runner is executing inside a Claude Code session. In that case, the spawned `claude` CLI is contending with the parent's auth/session state and is more likely to hang. Route the judge through one of:

a) Anthropic API direct (using `@anthropic-ai/sdk` via Node — no CLI shell-out, no auth contention).
b) Sub-process with explicit auth-isolation env (`CLAUDE_CODE=` empty, fresh `XDG_RUNTIME_DIR`, fresh tmp `HOME`).
c) Codex CLI as the judge backend (claude-sonnet-4-6 not supported on ChatGPT codex per existing comment at line 1570; but Anthropic codex / OpenRouter codex models can score).

Update:
- `extension/src/services/judge-spawn-env.ts` (new) — `buildJudgeEnv(backend, isNested)` returns an env override map.
- `extension/src/bin/microverse-runner.ts:1581` — call `buildJudgeEnv` and pass result to spawn options.

**Effort**: ≤2h.
**Class**: structural. Removes the most-likely class of intermittent hang (parent-session auth contention).

### R-SJET-4 — Add `judge_backend: 'claude' | 'codex' | 'auto'` config

Today the judge is hardcoded to `'claude'` at `microverse-runner.ts:1581` (`buildJudgeInvocation('claude', …)`), with a code comment explaining that codex on ChatGPT accounts rejects `claude-sonnet-4-6`. That assumption may be obsolete (Codex API now supports anthropic-passthrough models on some providers) and is structurally too rigid: when claude spawn is broken, the operator has no escape hatch.

Expose `judge_backend` as a config in `pickle_settings.json`:

```json
{
  "microverse": {
    "judge_backend": "auto",
    "judge_backend_fallback": "codex",
    "judge_model_claude": "claude-sonnet-4-6",
    "judge_model_codex": "gpt-5.4"
  }
}
```

`'auto'` tries claude first; on R-SJET-2's typed `JudgeMeasurementTimeout` or `JudgeMeasurementSpawnFailed` from the first attempt, switches to `judge_backend_fallback` for subsequent attempts and emits an event. `'claude'` and `'codex'` are explicit pins.

Update:
- `extension/src/services/pickle-settings.ts` — schema + defaults.
- `extension/src/bin/microverse-runner.ts:1581` — replace the hardcoded `'claude'` with `resolveJudgeBackend(settings, attemptNumber, lastFailure)`.
- `extension/src/services/backend-spawn.ts:433` — `buildJudgeInvocation('codex', ...)` already exists (lines 452-479); wire it through.
- New tests: judge_backend resolution under each mode + auto-fallback behavior.

**Effort**: ≤1h.
**Class**: structural escape hatch. Operators can route around environment-specific claude-spawn brokenness without code changes.

### R-SJET-5 — Improve telemetry on the judge spawn

Today the only diagnostic on failure is the single stderr line `[microverse] measureLlmMetric failed (judge_backend=claude, session_backend=X, model=Y): spawnSync claude ETIMEDOUT`. That tells the operator *what* failed but nothing about *why*. Future occurrences should be diagnosable in seconds, not by re-reading a 22-minute log.

Add structured telemetry:
- Pre-spawn: log `cmd`, `args` (with prompt body redacted to first 200 chars), full env keys (values redacted), `cwd`, `timeout_ms`, `stdio` configuration.
- Mid-spawn: every 30s, log child PID + `kill -0` liveness + observed stdout/stderr byte count.
- On timeout: log captured stdout bytes, captured stderr bytes (in full — claude often emits diagnostic info to stderr that we discard today), child PID, time to first stdout byte (if any).
- All events go to `<session-dir>/judge_spawn_debug.ndjson`.

Update:
- `extension/src/bin/microverse-runner.ts:1558-1612` — instrumentation wrapper around the spawn.
- `extension/src/services/judge-telemetry.ts` (new) — NDJSON writer + redaction helpers.

**Effort**: ≤1h.
**Class**: future-proofing. Doesn't fix the bug but makes the next variant of this bug 10× cheaper to diagnose.

### R-SJET-6 — Integration test against a mocked-hanging claude binary

Create a test that simulates the failure mode: substitute a fake `claude` binary that sleeps indefinitely on stdin, and assert that `measureLlmMetricWithBackoff` returns a clean `judge_timeout` failure within 30s (not 12 minutes — because the test should configure shorter per-attempt timeouts) with the right exit-reason classification.

Update:
- `extension/tests/integration/judge-spawn-timeout.test.js` (new).
- `extension/tests/fixtures/bin/fake-claude-hang.sh` — shell script that `sleep infinity`s on stdin read, ignores SIGTERM (forces SIGKILL escalation), writes nothing to stdout.
- Test harness uses `process.env.PATH` override to inject the fake binary; restores PATH on teardown.
- Asserts:
  - Total elapsed ≤ 30s under configured short timeouts.
  - Returned `exitReason === 'judge_timeout'`.
  - Returned `exhaustedFailureKind === 'timeout'`.
  - Telemetry NDJSON exists and contains 4 spawn-attempt records.

**Effort**: ≤1h (after R-SJET-1..5).
**Class**: regression prevention.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-SJET-01 | `measureLlmMetricAttempt` and `probeJudgeCliAvailability` both spawn `claude` with `stdio[0] === 'ignore'`. | grep on `extension/src/bin/microverse-runner.ts` finds no `stdio: ['pipe', 'pipe', 'pipe']` in either function; replaced by `stdio: ['ignore', 'pipe', 'pipe']`. |
| AC-SJET-02 | `measureLlmMetric` returns null with `failureKind: 'timeout'` within `(timeoutSeconds * 1000) + 2000` ms on a hung child process. | Integration test `judge-spawn-timeout.test.js` against a fake-claude-hang binary measures elapsed; assertion `elapsed < per_attempt_timeout_ms + 2000`. |
| AC-SJET-03 | `JudgeMeasurementTimeout` and `JudgeMeasurementSpawnFailed` are distinct typed error classes; `classifyJudgeError` returns the correct kind by `instanceof` check (not by regex on `.message`). | Unit test on `classifyJudgeError` with both error class instances + a control `ENOENT` instance. |
| AC-SJET-04 | `pickle_settings.json` accepts `judge_backend: 'claude' | 'codex' | 'auto'` and `judge_backend_fallback` keys; `'auto'` falls back to the fallback backend on first attempt's typed timeout. | Integration test runs the runner with `judge_backend: 'auto'` against fake-claude-hang; asserts second attempt uses codex (not claude) and emits a `judge_backend_fallback_engaged` event. |
| AC-SJET-05 | When `judge_backend: 'auto'` falls back to codex and codex succeeds, the runner records `judge_backend_used: 'codex'` in the iteration history entry. | Integration test asserts `history[0].judge_backend_used === 'codex'` in the microverse state after a successful fallback iteration. |
| AC-SJET-06 | `<session-dir>/judge_spawn_debug.ndjson` exists after a judge spawn attempt (success or failure) and contains a `spawn_start` event with redacted env keys + `spawn_end` event with elapsed_ms + final stdout/stderr byte counts. | Integration test reads NDJSON, asserts shape. |
| AC-SJET-07 | The reproducer command from § Reproducer (direct `measureLlmMetric` invocation node one-liner) returns a result (success OR clean failure within ≤30s under `PICKLE_JUDGE_PROBE_TIMEOUT_MS=5000` and `DEFAULT_JUDGE_TIMEOUT=10` test config) — does NOT hang for 180s. | Manual operator validation pre-close, logged in `prds/p1-szechuan-sauce-judge-etimedout-baseline-measurement.md` post-validation gaps. |

## Bundle sizing

**Single-PRD bundle. ≤6 atomic + 4 hardening. ≤4-6h codex.**

Sequencing in the bundle PRD:
- R-SJET-1 first (≤30 min, lowest blast radius — 1-line stdio change × 2 call sites).
- R-SJET-2 (≤1h, async spawn + typed errors — depends on R-SJET-1 landing cleanly).
- R-SJET-5 (≤1h, telemetry — can run in parallel with R-SJET-2 if a second worker is available; otherwise serial).
- R-SJET-4 (≤1h, judge_backend config — depends on R-SJET-2's typed errors for fallback trigger).
- R-SJET-3 (≤2h, nested-claude env isolation — depends on R-SJET-2 + R-SJET-4 for fallback path).
- R-SJET-6 (≤1h, integration test — depends on R-SJET-1..5).

Hardening tickets (3-4):
- Lint + typecheck + `npm run test:fast` after each implementation ticket (worker-gate compliant).
- Conformance docs per R-code (R-CTSF compliant; closer-owned residuals tagged `[manager]`).
- Documentation: `docs/judge-spawn-troubleshooting.md` describing the failure mode + telemetry NDJSON schema + how to diagnose future variants in seconds.
- Manager-owned closer (version bump, install.sh, MASTER_PLAN edit, gh release) — NOT in worker scope per R-CTSF.

## Out of scope

- **Fixing R-SSDF (Finding #46, codex-worker session-dir firewall conflict).** Already filed today; lives in `prds/p1-szechuan-sauce-session-dir-firewall-conflict.md`. R-SJET and R-SSDF are independent — R-SJET fires regardless of repo firewall, R-SSDF fires only on firewalled repos and only on codex-worker side. Both must ship to make szechuan-sauce healthy end-to-end on the LOA-753 environment.
- **Fixing R-CCPM-1b (Finding #45, codex manager hallucinated wedge).** Already filed today; lives in `prds/p1-codex-manager-hallucinated-wedge-self-terminate.md`. Different layer (manager kills its own healthy mux-runner via SIGTERM); unrelated to judge spawn.
- **R-MJCP successor for the probe path.** R-MJCP closed in v1.73.0 covered the probe ETIMEDOUT misclassification. The probe is currently functional (`claude --version` returns ok); R-SJET only touches the measurement path. If a future occurrence exhibits a hung probe, file a separate R-MJCP-3 PRD against `probeJudgeCliAvailability`.
- **Refactoring `measureLlmMetricWithBackoff`'s 4-attempt schedule.** Current schedule (immediate + 10s + 30s + 60s × 180s per attempt) burns ~12 min on a deterministic hang. R-SJET-2 + R-SJET-4 fix the per-attempt hang and add a fallback path; once the per-attempt class is fast-fail, the 4-attempt schedule becomes a non-issue. Don't co-touch the schedule in this bundle.
- **Switching to Anthropic API direct as the default judge path.** Hypothesis 3 of R-SJET-3 implies the structurally-cleanest fix would be to drop the CLI shell-out entirely and call the API directly. That's a larger surgery (auth, retry/backoff at the API level, rate-limit handling, streaming) and should be its own design PRD. R-SJET keeps the CLI path and patches its symptoms.

## Related findings / bundles

- **Finding #14 R-MJCP** (closed v1.73.0). Microverse judge probe ETIMEDOUT *misclassification*. Same family, different code path: R-MJCP fixed the probe's classification, R-SJET fixes the measurement spawn's hang. R-SJET could be coded as `R-MJCP-2` if we prefer continuity; using a new R-code keeps the bug's distinct shape visible in the queue.
- **Finding #46 R-SSDF** (filed 2026-05-17 AM). Sibling on the same session. Codex-worker session-dir firewall conflict. Independent of R-SJET; both must ship before szechuan-sauce can run end-to-end on the LOA-753 environment.
- **Finding #45 R-CCPM-1b** (filed 2026-05-17 AM). Codex manager hallucinated wedge. Same morning, same session, different layer. Defensible to bundle thematically under "codex-backend compatibility hardening" but easier to ship as independent P1s.
- **Finding #44 R-CTSF** (closed v1.75.2). Established the closer-ownership-tag pattern that R-SJET inherits: manager-owned residuals (version bump, install.sh, MASTER_PLAN edit, release) are tagged `[manager]` and excluded from worker AC evaluation.
- **Working Rule 1** (`MASTER_PLAN.md` § Working Rules). Bugs first. Open P1 ceiling ≤3; with R-SJET this filing pushes the queue to **4 open P1 bundles** (B-QSRC + B-CCPM-1b + B-SSDF + B-SJET), over the ceiling. Operator triage required.

## Post-validation gaps

To resolve before closing this PRD (the bundle that ships R-SJET should answer these or file successors):

1. **Does the same ETIMEDOUT × 4 fire on plumbus and microverse modes?** Both call `measureLlmMetricWithBackoff` at the same line in the same file; the bug is presumed shared. Confirm by triggering each mode on the same broken environment after R-SJET-1 lands (should pass) and on a pre-R-SJET-1 commit (should fail identically).
2. **Is `claude-sonnet-4-6` a valid model ID against the current claude CLI?** Run `claude --model claude-sonnet-4-6 -p "echo ok"` from a fresh shell. If the CLI rejects the model ID with a fast error, the ETIMEDOUT is not the spawn-hang it appears to be — it's a slow rejection. Less likely (180s for a rejection is excessive) but worth verifying at close time.
3. **Should the judge default to `'auto'` instead of `'claude'`?** R-SJET-4 introduces the config. Decision: ship with `'claude'` default to preserve current behavior, document `'auto'` as the operator-recommended setting in `docs/judge-spawn-troubleshooting.md`. Revisit after 30 days of telemetry from R-SJET-5.
4. **Does the spawn hang reproduce on a fresh claude CLI install (no nested-claude context, no parent session state)?** If hypothesis 2 is correct, a fresh install in a clean shell should succeed. Confirm at close time.
5. **What's the per-attempt timeout that real-world judge calls actually need?** `DEFAULT_JUDGE_TIMEOUT = 180s` (line 1283). Anthropic claude-sonnet-4-6 typically returns within 30-60s for prompts of this size; 180s is generous. Once R-SJET ships, log p50/p95/p99 of successful judge call durations and right-size the default.
6. **Does R-SJET-3's `CLAUDE_CODE=` env-strip interact badly with claude's auth resolution?** If the operator's `~/.claude/credentials.json` is needed and the env-strip blocks it, the judge spawn might fail with auth errors instead of timeouts. Confirm telemetry captures the auth-error case distinctly.
7. **Should pickle-rick's runtime expose a `pickle-rick judge-health-check` CLI** that runs the reproducer end-to-end and reports pass/fail in <60s? Useful for operators diagnosing this bug class without re-reading PRDs. File as P3 follow-up if there's appetite.

## Post-Filing Observations (2026-05-17 PM — claude-backend retry)

After this PRD was filed, the operator re-ran szechuan-sauce on the same LOA-753 branch with the same scope.json (91 paths) and the same target, but flipped the worker backend from codex to claude (`--backend claude`). The hypothesis going in was "the judge always hangs"; the observed result is meaningfully more nuanced.

### Session: `2026-05-17-902b9155` (claude-backend retry)

The judge did NOT fail consistently — it succeeded once before failing. Timeline:

- `19:00:06Z` microverse-runner started, gap analysis phase started.
- `19:28:56Z` LLM baseline metric: 9 (succeeded — **28m 50s elapsed for baseline**).
- `19:28:56Z` Gap analysis complete — transitioning to iterating.
- `19:28:56Z` Iteration 2 began.
- Worker iter 2 ran, fixed a P2 dead-code finding, committed `a9c0038eb szechuan-sauce: YAGNI — drop dead AbortController in startCommentChatStream`.
- `20:02:20Z` ERROR: Metric measurement failed (judge_timeout) after 4 attempt(s): spawnSync claude ETIMEDOUT.
- `20:02:20Z` microverse-runner finished. 2 iterations, 62m 13s, exit: judge_timeout.

So iter-1 baseline succeeded (slow, 28+ min). Iter-3 baseline (post-iter-2 fix) hit the same ETIMEDOUT × 4 we saw in the original observation.

### Cross-session pattern — backend modulates judge spawn success

| Session | Worker backend | Iter-1 baseline | Iter-N>1 baseline | Notes |
|---|---|---|---|---|
| `2026-05-17-0fca029f` run 1 | codex | ETIMEDOUT × 4 | never reached | 22m 4s wall, 0 baseline measurements |
| `2026-05-17-0fca029f` run 2 | codex | ETIMEDOUT × 4 | never reached | 27m 0s wall, 0 baseline measurements |
| `2026-05-17-902b9155` | claude | succeeded, 28m 50s | ETIMEDOUT × 4 at iter-3 | 62m 13s wall, 1 baseline measurement, 1 commit |

Codex worker → judge fails 100% at baseline 1. Claude worker → judge succeeds at baseline 1 (slowly), fails at baseline N>1. This shifts the bug shape from "deterministic spawn-hang" to "intermittent spawn-hang modulated by worker-backend identity and/or parent-process lifetime."

### Significance

1. **H1 (stdin pipe held open) is still the most likely root cause, but it needs a sub-hypothesis H1b.** The intermittent flavor of the hang is compatible with H1 if the pipe-hold only races into a hang under certain parent-process states — e.g., when the parent claude session has been running long enough to consume some shared resource (file descriptors, posix-spawn slot, libuv thread pool), or when sibling claude processes have polluted shared XDG/cache state. H1 alone explains "always hangs"; H1b explains "sometimes hangs, more often as the parent ages." Both can be true; R-SJET-1's stdin-close fix is still load-bearing.

2. **H2 (nested-claude auth contention) gains evidence from the claude-worker case.** When the worker IS claude, the judge spawn is a claude-spawning-claude-spawning-claude tower (operator's claude session → mux-runner → microverse-runner → judge `claude` CLI). The claude-worker case failed at iter N>1 — i.e., after the tower had been standing for >30 min. The codex-worker case failed at iter 1 — i.e., when the tower is two levels shorter but still nested. Both fail; the claude case fails later. Consistent with "auth/session contention compounds with depth and age."

3. **The judge spawn is intermittent, not deterministic.** The R-SJET fix must handle BOTH "first spawn hangs" AND "Nth spawn hangs after parent claude has been running for >30 min." R-SJET-1's stdin-close addresses the always-hang shape; R-SJET-3's nested-claude env isolation addresses the compounds-with-age shape; R-SJET-4's `judge_backend: 'auto'` fallback addresses the "we can't predict which spawn will hang, so we need an escape hatch."

4. **The 28-minute "successful" baseline is itself anomalous.** Claude CLI startup should be <5 seconds, not 30 minutes. A successful judge call returning a score of 9 in 28m 50s is not "healthy" — it's "barely-not-timed-out." Something structurally wrong is happening even when the spawn appears to work. R-SJET-5's mid-spawn telemetry (PID liveness + 30s output sampling) should make this diagnosable when it next happens.

### Useful additional observation — judge breakage doesn't prevent point fixes

Despite the judge breaking on iter 3, this szechuan-sauce run DID produce real engineering value before it died:

- **1 commit landed** (`a9c0038eb szechuan-sauce: YAGNI — drop dead AbortController in startCommentChatStream`) on the LOA-753 branch.
- **Full 125-line `gap_analysis.md` written** — contract map, Override 4/5/6 results (all PASS), 3 remaining P3 findings catalogued at confidence 80-85.
- 0 P0/P1/P2 findings remained after the iter-2 fix; only 3 surgical P3s.

The judge is structurally downstream enough that worker iterations CAN produce real value before the judge dies. The bug breaks the CONVERGENCE LOOP (we can no longer measure whether we're done), but it doesn't prevent the worker from making point fixes. Today the runner treats any baseline-measurement failure as a runner-level fatal exit, which discards subsequent iterations and (worse) makes operators distrust the commits the worker DID land.

### New candidate fix — R-SJET-7

**R-SJET-7 — Continue iterating with `convergence_not_measurable` marker when the judge times out.**

Today, when `measureLlmMetricWithBackoff` exhausts its 4 attempts, the runner exits with `exit_reason=judge_timeout` and the iteration loop terminates. The worker's prior iteration commits are preserved in git (they're not reverted) but no further iterations run, even though the worker side is structurally healthy.

Proposed behavior: when baseline measurement fails after R-SJET-2's typed timeout, the runner should:
- Record `convergence_status: 'unmeasurable_due_to_judge_timeout'` in the iteration history entry.
- Treat the failed measurement as a "fix-only" iteration boundary — worker still produces commits, but the convergence delta-threshold check is skipped for this iteration.
- Continue to iteration N+1 with the same fix-only semantics.
- Only halt the runner when (a) the worker itself reports no findings (`gap_analysis.findings_remaining === 0`), (b) the runner hits its configured `stall_limit`, or (c) the operator interrupts.
- Emit a `judge_unmeasurable_iteration_continued` event at iteration boundary so operators can see the degraded mode in the runner log.

Update:
- `extension/src/bin/microverse-runner.ts:1681` (`measureLlmMetricWithBackoff`) returns the typed-timeout result without throwing.
- `extension/src/bin/microverse-runner.ts:2216` (`measureLlmBaseline` callers) check for the typed-timeout return shape and route to the fix-only branch instead of the exit branch.
- `extension/src/services/pickle-settings.ts` — new boolean `microverse.continue_on_judge_timeout` (default `true` per acceptance criteria below; operators can pin `false` to preserve old fail-fast behavior).
- Iteration history schema gains `convergence_status` string field.

**Acceptance**: AC-SJET-08 — judge ETIMEDOUT after iteration N does NOT discard the iteration N commit or terminate the runner. Runner records `convergence_status: 'unmeasurable_due_to_judge_timeout'` in the iteration history entry and continues to iteration N+1. Integration test: fake-claude-hang binary returns timeout on baseline calls; assert (a) iteration N commit survives in git log, (b) `state.json` shows iteration N+1 started, (c) runner only exits when worker reports zero remaining findings.

**Effort**: ≤1h (decoupling baseline-measurement failure from iteration-loop termination is structurally cleaner than the current coupling; the wiring change is small).
**Class**: structural. Removes the strongest amplifier of this bug class — the operator-trust regression where "judge hung → I doubt the worker's commits."
**Depends on**: R-SJET-2 (typed timeout error class is the signal that distinguishes "judge unmeasurable" from "judge fundamentally broken — abort").

## Trap doors

Each ticket's `conformance_*.md` MUST include explicit evidence for:
- R-SJET-1: grep on `microverse-runner.ts` finds zero `stdio: ['pipe', 'pipe', 'pipe']` occurrences in judge spawn paths; both relevant lines (1594, 1638) updated.
- R-SJET-2: typed-error unit test passes; `classifyJudgeError` uses `instanceof` branches before falling back to regex.
- R-SJET-3: env-isolation test confirms `CLAUDE_CODE` is stripped from spawn env when nested-claude context detected; clean-shell control confirms env is preserved otherwise.
- R-SJET-4: `pickle_settings.json` schema accepts `judge_backend: 'auto'`; integration test confirms fallback path engages on first-attempt typed timeout.
- R-SJET-5: `judge_spawn_debug.ndjson` schema documented in `docs/judge-spawn-troubleshooting.md`; integration test asserts NDJSON shape.
- R-SJET-6: integration test runs in CI under `npm run test:fast` (or `npm run test:integration` if too slow for fast tier); asserts ≤30s total elapsed under short-timeout config.
