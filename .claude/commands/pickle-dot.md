Convert a PRD (Product Requirements Document) into a strongdm/attractor-compatible DOT digraph.

Persona active via CLAUDE.md. **SPEAK BEFORE ACTING**.

## Step 1: Acquire PRD
From `$ARGUMENTS`: file path (contains `/` or `.md`) → read file. Substantial text → use directly. No argument → ask user.

## Step 2: Parse PRD
Extract:
- **Metadata**: project slug (lowercase+underscores), goal (objective statement)
- **Tasks**: ID (`[A-Za-z_][A-Za-z0-9_]*`), description, type (code/review/approval/conditional/parallel), prompt (substantive LLM instruction with PRD context), critical? (P0/acceptance criteria), dependencies, complexity (low/medium/high)
- **Gates**: human review → hexagon, conditional routing → diamond
- **Parallelism**: independent tasks → component fan-out / tripleoctagon fan-in
- **Acceptance criteria**: → `goal_gate=true` markers

## Step 3: Build DAG

**Structure**: exactly one `Mdiamond` start + one `Msquare` exit. All nodes reachable from start. Exit reachable from all non-terminal nodes. No orphans. DAG only (`->`, never `--`).

**Shapes**: Mdiamond=start, Msquare=exit, box=codergen(default), diamond=conditional, hexagon=human gate, component=parallel fan-out, tripleoctagon=parallel fan-in

**Parallel**: every component fan-out MUST have matching tripleoctagon fan-in.
**Conditional**: every diamond MUST have 2+ outgoing edges with `condition` attributes.
**Approval**: hexagon with approved/revise edges.

## Step 4: Generate DOT

Syntax: one `digraph`, bare IDs (`[A-Za-z_][A-Za-z0-9_]*`), `->` only, commas between attrs, double-quoted strings.

```dot
digraph ${SLUG} {
    goal = "${GOAL}"
    label = "${LABEL}"
    default_max_retry = 2
    // model_stylesheet = "* { llm_model: claude-sonnet-4-6; } .critical { llm_model: claude-opus-4-6; reasoning_effort: high; }"
    start [shape=Mdiamond, label="Begin"]
    // nodes with: label, prompt, goal_gate, max_retries, timeout (300s/900s/1800s by complexity), class
    done [shape=Msquare, label="Complete"]
    // edges with: label, condition (for diamond/hexagon), weight (2=happy path)
}
```

Edge conditions: `outcome=success`, `outcome=fail`, `outcome!=success`, `context.KEY=VALUE`, combine with `&&`.

## Step 5: Validate
**Errors** (must fix): single start/exit, no incoming to start, no outgoing from exit, all reachable, exit reachable from all, no orphans, valid targets, diamond has 2+ conditional edges, component↔tripleoctagon paired, valid condition syntax, valid IDs, commas in attrs, quoted strings, `->` only, single digraph.

**Warnings** (should fix): every box has non-empty prompt, happy-path edges higher weight, goal_gate nodes have retry path, no duplicate IDs.

## Step 6: Present & Save
Show DOT in ```dot block. Summary table (nodes by type, edges, goal-gated). Ask where to save (default: `./${SLUG}.dot`). Offer Graphviz render if `dot` available: `dot -Tsvg file.dot -o file.svg`.

## Reference: Condition Language
`ConditionExpr ::= Clause ('&&' Clause)*` where `Clause ::= Key Op Literal`. Keys: `outcome`, `preferred_label`, `context.PATH`. Ops: `=`, `!=`. Status values lowercase: success, fail, partial_success, retry.

## Reference: Shape→Handler
Mdiamond=start, Msquare=exit, box=codergen, hexagon=wait.human, diamond=conditional, component=parallel, tripleoctagon=parallel.fan_in, parallelogram=tool, house=stack.manager_loop

## Reference: Node Attrs
label(String), shape(String,"box"), prompt(String), goal_gate(Boolean,false), max_retries(Integer,0), timeout(Duration), class(String), retry_target(String), fidelity(String)

## Reference: Edge Attrs
label(String), condition(String), weight(Integer,0), fidelity(String)
