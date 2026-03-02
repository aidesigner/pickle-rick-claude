# Pickle Rick Roadmap PRD
| Pickle Rick Roadmap | | Strategic feature roadmap for the Pickle Rick autonomous engineering system |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Pickle Rick **Audience**: Engineering | **Status**: Draft **Created**: 2026-02-28 **Updated**: 2026-03-01 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction
- [x] Problem Statement
- [x] Objective & Scope
- [x] Feature Roadmap
- [x] Prioritization
- [x] Risks & Mitigations

## Introduction

Pickle Rick is an autonomous iterative engineering lifecycle (PRD → Breakdown → Research → Plan → Implement → Refactor) built on Claude Code. The system is stable and battle-tested (619 tests, 26 modules, 18 slash commands). This roadmap captures the next wave of capabilities — organized into themes, prioritized by impact and feasibility.

## Problem Statement

**Current State**: Pickle Rick executes epics sequentially, one ticket at a time, with manual orchestration for cross-epic learning. A three-state circuit breaker detects and stops stalled sessions, but cannot auto-recover (requires manual `circuit-reset.js`). PRD refinement includes codebase analysis via parallel Morty analysts, but the initial PRD drafting (`/pickle-prd`) has no codebase awareness. Integration with external systems (issue trackers, chat, CI) is absent. Token/LOC metrics are tracked via `/pickle-metrics`.

**Primary Users**: Solo developers and small teams using Claude Code for autonomous coding.

**Pain Points**:
1. Sequential ticket execution wastes time when tickets are independent
2. No learning between epics — the same mistakes repeat
3. ~~Stalled sessions require manual diagnosis and recovery~~ *(addressed: circuit breaker detects stalls and stops sessions; manual recovery via `circuit-reset.js`)*
4. No visibility into progress without checking tmux or running `/pickle-status`
5. ~~PRD quality depends entirely on user input — no codebase awareness~~ *(partially addressed: `/pickle-refine-prd` deploys a Codebase Context analyst)*

## Objective & Scope

**Objective**: Evolve Pickle Rick from a sequential ticket executor into an intelligent, self-healing, parallel-capable engineering system with external integrations.

**Ideal Outcome**: Multi-ticket parallel execution, cross-epic learning, auto-recovery from failures, and bidirectional sync with issue trackers and notification systems.

---

## Feature Roadmap

### Theme 1: Execution & Workflow

#### 1.1 Parallel Ticket Execution
**Priority**: P0 — High Impact, Medium Effort

Spawn multiple Morty workers across tmux panes to process independent tickets simultaneously. Requires dependency analysis to determine which tickets can safely run in parallel.

**Key deliverables**:
- Ticket dependency graph (DAG) construction from PRD breakdown
- Parallel Morty spawner with configurable concurrency limit
- Shared resource conflict detection (same file touched by multiple tickets)
- Merge conflict resolution strategy when parallel branches converge

**Risks**: File-level conflicts between parallel workers. Mitigate with file-lock awareness or pessimistic serialization of overlapping tickets.

#### 1.2 Smart Dependency Ordering
**Priority**: P0 — High Impact, Low Effort

Analyze ticket interdependencies during breakdown phase. Build a DAG so tickets execute in optimal topological order instead of linear sequence.

**Key deliverables**:
- Dependency extraction from ticket specs (explicit `depends_on` field)
- Implicit dependency detection (shared files, imports, test fixtures)
- Topological sort with cycle detection and user-facing error

**Note**: This is a prerequisite for 1.1 (parallel execution). Ship this first.

#### 1.3 Checkpoint / Resume Mid-Ticket
**Priority**: P1 — Medium Impact, Medium Effort

If a Morty worker dies or times out mid-implementation, resume from the last successful phase (research, plan, implement) instead of restarting the entire ticket.

**Key deliverables**:
- Per-phase artifact persistence (already partially exists: `research_*.md`, `plan_*.md`)
- Phase completion markers in ticket frontmatter (`phases_completed: [research, plan]`)
- `spawn-morty.ts` `--resume-phase` flag to skip completed phases
- Retry logic in tmux-runner to detect partial completion

#### 1.4 Adaptive Iteration Budgets
**Priority**: P2 — Low Impact, Low Effort

Assign iteration budgets based on ticket complexity instead of a global default. Simple rename tickets get 2 iterations; complex architectural tickets get 5+.

**Key deliverables**:
- Complexity scoring during breakdown (lines of code estimate, file count, test requirement)
- Per-ticket `max_iterations` field in frontmatter
- tmux-runner reads per-ticket budget, falls back to global default

---

### Theme 2: Intelligence & Learning

#### 2.1 Post-Mortem Analysis
**Priority**: P1 — High Impact, Medium Effort

After each epic completes, analyze what went wrong: which tickets needed retries, which phases stalled, what error patterns emerged. Feed insights back to improve future PRD refinement.

**Key deliverables**:
- Epic summary generator (reads all iteration logs, worker logs, retry counts)
- Pattern extraction: common failure modes, slow phases, flaky tests
- Summary written to `session_dir/post-mortem.md`
- Optional: feed post-mortem into next PRD refinement cycle as context

#### 2.2 Codebase-Aware PRD Generation
**Priority**: P1 — High Impact, Medium Effort
**Status**: ⚡ Partially Complete

`/pickle-refine-prd` already deploys a Codebase Context analyst (one of 3 parallel Morty workers) that scans architecture, patterns, file structure, and test conventions. The remaining gap is injecting this context into the *initial* PRD drafting (`/pickle-prd`), not just refinement.

**What's done**:
- Codebase Context analyst in refinement team (`spawn-refinement-team.ts`)
- Auto-suggests affected files and test locations per ticket during decomposition

**Remaining deliverables**:
- Inject codebase snapshot into `/pickle-prd` interview context (Step 2)
- Standalone codebase snapshot tool reusable outside refinement

#### 2.3 Test Gap Detection
**Priority**: P2 — Medium Impact, Medium Effort

Identify untested code paths and auto-generate ticket specs for coverage gaps. Run as a standalone command or chain after Meeseeks review.

**Key deliverables**:
- Coverage analysis integration (Istanbul/c8 for JS/TS)
- Gap-to-ticket generator: each uncovered function/branch becomes a ticket spec
- `/pickle-coverage` command to run standalone

---

### Theme 3: Integration

#### 3.1 GitHub Issues / Linear Sync
**Priority**: P1 — High Impact, High Effort

Bidirectional sync between Pickle Rick tickets and external issue trackers. Pull specs from GitHub Issues or Linear, push status updates back as tickets progress.

**Key deliverables**:
- Issue importer: fetch issue body → convert to ticket frontmatter format
- Status pusher: update issue labels/status as ticket moves through phases
- Comment sync: post implementation summaries as issue comments
- Config in `pickle_settings.json`: `issue_tracker: { type: "github", repo: "org/repo" }`

#### 3.2 PR Auto-Creation Per Ticket
**Priority**: P1 — Medium Impact, Low Effort

Each completed ticket gets its own PR with a generated description. `pr-factory.ts` exists but isn't wired into the main execution loop.

**Key deliverables**:
- Wire `pr-factory.ts` into tmux-runner ticket completion flow
- Branch-per-ticket strategy (already partially exists in git-utils)
- PR description template: ticket spec summary, files changed, test results
- Configurable: `auto_pr: true` in `pickle_settings.json`

#### 3.3 Notifications (Slack / Webhook)
**Priority**: P2 — Low Impact, Low Effort
**Status**: ⚡ Partially Complete

macOS notifications already exist in tmux-runner and jar-runner (epic complete, session stalled). Extend to Slack webhooks and generic HTTP endpoints.

**What's done**:
- macOS native notifications on epic completion and session stall (`buildTmuxNotification` in tmux-runner)

**Remaining deliverables**:
- Notification abstraction layer (Slack webhook, generic HTTP POST)
- Event types: epic_complete, ticket_complete, ticket_failed, circuit_open
- Config in `pickle_settings.json`: `notifications: [{ type: "slack", webhook_url: "..." }]`

---

### Theme 4: Quality & Safety

#### 4.1 Meeseeks Auto-Trigger
**Priority**: P1 — Medium Impact, Low Effort
**Status**: ⚡ Partially Complete

`/pickle-refine-prd --meeseeks` chains a full Meeseeks review after all tickets complete. The remaining gap is interval-based triggering (every N tickets) to catch quality drift mid-epic.

**What's done**:
- `--meeseeks` flag on `/pickle-refine-prd` (chains Meeseeks after `TASK_COMPLETED`)
- `chain_meeseeks` field in `state.json`, transition logic in tmux-runner

**Remaining deliverables**:
- `chain_meeseeks_interval` setting (e.g., every 3 tickets)
- tmux-runner checks ticket count and spawns mid-epic Meeseeks pass
- Review results feed into subsequent ticket context

#### 4.2 Regression Detection
**Priority**: P1 — Medium Impact, Low Effort

Track test counts across iterations. Alert immediately if tests disappear or fail counts increase between iterations.

**Key deliverables**:
- Test count parser (extract pass/fail/skip from `npm test` output)
- Per-iteration test snapshot stored in state.json or iteration log
- Stop-hook or post-iteration check: if `tests_passing < previous_tests_passing`, flag regression
- Configurable: `regression_detection: true` (default on)

#### 4.3 Complexity Scoring for PRDs
**Priority**: P2 — Low Impact, Low Effort

Flag PRDs that are too ambitious for a single epic. Suggest splitting when ticket count, estimated file changes, or dependency depth exceeds thresholds.

**Key deliverables**:
- Scoring heuristic: ticket count, cross-file dependencies, new-file-creation ratio
- Warning during breakdown phase: "This PRD has 15 tickets touching 40 files — consider splitting"
- Suggested split points based on dependency clusters

---

### Theme 5: Chaos & Resilience

#### 5.1 Self-Healing Sessions
**Priority**: P0 — High Impact, Medium Effort
**Status**: ✅ Largely Complete (circuit breaker)

The circuit breaker (`circuit-breaker.ts`) implements three-state stall detection (CLOSED → HALF_OPEN → OPEN) with multi-signal progress checks (git diff, HEAD changes, step/ticket transitions) and repeated-error detection via normalized error signatures. Sessions are stopped before wasting hours. Manual recovery via `circuit-reset.js`.

**What's done**:
- Three-state circuit breaker integrated into tmux-runner (54 tests)
- Git-diff progress detection + lifecycle transition tracking
- Two-phase NDJSON error extraction with normalization (paths, timestamps, UUIDs)
- Configurable thresholds: `default_cb_no_progress_threshold`, `default_cb_same_error_threshold`, `default_cb_half_open_after`
- `circuit-reset.js` CLI for manual OPEN → CLOSED recovery
- Color-coded circuit state in tmux monitor
- `circuit_open` exit reason with macOS notification

**Remaining deliverables** (true self-healing, not just detection):
- Auto-retry: on OPEN, kill zombie Morty, reset ticket to previous phase, retry once
- Escalation: if auto-retry fails, pause session and notify user
- Heartbeat mechanism: workers write periodic timestamps to detect hung subprocesses

#### 5.2 Project Mayhem Integration
**Priority**: P3 — Low Impact, High Effort

Run mutation testing during or after epic execution to validate that Morty's code actually matters (tests kill mutants). Uses existing `/project-mayhem` infrastructure.

**Key deliverables**:
- Post-ticket mutation testing pass (optional, configurable)
- Mutation survival report per ticket
- Auto-generate fix tickets for surviving mutants

---

## Prioritization Summary

| Priority | Feature | Theme | Effort | Status |
|----------|---------|-------|--------|--------|
| **P0** | 1.2 Smart Dependency Ordering | Execution | Low | Todo |
| **P0** | 1.1 Parallel Ticket Execution | Execution | Medium | Todo |
| **P0** | 5.1 Self-Healing Sessions | Resilience | Medium | ✅ Largely Complete |
| **P1** | 1.3 Checkpoint/Resume Mid-Ticket | Execution | Medium | Todo |
| **P1** | 2.1 Post-Mortem Analysis | Intelligence | Medium | Todo |
| **P1** | 2.2 Codebase-Aware PRD Generation | Intelligence | Medium | ⚡ Partial |
| **P1** | 3.1 GitHub/Linear Sync | Integration | High | Todo |
| **P1** | 3.2 PR Auto-Creation Per Ticket | Integration | Low | Todo |
| **P1** | 4.1 Meeseeks Auto-Trigger | Quality | Low | ⚡ Partial |
| **P1** | 4.2 Regression Detection | Quality | Low | Todo |
| **P2** | 1.4 Adaptive Iteration Budgets | Execution | Low | Todo |
| **P2** | 2.3 Test Gap Detection | Intelligence | Medium | Todo |
| **P2** | 3.3 Notifications | Integration | Low | ⚡ Partial |
| **P2** | 4.3 Complexity Scoring | Quality | Low | Todo |
| **P3** | 5.2 Project Mayhem Integration | Chaos | High | Todo |

## Recently Shipped (since roadmap creation)

| Feature | Date | Notes |
|---------|------|-------|
| Circuit Breaker & Rate Limiting | 2026-03-01 | Three-state machine, progress detection, error signatures, monitor display, circuit-reset CLI. 54 tests. Addresses 5.1. |
| `/pickle-metrics` | 2026-02-28 | Token/LOC tracking — daily/weekly, per-project, JSON export. 48 tests. |
| `--meeseeks` chaining | 2026-02-27 | Auto-transition from ticket execution to Meeseeks review. Addresses 4.1 partially. |
| `/pickle-refine-prd` codebase analyst | 2026-02-26 | Parallel Codebase Context worker scans architecture during refinement. Addresses 2.2 partially. |

## Suggested Execution Order

**Wave 1 — Foundation** (P0):
1. Smart Dependency Ordering (prerequisite for parallel)
2. Parallel Ticket Execution (biggest throughput unlock)
3. ~~Self-Healing Sessions~~ *(done — circuit breaker shipped; remaining: auto-retry, heartbeat)*

**Wave 2 — Intelligence & Quality** (P1, low-effort first):
4. Regression Detection
5. Meeseeks Auto-Trigger (finish interval-based triggering)
6. PR Auto-Creation Per Ticket
7. Checkpoint/Resume Mid-Ticket
8. Post-Mortem Analysis
9. Codebase-Aware PRD Generation (finish `/pickle-prd` injection)

**Wave 3 — Integration & Polish** (P1 high-effort + P2):
10. GitHub/Linear Sync
11. Notifications (finish Slack/webhook)
12. Adaptive Iteration Budgets
13. Test Gap Detection
14. Complexity Scoring

**Wave 4 — Chaos** (P3):
15. Project Mayhem Integration

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Parallel execution causes merge conflicts | High | File-lock awareness, pessimistic serialization for overlapping files |
| Self-healing loops (recovery triggers recovery) | High | Circuit breaker limits retries via `total_opens` counter; max recovery attempts per ticket (default: 2), then pause |
| Issue tracker API rate limits | Medium | Batch updates, configurable sync interval |
| Codebase snapshot too large for context | Medium | Selective scanning — key files only, not full repo |
| Complexity scoring false positives | Low | Scoring is advisory only, never blocks execution |
