---
id: deadf00d
title: "R-WSWA-5-FIXTURE Oversized umbrella ticket with sprawling scope"
status: "In Progress"
priority: High
complexity_tier: large
created: 2026-05-30
updated: "2026-05-30"
---
# Description

## Problem to solve
This ticket spans many subsystems and cannot be completed in a single worker session.
It is intentionally large to trigger the oversized-wedge detection path when a worker
exits clean but produces zero review/conformance artifacts.

## Solution
Refactor the entire data-pipeline stack, update all 40+ downstream consumers, migrate
the database schema, regenerate the client SDKs, update CI workflows, and add
comprehensive integration tests covering every edge case.

## Files to modify
- `extension/src/bin/mux-runner.ts` (forward-created)
- `extension/src/bin/pipeline-runner.ts` (forward-created)
- `extension/src/bin/spawn-morty.ts` (forward-created)
- `extension/src/bin/setup.ts` (forward-created)
- `extension/src/bin/microverse-runner.ts` (forward-created)
- `extension/src/services/state-manager.ts` (forward-created)
- `extension/src/services/pickle-utils.ts` (forward-created)
- `extension/src/services/git-utils.ts` (forward-created)
- `extension/src/services/convergence-gate.ts` (forward-created)
- `extension/src/services/activity-logger.ts` (forward-created)
- `extension/src/types/index.ts` (forward-created)
- `extension/tests/integration/worker-artifact-progress-tracking.test.js` (forward-created)
- `extension/tests/integration/worker-auto-skip-oversized.test.js` (forward-created)

## Acceptance criteria
- [ ] All 40 downstream consumers migrated
- [ ] Schema migration tested against prod-scale dataset
- [ ] CI green on all three platforms
- [ ] Zero lint warnings
- [ ] All integration tests pass
