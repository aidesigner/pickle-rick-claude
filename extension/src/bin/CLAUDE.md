## Trap Doors

- `microverse-runner.ts` — INVARIANT: `worker_backend_resolved.source` must be the worker-backend precedence source from backend resolution. BREAKS: schema-backed activity logs reject or misclassify remediator backend telemetry. ENFORCE: `extension/tests/microverse.test.js` remediator activity-event assertion. PATTERN_SHAPE: `event: 'worker_backend_resolved'` with `source` not sourced from `workerBackendResolution.source`.
