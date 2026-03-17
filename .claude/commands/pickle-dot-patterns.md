Pickle-dot pattern reference. Read by `/pickle-dot` on demand — do NOT load this file unless `/pickle-dot` instructs you to.

## Tier 1: Always Emit

**0. Dependency Setup** — first node after start. Tool node installs deps in `working_dir`:
```
setup_deps [shape=parallelogram, tool_command="cd ${WORKING_DIR} && npm install 2>&1", timeout="120s"]
start -> setup_deps -> first_impl
```
Detect package manager: `npm install`, `pnpm install`, `yarn install`, `pip install -r requirements.txt`, etc.

**0b. max_parallel=1** — ALL `shape=component` fan-out nodes MUST use `max_parallel=1`. Parallel claude processes OOM the Docker container (7GB limit).

**1. Test-Fix Loops** — every impl has verification routing back on failure:
```
impl -> test -> check [shape=diamond]
check -> next [condition="outcome=success", weight=2]
check -> impl [condition="outcome=fail"]
```

**2. Goal Gates** — P0/critical nodes get `goal_gate=true`. PRD acceptance criteria → `acceptance_criteria` attr + `goal_gate=true`. Prefer per-node `retry_target`. Context vars: `context.tests_pass`, `context.build_status`, `context.lint_status`, `context.typecheck_status`.

**CRITICAL: `context_on_success` bridge** — every key in `acceptance_criteria` MUST be set by `context_on_success="key=value,key2=value2"` on the final verification tool node. Without this, criteria always fail → infinite retry:
```
verify_final [shape=parallelogram,
    tool_command="cd ${WORKING_DIR} && ${LINT_CMD} 2>&1 && ${TYPECHECK_CMD} 2>&1 && ${TEST_CMD} 2>&1",
    goal_gate=true, retry_target="fix_all", max_visits=3,
    context_on_success="tests_pass=true,lint_status=passing,typecheck_status=passing"]
```
Do NOT put `context_on_success` on intermediate per-phase verify nodes — those use goal gates for convergence. Only the final verify_final before exit sets acceptance criteria context.

**3. Conditional Routing** — diamond nodes, 2+ edges covering all cases:
```
check [shape=diamond]
check -> a [condition="outcome=success", weight=2]
check -> b [condition="outcome=fail"]
```

**6. Max Visits** — `max_visits` on looping nodes prevents infinite convergence.

**13. Lint Gate** — separate tool node for linter, BEFORE tests:
```
verify_lint [shape=parallelogram, tool_command="cd ${WORKING_DIR} && npm run lint 2>&1", max_visits=3]
```
Detect: `npm run lint`, `ruff check .`, `golangci-lint run`. Skip if no linter.

**14. Type-Check Gate** — separate tool node, AFTER lint, BEFORE tests:
```
verify_types [shape=parallelogram, tool_command="cd ${WORKING_DIR} && npx tsc --noEmit 2>&1", max_visits=3]
```
Detect: `tsc --noEmit`, `mypy .`, `go vet ./...`. Skip for dynamically-typed projects.

**21. Cross-Phase Cleanup (fix_all)** — before verify_final, fixes ALL remaining issues across all phases:
```
fix_all [prompt="Fix ALL remaining issues across the entire codebase. Run each check and fix failures: 1) cd ${WORKING_DIR} && ${LINT_FIX_CMD} 2>&1. 2) ${TYPECHECK_CMD} 2>&1. 3) ${TEST_CMD} 2>&1. Iterate until all pass with zero errors. Do NOT skip or suppress errors.", permission_mode="bypassPermissions", max_visits=5]
```
Resolve: `${LINT_FIX_CMD}` = `npx eslint src/ --fix` (Node), `ruff check --fix .` (Python), `golangci-lint run --fix` (Go). `${TYPECHECK_CMD}` = `npx tsc --noEmit` / `mypy .` / `go vet ./...`. `${TEST_CMD}` = `npm test` / `pytest` / `go test ./...`.

Uses Default tier (no `class`). Graph-level and verify_final `retry_target` MUST point to `fix_all`. Single-phase pipelines: still recommended; trivial ones may use sole impl node.

## Tier 2: Default (emit unless explicitly simplified)

**15. Conformance Check** — LLM gate verifying requirements met. Opus (`.review` class), `goal_gate=true`:
```
conformance [class="review", goal_gate=true, retry_target="impl", prompt="Conformance audit: read the original prompt and git diff. Verify every requirement addressed. Output PASS or FAIL with unmet requirements."]
```

**16. Spec-First TDD** — write failing tests FROM spec BEFORE impl. Mandatory for `goal_gate=true` impl nodes:
```
spec_tests [class="review", prompt="Write failing tests for EVERY requirement. Do NOT write production code.", goal_gate=true, retry_target="spec_tests"]
impl [prompt="Make all failing tests pass. Do NOT modify test files.", goal_gate=true, retry_target="impl"]
```

**19. Review Convergence Ratchet** — N consecutive clean agent team passes required. Default for all pipelines. Replaces Pattern 7.

Team composition: `correctness` + `patterns` always. Add `architecture` (>5 files), `security` (auth/data), `performance` (hot paths), `api_compatibility` (contracts). Ask user: "Review team? Consecutive passes? (default: 2)"

Each pass = `component→tripleoctagon` fan-out. Pass K failure resets to pass 1. Fix prompts include simplification.
```
split_review_N [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
reviewer_X_N [class="review", prompt="<narrow focus> ONLY. List issues with file:line."]
merge_review_N [shape=tripleoctagon, class="review", prompt="Consolidate. BLOCKER or ADVISORY. CLEAN or DIRTY."]
check_review_N [shape=diamond]
fix_N [prompt="Fix all BLOCKERs. Also simplify. Do NOT modify test files.", max_visits=5]
reverify_N [shape=parallelogram, tool_command="cd ${WORKING_DIR} && ..."]
```

## Tier 3: Conditional (emit when PRD analysis flags them)

**4. Parallel Fan-Out/Fan-In** — when PRD has independent workstreams:
```
split [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
merge [shape=tripleoctagon, prompt="Select best"]
```

**8. Security Scanning** — separate from tests. For projects with security tooling:
```
verify_security [shape=parallelogram, tool_command="npm audit --audit-level=high 2>&1"]
```

**9. Coverage Qualification** — score-based gate on new/changed code (>=80%):
```
check_coverage [shape=diamond, prompt="Check coverage on new/changed code..."]
```

**10. Scope Creep Detection** — post-implementation, before review. Opus (`.review`):
```
scope_check [class="review", prompt="Compare git diff against prompt. Flag out-of-scope changes."]
```

**11. Drift Detection** — in review-simplify cycles (Pattern 7 standalone only). Pattern 19 ratchet handles via reset-on-fail.

**17. Adversarial Red Team** — AFTER conformance. Ask user for security/auth/data phases:
```
red_team [class="review", prompt="Attempt to break: invalid inputs, races, exhaustion, state corruption. Write repro tests.", goal_gate=true, retry_target="impl"]
```

**18. Competing Implementations** — two parallel approaches for high-complexity phases (>3 files). Ask user:
```
split_impl [shape=component, max_parallel=1, join_policy="wait_all", error_policy="continue"]
approach_minimal [prompt="MINIMAL changes — smallest diff..."]
approach_clean [prompt="CLEAN architecture — best design..."]
select_best [shape=tripleoctagon, class="critical", eval_criteria="completeness,faithfulness", eval_threshold=0.7]
```

**20. Microverse Convergence Loop** — for quantitative targets (metric optimization). Replaces standard impl→verify:
```
commit_baseline [shape=parallelogram, tool_command="cd ${WORKING_DIR} && git add -u && git -c user.name=attractor -c user.email=attractor@local commit -m 'microverse: baseline' --allow-empty 2>&1"]
baseline [shape=parallelogram, tool_command="cd ${WORKING_DIR} && <measurement_cmd> 2>&1"]
optimize [prompt="Make ONE targeted change toward <TARGET>. Smallest diff.", max_visits=8]
measure [shape=parallelogram, tool_command="cd ${WORKING_DIR} && <measurement_cmd> 2>&1"]
compare [class="review", prompt="Compare measurement vs target. MUST output STATUS: marker on its own line — the engine's parseStatusMarker ONLY recognizes: STATUS: SUCCESS (target met), STATUS: PARTIAL_SUCCESS (improved but not at target), STATUS: FAIL (regressed/stalled). Bare words like PASS/FAIL are ignored.", max_visits=10]
check [shape=diamond]
rollback [shape=parallelogram, tool_command="cd ${WORKING_DIR} && git checkout . 2>&1"]

check -> next [condition="outcome=success", weight=2]
check -> optimize [condition="outcome=partial_success"]
check -> rollback [condition="outcome=fail"]
rollback -> optimize
```

## Superseded (reference only)

**5. Human Gates** — NOT IMPLEMENTED for claude-code backend. Do not emit hexagon nodes.

**7. Review-Simplify Cycle** — superseded by Pattern 19 (ratchet). Standalone fallback only.

**12. Multi-Pass Complexity** — superseded by Pattern 18 (competing impls).

## Retry Target Scoping

- **Graph-level `retry_target` MUST point to `fix_all`** — not setup_deps, not per-phase impl
- **Per-node `retry_target`** on every `goal_gate=true` node
- **Fan-out branches stay within scope** — retry only to nodes in the same component→tripleoctagon pair

## Anti-Patterns (NEVER)

- Linear chains without feedback loops
- `goal_gate=true` without `retry_target`
- Graph-level `retry_target` to setup_deps/start/per-phase impl (full re-run or scoped-only retry)
- Fan-out `retry_target` outside branch scope
- Hexagon nodes (deadlock)
- Diamond without 2+ edges (stalls)
- Parallel siblings depending on each other (deadlock)
- Lint/typecheck/test bundled into one gate
- Security scanning bundled with tests
- Conformance skipped
- Impl before spec tests on critical paths
- Single review pass as final gate (use ratchet)
- Ratchet fail routing to same pass (defeats consecutive enforcement)
- Standard impl→verify for metric optimization (use microverse)
- acceptance_criteria keys without matching `context_on_success`
- verify_final `retry_target` to per-phase impl (can't fix cross-phase issues)
- Missing fix_all before verify_final in multi-phase pipelines
- >4 reviewers per team

## Model Routing

Two tiers: `${DEFAULT_MODEL}` (impl/tools) and `${REVIEW_MODEL}` (review/conformance/red-team).

```dot
// anthropic (default):
model_stylesheet = "* { llm_model: claude-sonnet-4-6; } .critical { llm_model: claude-opus-4-6; reasoning_effort: high; } .review { llm_model: claude-opus-4-6; }"
// non-anthropic:
model_stylesheet = "* { llm_model: ${DEFAULT}; llm_provider: ${PROVIDER}; } .critical { llm_model: ${REVIEW}; reasoning_effort: high; } .review { llm_model: ${REVIEW}; }"
```

| Provider | Default | Review |
|----------|---------|--------|
| `anthropic` | `claude-sonnet-4-6` | `claude-opus-4-6` |
| `openai` | `gpt-4.1` | `o3` |
| `qwen` | `qwen-plus` | `qwen-max` |
| `gemini` | `gemini-2.5-flash` | `gemini-2.5-pro` |
| `deepseek` | `deepseek-chat` | `deepseek-reasoner` |
| `ollama` | `qwen3:32b` | `qwen3:32b` |
| `vllm` | *(ask user)* | *(ask user)* |

## Conditions Reference

`outcome=success`, `outcome=fail`, `outcome=partial_success`, `outcome=retry`, `outcome=skipped`, `context.KEY=VALUE`, combine with `&&`.

## Shapes Reference

Mdiamond=start, Msquare=exit, box=codergen, diamond=conditional, component=fan-out, tripleoctagon=fan-in, parallelogram=tool, house=manager_loop. (hexagon=human — NOT IMPLEMENTED)

Permission modes: `plan` (default), `bypassPermissions`, `acceptEdits`, `auto`, `default`, `dontAsk`. NOT `full`.

## DOT Schema

Full schema: `attractor/DOT_SCHEMA.md`. Key tool attribute: `context_on_success` (sets RunContext keys on exit 0).
