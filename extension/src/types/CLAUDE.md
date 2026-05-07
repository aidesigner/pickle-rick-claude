## Trap Doors

- `activity-events.schema.json` — INVARIANT: refinement event catalogs must mirror the schema's required top-level and `gate_payload` fields. BREAKS: analyst prompts emit invalid AC payload contracts. ENFORCE: `spawn-refinement-team` prompt test coverage. PATTERN_SHAPE: activity-event docs table listing payload keys for schema-backed events.
- `index.ts` — INVARIANT: `State.effort` values must stay aligned with setup CLI and codex spawn unions, including `xhigh`. BREAKS: persisted effort overrides are rejected or dropped before codex argv emission. ENFORCE: setup/backend-spawn/spawn-morty effort regression tests. PATTERN_SHAPE: `'low' | 'medium' | 'high'` union guarding `state.effort` or `VALID_EFFORTS`.
