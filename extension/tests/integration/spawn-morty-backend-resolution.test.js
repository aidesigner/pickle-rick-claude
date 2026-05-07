// @tier: integration
// R-XBL-2 — single source of truth for backend resolution at spawn time.
// Verifies: (1) state.backend is read at exec time via StateManager.read
// (recoverable, dead-pid-aware); (2) `--backend <name>` CLI flag overrides
// state/env and emits worker_spawn_backend_override activity event; (3)
// PICKLE_REFINEMENT_LOCK=1 sentinel forces 'claude' even with --backend codex;
// (4) malformed `--backend` value exits 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../../bin/spawn-morty.js');
const ACTIVITY_EVENT_SCHEMA_PATH = path.resolve(__dirname, '../../src/types/activity-events.schema.json');
const ACTIVITY_EVENT_SCHEMA = JSON.parse(fs.readFileSync(ACTIVITY_EVENT_SCHEMA_PATH, 'utf-8'));

function makeTmpDir(prefix = 'pickle-xbl2-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writePickleSettings(extensionDir, settings) {
  fs.writeFileSync(path.join(extensionDir, 'pickle_settings.json'), JSON.stringify(settings, null, 2));
}

function writeTicketFile(ticketDir, ticketId, complexityTier = 'large') {
  const content = `---
id: ${ticketId}
title: Backend routing mismatch fixture
priority: Medium
complexity_tier: ${complexityTier}
---

## Test Fixture

This ticket drives routing-path regression coverage.
`;
  const ticketFile = path.join(ticketDir, `linear_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketFile, content);
  return ticketFile;
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
  pickle_refinement_lock: process.env.PICKLE_REFINEMENT_LOCK || null,
}, null, 2));
process.exit(0);
`);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function makeHarness({ stateBackend = 'codex', extras = {} } = {}) {
  const tmpDir = makeTmpDir();
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'session');
  const ticketId = 'ticket-001';
  const ticketDir = path.join(sessionDir, ticketId);
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    backend: stateBackend,
    working_dir: repoDir,
    iteration: 1,
    max_iterations: 5,
    schema_version: 1,
    ...extras,
  }));
  const shimDir = path.join(tmpDir, 'bin');
  const shimLogs = {
    codex: path.join(tmpDir, 'codex-shim.json'),
    claude: path.join(tmpDir, 'claude-shim.json'),
    hermes: path.join(tmpDir, 'hermes-shim.json'),
  };
  writeShim(shimDir, 'codex', shimLogs.codex);
  writeShim(shimDir, 'claude', shimLogs.claude);
  writeShim(shimDir, 'hermes', shimLogs.hermes);
  return { tmpDir, sessionDir, ticketDir, ticketId, repoDir, shimDir, shimLogs };
}

function runMorty(harness, args, env = {}) {
  return spawnSync(process.execPath, [SPAWN_MORTY_BIN,
    'do the thing',
    '--ticket-id', harness.ticketId,
    '--ticket-path', harness.ticketDir,
    '--timeout', '30',
    ...args,
  ], {
    env: {
      ...process.env,
      EXTENSION_DIR: harness.tmpDir,
      PATH: `${harness.shimDir}${path.delimiter}${process.env.PATH || ''}`,
      PICKLE_BACKEND: '',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 45000,
  });
}

function readActivityEvents(sessionDir, eventName) {
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
  const activity = Array.isArray(state.activity) ? state.activity : [];
  return activity.filter((entry) => entry?.event === eventName);
}

function resolveSchemaRef(ref) {
  return ACTIVITY_EVENT_SCHEMA.definitions[ref.replace('#/definitions/', '')];
}

function validateActivityEventAgainstSchema(payload, defName) {
  const def = ACTIVITY_EVENT_SCHEMA.definitions[defName];
  assert.ok(def, `missing schema definition for ${defName}`);
  for (const field of def.required ?? []) {
    assert.ok(field in payload, `${defName}: missing required field ${field}`);
  }
  for (const [field, rawProp] of Object.entries(def.properties ?? {})) {
    if (!(field in payload)) continue;
    const prop = rawProp.$ref ? resolveSchemaRef(rawProp.$ref) : rawProp;
    const value = payload[field];
    if (Array.isArray(prop.type)) {
      const matchesType = prop.type.some((typeName) => {
        if (typeName === 'null') return value === null;
        if (typeName === 'integer') return Number.isInteger(value);
        return typeof value === typeName;
      });
      assert.ok(matchesType, `${defName}.${field}: value ${JSON.stringify(value)} does not match ${prop.type.join('|')}`);
    } else if (prop.type === 'integer') {
      assert.ok(Number.isInteger(value), `${defName}.${field}: expected integer, got ${JSON.stringify(value)}`);
    } else if (prop.type === 'string') {
      assert.equal(typeof value, 'string', `${defName}.${field}: expected string, got ${typeof value}`);
    }
    if (Array.isArray(prop.enum)) {
      assert.ok(prop.enum.includes(value), `${defName}.${field}: ${JSON.stringify(value)} not in enum ${prop.enum.join(',')}`);
    }
  }
}

function which(harness) {
  // Determine which shim was invoked by checking the log files.
  const invoked = [];
  for (const [backend, logPath] of Object.entries(harness.shimLogs)) {
    if (fs.existsSync(logPath)) invoked.push({ backend, log: JSON.parse(fs.readFileSync(logPath, 'utf-8')) });
  }
  return invoked;
}

// NOTE: spawn-morty exits 1 on the shim path because the shim does not emit
// WORKER_DONE or write a lifecycle artifact — that is downstream worker
// validation, not the backend-resolution surface this test gates. Assert on
// spawn evidence (shim log + activity event) which is written BEFORE the
// validation failure exits the process.

test('R-XBL-2: state.backend=codex with no override spawns codex (state SoT)', () => {
  const harness = makeHarness({ stateBackend: 'codex' });
  try {
    runMorty(harness, []);
    const invoked = which(harness);
    assert.equal(invoked.length, 1, `expected exactly one shim invoked; got ${JSON.stringify(invoked.map(i => i.backend))}`);
    assert.equal(invoked[0].backend, 'codex');
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].backend, 'codex');
    assert.equal(resolved[0].source, 'state');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-2: --backend hermes overrides state.backend=codex and emits override event', () => {
  const harness = makeHarness({ stateBackend: 'codex' });
  try {
    runMorty(harness, ['--backend', 'hermes']);
    const invoked = which(harness);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].backend, 'hermes');
    const overrides = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_override');
    assert.equal(overrides.length, 1, 'expected one worker_spawn_backend_override event');
    assert.equal(overrides[0].backend, 'hermes');
    assert.equal(overrides[0].source, 'cli-flag-override');
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved[0].source, 'cli-flag-override');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-2: PICKLE_REFINEMENT_LOCK=1 forces claude even with --backend codex', () => {
  const harness = makeHarness({ stateBackend: 'codex' });
  try {
    runMorty(harness, ['--backend', 'codex'], { PICKLE_REFINEMENT_LOCK: '1' });
    const invoked = which(harness);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].backend, 'claude');
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved[0].source, 'refinement-lock');
    const overrides = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_override');
    assert.equal(overrides.length, 0, 'refinement-lock must NOT emit override event');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-2: --backend bogus exits 1 with validation message', () => {
  const harness = makeHarness({ stateBackend: 'codex' });
  try {
    const result = runMorty(harness, ['--backend', 'bogus']);
    assert.equal(result.status, 1, 'expected exit 1');
    assert.ok(/--backend must be one of/.test(result.stderr), `expected validation message; stderr=${result.stderr}`);
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-2: state.backend=hermes spawns hermes (single source of truth)', () => {
  const harness = makeHarness({ stateBackend: 'hermes' });
  try {
    runMorty(harness, []);
    const invoked = which(harness);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].backend, 'hermes');
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved[0].backend, 'hermes');
    assert.equal(resolved[0].source, 'state');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

// NOTE: this test forces mismatch only via the existing heuristic path:
// state.backend=codex + settings heuristic ON + large ticket => resolved claude.
test('backend-spawn-assertion: stale state/backend + heuristic mismatch exits non-zero', () => {
  const harness = makeHarness({ stateBackend: 'codex' });
  writePickleSettings(harness.tmpDir, { enable_backend_routing_heuristic: true });
  const ticketFile = writeTicketFile(harness.ticketDir, harness.ticketId);
  try {
    const result = runMorty(harness, ['--ticket-file', ticketFile]);
    assert.equal(result.status, 1);
    const invoked = which(harness);
    assert.equal(invoked.length, 0, `expected spawn-block before exec; got ${JSON.stringify(invoked.map(i => i.backend))}`);
    const mismatch = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_mismatch');
    assert.equal(mismatch.length, 1);
    validateActivityEventAgainstSchema(mismatch[0], 'worker_spawn_backend_mismatch');
    assert.equal(mismatch[0].resolved_backend, 'claude');
    assert.equal(mismatch[0].state_backend, 'codex');
    assert.equal(mismatch[0].source, 'settings');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('backend-spawn-assertion: fresh backend_flip_reason bypasses mismatch once and clears flags', () => {
  const harness = makeHarness({
    stateBackend: 'codex',
    extras: {
      flags: {
        backend_flip_reason: 'codex-spark-429',
        backend_flip_reason_ts: new Date(Date.now() - 30_000).toISOString(),
      },
    },
  });
  writePickleSettings(harness.tmpDir, { enable_backend_routing_heuristic: true });
  const ticketFile = writeTicketFile(harness.ticketDir, harness.ticketId);
  try {
    const result = runMorty(harness, ['--ticket-file', ticketFile]);
    assert.equal(result.status, 1);
    const invoked = which(harness);
    assert.equal(invoked.length, 1);
    assert.equal(invoked[0].backend, 'claude', 'expected mismatch-bypass to continue with resolved backend');
    const state = JSON.parse(fs.readFileSync(path.join(harness.sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.flags?.backend_flip_reason, undefined);
    assert.equal(state.flags?.backend_flip_reason_ts, undefined);
    const mismatch = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_mismatch');
    assert.equal(mismatch.length, 0);
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].source, 'settings');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('backend-spawn-assertion: stale backend_flip_reason does not bypass mismatch', () => {
  const harness = makeHarness({
    stateBackend: 'codex',
    extras: {
      flags: {
        backend_flip_reason: 'codex-spark-429',
        backend_flip_reason_ts: new Date(Date.now() - 120_000).toISOString(),
      },
    },
  });
  writePickleSettings(harness.tmpDir, { enable_backend_routing_heuristic: true });
  const ticketFile = writeTicketFile(harness.ticketDir, harness.ticketId);
  try {
    const result = runMorty(harness, ['--ticket-file', ticketFile]);
    assert.equal(result.status, 1);
    const state = JSON.parse(fs.readFileSync(path.join(harness.sessionDir, 'state.json'), 'utf-8'));
    const mismatch = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_mismatch');
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].resolved_backend, 'claude');
    assert.equal(mismatch[0].state_backend, 'codex');
    assert.equal(state.flags?.backend_flip_reason, 'codex-spark-429');
    assert.equal(typeof state.flags?.backend_flip_reason_ts, 'string');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});

test('R-XBL-7: state.backend=claude wins over poisoned PICKLE_BACKEND=codex env', () => {
  const harness = makeHarness({ stateBackend: 'claude' });
  try {
    runMorty(harness, [], { PICKLE_BACKEND: 'codex' });
    const invoked = which(harness);
    assert.equal(invoked.length, 1, `expected exactly one shim invoked; got ${JSON.stringify(invoked.map((i) => i.backend))}`);
    assert.equal(invoked[0].backend, 'claude', 'env-poison PICKLE_BACKEND=codex must not win over state.backend=claude');
    const resolved = readActivityEvents(harness.sessionDir, 'worker_spawn_backend_resolved');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].backend, 'claude');
    assert.equal(resolved[0].source, 'state');
  } finally {
    fs.rmSync(harness.tmpDir, { recursive: true, force: true });
  }
});
