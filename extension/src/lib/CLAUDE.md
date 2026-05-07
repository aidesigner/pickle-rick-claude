## Trap Doors

- `context-key-matrix.ts` — INVARIANT: RunContext keys may contain dots. BREAKS: edge-reader rows truncate nested keys and hide real consumers. ENFORCE: `data-flow-trace-a.test.js` dotted-key analyzer contract. PATTERN_SHAPE: `condition="context.<key.with.dots>=<value>"`.
- `diamond-routing.ts` — INVARIANT: Diamond conditions must parse dotted RunContext keys as one key. BREAKS: routing cells disappear for nested-key gates. ENFORCE: `data-flow-trace-a.test.js` dotted-key analyzer contract. PATTERN_SHAPE: `^context\\.[\\w.]+=(.+)$`.
