// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { scanSession } from '../bin/audit-worker-backends.js';

function makeTmpDir(prefix = 'pickle-audit-worker-backends-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDeadTmpState(sessionDir, payload, suffix = '999999') {
  const tmpPath = path.join(sessionDir, `state.json.tmp.${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(tmpPath, future, future);
}

test('audit-worker-backends: worker_backend_resolved allows codex worker under claude session without mismatch', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'claude',
    activity: [
      {
        event: 'worker_backend_resolved',
        ts: new Date().toISOString(),
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: 'codex',
        source: 'worker_backend',
      },
    ],
  }));

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_123.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'claude');
  assert.equal(report.worker_backend_resolution_count, 1);
  assert.equal(report.mismatch_count, 0);
  assert.deepEqual(report.mismatches, []);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('audit-worker-backends: worker_spawn_backend_override suppresses intentional codex override mismatches', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'claude',
    activity: [
      {
        event: 'worker_backend_resolved',
        ts: new Date().toISOString(),
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: null,
        source: 'backend',
      },
      {
        event: 'worker_spawn_backend_override',
        ts: new Date().toISOString(),
        ticket: 'ticket-001',
        backend: 'codex',
        source: 'cli-flag-override',
      },
    ],
  }));

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_123.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'claude');
  assert.equal(report.worker_backend_resolution_count, 1);
  assert.equal(report.mismatch_count, 0);
  assert.deepEqual(report.mismatches, []);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('audit-worker-backends: per-log spawn backend beats ticket-level fallback for mixed backend retries', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'claude',
    activity: [
      {
        event: 'worker_backend_resolved',
        ts: new Date().toISOString(),
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: null,
        source: 'backend',
      },
      {
        event: 'worker_spawn_backend_resolved',
        ts: new Date().toISOString(),
        ticket: 'ticket-001',
        pid: 111,
        backend: 'codex',
        source: 'cli-flag-override',
      },
      {
        event: 'worker_spawn_backend_resolved',
        ts: new Date().toISOString(),
        ticket: 'ticket-001',
        pid: 222,
        backend: 'claude',
        source: 'state',
      },
    ],
  }));

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_111.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );
  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_222.log'),
    'ordinary claude worker output\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'claude');
  assert.equal(report.worker_backend_resolution_count, 1);
  assert.equal(report.mismatch_count, 0);
  assert.deepEqual(report.mismatches, []);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('audit-worker-backends: codex banner under hermes-expected worker is flagged as a mismatch', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'hermes',
    activity: [
      {
        event: 'worker_spawn_backend_resolved',
        ts: new Date().toISOString(),
        ticket: 'ticket-001',
        pid: 333,
        backend: 'hermes',
        source: 'state',
      },
    ],
  }));

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_333.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'hermes');
  assert.equal(report.mismatch_count, 1);
  assert.deepEqual(report.mismatches, [
    {
      ticket: 'ticket-001',
      log: 'worker_session_333.log',
      patterns_found: [
        'Reading additional input from stdin...',
        'chatgpt.com/codex/settings/usage',
      ],
    },
  ]);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('audit-worker-backends: stale override does not mask a newer ticket-level claude resolution', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'claude',
    activity: [
      {
        event: 'worker_spawn_backend_override',
        ts: '2026-05-19T10:00:00.000Z',
        ticket: 'ticket-001',
        backend: 'codex',
        source: 'cli-flag-override',
      },
      {
        event: 'worker_backend_resolved',
        ts: '2026-05-19T10:05:00.000Z',
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: null,
        source: 'backend',
      },
    ],
  }));

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_999.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'claude');
  assert.equal(report.worker_backend_resolution_count, 1);
  assert.equal(report.mismatch_count, 1);
  assert.deepEqual(report.mismatches, [
    {
      ticket: 'ticket-001',
      log: 'worker_session_999.log',
      patterns_found: [
        'Reading additional input from stdin...',
        'chatgpt.com/codex/settings/usage',
      ],
    },
  ]);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('audit-worker-backends: promotes recoverable state tmp before backend mismatch audit', () => {
  const sessionDir = makeTmpDir();
  const ticketDir = path.join(sessionDir, 'ticket-001');
  fs.mkdirSync(ticketDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    backend: 'claude',
    activity: [
      {
        event: 'worker_backend_resolved',
        ts: '2026-05-19T10:00:00.000Z',
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: null,
        source: 'backend',
      },
    ],
  }), 'utf-8');

  writeDeadTmpState(sessionDir, {
    backend: 'claude',
    activity: [
      {
        event: 'worker_backend_resolved',
        ts: '2026-05-19T10:00:00.000Z',
        ticket_id: 'ticket-001',
        backend: 'claude',
        worker_backend: null,
        source: 'backend',
      },
      {
        event: 'worker_spawn_backend_override',
        ts: '2026-05-19T10:05:00.000Z',
        ticket: 'ticket-001',
        backend: 'codex',
        source: 'cli-flag-override',
      },
    ],
  });

  fs.writeFileSync(
    path.join(ticketDir, 'worker_session_123.log'),
    'Reading additional input from stdin...\nchatgpt.com/codex/settings/usage\n',
  );

  const report = scanSession(sessionDir);
  assert.equal(report.session_backend, 'claude');
  assert.equal(report.subtool_override_count, 0);
  assert.equal(report.mismatch_count, 0);
  assert.deepEqual(report.mismatches, []);

  const promotedState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
  assert.equal(Array.isArray(promotedState.activity), true);
  assert.equal(promotedState.activity.length, 2, 'recoverable tmp should replace stale base state');

  fs.rmSync(sessionDir, { recursive: true, force: true });
});
