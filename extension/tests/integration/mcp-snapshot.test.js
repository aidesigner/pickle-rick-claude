// @tier: integration
//
// AC-MFW-4 — verifies the setup-time MCP snapshot (Option D, FR-4).
//
// 1. runMcpSnapshot with a stubbed fetchFn and ['linear'] servers writes
//    ${sessionRoot}/mcp-context/linear-ticket.json with title + description.
// 2. No-op path: empty snapshotServers creates no mcp-context/ dir and does
//    not throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runMcpSnapshot } = await import(
  path.resolve(__dirname, '../../bin/setup.js')
);

test('AC-MFW-4: runMcpSnapshot writes linear-ticket.json with title + description', async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-snap-'));
  try {
    const stubFetch = async (_server, _ticketId) => ({
      title: 'Stub Ticket Title',
      description: 'Stub ticket description.',
    });

    await runMcpSnapshot(
      sessionRoot,
      ['linear'],
      '/fake/mcp-config.json',
      'implement ENG-123 — stub feature',
      stubFetch,
      false
    );

    const snapshotPath = path.join(sessionRoot, 'mcp-context', 'linear-ticket.json');
    assert.ok(
      fs.existsSync(snapshotPath),
      `mcp-context/linear-ticket.json must exist at ${snapshotPath}`,
    );

    const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    assert.equal(data.title, 'Stub Ticket Title', 'snapshot must contain ticket title');
    assert.ok(
      typeof data.description === 'string' && data.description.length > 0,
      'snapshot must contain non-empty ticket description',
    );
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});

test('AC-MFW-4: no-op path (empty snapshot servers) creates no mcp-context dir and does not throw', async () => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-snap-noop-'));
  try {
    // Should resolve without throwing
    await runMcpSnapshot(
      sessionRoot,
      [],
      '/fake/mcp-config.json',
      'implement ENG-456 — no-op test',
      async () => ({ title: 'X', description: 'Y' }),
      false
    );

    assert.ok(
      !fs.existsSync(path.join(sessionRoot, 'mcp-context')),
      'mcp-context/ dir must NOT be created when worker_mcp_snapshot_servers is empty',
    );
  } finally {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
});
