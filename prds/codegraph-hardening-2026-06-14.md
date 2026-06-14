# Codegraph Hardening → Default-On (B-CGH) — 2026-06-14

**Status:** PLAN — refine + build via `/pickle-pipeline` in a FRESH session (clear context first).
**Goal:** harden the v2.0 codegraph integration so it can ship **default-ON** with confidence — fix the one known flake, instrument it for efficacy, validate efficacy with a controlled A/B, then flip the default.
**Backend:** claude (control-flow + settings + test edits; not codex).

## Why now

Codegraph (`@colbymchenry/codegraph@0.9.9`) shipped in **v2.0.0-beta.3** and is **genuinely wired** but **default-OFF and never exercised in a real pipeline** — so its efficacy is unproven and one path flakes. This bundle makes it production-ready, then turns it on.

**Current wiring (HEAD-verified 2026-06-14):**
- `extension/src/bin/setup.ts:198` `runCodegraphIndexAtSetup` — indexes the repo at session start; early-returns unless `enabled && index_at_setup`; call-site `setup.ts:1698` is try/catch fail-open (never blocks launch); honors `PICKLE_CODEGRAPH=off`.
- `extension/src/bin/spawn-morty.ts:717` `buildCodegraphContextSection` — derives terms from ticket title/content, ranks graph hits, injects a `## Code Graph Context` block into the worker prompt (non-trivial tiers only, capped at `context_max_bytes`); **never throws** (returns `''` on disabled/degraded/zero-hits).
- `extension/src/services/backend-spawn.ts:~454` — wires a `codegraph serve --mcp` MCP server for workers when `expose_mcp_to_workers`; single-writer discipline (C7).
- `extension/src/services/pickle-utils.ts:794` `resolveCodegraphSettings` — compiled defaults (`enabled:false`, `index_at_setup:false`, `expose_mcp_to_workers:false`).
- Operator config: `pickle_settings.json:codegraph` (same defaults).
- Observable events: `codegraph_index_built` / `codegraph_index_failed` / `codegraph_degraded` / `codegraph_sync_completed` / `codegraph_session_summary` — all **functional** telemetry; **none measures efficacy**.

## Workstreams

### CGH-1 — Stabilize the C0 `serve --mcp` handshake flake (P1, the default-on blocker)
The `C0: serve --mcp stdio handshake` test (`extension/tests/integration/codegraph-real-index.test.js`) **passes in isolation but times out at 60s under expensive-tier parallel load** — the B-RRH **E9a** "serialize codegraph handshake" finding, still unshipped. This is the #1 reason `expose_mcp_to_workers` can't go on by default.
- **AC-CGH-1-1:** add the codegraph handshake/real-index tests to `extension/tests/integration/.serial-tests.json` (with a reason in `.serial-tests.reasons.json`); `audit-test-isolation.sh` passes.
- **AC-CGH-1-2:** widen the handshake `spawnSync` timeout to comfortably exceed the index/handshake budget under serial run; the test is green 5/5 in the expensive tier.
- **AC-CGH-1-3:** the `codegraph serve --mcp` startup has a bounded retry/backoff so a slow first-handshake degrades to `codegraph_degraded` (fail-open) rather than hanging a worker.

### CGH-2 — Efficacy instrumentation (P1, prerequisite for measurement)
There is **no event tying what-got-injected to outcomes**. Add it.
- **AC-CGH-2-1:** new activity event `codegraph_context_injected` (add to `VALID_ACTIVITY_EVENTS` in `types/index.ts` + `activity-events.schema.json`) emitted by `buildCodegraphContextSection` with payload `{ticket, tier, terms_count, hits_count, bytes, build_ms }`; and `codegraph_context_skipped` with `{reason: disabled|non_graph_tier|no_terms|zero_hits|degraded}`.
- **AC-CGH-2-2:** every early-return branch in `buildCodegraphContextSection` emits the skip event with the correct reason (one fixture per branch).

### CGH-3 — Efficacy A/B harness + measurement (P1, the actual validation)
A controlled on/off comparison — **tests prove it runs; this proves it helps.**
- **AC-CGH-3-1:** a `bin/codegraph-efficacy-probe.js` low-variance harness: for a fixed set of real tickets, build the worker prompt WITH and WITHOUT the `## Code Graph Context` section, run the worker on both, and score the diffs for (a) refs that don't resolve at HEAD (hallucination), (b) whether the right consumer files were touched, (c) gate-pass. Emits a per-ticket `codegraph_efficacy_sample`.
- **AC-CGH-3-2:** a documented full-pipeline A/B protocol (same bundle, same baseline, on vs off) keying on the existing substrate — activity events (`path_not_verified` / readiness false-positives / no-progress), `pickle-metrics` (tokens/wall-clock), citadel + anatomy-park finding counts, closer sibling-test-drift count — with a results template.
- **AC-CGH-3-3:** run the probe on ≥5 cross-file-heavy tickets (e.g. the R-DSAN W3/W4 consolidation tickets) and record a baseline efficacy delta in `prds/research/codegraph-efficacy-baseline.md`.

### CGH-4 — Index-at-setup cost + staleness correctness (P2)
Index-at-setup runs on **every** launch (`index_timeout_ms: 120000`). Measure and bound it.
- **AC-CGH-4-1:** capture actual index/sync wall-time in `codegraph_index_built` payload; confirm `cgResolveIndexAction` reuses a fresh `.codegraph/codegraph.db` (staleness `30min`) so warm launches are `noop`/`sync`, not full re-index.
- **AC-CGH-4-2:** a launch-latency regression asserting a warm-cache resume does not pay a full index.
- **AC-CGH-4-3:** verify the C7 single-writer `sync` discipline holds across two concurrent sessions on the same repo (no `.codegraph/codegraph.db` corruption).

### CGH-5 — Graceful-degradation hardening (P2)
Default-on means failures must NEVER block a launch or a worker.
- **AC-CGH-5-1:** index failure / binary-unresolvable / `serve --mcp` merge-fail all emit `codegraph_degraded` and continue (setup completes, worker spawns with no `## Code Graph Context`); one fixture per failure mode.
- **AC-CGH-5-2:** `PICKLE_CODEGRAPH=off` fully short-circuits every path (kill-switch trap door).

### CGH-6 — Flip the default ON (P1, the finish line — gated on CGH-1..5 green)
- **AC-CGH-6-1:** `resolveCodegraphSettings` compiled defaults → `enabled:true`, `index_at_setup:true`; **`expose_mcp_to_workers` stays `false`** until CGH-1 proves the MCP server stable under load (separate follow-up flip).
- **AC-CGH-6-2:** `pickle_settings.json:codegraph` mirrors the new defaults.
- **AC-CGH-6-3:** update `codegraph-settings.test.js` `DEFAULTS` + all resolver merge tests + `extension/CLAUDE.md` settings table + `extension/src/bin/CLAUDE.md` to the new defaults.
- **AC-CGH-6-4:** a real `/pickle-pipeline` smoke (this very bundle's own run, or a follow-up) shows `codegraph_index_built` + ≥1 `codegraph_context_injected` with non-zero hits — proving default-on actually injects context in a live run.

## Non-Goals
- Enabling `expose_mcp_to_workers` by default (gated on CGH-1; separate decision once the handshake is proven stable).
- Replacing/upgrading `@colbymchenry/codegraph` (0.9.9 stays).
- Improving `deriveCodegraphTerms` relevance beyond what CGH-3 measurement surfaces (a follow-up if the A/B shows weak hits).

## Sequencing
CGH-1 (flake) + CGH-2 (instrumentation) first — they unblock measurement. Then CGH-3 (validate) + CGH-4/5 (cost/degradation). **CGH-6 (flip default) LAST**, gated on the rest green + CGH-3 showing a non-negative efficacy delta. If CGH-3 shows codegraph *doesn't* help (or hurts cost), STOP at CGH-5 and leave default-off — the measurement decides the flip.

**Refine this into atomic tickets via `/pickle-pipeline` in a fresh session.**
