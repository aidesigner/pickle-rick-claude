# PRD Authoring Guide

This file documents conventions for authors writing PRDs and tickets under `prds/`.

---

## Forward-Reference Annotation Grammar

When a ticket or PRD references a file path that does not yet exist at `HEAD` (because a sibling ticket in the same bundle will create it), you **must** annotate the backticked path with one of the three canonical forms below. These annotations tell `check-readiness.ts`, `audit-ticket-bundle.ts`, and the pre-flight audit script (`audit-ticket-forward-refs.sh`) that the path is intentionally forward-created, not a typo.

**Regex source of truth**: `extension/src/services/forward-ref-annotation.ts` (R-FRA-6 module — `FORWARD_REF_ANNOTATION_RE`). Enforcement points are in `extension/CLAUDE.md` under trap doors R-RTRC-1, R-RTRC-2, R-RTRC-7, and R-FRA-6.

### Rules

- The annotation goes **outside** the backticks (after the closing backtick).
- There must be **exactly one ASCII space** between the closing backtick and the opening parenthesis.
- Ticket hashes must match `/^[A-Za-z0-9]{6,12}$/` (8-char short SHA or ticket-dir basename are both accepted).

### Form 1 — `(forward-created)`

Use when **this ticket** creates the file and no upstream ticket hash exists yet.

```
`path/to/new-file.ts` (forward-created)
```

**Worked example** (ticket that creates a new service module):

> Files to create:
> - `extension/src/services/forward-ref-annotation.ts` (forward-created)

---

### Form 2 — `(created by ticket <8hex>)`

Use when a **specific upstream ticket** in the same bundle creates the file. Replace `<8hex>` with that ticket's 8-character id.

```
`path/to/new-file.ts` (created by ticket <8hex>)
```

**Worked example** (ticket that consumes a module created by ticket `a1b2c3d4`):

> Files to modify:
> - `extension/src/bin/check-readiness.ts` — import from `extension/src/services/forward-ref-annotation.ts` (created by ticket a1b2c3d4)

---

### Form 3 — `(introduced by ticket <8hex>)`

Synonym of Form 2. Accepted for natural prose flow when "introduced" reads more clearly than "created".

```
`path/to/new-file.ts` (introduced by ticket <8hex>)
```

**Worked example** (same scenario as Form 2, prose variant):

> The predicate in `extension/src/services/forward-ref-annotation.ts` (introduced by ticket a1b2c3d4) must be imported by both `check-readiness.ts` and `audit-ticket-bundle.ts`.

---

### Cross-links

The enforcement points that validate these annotations at runtime are documented as trap doors in `extension/CLAUDE.md`:

- **R-RTRC-1** — `spawn-refinement-team.ts` `PATH_VERIFICATION_PROMPT_SECTION`: analysts receive the same grammar at refinement time.
- **R-RTRC-2** — `check-readiness.ts` `extractContractReferences`: annotated paths are suppressed from `path_not_verified` findings.
- **R-RTRC-7** — `check-readiness.ts` annotation schema: canonical separator, hash, and alias rules.
- **R-FRA-6** — `extension/src/services/forward-ref-annotation.ts`: single source for `FORWARD_REF_ANNOTATION_RE`; both `check-readiness.ts` and `audit-ticket-bundle.ts` import from it.
- **R-FRA-2** — `extension/scripts/audit-ticket-forward-refs.sh`: pre-flight script delegates to the same module.
- **R-FRA-1** — `.claude/commands/pickle-refine-prd.md` Step 7c: refinement skill shows the same reminder.
- **R-RTRC-7 / R-TAQ-2** — `audit-ticket-bundle.ts` `checkPathDrift`: bundle audit accepts the same forms.

---

## Skip-Flag Conventions

When a PRD or ticket needs to bypass the readiness gate and/or the ticket-audit gate, use the **unified** flag only:

```
state.flags.skip_quality_gates_reason: "<non-empty reason string>"
```

A non-empty trimmed string in `skip_quality_gates_reason` is the **single operator-facing quality-gate bypass surface** (W1a). It bypasses every quality gate with one flag:

- the readiness gate (R-QGSK-1),
- the ticket-audit gate (R-TAQ-3),
- the bundle-bootstrap exemption (R-BUNDLE-1 — allowlisted sessions write this flag, not the legacy per-gate reasons), and
- the refinement **AC-shape gate** (`spawn-refinement-team.ts`) — the `--skip-ac-shape-gate "<reason>"` CLI flag folds into the same surface.

The reason is recorded as an audit-trail activity event.

### Conflict-resolution rule (unified wins)

When BOTH the unified flag and a legacy/CLI per-gate flag are present, the **unified `skip_quality_gates_reason` wins**:

- **Read time** — `mux-runner.ts:resolveQualityGateSkipReason` reads the unified flag first; a per-callsite legacy field is consulted **only** when the unified flag is empty.
- **Migration** — `state-manager.ts:migrateLegacySkipQualityGatesFlags` is one-way: when the unified flag is already set it **drops** both legacy fields; when it is empty it **promotes** the first non-empty legacy reason (readiness over ticket-audit) into the unified flag and drops both legacy fields.
- **AC-shape gate** — an explicit `--skip-ac-shape-gate "<reason>"` CLI override wins over the persisted unified flag; otherwise the unified flag bypasses the gate.

### Legacy flags (deprecated — do not use in new tickets)

| Legacy field | Replaces |
|---|---|
| `state.flags.skip_readiness_reason` | readiness gate only |
| `state.flags.skip_ticket_audit_reason` | ticket-audit gate only |

Both legacy flags still work at runtime: `mux-runner.ts` reads them as a fallback (R-QGSK-2) with a deprecation warning, and `state-manager.ts` auto-migrates them into `skip_quality_gates_reason` on the first state read (R-QGSK-3). New PRDs and tickets **MUST** cite `skip_quality_gates_reason`; legacy fields will be removed in a future schema version.

### NOT a quality-gate flag (scoped out)

`state.flags.skip_smoke_gate_reason` (R-CNAR-6) bypasses the **spark-codex backend health gate**, not a quality gate. It is a **distinct** flag and is intentionally NOT collapsed into `skip_quality_gates_reason`.

### Kill-switch

`PICKLE_RECOVERY_CONSOLIDATION=off` reverts the bundle-bootstrap exemption to the legacy per-gate dual-write and disables the AC-shape unified-flag fold-in (CLI flag only). Default (unset / any other value) keeps the single-surface behavior active.

### Source of truth

- Runtime call site: `mux-runner.ts:resolveQualityGateSkipReason` — reads unified flag first, falls back to per-callsite legacy field with `skip_flag_legacy_used` activity event.
- Migration: `state-manager.ts:migrateLegacySkipQualityGatesFlags` — one-way promotion on every `StateManager.read()`.
- AC-shape fold-in: `spawn-refinement-team.ts:runAcShapeEnforcement` — honors the CLI flag then the unified state flag.
- Tests: `extension/tests/state-manager-skip-flags-migration.test.js` (AC-4 a..e), `extension/tests/one-skip-surface.test.js` (W1a single-surface invariants).
