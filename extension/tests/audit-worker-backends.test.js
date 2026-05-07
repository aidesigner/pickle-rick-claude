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
