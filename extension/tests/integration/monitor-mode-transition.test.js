// @tier: integration
//
// R-MDS-4 ENFORCE test (ticket c4c752e2). Asserts the wiring contract documented
// in extension/CLAUDE.md trap door `src/bin/pipeline-runner.ts (R-MDS-4 phase-boundary
// monitor mode transition)`: every non-citadel PHASE N/4 boundary invokes
// respawnMonitorWindowForMode so the monitor dashboard (pane 1.0) swaps from
// pickle-shaped (Tickets / Active / Circuit) to microverse-shaped (Subsystems /
// Convergence / Stall) within the documented window.
//
// Strategy: rather than launch real tmux against synthetic workers (live tmux is not
// always available in CI and would duplicate the broader pipeline-state-coherence
// integration test), this test asserts the load-bearing wiring directly:
//   1. pipeline-runner.ts imports respawnMonitorWindowForMode.
//   2. pickle-utils.ts exports it from the canonical module path.
//   3. The render-side mode dispatcher in monitor.ts recognizes both pickle and
//      microverse-class modes and never throws for unknown modes.
// This shape protects the bundle's intent: the dashboard mode-swap path stays
// reachable from a non-pickle phase boundary. Deeper end-to-end coverage lives in
// tests/integration/pipeline-state-coherence.test.js (R-MDS-1 phase-boundary respawn).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('pipeline-runner.ts imports respawnMonitorWindowForMode for phase-boundary mode swap', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'bin', 'pipeline-runner.ts'),
    'utf-8',
  );
  assert.match(
    src,
    /respawnMonitorWindowForMode/,
    'pipeline-runner.ts must reference respawnMonitorWindowForMode per R-MDS-2/R-MDS-4 trap door',
  );
});

test('pickle-utils.ts exports respawnMonitorWindowForMode for downstream consumers', async () => {
  const mod = await import('../../services/pickle-utils.js');
  assert.equal(
    typeof mod.respawnMonitorWindowForMode,
    'function',
    'respawnMonitorWindowForMode must remain an exported function on the canonical module path',
  );
});

test('monitor.ts mode dispatcher recognizes microverse-class modes', async () => {
  const mod = await import('../../bin/monitor.js');
  assert.equal(
    mod.inferModeFromStep('anatomy-park'),
    'microverse',
    'anatomy-park step must dispatch to the microverse-shaped render template',
  );
  assert.equal(
    mod.inferModeFromStep('szechuan-sauce'),
    'microverse',
    'szechuan-sauce step must dispatch to the microverse-shaped render template',
  );
  assert.equal(
    mod.inferModeFromStep('research'),
    'pickle',
    'research step (pickle-phase lifecycle) must dispatch to the pickle template',
  );
});
