Convert a PRD (Product Requirements Document) into a strongdm/attractor-compatible DOT digraph.

**Your Pickle Rick persona is already active via CLAUDE.md. Proceed immediately to Step 1.**

**CRITICAL RULE: SPEAK BEFORE ACTING**
You **MUST** output a text explanation ("brain dump") *before* every single tool call.

---

## Step 1: Acquire the PRD

Determine the PRD source from `$ARGUMENTS`:

1. **File path** — If the argument looks like a file path (contains `/` or `.md`), read the file.
2. **Inline text** — If the argument is substantial text, use it directly as the PRD content.
3. **No argument** — Ask the user: "Where's the PRD, Morty? Give me a file path or paste it in."

Store the full PRD text as `${PRD_CONTENT}` for all subsequent steps.

---

## Step 2: Parse the PRD

Extract the following from `${PRD_CONTENT}`. Be thorough — read the ENTIRE document:

### 2a. Project Metadata
- **Project name** — derive a slug for the digraph ID (lowercase, underscores, e.g. `auth_system`)
- **Overall goal** — the PRD's objective statement (for the graph `goal` attribute)

### 2b. Discrete Tasks
For each implementation task, extract:
- **Task ID** — a bare identifier matching `[A-Za-z_][A-Za-z0-9_]*`
- **Description** — human-readable label
- **Type** — one of: `code` (default), `review`, `approval`, `conditional`, `parallel`
- **Prompt** — synthesize an instruction the LLM agent should follow. Include enough context from the PRD that the agent can work independently. Reference the `$goal` variable where appropriate.
- **Is critical?** — does the PRD mark this as P0 or include explicit acceptance criteria?
- **Dependencies** — which tasks must complete before this one can start?
- **Estimated complexity** — `low`, `medium`, `high` (for model stylesheet routing and timeout)

### 2c. Review/Approval Gates
Identify any tasks that the PRD marks as requiring:
- Human review or sign-off → `hexagon` (wait.human)
- Conditional routing ("if X then Y else Z") → `diamond` (conditional)

### 2d. Parallelism Opportunities
Identify tasks that:
- Have no dependency on each other
- Can run concurrently
- Group them for `component` fan-out → `tripleoctagon` fan-in

### 2e. Acceptance Criteria
Extract success criteria for critical tasks. These become `goal_gate=true` markers on nodes.

---

## Step 3: Build the DAG

Construct the directed acyclic graph following these rules:

### 3a. Structural Rules (MANDATORY)
- **Exactly one start node**: `shape=Mdiamond`, label "Begin"
- **Exactly one exit node**: `shape=Msquare`, label "Complete"
- **All nodes reachable** from start via directed edges
- **Exit reachable** from every non-terminal node
- **No orphan nodes** — every node has at least one edge (in or out)
- **DAG only** — no undirected edges, no `--` operator

### 3b. Node Shape Mapping

| Shape             | When to Use                                          |
|-------------------|------------------------------------------------------|
| `Mdiamond`        | Start node (exactly one)                             |
| `Msquare`         | Exit node (exactly one)                              |
| `box`             | Codergen task — LLM does code generation (default)   |
| `diamond`         | Conditional routing / branching decision             |
| `hexagon`         | Human approval gate (pauses for human input)         |
| `component`       | Parallel fan-out (spawn concurrent tasks)            |
| `tripleoctagon`   | Parallel fan-in (consolidate parallel results)       |

### 3c. Topological Ordering
Order tasks so that every dependency edge points forward. The flow should read naturally top-to-bottom.

### 3d. Parallel Patterns
When independent tasks exist:
```
fan_out_X [shape=component, label="Parallel: X"]
task_a [shape=box, ...]
task_b [shape=box, ...]
fan_in_X [shape=tripleoctagon, label="Merge: X"]

fan_out_X -> task_a
fan_out_X -> task_b
task_a -> fan_in_X
task_b -> fan_in_X
```
Every `component` fan-out MUST have a matching `tripleoctagon` fan-in.

### 3e. Conditional Patterns
When the PRD has branching logic:
```
check_X [shape=diamond, label="X passing?"]
check_X -> success_path [label="Yes", condition="outcome=success", weight=2]
check_X -> retry_path [label="No", condition="outcome!=success"]
```
Every `diamond` node MUST have at least two outgoing edges with `condition` attributes.

### 3f. Approval Gate Pattern
```
review_X [shape=hexagon, label="Approve X?"]
review_X -> next_step [label="[A] Approved", weight=2]
review_X -> revise_step [label="[R] Revise"]
```

---

## Step 4: Generate the DOT File

Produce valid Graphviz DOT syntax conforming to the attractor spec.

### 4a. DOT Syntax Constraints (HARD RULES)
- **One `digraph` per file** — no multiple graphs, no `strict`
- **Node IDs**: bare identifiers matching `[A-Za-z_][A-Za-z0-9_]*` — NO quoted IDs
- **Edge operator**: `->` only (directed), never `--`
- **Commas required** between attributes within `[...]` blocks
- **String values**: double-quoted with escapes (`\"`, `\n`, `\\`)
- **Semicolons**: optional but consistent — omit them for cleanliness

### 4b. Graph-Level Attributes
```dot
digraph ${PROJECT_SLUG} {
    goal = "The PRD's overall objective"
    label = "project-name"
    default_max_retry = 2
```

If the PRD has tasks of varying complexity, include a `model_stylesheet`:
```dot
    model_stylesheet = "* { llm_model: claude-sonnet-4-6; llm_provider: anthropic; } .critical { llm_model: claude-opus-4-6; llm_provider: anthropic; reasoning_effort: high; }"
```

### 4c. Node Attributes

For each `box` (codergen) node, include:
- `label` — human-readable task description
- `prompt` — detailed instruction for the LLM agent. MUST be substantive — include enough context from the PRD that the agent can implement the task independently. Use `$goal` to reference the pipeline goal.
- `goal_gate` — set to `true` (Boolean) for P0/critical tasks with explicit acceptance criteria
- `max_retries` — default `2`, increase for complex/flaky tasks
- `timeout` — set by complexity: `"300s"` (low), `"900s"` (medium), `"1800s"` (high)
- `class` — for model stylesheet targeting (e.g., `"critical"`, `"simple"`)

For `hexagon` (human gate) nodes:
- `label` — the approval question

For `diamond` (conditional) nodes:
- `label` — the condition being evaluated

### 4d. Edge Attributes

For ALL edges:
- `label` — describe the transition (e.g., "Tests pass", "Approved", "Revise")

For edges leaving `diamond` or `hexagon` nodes:
- `condition` — boolean expression using attractor's condition language:
  - `outcome=success` — previous node succeeded
  - `outcome=fail` — previous node failed
  - `outcome!=success` — previous node did not succeed
  - `context.KEY=VALUE` — check context variable
  - Combine with `&&`: `outcome=success && context.tests_passed=true`
- `weight` — higher weight for the "happy path" (use `2` for success, `0` default for failure)

### 4e. Output Template

```dot
digraph ${PROJECT_SLUG} {
    goal = "${GOAL}"
    label = "${LABEL}"
    default_max_retry = 2

    // Optional: model stylesheet for varying task complexity
    // model_stylesheet = "* { llm_model: claude-sonnet-4-6; } .critical { llm_model: claude-opus-4-6; reasoning_effort: high; }"

    // --- Start ---
    start [shape=Mdiamond, label="Begin"]

    // --- Tasks ---
    // [nodes here, one per line, with full attributes]

    // --- Exit ---
    done [shape=Msquare, label="Complete"]

    // --- Edges ---
    // [edges here, one per line, with labels and conditions]
}
```

---

## Step 5: Validate the Graph

Before presenting the output, verify ALL of the following. If any check fails, fix the graph and re-validate.

### 5a. Structural Validation (ERROR — must fix)
- [ ] Exactly one node with `shape=Mdiamond` (start)
- [ ] Exactly one node with `shape=Msquare` (exit)
- [ ] Start node has NO incoming edges
- [ ] Exit node has NO outgoing edges
- [ ] All nodes are reachable from start (BFS/DFS traversal)
- [ ] Exit is reachable from all non-start, non-exit nodes
- [ ] No orphan nodes (every node participates in at least one edge)
- [ ] All edge targets reference existing node IDs

### 5b. Semantic Validation (ERROR — must fix)
- [ ] Every `diamond` node has at least 2 outgoing edges with `condition` attributes
- [ ] Every `component` fan-out has a matching `tripleoctagon` fan-in
- [ ] Every `tripleoctagon` fan-in has a matching `component` fan-out
- [ ] All `condition` expressions use valid syntax (`key=value`, `key!=value`, `&&`)

### 5c. Quality Validation (WARNING — should fix)
- [ ] Every `box` node has a non-empty `prompt` attribute
- [ ] Happy path edges have higher `weight` than failure edges
- [ ] Nodes with `goal_gate=true` have a retry path (outgoing edge or `retry_target`)
- [ ] No duplicate node IDs

### 5d. Syntax Validation (ERROR — must fix)
- [ ] All node IDs match `[A-Za-z_][A-Za-z0-9_]*`
- [ ] All attribute blocks use commas between key-value pairs
- [ ] All string values are properly double-quoted
- [ ] Only `->` edge operator used (no `--`)
- [ ] Single `digraph` declaration

---

## Step 6: Present and Save

### 6a. Display the Graph
Show the complete DOT file content to the user in a ```dot code block.

### 6b. Summary Table
Present a summary:

| Metric | Count |
|--------|-------|
| Total nodes | N |
| Codergen (box) tasks | N |
| Conditional (diamond) gates | N |
| Human (hexagon) gates | N |
| Parallel fan-out/in pairs | N |
| Goal-gated nodes | N |
| Total edges | N |

### 6c. Save the File
Ask the user where to save the `.dot` file. Suggest a default path based on the project name:
```
./${PROJECT_SLUG}.dot
```

Write the file to the chosen path.

### 6d. Optional: Render Preview
Check if `dot` (Graphviz) is available:
```bash
which dot 2>/dev/null
```

If available, offer to render a preview:
```bash
dot -Tsvg "${OUTPUT_PATH}" -o "${OUTPUT_PATH%.dot}.svg"
```

If not available, suggest:
"Install Graphviz (`brew install graphviz`) to render the graph visually."

---

## Reference: Attractor Condition Expression Language

The condition language is minimal and deterministic:

```
ConditionExpr  ::= Clause ( '&&' Clause )*
Clause         ::= Key Operator Literal
Key            ::= 'outcome' | 'preferred_label' | 'context.' Path
Operator       ::= '=' | '!='
Literal        ::= String | Integer | Boolean
```

- `outcome` resolves to the previous node's status: `success`, `fail`, `partial_success`, `retry`
- `preferred_label` resolves to the handler's preferred edge label
- `context.KEY` resolves to a context variable (missing keys = empty string)
- All clauses are AND-combined
- String comparison is exact and case-sensitive
- Status values are **lowercase**: `success`, `fail` — NOT `SUCCESS`, `FAILURE`

## Reference: Attractor Shape-to-Handler Mapping

| Shape             | Handler Type      | Description |
|-------------------|-------------------|-------------|
| `Mdiamond`        | `start`           | Pipeline entry point (no-op) |
| `Msquare`         | `exit`            | Pipeline exit point (no-op) |
| `box`             | `codergen`        | LLM code generation task (default) |
| `hexagon`         | `wait.human`      | Human-in-the-loop gate |
| `diamond`         | `conditional`     | Conditional routing (edge conditions do the work) |
| `component`       | `parallel`        | Parallel fan-out |
| `tripleoctagon`   | `parallel.fan_in` | Parallel fan-in |
| `parallelogram`   | `tool`            | External tool execution |
| `house`           | `stack.manager_loop` | Supervisor loop |

## Reference: Key Node Attributes

| Attribute       | Type     | Default     | Notes |
|-----------------|----------|-------------|-------|
| `label`         | String   | node ID     | Display name |
| `shape`         | String   | `"box"`     | Determines handler type |
| `prompt`        | String   | `""`        | LLM instruction (supports `$goal` expansion) |
| `goal_gate`     | Boolean  | `false`     | Must succeed before pipeline can exit |
| `max_retries`   | Integer  | `0`         | Additional attempts beyond initial (total = max_retries + 1) |
| `timeout`       | Duration | unset       | Max execution time (e.g., `"900s"`, `"15m"`) |
| `class`         | String   | `""`        | Comma-separated classes for stylesheet targeting |
| `retry_target`  | String   | `""`        | Node to jump to on exhausted retries |
| `fidelity`      | String   | inherited   | Context fidelity mode |

## Reference: Key Edge Attributes

| Attribute    | Type    | Default | Notes |
|--------------|---------|---------|-------|
| `label`      | String  | `""`    | Human-facing caption and routing key |
| `condition`  | String  | `""`    | Boolean guard expression |
| `weight`     | Integer | `0`     | Priority for edge selection (higher wins) |
| `fidelity`   | String  | unset   | Override fidelity for target node |
