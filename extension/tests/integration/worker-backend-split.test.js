// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildManagerInvocation, buildWorkerInvocation, resolveBackend, resolveWorkerBackendFromStateFile } from '../../services/backend-spawn.js';
import { buildRefinementWorkerInvocation } from '../../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../../bin/spawn-morty.js');

function makeTmpDir(prefix = 'pickle-worker-backend-split-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function writeShim(shimDir, name, logPath) {
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = path.join(shimDir, name);
  fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  bin: ${JSON.stringify(name)},
  argv: process.argv.slice(2),
  pickle_backend: process.env.PICKLE_BACKEND || null,
  pickle_refinement_lock: process.env.PICKLE_REFINEMENT_LOCK || null
}, null, 2));
process.exit(0);
`);
  fs.chmodSync(shimPath, 0o755);
}

function readActivityEvents(sessionDir, eventName) {
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
  const activity = Array.isArray(state.activity) ? state.activity : [];
  return activity.filter((entry) => entry?.event === eventName);
}

test('worker-backend split: worker uses worker_backend, manager uses backend, refinement lock stays claude', () => {
  const tmpDir = makeTmpDir();
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  const ticketId = 'ticket-001';
  const ticketDir = path.join(sessionDir, ticketId);
  const repoDir = path.join(tmpDir, 'repo');
  const shimDir = path.join(tmpDir, 'bin');
  const codexLog = path.join(tmpDir, 'codex-shim.json');
  const claudeLog = path.join(tmpDir, 'claude-shim.json');

  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    backend: 'claude',
    worker_backend: 'codex',
    current_ticket: ticketId,
    working_dir: repoDir,
    iteration: 1,
    max_iterations: 5,
    schema_version: 1,
  }));
  writeShim(shimDir, 'codex', codexLog);
  writeShim(shimDir, 'claude', claudeLog);

  const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
    'implement thing',
    '--ticket-id', ticketId,
    '--ticket-path', ticketDir,
    '--timeout', '30',
  ], {
    env: {
      ...process.env,
      EXTENSION_DIR: tmpDir,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
      PICKLE_BACKEND: '',
    },
    encoding: 'utf-8',
    timeout: 45000,
  });

  assert.equal(result.status, 1, 'spawn-morty exits 1 in shim harness after spawn validation');
  assert.equal(fs.existsSync(codexLog), true, 'worker spawn should invoke codex');

  const workerResolved = resolveWorkerBackendFromStateFile(path.join(sessionDir, 'state.json'));
  assert.equal(workerResolved.backend, 'codex');
  assert.equal(workerResolved.source, 'worker_backend');
  assert.equal(buildWorkerInvocation(workerResolved.backend, { prompt: 'x', addDirs: [] }).cmd, 'codex');

  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
  assert.equal(resolveBackend(state), 'claude');
  assert.equal(buildManagerInvocation(resolveBackend(state), { prompt: 'x', addDirs: [] }).cmd, 'claude');

  const workerBackendEvents = readActivityEvents(sessionDir, 'worker_backend_resolved');
  assert.ok(workerBackendEvents.length >= 1);
  assert.equal(workerBackendEvents[0].backend, 'claude');
  assert.equal(workerBackendEvents[0].worker_backend, 'codex');
  assert.equal(workerBackendEvents[0].source, 'worker_backend');

  const spawnResolvedEvents = readActivityEvents(sessionDir, 'worker_spawn_backend_resolved');
  assert.equal(spawnResolvedEvents.length, 1);
  assert.equal(spawnResolvedEvents[0].backend, 'codex');
  assert.equal(spawnResolvedEvents[0].source, 'state');

  const previous = process.env.PICKLE_REFINEMENT_LOCK;
  process.env.PICKLE_REFINEMENT_LOCK = '1';
  try {
    const locked = resolveWorkerBackendFromStateFile(path.join(sessionDir, 'state.json'));
    assert.equal(locked.backend, 'claude');
    assert.equal(locked.source, 'env_lock');
    assert.equal(buildRefinementWorkerInvocation({ prompt: 'x', addDirs: [], maxTurns: 1, backend: locked.backend }).cmd, 'claude');
  } finally {
    if (previous === undefined) delete process.env.PICKLE_REFINEMENT_LOCK;
    else process.env.PICKLE_REFINEMENT_LOCK = previous;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
