## Trap Doors

- `activity-events.schema.json` — INVARIANT: refinement event catalogs must mirror the schema's required top-level and `gate_payload` fields. BREAKS: analyst prompts emit invalid AC payload contracts. ENFORCE: `spawn-refinement-team` prompt test coverage. PATTERN_SHAPE: activity-event docs table listing payload keys for schema-backed events.
