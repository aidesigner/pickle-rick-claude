# Conformance

- Explicit `--worker-timeout` remains the only path that persists `flags.tier_cap_override.medium.worker_timeout_seconds`.
- Fresh/default setup still persists `state.worker_timeout_seconds`.
- Settings-derived default timeout now has an explicit regression proving override-state cleanliness.
- Focused verification: `node --test tests/setup.test.js` from `extension/` passed.
