# PRD: Plumbus Generative Audit Frames

## Problem

The plumbus rubric (`.claude/commands/pickle-dot-patterns.md`) is purely **enumerative**. It lists ~140 named validator rules, ~50 anti-patterns, and ~30 named patterns; the worker scans the target `.dot` file for matches against this catalog. This works fine for failure modes someone has already tripped over and named — but it cannot, by construction, surface failure modes nobody has seen yet.

The rubric's growth pattern is reactive: each recent trap class was added only after it surfaced in review. The catalog then covers named instances of the class, not the class itself — a sibling instance with different node names walks straight past the scan. Trap classes the rubric has acquired this way (dates = when the corresponding defensive entry landed in `pickle-dot-patterns.md`, not necessarily a single production incident):

- **Silent-success trap on per-artifact gates** (documented 2026-04-17): a codergen returns success without writing its artifact; the gate's `context_on_success="artifact_X=seeded"` flag flips anyway; a downstream diamond reading that flag locks onto the patch branch (which correctly no-ops on empty pool); the gate fails forever. The `verify_gate_needs_both_context_paths` validator rule (added 2026-04-16) is one mechanical instance; the asymmetric-flag class is broader.
- **Contract-verify exit-code mismatch** (documented 2026-04-17): a routing-signal tool (writes `ATTRACTOR_CTX:<key>=...` on stdout, downstream diamond consumes the key) is wired with `retry_target`-on-nonzero-exit, so the routing path is unreachable exactly when the routing matters. The script's exit-code semantics and the DOT's interpretation disagree silently.
- **Diamond locked-on-patch when pool empty + artifact seeded** (documented 2026-04-17): two outgoing `condition=` edges are simultaneously satisfiable in the same context cell; engine picks the higher-weighted edge deterministically; the lower-weighted branch is latent but never fires. The cell `(artifact=seeded, pool=non-empty)` is a latent trap the author didn't realize was reachable.
- **Drift detection blindspot** (documented 2026-04-14, addressed by the `iterate_body_with_pool_needs_drift_detection` rule and schema attrs `max_drift_iterations` / `drift_tolerance`): pool growth outruns fix rate, V_total climbs silently while the fresh-regression gate accepts every iteration. Called out here for completeness — this class is outside generative-frame scope, it requires the schema additions already tracked in `pickle-dot-patterns.md`.

The first three classes share a shape: they are *structural* properties of the `.dot` graph (asymmetric writes, cartesian-product stuck cells, tool/graph contract mismatch) that a node-by-node scan against a named-rule catalog cannot see. The fourth is listed for honesty: it's a dynamics problem, not a structural one, and sits outside what frames can catch. We want generative concepts that can flag new instances of the first three classes *before* a specific instance has been catalogued.

## Root Causes

### 1. Catalog matching ≠ structural reasoning

The rubric tells the worker "look for X." It does not tell the worker "for every node, ask question Q and report what you find." The worker can only see what it's been told to see. New trap → new rule → ship the rule → wait for the next new trap.

### 2. Context-state coupling is invisible to a node-by-node scan

Most recent failures were **interactions between two nodes** mediated by a context key. `gate_X` writes `artifact_X=seeded` on success; `diamond_X` reads it for routing. The bug isn't in either node's attrs — it's in the missing cleanup edge. A scan that walks one node at a time can't catch this. You have to walk the (writer, reader) graph of every context key.

### 3. Convergence guarantees are not proved, just hoped for

Every cycle in a `.dot` graph is an implicit promise that "this loop terminates." The current rubric checks `max_visits` exists (a budget) but doesn't check that there's any *mechanism* by which the loop's predicate becomes satisfiable. A `fix_X → gate_X → fix_X` loop where `fix_X` has no `model_ladder`, no `__pool_findings__`, and no `__fix_attempt_history` will deterministically loop until the budget bounds it — the rubric calls this "convergent" because it has a budget, but it is not.

### 4. Tool nodes have semantics the DOT can't introspect

A tool's `tool_command` is opaque to the validator. Whether `bun verify-contract.ts` exits 1 on script crash vs script-found-violations vs script-clean is invisible to any pattern-match — you have to read the script and reason about its contract. The rubric currently delegates this to the human author and is silent when they get it wrong.

## Acceptance Criteria

### A1. New rubric section: `## Generative Audit Frames`

Plumbus rubric gains a new section (placed before `## Tier 1: Always Emit`) titled `## Generative Audit Frames`. Six frames documented as named procedures the worker MUST apply during the iteration-1 edge walk, in order, before scanning for named patterns:

1. Context Key Lifecycle Trace
2. Success/Failure Symmetry
3. Edge Condition Exhaustiveness
4. Tool Exit Code Semantics Audit
5. Loop Convergence Proof Obligation
6. Counterfactual Outcome Test

Each frame has: **Procedure** (numbered steps the worker follows), **Output** (specific findings format under a `## Generative Findings` section in `gap_analysis.md`), **Severity Mapping** (how findings translate to P0–P4), **Examples** (one positive, one negative drawn from the v9 debug session).

### A2. Worker protocol update — Plumbus Override 6

`plumbus.md` Worker Mode gains a new override:

```markdown
### Override 6: Generative Audit Pass (iteration 1, after Edge Walk)

After completing the Edge Walk (Override 2) and BEFORE pattern catalog scan, apply the six Generative Audit Frames from `pickle-dot-patterns.md § Generative Audit Frames` in order. Write findings under a `## Generative Findings` section in `gap_analysis.md` (preserve across iterations like `## Edge Map`). Findings are folded into the P0–P4 priority queue using each frame's documented severity mapping.

Skip on subsequent iterations if `## Generative Findings` already exists in `gap_analysis.md` AND no new nodes/edges have been added since the section was written.
```

### A3. Companion analysis script

A new mechanical companion script ships with the extension, following the existing `extension/src/*.ts` → compiled `extension/bin/*.js` convention (install.sh's rsync step excludes `src/`, so only the compiled JS is deployed).

- **Source**: `extension/src/plumbus-frame-analyzer.ts`
- **Compiled output**: `extension/bin/plumbus-frame-analyzer.js`
- **Install.sh**: must add `chmod +x "$EXTENSION_ROOT/extension/bin/plumbus-frame-analyzer.js"` alongside the other bin entries.
- **Runtime**: `node` (not `bun`). The extension's deployed tree is Node-only — bun runs in the attractor repo's dev loop, not inside `~/.claude/pickle-rick/`.

The script performs the parts of frames 1, 3, and 5 that are deterministic graph analysis (cartesian-product enumeration, SCC detection, key writer/reader matrix). The plumbus worker invokes it once per iteration-1 audit and folds its JSON output into the worker's reasoning. This avoids asking the LLM to do graph-theoretic analysis it's bad at.

Output schema:
```json
{
  "context_keys": [{ "key": "artifact_api_controller", "writers": [...], "readers": [...] }],
  "diamond_routing": [{ "diamond": "diamond_api_controller_mode", "covered_states": [...], "stuck_states": [...] }],
  "cycles": [{ "scc_nodes": [...], "convergence_signal": "iterate" | "model_ladder" | "fix_attempt_history" | null }]
}
```

### A4. Findings format consistency

Every Generative Audit Frame finding carries three structured tags plus the standard body:

- **`analysis_mode: mechanical | llm-assisted | llm-only`** — how the finding was produced. `mechanical` = companion script derived the finding directly from the graph JSON. `llm-assisted` = companion script supplied the matrix, LLM interpreted severity/intent. `llm-only` = no companion-script output (analyzer missing or frame not script-backed). This tag drives worker behavior (see A7 verification protocol) — it does NOT change the finding's severity. The bug's truth value is independent of how it was found.
- **`confidence: HIGH | MEDIUM | LOW`** — Frame-4-specific, omitted for other frames. Reflects which of Frame 4's three analysis modes the worker was able to execute (see Frame 4 procedure below).
- **`cluster_key`** — a tuple declared per frame (A5) that identifies which findings describe the same underlying defect.

Raw finding body (one per finding, pre-cluster):

```markdown
### [Frame N: Frame Name]
- **[priority]** `nodeId(s)` — frame-specific finding statement.
  - **Analysis mode**: mechanical | llm-assisted | llm-only
  - **Confidence**: HIGH | MEDIUM | LOW  *(Frame 4 only)*
  - **Cluster key**: `<frame-declared tuple>`
  - **Trace**: <which keys/edges/states triggered this>
  - **Risk**: <what could go wrong if unfixed>
  - **Suggested fix**: <surgical proposed edit>
```

### A5. Finding clusters

Raw findings with matching `cluster_key` collapse into one bullet in `gap_analysis.md` under a `### Multi-frame finding: <cluster_key>` header. Each frame's lens appears as a sub-bullet. Cluster severity = `max(member severities)`. Cluster fix = the most actionable member (typically the Frame 2 symmetry fix when Frames 1+2+6 co-fire). The worker's priority queue references **clusters**, not raw findings — fix once, all lenses clear on re-walk.

Per-frame `cluster_key` shapes:
- Frame 1: `(reader_node, key)` for orphan-reader findings; `(node, key)` for writer findings
- Frame 2: `(node, key)`
- Frame 3: `(diamond_node, cell_signature)` where `cell_signature` = stable hash of the cartesian cell's key-value pairs
- Frame 4: `(tool_node)`
- Frame 5: `(scc_representative_node)` = lowest-ID node in the SCC
- Frame 6: `(node, artifact_path)` — rarely clusters with 1/2

Concrete rollup:

```markdown
### Multi-frame finding: gate_controller_routes / artifact_api_controller
- **[F1: P0, mechanical]** Asymmetric writer — only success path writes `artifact_api_controller=seeded`.
- **[F2: P0, llm-assisted]** Missing `context_on_failure` paired with `context_on_success` on the seed.
- **[F6: P1, llm-only]** Seed relies on downstream gate as ONLY counterfactual guard.
- **Cluster severity**: P0
- **Suggested fix (root cause)**: Add `context_on_failure="artifact_api_controller=seed_failed"` to `gate_controller_routes`.
```

No severity promotion for cluster size — max-severity carries the weight, and inflating on cluster cardinality would re-introduce the noise-inflation problem dedup is meant to kill.

### A6. Engine-injected key registry

A new static data file `extension/data/engine-injected-keys.json` enumerates context keys the attractor engine writes (or the iterate/tool handlers write) without the author declaring `context_on_success` / `context_on_failure`. Frame 1 loads the registry and classifies any matching key as engine-written, suppressing false-positive "orphan writer" findings. Schema:

```json
{
  "engine_keys": ["outcome", "current_node", "workspace.path", "runId", "graph.goal", "tool.output"],
  "engine_key_patterns": [
    "pool_count_reviewer_*",
    "__last_failure_*",
    "__pool_findings__",
    "__fix_attempt_history",
    "__ladder_position.*"
  ],
  "user_written_patterns": [
    "artifact_*"
  ]
}
```

The `user_written_patterns` section is important: `artifact_*` keys are *not* engine-written — they follow an author convention (`context_on_success="artifact_X=seeded"`). Frame 1/2 MUST check user-written symmetry on these. The registry distinguishes user-written-by-convention from engine-written-by-handler so the symmetry check fires on the first class and stays silent on the second.

Deployed location: `~/.claude/pickle-rick/extension/data/engine-injected-keys.json`. Install.sh includes a copy step. Both `plumbus-frame-analyzer.js` (mechanical Frame 1 path) and the plumbus worker (LLM-only Frame 1 path) read from this file so the classification is consistent across analysis modes.

Side benefit: the registry centralizes documentation of engine-injected keys that's currently scattered across handler trap-doors.

### A7. Worker verification protocol for `llm-only` findings

When a finding's `analysis_mode` is `llm-only`, the worker runs a verification pass before queueing it for fix:

1. **Frame 1 / 2 llm-only**: re-derive the writer/reader set for just the key named in the finding by grepping `context_on_success`, `context_on_failure`, and `condition="context.<key>..."` across all nodes. Confirm the asymmetry/orphan holds.
2. **Frame 3 llm-only**: re-enumerate the cartesian product for just the one diamond named in the finding; confirm the cited stuck/nondeterministic cell holds.
3. **Frame 5 llm-only**: re-walk just the one SCC named in the finding; confirm no member has any recognized convergence signal from the registry.

If verification confirms → act at the finding's original severity. If verification disagrees → downgrade the finding to P3 and write a `### Verification disagreement` block in `gap_analysis.md` recording both the original finding and the verification result. This adds one targeted re-check per llm-only finding but prevents blanket confidence loss across the audit pass.

Frames 4 and 6 are LLM-only by design (no companion-script mechanical path exists); their verification is the built-in procedure's guardrails (Frame 4's Mode A/B/C gate inside the Frame 4 procedure, Frame 6's direct-vs-transitive-guard heuristic), not an extra pass.

### A8. Validator rule promotion path

When a Generative Audit Frame produces the same finding pattern across ≥3 distinct `.dot` files, that pattern is a candidate for promotion to a named validator rule. The PRD does NOT auto-promote (out of scope) but the rubric documents the path: "If you see this finding repeatedly across pipelines, file an issue suggesting a new validator rule with the documented finding template."

## Implementation Notes

### Frame 1: Context Key Lifecycle Trace

**Procedure:**
1. Load the engine-injected key registry (`extension/data/engine-injected-keys.json`, A6). Every key that matches `engine_keys` literally or `engine_key_patterns` as a glob is classified as **engine-written** and skipped by the orphan-writer / asymmetry checks — the engine handler is its writer. Keys matching `user_written_patterns` (e.g. `artifact_*`) are **explicitly included** in the symmetry check: they're author-convention writes, not engine writes, and the whole point of the frame is to catch the asymmetric ones.
2. Build a writer/reader matrix for every remaining context key referenced in the graph. Sources of writes: `context_on_success` attrs, `context_on_failure` attrs, `ATTRACTOR_CTX:<key>=...` lines in `tool_command` text (supplemental regex pass — the attractor parser treats tool_command as opaque text; see §Companion script architecture). Sources of reads: edge `condition="context.<key>=<value>"` clauses, `context_keys=` attrs on codergen nodes, `ATTRACTOR_CTX_<key>` references inside `tool_command` strings, prompt body text mentioning `${ATTRACTOR_CTX_*}`.
3. For every key in the matrix, classify:
   - **Orphan reader** (read by ≥1 edge or attr, never written): the key will always be undefined → that edge never fires → silent dead routing.
   - **Orphan writer** (written by ≥1 attr, never read): wasted state, OR the author intended a reader and forgot it → the routing they wanted doesn't exist.
   - **Asymmetric writer** (written on success path but never written on the failure path the diamond can reach): the silent-success-trap class.
   - **Multi-writer with conflicting values** (two `context_on_success` attrs on different nodes write the same key with different values): non-deterministic routing depending on which node ran last.
4. Emit findings per orphan/asymmetric/multi-writer key.

**Severity:**
- Orphan reader on a `condition=` edge → **P1** (anti-pattern: dead routing edge).
- Asymmetric writer where the un-written branch is reachable from a `retry_target` loop → **P0** (silent-success trap class).
- Orphan writer → **P3** (cleanup opportunity, may indicate missing reader).
- Multi-writer conflict → **P1**.

**Example (v9 trap):**
- `artifact_api_controller` had writers: `impl_api_controller_seed.context_on_success`, `impl_api_controller_patch.context_on_success`. Reader: `diamond_api_controller_mode → impl_api_controller_patch [condition="context.artifact_api_controller=seeded"]`. Asymmetric — no writer on the failure path of `gate_controller_routes` (gate's `retry_target` returned to the diamond, which still saw `seeded` → looped on patch). The fix added `gate_controller_routes.context_on_failure="artifact_api_controller=seed_failed"`.

### Frame 2: Success/Failure Symmetry

**Procedure:** For every node `N`:
1. Enumerate the state-mutating attrs `N` carries: `context_on_success`, `context_on_failure`, `commit_and_push`, `escalate_on`, `reports_to_v` writes, plus `ATTRACTOR_CTX:` writes from its tool output.
2. For each attr, ask: "If `N` reaches the **opposite** outcome (success→fail or fail→success), and the next graph traversal depends on the state this attr writes, what unwinds it?"
3. If nothing unwinds it AND a downstream routing edge depends on the state, file a finding.

**Heuristic shortcut:** any node with `context_on_success` whose key matches a downstream `condition="context.<key>=<value>"` MUST also have either `context_on_failure` writing a non-matching value OR a downstream node whose `context_on_failure` writes a non-matching value.

**Severity:** **P0** when the asymmetric state participates in a `retry_target` loop or `iterate` body routing. **P2** otherwise.

**Example:** the `verify_gate_needs_both_context_paths` validator rule (added 2026-04-16) is one mechanical instance of this frame. The frame generalizes beyond gates to any node-pair coupling.

### Frame 3: Edge Condition Exhaustiveness

**Procedure:** For every diamond and every fan-out from a tool/codergen node with multiple outgoing `condition=` edges:
1. Identify the set of context keys referenced in any outgoing edge condition.
2. Enumerate the cartesian product of values each key has been observed taking (from `context_on_success`/`_on_failure` attrs anywhere in the graph, plus `outcome ∈ {success, fail}`, plus the implicit "unset" value).
3. For each cell of the product, count matching edges:
   - **0 matches** → stuck state. Pipeline halts at the diamond with "no outgoing edge."
   - **1 match** → fine.
   - **≥2 matches with same weight** → non-deterministic routing (engine picks first by insertion order, but author probably didn't realize).
   - **≥2 matches with different weights** → fine, but worth annotating with intent in a comment.
4. Emit a finding per stuck-state cell and per nondeterministic cell.

**Severity:** Stuck states are **P0**. Nondeterministic routing is **P1**. Multi-match deterministic routing without comment is **P3**.

**Example (v9 trap):** `diamond_api_controller_mode` had edges:
```
-> impl_api_controller_patch [condition="context.artifact_api_controller=seeded", weight=2]
-> impl_api_controller_seed  [condition="context.pool_count_reviewer_controller=empty"]
```
Cartesian product: `(artifact ∈ {unset, seeded, seed_failed}) × (pool_count ∈ {empty, non-empty})` = 6 cells.
- `(unset, empty)` → 1 match (seed). OK.
- `(unset, non-empty)` → 0 matches. STUCK.
- `(seeded, empty)` → 2 matches with weight 2 vs default 1 → patch wins. The trap state.
- `(seeded, non-empty)` → 2 matches → patch wins. Probably intended.
- `(seed_failed, empty)` → 1 match (seed). OK.
- `(seed_failed, non-empty)` → 0 matches. STUCK.

The `(unset, non-empty)` and `(seed_failed, non-empty)` stuck-state cells were latent bugs the catalog wouldn't have flagged.

### Frame 4: Tool Exit Code Semantics Audit

**Procedure:** For every tool node:
1. Classify the tool's intended purpose by inspecting `tool_command`, `reports_to_v`, downstream edges, and (where the script is in the local repo) the script's source:
   - **Build/check tool**: exit 0 = pass, exit non-zero = real failure. Examples: `tsc --noEmit`, `npm test`, `eslint`.
   - **Routing-signal tool**: writes `ATTRACTOR_CTX:<key>=...` to stdout; the downstream diamond consumes the key; exit code should be 0 unless the script itself crashed. Examples: `verify-contract.ts`, future category-emitting verify scripts.
   - **Scaffolding tool**: side-effect-only (creates files, runs migrations, installs deps). Exit code matters; output usually doesn't.
2. Cross-reference the classification against the DOT's interpretation:
   - Build/check tool with `retry_target` to a fix node → consistent.
   - Routing-signal tool with `retry_target` to a fix node AND downstream `condition="context.<routing_key>=..."` edges → **inconsistent** (the routing path is unreachable when the script exits non-zero, which is exactly when the routing matters). The verify-contract.ts trap.
   - Scaffolding tool with `reports_to_v` → suspect (scaffolding doesn't produce a convergence signal).
3. For routing-signal tools, attempt to verify the script's actual exit-code semantics. Three modes, tried in order; the first one whose gates all pass wins. Every Frame 4 finding records which mode fired as its `confidence:` tag.
   - **Mode A (`confidence: HIGH`)**: read the script and report actual semantics. Gates — ALL must hold:
     - a. Script path resolves within the current working repo (not a remote URL, not a tool binary on PATH).
     - b. File ≤ 200 LOC.
     - c. ≤ 5 call sites to `process.exit()` / `exit()` / equivalent in the detected language.
     - d. Exit codes are literal integers (no computed / variable exit codes).
     - e. Language is one of: TypeScript, JavaScript, Python, Bash. (Extendable — pick languages the LLM can reliably trace.)
   - **Mode B (`confidence: MEDIUM`)**: source unreachable or fails a Mode A gate, but `tool_command` contains heuristic hints. Recognized hints: chained `&& echo` / `|| echo` sentinels, `ATTRACTOR_CTX:<key>=` substrings embedded in `tool_command`, inline comments in the DOT adjacent to the tool node stating exit-code intent. LLM classifies heuristically using only these hints.
   - **Mode C (`confidence: LOW`)**: neither source nor hints available. The LLM emits a finding of the form "script semantics unverified; reasoning from downstream wiring only" and reports whether the routing diamond has what it needs under *both* exit-0 and exit-nonzero cases. A Mode C finding is **not auto-actionable**; the worker flags it for manual investigation in `gap_analysis.md`.

   Log the gate outcome explicitly in `gap_analysis.md` so the rubric never looks authoritative when it's guessing:

   ```markdown
   #### Frame 4 attempt for verify-contract.ts
   - Script path resolved: ✓ (packages/attractor/scripts/verify-contract.ts)
   - Size: 510 LOC (limit 200) — ✗
   - Mode A SKIPPED. Falling back to Mode B (heuristic).
   - tool_command hint found: `ATTRACTOR_CTX:contract_violation_category=` → routing-signal tool.
   - Confidence: MEDIUM.
   ```

**Severity:** Routing-signal tool with conflicting wiring → **P0** at Mode A/B confidence; **P0 flagged manual-investigation** at Mode C. Build/check tool wired as routing-signal → **P0**. Suspect scaffolding `reports_to_v` → **P2**. Severity is independent of `confidence:` — low confidence means "verify before acting," not "downgrade the bug."

### Frame 5: Loop Convergence Proof Obligation

**Procedure:** Run Tarjan's SCC on the directed graph. For every non-trivial SCC (size ≥ 2 or self-loop):
1. Identify the SCC's "convergence signal" — the mechanism by which a strict subset of the SCC's nodes can produce a different outcome on iteration N+1 than on iteration N. Recognized signals (mechanical only — the attractor parser does not expose inline DOT comments, so comment-based convergence markers are not detectable; a future `convergence_proof="..."` attribute is a cleaner way to let authors suppress false-positives and is tracked as a follow-up rather than a frame feature):
   - SCC contains an `iterate` node (`class="iterate"`) with `convergence_epsilon > 0` and `until` predicate.
   - SCC contains a codergen node with `model_ladder` + `ladder_advance_on=rollback`.
   - Any SCC member's `context_keys=` attr includes `__pool_findings__` (pool grows; fix scope changes per iteration).
   - Any SCC member's `context_keys=` attr includes `__fix_attempt_history` (fix node sees prior failed attempts).
   - Any SCC member's `context_keys=` attr includes `__last_failure_output` (failure-driven loop — fix node sees the last tool's stderr/stdout). Legitimate pattern; without this check, every retry loop would false-positive.
2. If NO signal is found, file a finding: the SCC is a budget-bounded loop with no information-injection mechanism — it will deterministically plateau until `max_visits` ends it.

**Severity:**
- SCC with no convergence signal AND on a `retry_target` path (budget-bounded plateau — the loop will deterministically run to `max_visits` while producing zero new signal per iteration; wastes the full budget silently) → **P0**.
- SCC with no convergence signal NOT on a `retry_target` path (no amplifier effect; plateau is visible to the author on the first re-entry) → **P1**.
- SCC with `model_ladder` only (no fresh information per iteration beyond model swap) → **P2** (works but burns budget; flag as "budget-bounded ladder loop").

**Note on iterate bodies:** the iterate handler's body subgraph IS itself a convergence mechanism (V_total descent, drift detection). So an SCC entirely within an iterate body, contained by an iterate parent with `convergence_epsilon` set, satisfies the proof obligation by construction.

### Frame 6: Counterfactual Outcome Test

**Procedure:** For every node `N`:
1. Construct the counterfactual: "What if `N` returned SUCCESS without producing its expected side effect?" (For codergen: file not written / file written incorrectly. For tool: script no-op'd. For reviewer: no findings emitted despite real defects.)
2. Identify the downstream guards that would catch this:
   - Tool node downstream that mechanically checks the artifact (`gate_X` reading the file).
   - `allowed_paths` post-execution check (engine verifies files written are within the allowlist; does NOT verify they were written).
   - A future `expected_paths` attribute (proposed in [open question 1](#open-questions)) that would assert minimum files written.
   - Reviewer in a downstream phase that would flag the missing artifact.
3. If the only guard is "the next codergen would notice" (i.e., a transitive guard, not a direct one), file a finding: silent-failure trap class.

**Severity:** No direct guard → **P1**. Transitive guard only → **P2** (works in happy path, fails open under silent regress).

**Example:** `impl_api_controller_seed` returning success-with-no-file was caught only by `gate_controller_routes` reading the file path — but the gate's failure didn't unwind the artifact flag (Frame 2's symmetry issue), so the catch became a trap. Frame 6 flags the seed node for relying on a downstream gate as its ONLY counterfactual guard, and Frame 2 flags the gate for failing to unwind.

### Companion script architecture

Source at `extension/src/plumbus-frame-analyzer.ts`, compiled (by the existing `npx tsc` step in `install.sh`) to `extension/bin/plumbus-frame-analyzer.js`, deployed to `~/.claude/pickle-rick/extension/bin/plumbus-frame-analyzer.js`. It:

- Discovers the attractor parser's local clone using the same three-step pattern `plumbus.md` uses for the validator: `$ATTRACTOR_ROOT` env var → `../attractor/` relative path → `find ~/loanlight -maxdepth 2` wildcard. Parser entry point is `packages/attractor/src/parser.ts` which exports `parse(source: string): Graph` and the `Graph` / `Node` / `Edge` interfaces. Imports the parser via dynamic `import()` off the discovered path.
- Parses the target `.dot` file into a `Graph` object.
- Runs three deterministic analyses:
  - **Context key matrix** (Frame 1, 2): walks all nodes, builds writers/readers per key, returns the matrix. Note: `ATTRACTOR_CTX:<key>=...` patterns inside `tool_command` strings and `${ATTRACTOR_CTX_*}` references inside prompt-body text are opaque to the attractor parser — the analyzer performs a supplementary regex pass over those string fields to populate the matrix.
  - **Diamond routing exhaustiveness** (Frame 3): walks all diamonds and outcome-multi-fan-out tool nodes, enumerates the cartesian product, returns the per-cell match count.
  - **SCC + convergence signals** (Frame 5): Tarjan's SCC (hand-rolled inline, ~80 LOC — extension has zero runtime deps and we want to keep it that way), annotate each SCC with detected convergence signals.
- Outputs JSON to stdout in the schema in A3.

The plumbus worker invokes this once per iteration-1 audit:
```bash
node "${EXTENSION_ROOT}/extension/bin/plumbus-frame-analyzer.js" "${TARGET}" > "${SESSION_ROOT}/frame-analysis.json"
```
Then references the JSON in its prompt context when applying frames 1, 3, 5. Frames 2, 4, 6 are LLM-only (require reasoning about intent and counterfactuals — no purely mechanical analysis suffices).

### Backwards compatibility

- The new rubric section is purely additive; existing patterns and rules are unchanged.
- Plumbus Override 6 is gated on `## Generative Findings` not yet existing in `gap_analysis.md`, so re-runs against partially-analyzed sessions don't re-do the work.
- The companion script falls back gracefully: if the script can't be located (e.g. running plumbus against a `.dot` outside this repo with no extension installed), the worker logs a notice and applies frames 1, 3, 5 manually with reduced confidence.

## Open Questions — Resolutions

All five original open questions resolved during validation. Kept here as decision record rather than live questions.

1. **`expected_paths` codergen attribute** → **Resolved: ship as sibling attractor PRD.** Opt-in, comma-separated paths. Post-codergen, the engine walks `expected_paths`, checks existence in workspace, and on miss converts outcome to FAIL with `failure_reason="expected_path_missing: <path>"` and populates `__last_failure_output` so `retry_target` sees the gap. Paired validator rule `expected_paths_subset_of_allowed_paths` enforces that every expected path is writable per the allowlist (otherwise the gate is unsatisfiable by construction). Patch-style nodes that legitimately no-op stay opt-out. Tracked at `attractor/docs/prd/expected-paths-codergen-attribute.md`. Plumbus Frame 6 ships LLM-only; deterministic mode lights up automatically when the attractor attribute lands and authors start declaring it (see §Priority P2).

2. **Frame 1 engine-prefix handling** → **Resolved via A6 registry.** Ship `extension/data/engine-injected-keys.json` with `engine_keys` (literal), `engine_key_patterns` (glob), and `user_written_patterns` (the `artifact_*` class the engine does NOT auto-set — author convention writes them via `context_on_success`). Frame 1 and Frame 2 both load the registry so the classification is consistent. Side benefit: centralizes documentation of engine-injected keys that is currently scattered across handler trap-doors.

3. **Promote `scc_without_convergence_signal` to a validator rule** → **Resolved: yes, file a follow-up ticket.** Mechanical signals only (the set in Frame 5 step 1 — `iterate`/`model_ladder`/`__pool_findings__`/`__fix_attempt_history`/`__last_failure_output`). Severity **WARNING** (not ERROR) to acknowledge false-positive risk on legitimate-but-unusual loops. Suppression path is a future `convergence_proof="..."` codergen/iterate attribute — out of scope here, follow-up ticket in the attractor validator track.

4. **Frame 4 source-access limitation** → **Resolved via the three-mode gate in the Frame 4 procedure.** `confidence: HIGH | MEDIUM | LOW` tag records which mode fired. Rubric logs the gate outcome explicitly in `gap_analysis.md` so the rubric never looks authoritative when it's guessing. Mode C findings are flagged manual-investigation, not auto-actionable.

5. **Frame interaction (multi-lens echo vs dedup)** → **Resolved via A5 clustering.** Not a binary "dedup vs keep separate" — cluster. Each frame emits raw findings with a `cluster_key`; findings with matching keys collapse into one `### Multi-frame finding` bullet with lenses as sub-bullets. Cluster severity = max(member severities). Worker priority queue references clusters, not raw findings — fix once, all lenses clear on re-walk. Educational benefit of three-lens reporting preserved; noise-inflation of three-times-fixing-the-same-bug eliminated.

### Surfaced During Validation — Also Resolved

6. **Dedup ordering rule** (validation question) → folded into A5. Cluster fix = "the most actionable member" (operationalized as: Frame 2's symmetry fix wins when Frames 1+2+6 co-fire; Frame 3's cartesian-cell fix wins for stuck-state clusters; Frame 4's tool-wiring fix wins for its own clusters).

7. **Frame 4 step 3 feasibility gate** (validation question) → folded into Q4 / Frame 4 procedure. The five Mode A gates (path resolves in-repo, ≤200 LOC, ≤5 exit call sites, literal exit codes, recognized language) ARE the feasibility gate. When Mode A's gates fail the worker drops to Mode B or C — no pretending Mode-A precision the worker couldn't actually produce.

8. **Degraded mode when companion script is unavailable** (validation question) → folded into A4 `analysis_mode:` + A7 verification protocol. The bug's truth value is independent of how it was found, so severity does NOT downgrade when the analyzer is missing. Instead, the finding is tagged `analysis_mode: llm-only`, and the worker runs a targeted verification pass (A7) before acting. If verification confirms → act at original severity. If verification disagrees → downgrade to P3 and record the disagreement. This preserves high-signal findings even without the companion script.

## Priority

**P0** — ship Frames 1 (Context Key Lifecycle), 2 (Symmetry), 3 (Edge Exhaustiveness), and 4 (Exit Code). Coverage mapping against §Problem:

| Trap class | Frames that fire | Notes |
|---|---|---|
| Silent-success trap (asymmetric flag) | 1 (P0 asymmetric writer) + 2 (P0 missing failure unwinding) | Multi-lens by design; collapses into a single `### Multi-frame finding` cluster per A5 |
| Contract-verify exit-code mismatch | 4 (P0 routing-signal tool with retry_target) | Frame 4 is the only frame that reasons about tool contracts |
| Diamond locked-on-patch (stuck/latent cells) | 3 (P0 stuck cell, P1 nondeterministic overlap) | Frame 1+2 do NOT catch this — it's a cartesian-product property, not a key-lifecycle property |
| Drift detection blindspot | none — out of scope | Dynamics/convergence class; addressed by attractor schema additions in `pickle-dot-patterns.md`, not by generative frames |

Companion script ships in the P0 batch so the LLM isn't doing Tarjan's SCC or cartesian-product enumeration in its head.

**P1** — Frame 5 (Loop Convergence Proof Obligation). Mechanical (Tarjan's SCC is already computed for Frame 3's companion-script output), high-signal on the budget-bounded-plateau class. Not blocking the §Problem fixes but hardens the loop-design surface; ship once P0 is stable and authors are using the audit pass.

**P2** — Frame 6 (Counterfactual Outcome). Ships in LLM-only mode immediately (no dependency on attractor changes); deterministic mode lights up automatically once the `expected_paths` codergen attribute lands via the sibling attractor PRD (`attractor/docs/prd/expected-paths-codergen-attribute.md`, Q1). Frame 6 does NOT block on that PRD — the LLM-only path is good enough to catch the silent-failure-trap class when paired with Frame 2's symmetry check via A5 clustering.

Out-of-scope: auto-promoting Generative Findings to named validator rules; teaching the rubric to suggest the precise validator-rule code for a finding pattern; cross-pipeline learning of the kind described in `docs/prd/self-healing-diagnose-route.md` Phase 3 over in attractor; the drift-detection class (lives in the attractor schema track).
