Convert a PRD into an attractor-compatible DOT digraph.

Persona via CLAUDE.md. **SPEAK BEFORE ACTING**.

Attractor = **convergence basin**, not task list. Failures route back toward the basin. Linear chains forbidden unless zero failure modes.

## Step 1: Acquire PRD, Flags & Resolve Working Dir

`$ARGUMENTS`: extract flags first, remainder is the PRD source.

**Flags** (all optional):
- `--provider <name>` — `anthropic` (default), `openai`, `qwen`, `gemini`, `deepseek`, `ollama`, `vllm`
- `--review-provider <name>` — separate provider for review/critical nodes (`.review`, `.critical` classes). Enables mixed-provider workflows (e.g., `--provider qwen --review-provider anthropic` = Qwen for impl, Opus for adversarial review)
- `--models default=<id>,review=<id>` — model IDs for two semantic tiers
- `--model <id>` — shorthand: one model for both tiers
- `--isolated` — skip workspace prompt, use isolated workspace mode
- `--shared` — skip workspace prompt, use shared mode (default)
- `--exit-validation` — prefer `exit_validation` graph attribute over a separate `verify_final` tool node for simple pipelines (single test command, no delta logic)
- `--multimodal` — enable `attachments_context_key` on relevant nodes for PRDs referencing screenshots, mockups, or images
- `--backend <name>` — execution backend: `claude-code` (default), `llm`, `mastra`, `qwen-code`, `none`. Passed through to `/attract` on submission
- `--builder` — enable the BuilderSpec codegen path (Phase 1 opt-in; default remains prompt-only until Phase 2 rollout)
- `--legacy` — explicit prompt-only generation path; identical to default, use to bypass `--builder` if set globally

**Provider defaults** (when `--models` not given):

| Provider | Default tier | Review tier |
|----------|-------------|-------------|
| `anthropic` | `claude-sonnet-4-6` | `claude-opus-4-6` |
| `openai` | `gpt-4.1` | `o3` |
| `qwen` | `qwen-plus` | `qwen-max` |
| `gemini` | `gemini-2.5-flash` | `gemini-2.5-pro` |
| `deepseek` | `deepseek-chat` | `deepseek-reasoner` |
| `ollama` | `qwen3:32b` | `qwen3:32b` |
| `vllm` | *(ask user)* | *(ask user)* |

**PRD source**: path (has `/` or `.md`) → read file. Text → use directly. Empty → ask user.

**Working directory**: attractor runs in Docker, project mounted at `/repos/`. Use `git rev-parse --show-toplevel` to determine mount path. If not a git repo or ambiguous, **ask the user**: "What path will this repo be mounted at inside `/repos/`?" All `tool_command` paths use `cd ${WORKING_DIR} &&`. **Never** use absolute local paths.

**Spec file** (Layer 3 — Spec-Driven Acceptance): After resolving working dir, determine the PRD file path for `spec_file`:
- If PRD was a file path → use that path remapped to workspace (e.g., `/workspace/<run-id>/prd.md` for isolated, `/repos/<repo>/prd.md` for shared)
- If PRD was inline text → write it to `${WORKING_DIR}/prd.md` and reference that path
- Emit `spec_file` as a graph attribute in the BuilderSpec. The engine interpolates `$spec_file` in node prompts.

**Workspace isolation**: After resolving the working directory, determine workspace mode:
- If `--isolated` flag → use isolated mode
- If `--shared` flag → use shared mode
- Otherwise → defer to Step 2b checklist (recommend isolated for greenfield/risky, shared for iterative/quick)

**If isolated**: set `workspace: "isolated"` in BuilderSpec and populate `workspaceOpts`:
1. `workspaceOpts.repoUrl` — derive from `git remote get-url origin`. **Must be HTTPS** — validator rule 22 (`workspace_config`) rejects SSH URLs. Convert SSH format: `git@github.com:org/repo.git` → `https://github.com/org/repo.git`.
2. `workspaceOpts.repoBranch` — current branch name (e.g., `"main"`)
3. `workspaceOpts.cleanup` — **always `"preserve"` by default**. Use `"delete"` only when the pipeline has a `commit_and_push` node.
4. **MANDATORY for isolated**: at least one phase must push verified code. The builder auto-emits a `commit_and_push` tool node when `workspace: "isolated"`. Without this, code is lost on cleanup.

**If shared**: omit `workspace`, `workspaceOpts` from BuilderSpec.

## Step 2: Analyze PRD

Extract: slug, goal, tasks, acceptance criteria.

**Detect which conditional patterns apply** (read pattern reference for details):

| Signal in PRD | Pattern to emit |
|---------------|-----------------|
| Security/auth/data/crypto surface | 8 (security scan), 17 (red team) — recommend in Step 2b |
| Quantitative target with measurable metric (see microverse detection below) | 20 (microverse) — replaces standard impl→verify for that phase |
| Long-running external process ("wait for", "monitor", "poll", deploy, migration, CI wait) | 24 (manager loop) — supervisor polling node |
| High-complexity phase (>3 files, cross-cutting) | 18 (competing impls) — recommend in Step 2b |
| Coverage requirements | 9 (coverage gate) |
| Multiple independent workstreams | 4 (fan-out/fan-in) |

**Plan review teams** per phase:
1. `correctness` + `patterns` (always)
2. + `architecture` if >5 files or new modules
3. + `security` if auth/data/crypto
4. + `performance` if hot paths
5. + `resources` if new I/O code (streams, file handles, spawned processes, database connections)
6. + `concurrency` if parallel execution, shared state, fan-out nodes, async coordination, or multiple processes accessing same files/databases
7. + `error-handling` if error recovery paths, retries, fault tolerance, or external service calls
8. Default: 2 consecutive clean passes. **Maximum**: 3 passes for any single phase (>3 has diminishing returns and multiplies stall risk — each pass creates N review nodes + merge + fix cycle). Present in Step 2b checklist for user confirmation.

**Extract affected files** (Layer 4 — Permission Scoping): From the PRD's "affected files", "scope", or "changes" section, derive per-phase `allowedPaths` and `escalateOn` lists. If the PRD doesn't specify affected files, emit a comment and default to `["src/**", "tests/**"]`. When building per-phase `allowedPaths`, use the prompt text as the source of truth — not just the PRD's file list. After drafting each phase's `prompt`, scan it for file-path references and ensure every referenced file is in `allowedPaths`.

**Count requirements per phase**: For phases with 3+ requirements, flag for BDD scenario generation (`bddScenarios: true`). Phases with 1-2 requirements use spec_tests alone.

**Microverse detection** (Pattern 20): A phase qualifies for microverse when ALL of:
1. **Numeric target** — PRD states a quantitative goal: "reduce to N", "improve to Z%", "keep under N ms", "achieve N% coverage", "at least/at most N", or any number + comparison.
2. **Measurable** — you can construct a shell command that runs in <60s and prints a number on its last line. If the answer requires human judgment or visual inspection → NOT measurable (use standard impl with LLM judge).
3. **Gradual, not binary** — intermediate progress has value. "Get coverage from 60% to 90%" = microverse. "Make tests pass" = binary → standard impl.
4. **Direction is clear** — "reduce", "minimize", "below", "under", "fewer" → `direction: "reduce"`. "Improve", "maximize", "above", "at least", "increase" → `direction: "improve"`. Ambiguous → flag in Step 2b checklist for user clarification.

Derive the measurement command from PRD context:
| PRD signal | Command pattern |
|---|---|
| Coverage % | `npx jest --coverage --coverageReporters=text-summary 2>&1 \| grep 'Statements' \| grep -oE '[0-9.]+'` |
| Bundle size | `npm run build 2>/dev/null && wc -c < dist/bundle.js` |
| Lint error count | `(npx eslint src/ 2>&1 \|\| true) \| grep -c 'error'` |
| Build/response time | `{ time npm run build 2>/dev/null; } 2>&1 \| grep real \| grep -oE '[0-9]+\.[0-9]+'` |
| Custom metric | Extract script/command from PRD; wrap so last stdout line is a number |

The command MUST output a single number on its last line. Use the same command for both `baseline` and `measure` nodes.

**TypeScript strictness detection**: If the target project uses TypeScript, check `tsconfig.json` for strict flags: `exactOptionalPropertyTypes`, `strict`, `strictNullChecks`, `noUncheckedIndexedAccess`, `strictPropertyInitialization`. Record active flags as `${STRICT_FLAGS}`. If any are enabled, these MUST be embedded in every phase's `prompt` in Step 3 — agents default to `prop: T | undefined` instead of `prop?: T` under strict configs, causing type regressions that exhaust verify retries.

**Count total nodes**: If >20 nodes or >3 phases, plan fidelity tiers — use `defaultFidelity = "compact"` at graph level (builder handles this), `fidelity = "full"` on review/conformance/fix nodes.

**Validate**: Must have title + ≥1 requirement. Missing acceptance criteria → WARN. Missing title → STOP.

## Step 2b: Confirm Plan with User

**Do NOT proceed to graph construction without user confirmation.** Present your analysis as a single checklist. Show your best guesses — the user corrects what's wrong in one shot.

Format:

```
I analyzed the PRD. Here's my plan — confirm or correct anything:

**Slug**: ${SLUG}
**Goal**: ${GOAL} (1 sentence)
**Phases**: N — [phase names]
**Tech stack**: ${LANG}/${RUNTIME} — lint: ${LINT_CMD}, typecheck: ${TC_CMD}, test: ${TEST_CMD}, pkg: ${PKG_MGR}
**TS strictness**: [${STRICT_FLAGS} / standard (no strict flags) / N/A (not TypeScript)]
**Workspace**: [shared / isolated] ${reason}

**Per-phase breakdown:**

Phase 1: ${PHASE_NAME}
  Scope: ${allowedPaths} | Escalate: ${escalateOn}
  Requirements: N → [BDD scenarios: yes/no]
  Microverse: [yes — target: N, direction: reduce/improve, cmd: `...` / no — ${reason}]
  Review team: [roles] — ${N} consecutive passes
  Red team: [yes / no] — ${reason}
  Competing impls: [yes / no] — ${reason}

[repeat per phase]

**Pipeline shape:**
  ${template_summary — e.g., "single-phase with microverse loop, 2-pass review ratchet, conformance, red team"}

**Defense matrix:**
  L1 Competitive: [YES/NO]  L2 Guardrails: YES  L3 Spec-Driven: [YES/PARTIAL]
  L4 Permissions: YES  L5 Adversarial: [YES/NO]

Anything to change?
```

**Rules for the checklist:**
- **Tech stack**: Detect from PRD context, file extensions, or `package.json`/`pyproject.toml`/`go.mod` mentions. If ambiguous → show `[unknown — please specify]`
- **Microverse**: For each phase with a quantitative target, show the target, direction, and proposed measurement command. Let the user confirm the command works in their repo.
- **Scope**: If PRD lacks affected files, show `src/**, tests/** [broad — PRD lacks file list]` and ask if narrower scope is possible. Always verify test dirs are included in `allowedPaths` (agent needs to write tests). Show `escalateOn` list for user review.
- **Review team**: Show your recommendation with reasoning. Default 2 passes unless user overrides.
- **Red team / Competing impls**: Show recommendation. Don't ask open-ended — present a yes/no with your reasoning.
- **Workspace**: If not flagged, recommend based on context (isolated for greenfield/risky, shared for iterative/quick).
- **Omit items already resolved by flags** (e.g., `--isolated` → don't ask workspace, `--shared` → don't ask workspace).

Wait for user response. Apply corrections to your analysis, then proceed to **Step 3** (`--builder` flag) or **Step 3L** (prompt-only / `--legacy` or no flag).

---

## Step 3L: Prompt-Only Path (default or `--legacy`)

If `--builder` is **not** set (or `--legacy` is explicitly set), generate DOT directly from your Step 2 analysis without invoking the builder CLI. Read `.claude/commands/pickle-dot-patterns.md` for the complete pattern reference. Apply every pattern detected in Step 2, emit a `digraph ${SLUG} { ... }` using standard attractor DOT syntax, validate structurally (single start/exit, reachability, AC mapping completeness), then save to `./${SLUG}.dot`. Print a brief summary and offer `/attract ${SLUG}.dot` as the next step.

---

## Step 3: Construct BuilderSpec JSON (`--builder` path)

Translate your Step 2 analysis into a `BuilderSpec` JSON object. The builder CLI (`node ~/.claude/pickle-rick/extension/bin/dot-builder.js`) enforces all 15 validation rules, auto-applies Tier 1/2 patterns, and produces deterministic DOT output. Your role shifts from "write raw DOT" to "analyze PRD and construct typed JSON."

### BuilderSpec Interface

```typescript
interface BuilderSpec {
  slug: string;                   // URL-safe identifier; lowercase underscores
  goal: string;                   // Single-sentence goal from PRD
  phases: PhaseSpec[];            // May be empty for microverse-only pipelines
  acceptanceCriteria: Record<string, string>;  // Exit gate conditions (see AC Mapping below)
  workingDir?: string;            // Default: "${WORKING_DIR}" (attractor resolves at runtime)
  label?: string;                 // Graph display label; default: goal value
  defaultMaxRetry?: number;       // Graph-level default_max_retry; default: 3
  workspace?: 'isolated';         // Omit for shared (default)
  workspaceOpts?: WorkspaceOpts;  // Required when workspace: 'isolated'
  microverse?: { name: string; opts: MicroverseOpts };
  reviewRatchet?: number;         // Min 2 — N consecutive clean passes required
  modelStylesheet?: StylesheetConfig;
  specFile?: string;              // Path to PRD/spec; emitted as graph-level spec_file attribute
}

interface PhaseSpec {
  name: string;                   // Lowercase underscores; duplicates throw DUPLICATE_PHASE
  prompt: string;                 // Full impl instruction — agent has NO access to PRD
  allowedPaths: string[];         // Glob patterns; required on all impl phases
  severity?: 'error' | 'warning' | 'info';  // Diagnostic severity override; default 'error'
  dependsOn?: string[];           // Phase names this phase depends on; omit for independence
  contextOnSuccess?: Record<string, unknown>;  // Tier 1 (custom) AC keys emitted on conformance node
  escalateOn?: string[];          // Default: ["package.json","*.lock","*.config.*"]
  specFirst?: boolean;            // Pattern 16: default true when goalGate true, false otherwise
  goalGate?: boolean;             // Pattern 2: default false
  retryTarget?: string;           // Goal gate retry node; default: "fix_${phase_name}"
  timeout?: string;               // Duration string; default "30m"
  threadId?: string;              // Auto-assigned "phase_${N}" (1-based); override rarely
  securityScan?: boolean;         // Pattern 8: npm audit node after progress gate
  coverageTarget?: number;        // Pattern 9: e.g., 80 for 80% coverage gate
  competing?: boolean;            // Pattern 18: fan-out to two competing implementations
  redTeam?: boolean;              // Pattern 17: adversarial review after conformance
  bddScenarios?: boolean;         // Pattern 16b: explicit opt-in for Given/When/Then scenarios
  docOnly?: boolean;              // Suppress verify chain; use for doc-only phases
}

interface MicroverseOpts {
  prompt: string;                 // Optimization instruction for each iteration
  measureCommand: string;         // Shell command; MUST output single number on last stdout line
  target: number;                 // Numeric goal (e.g., 819200 for 800KB)
  direction: 'reduce' | 'improve';
  allowedPaths: string[];
  timeout?: string;               // Default "30m"
  maxVisits?: number;             // Overrides defaults (8 on optimize, 10 on compare) uniformly
}

interface WorkspaceOpts {
  repoUrl?: string;               // HTTPS URL required for isolated workspace
  repoBranch?: string;
  cleanup?: 'delete' | 'preserve';  // Default: 'delete' when omitted
}

interface StylesheetOverride {
  selector: string;
  model: string;
  effort?: string;
}

interface StylesheetConfig {
  defaultModel: string;
  defaultEffort?: string;
  overrides?: StylesheetOverride[];
  defaultProvider?: string;
  criticalModel?: string;
  criticalProvider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  reasoningEffort?: string;       // e.g., "high" for critical tier
}
```

### Mapping Step 2 Analysis → BuilderSpec

| Step 2 result | BuilderSpec field |
|---|---|
| Slug from PRD title | `slug` |
| One-sentence goal | `goal` |
| Phase list + prompts + scopes | `phases[]` (one `PhaseSpec` per phase) |
| Custom AC keys from PRD | `acceptanceCriteria` + matching `contextOnSuccess` in phases |
| Working dir from Step 1 | `workingDir` |
| Spec file path from Step 1 | `specFile` |
| Workspace mode from Step 1 | `workspace`, `workspaceOpts` |
| Review ratchet pass count | `reviewRatchet` |
| Microverse detection | `microverse.opts.measureCommand`, `.target`, `.direction` |
| Provider/model flags | `modelStylesheet` fields |
| Fan-out: ≥2 phases with no `dependsOn` | Omit `dependsOn` on independent phases — builder auto-emits Pattern 4 |
| Serial phases | Set `dependsOn: ["prior_phase"]` on dependent phases |

### AC Mapping Rules

The builder validates every key in `acceptanceCriteria` has exactly one source node:

- **Tier 2 keys** (auto-sourced by `verify_final` — do NOT add to any `contextOnSuccess`):
  `tests_pass`, `lint_clean`, `types_compile`, `cli_contract`, `determinism`, `validation_rules`
- **Tier 1 keys** (custom, PRD-specific): MUST appear in `PhaseSpec.contextOnSuccess` for exactly one phase. The builder maps them to that phase's `conformance_${phase}` node. Missing mapping → `BuildError: MISSING_AC_MAPPING`.

Example: PRD acceptance criterion "auth must be secure" → add `"auth_secure": "true"` to `acceptanceCriteria` AND add `contextOnSuccess: { auth_secure: "true" }` to the auth phase.

### Prompt Quality Rules

Each `PhaseSpec.prompt` must be complete — the executing agent has NO access to the PRD:
- Include: goal, specific files to create/modify, API contracts, test requirements, edge cases.
- **Never hardcode line numbers** — use searchable landmarks instead ("find the existing `.replaceAll('$goal', ...)` call").
- **Strict TypeScript**: If `${STRICT_FLAGS}` non-empty from Step 2, append: `"STRICT TSCONFIG: ${STRICT_FLAGS} enabled. Use optional property markers (prop?: T), never union types (prop: T | undefined). Run npx tsc --noEmit before finishing."`
- **I/O resources**: "Ensure all streams, file handles, and spawned processes are closed on every exit path (success, error, timeout). Flush TextDecoder/streams before returning."
- **Error handling**: "Never use empty catch blocks. Every catch must re-throw, return a typed error result, or log a warning with the original error."
- **Shared state**: "For shared resources (files, databases, state), use run-scoped or caller-scoped identifiers. Emit events AFTER state transitions complete."

---

### Few-Shot Examples

#### Example 1: Single-Phase Pipeline

PRD: Add full-text search to an articles API (TypeScript/Node, PostgreSQL).

```json
{
  "slug": "articles_search",
  "goal": "Add full-text search to the articles API via PostgreSQL tsvector",
  "workingDir": "${WORKING_DIR}",
  "specFile": "/repos/my-api/prd.md",
  "phases": [
    {
      "name": "search",
      "prompt": "Implement full-text search on the articles table using PostgreSQL tsvector/tsquery. Add GET /articles/search?q=<term> endpoint returning ranked results (ts_rank). Add a GIN index on the tsvector column via migration. Ensure existing GET /articles endpoint is unaffected. Write tests covering: empty query, single term, multi-term, special characters, no results. Do NOT modify unrelated endpoints.",
      "allowedPaths": ["src/articles/**", "src/db/**", "tests/articles/**"],
      "escalateOn": ["package.json", "*.lock", "*.config.*", "prisma/schema.prisma"],
      "specFirst": true,
      "contextOnSuccess": { "search_returns_ranked_results": "true" }
    }
  ],
  "acceptanceCriteria": {
    "tests_pass": "true",
    "lint_clean": "true",
    "types_compile": "true",
    "search_returns_ranked_results": "true"
  },
  "reviewRatchet": 2,
  "modelStylesheet": {
    "defaultModel": "claude-sonnet-4-6",
    "criticalModel": "claude-opus-4-6",
    "reviewModel": "claude-opus-4-6"
  }
}
```

Builder applies (auto): 0a `setup_deps`, 0c `capture_baseline`, 0d delta-aware verify, 0e progress gate, 1 test-fix loop, 3 conditional routing, 6 `max_visits`, 6b `read_only`+STATUS, 10 scope creep, 13 lint gate, 14 typecheck gate, 15 conformance, 16 spec-first TDD, 21 `fix_all`, 22 permission scoping, 23 defense matrix. `search_returns_ranked_results` maps to `conformance_search` via `contextOnSuccess`.

---

#### Example 2: Multi-Phase with Fan-Out

PRD: JWT auth module + protected REST endpoints (TypeScript/Express). Phases are independent — no `dependsOn`.

```json
{
  "slug": "jwt_auth_api",
  "goal": "Add JWT authentication and protected REST endpoints to the Express API",
  "workingDir": "${WORKING_DIR}",
  "specFile": "/repos/my-api/prd.md",
  "phases": [
    {
      "name": "auth",
      "prompt": "Implement JWT auth middleware: POST /auth/login (bcrypt verify, issue 1h JWT + refresh token), POST /auth/refresh (rotate refresh token), middleware that validates Authorization: Bearer <token> header. Algorithm allowlist: HS256 only. Timing-safe compare for bcrypt. Write tests for: missing token, expired token, malformed token, valid token, refresh rotation, algorithm confusion. STRICT TSCONFIG: strict enabled. Use optional property markers (prop?: T), never union types (prop: T | undefined). Run npx tsc --noEmit before finishing.",
      "allowedPaths": ["src/auth/**", "tests/auth/**"],
      "escalateOn": ["package.json", "*.lock", "*.config.*", ".env*"],
      "specFirst": true,
      "bddScenarios": true,
      "securityScan": true,
      "contextOnSuccess": { "auth_middleware_complete": "true" }
    },
    {
      "name": "api",
      "prompt": "Implement protected REST endpoints: GET /users/me, PUT /users/me, GET /users/:id/settings. Apply auth middleware from the auth phase (import from src/auth/middleware). Input validation with zod. Standardized error responses (401 unauthenticated, 403 forbidden, 404 not found, 422 validation). Write tests for: unauthenticated access (401), wrong user (403), valid access, validation errors. STRICT TSCONFIG: strict enabled. Use optional property markers (prop?: T).",
      "allowedPaths": ["src/api/**", "tests/api/**"],
      "escalateOn": ["package.json", "*.lock", "*.config.*"],
      "goalGate": true,
      "specFirst": true,
      "contextOnSuccess": { "api_endpoints_protected": "true" }
    }
  ],
  "acceptanceCriteria": {
    "tests_pass": "true",
    "lint_clean": "true",
    "types_compile": "true",
    "auth_middleware_complete": "true",
    "api_endpoints_protected": "true"
  },
  "reviewRatchet": 2,
  "modelStylesheet": {
    "defaultModel": "claude-sonnet-4-6",
    "criticalModel": "claude-opus-4-6",
    "reviewModel": "claude-opus-4-6"
  }
}
```

Neither `auth` nor `api` has `dependsOn` → builder emits Pattern 4 fan-out: `split_phases → [auth_nodes ∥ api_nodes] → merge_phases`. Thread IDs auto-assigned: `thread_id="phase_1"` on all auth nodes, `thread_id="phase_2"` on all api nodes. `auth_middleware_complete` maps to `conformance_auth.contextOnSuccess`; `api_endpoints_protected` maps to `conformance_api.contextOnSuccess`.

---

#### Example 3: Microverse (Numeric Optimization)

PRD: Reduce main bundle size from 2.1 MB to under 800 KB. No phase impl nodes — microverse replaces the entire impl/verify chain.

```json
{
  "slug": "reduce_bundle_size",
  "goal": "Reduce main bundle from 2.1MB to under 800KB via dead code elimination and code splitting",
  "workingDir": "${WORKING_DIR}",
  "specFile": "/repos/my-app/prd.md",
  "phases": [],
  "microverse": {
    "name": "bundle_opt",
    "opts": {
      "prompt": "Analyze bundle composition (use webpack-bundle-analyzer or source-map-explorer). Eliminate dead code via tree-shaking, apply dynamic import() for route-level code splitting, move large dependencies to lazy chunks, deduplicate shared modules. Focus on the largest contributors first. Do NOT break existing functionality or routing.",
      "measureCommand": "npm run build 2>/dev/null && wc -c < dist/bundle.js",
      "target": 819200,
      "direction": "reduce",
      "allowedPaths": ["src/**", "webpack.config.*", "vite.config.*"],
      "maxVisits": 10
    }
  },
  "acceptanceCriteria": {
    "tests_pass": "true",
    "lint_clean": "true",
    "types_compile": "true",
    "cli_contract": "true",
    "determinism": "true",
    "validation_rules": "true"
  },
  "modelStylesheet": {
    "defaultModel": "claude-sonnet-4-6",
    "criticalModel": "claude-opus-4-6",
    "reviewModel": "claude-opus-4-6"
  }
}
```

`phases: []` → no fan-out (Pattern 4 not applied), no conformance nodes. Microverse generates: `commit_baseline_bundle_opt → baseline_bundle_opt → optimize_bundle_opt → measure_bundle_opt → compare_bundle_opt → check_bundle_opt` with three-way routing: `outcome="success"` (target met) → ratchet or `fix_all`, `outcome="partial_success"` → loop back to `optimize`, `outcome="fail"` (regressed) → `rollback → optimize`. All 6 Tier 2 AC keys auto-sourced by `verify_final` — no custom `contextOnSuccess` needed. Defense matrix `specDriven = "NONE"` (zero phases).

---

## Step 4: Invoke Builder CLI + Fix Loop

Pipe the BuilderSpec JSON to the builder CLI. Run the fix loop on validation failure.

**Invocation:**
```bash
echo '<BuilderSpec JSON>' | node ~/.claude/pickle-rick/extension/bin/dot-builder.js
```

**Exit codes:**
- `0` — success: `BuildResult` JSON on stdout. Extract `.dot` field.
- `1` — build/validation error: `BuildError` JSON on stderr `{ "error": "<BuildErrorCode>", "message": "...", "diagnostics": [...] }`. Recoverable — LLM can fix BuilderSpec.
- `2` — unexpected error: plain error JSON on stderr `{ "error": "UNEXPECTED_ERROR", "message": "..." }`. Not recoverable — fix the input structure or escalate.

**Fix loop algorithm:**

```
best_spec             = initial BuilderSpec JSON
best_error_count      = ∞
prev_error_count      = ∞
consecutive_no_progress = 0
total_failed          = 0
iteration             = 1

loop:
  pipe current BuilderSpec JSON to builder CLI

  on exit 0:
    dot = parse stdout JSON → extract .dot field
    save to ./<slug>.dot
    → proceed to Step 5 (Success)

  on exit 1 or exit 2:
    diagnostics  = parse stderr JSON .diagnostics  // array of Diagnostic objects
    error_count  = diagnostics.length

    // Track best attempt
    if error_count < best_error_count:
      best_spec        = current BuilderSpec
      best_error_count = error_count
    else:
      total_failed += 1

    // Convergence guard: revert after 2 consecutive non-improvements
    if error_count >= prev_error_count:
      consecutive_no_progress += 1
      if consecutive_no_progress >= 2:
        revert current BuilderSpec to best_spec
        consecutive_no_progress = 0
    else:
      consecutive_no_progress = 0

    // Termination: 3 total iterations without improvement
    if total_failed >= 3:
      save best_spec output as ./<slug>.dot.draft
      print: "Fix-loop exhausted after <iteration> iterations. Best result (<best_error_count> errors) saved to <slug>.dot.draft — review diagnostics and fix manually."
      list all remaining diagnostics with their .fix hints
      → STOP

    // Fix each diagnostic in the current BuilderSpec
    for each diagnostic in diagnostics:
      read: diagnostic.rule, diagnostic.message, diagnostic.nodeId, diagnostic.fix
      apply minimum-scope fix to BuilderSpec that resolves this diagnostic

    prev_error_count = error_count
    iteration += 1
    continue
```

**Diagnostic-to-fix mapping** (most common `BuildErrorCode` values):

| `error` code | Fix in BuilderSpec |
|---|---|
| `MISSING_AC_MAPPING` | Add `contextOnSuccess: { "<key>": "<value>" }` to the phase whose conformance node should emit this key. Or remove the orphaned key from `acceptanceCriteria`. |
| `MISSING_ALLOWED_PATHS` | Add `allowedPaths: [...]` to the failing phase. |
| `INVALID_STRUCTURE` | Check `phases` for duplicate names or conflicting `dependsOn` chains. |
| `MISSING_TIMEOUT` | Add `timeout: "30m"` to the failing phase. |
| `WORKSPACE_NO_HTTPS` | Set `workspaceOpts.repoUrl` to an HTTPS URL (not SSH `git@...`). |
| `WORKSPACE_NO_PUSH` | Set `workspace: "isolated"` and populate `workspaceOpts` with valid HTTPS `repoUrl`. |
| `GOAL_GATE_NO_MAX_VISITS` | Builder should auto-set this; if error persists, add explicit `retryTarget: "fix_<phase>"`. |
| `INVALID_RATCHET` | `reviewRatchet` must be ≥ 2. |
| `PLAN_MODE_DEADLOCK` | Never set `permission_mode: "plan"` in prompts — deadlocks headless pipelines. |
| `INVALID_SPEC` | Missing required field (`slug`, `goal`, `phases`, `acceptanceCriteria`). Check for null/undefined. |
| `COMPONENT_NO_MERGE` | Paired `shape=component` must have a corresponding `shape=tripleoctagon` fan-in. Check `competing` phase settings. |
| `FAN_OUT_SCOPE_LEAK` | A `retryTarget` inside a fan-out branch points outside its component scope — use default target. |

## Step 5: Save & Summary

**On success (exit 0):**

1. Save the `.dot` string to `./${SLUG}.dot`
2. Print summary:

```
Pipeline saved to ${SLUG}.dot
  Slug: ${SLUG}
  Patterns applied: ${BuildResult.patternsApplied.join(', ')}
  Defense matrix: competitive=${defenseMatrix.competitive}, specDriven=${defenseMatrix.specDriven}, adversarial=${defenseMatrix.adversarial}
  Diagnostics: ${warnings} warning(s), ${infos} info(s)

Next: /attract ${SLUG}.dot
```

3. If `BuildResult.diagnostics` contains warnings or infos, list them — non-blocking but worth reviewing.

**On draft save (fix-loop exhaustion):**

List all remaining diagnostics from `best_spec` builder output with their `diagnostic.fix` hints. User must resolve manually and re-run `/pickle-dot --builder <prd>`.
