// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const AUDIT_BIN = path.join(EXTENSION_ROOT, 'bin/audit-ticket-bundle.js');
const FIXTURE_DIR = path.join(EXTENSION_ROOT, 'tests/fixtures/baseline-2026-05-03-7d9ee8cc');
const EXPECTED_JSON = path.join(
  EXTENSION_ROOT,
  'tests/fixtures/audit-ticket-bundle/2026-05-03-7d9ee8cc-expected.json',
);

const START_COMMIT = 'ee2ae138a6cc3edc4fbcd9b420f53cb9f5947bb6';

function tmpDir(prefix = 'pickle-audit-baseline-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function copyFixtureTickets(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ticketDir = path.join(dest, entry.name);
    fs.mkdirSync(ticketDir, { recursive: true });
    const srcTicketDir = path.join(src, entry.name);
    for (const file of fs.readdirSync(srcTicketDir)) {
      fs.copyFileSync(path.join(srcTicketDir, file), path.join(ticketDir, file));
    }
  }
}

test('R-TAQ-6: backfill audit on baseline-2026-05-03-7d9ee8cc fixture finds ≥12 defects across all classes', () => {
  const sessionDir = tmpDir();
  const manifestPath = path.join(sessionDir, 'audit-ticket-bundle.json');

  try {
    copyFixtureTickets(FIXTURE_DIR, sessionDir);

    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        working_dir: REPO_ROOT,
        start_commit: START_COMMIT,
      }),
    );

    const result = spawnSync(
      process.execPath,
      [AUDIT_BIN, sessionDir, '--manifest', manifestPath],
      { encoding: 'utf-8', timeout: 30_000, cwd: EXTENSION_ROOT },
    );

    assert.ok(
      result.status !== 2,
      `audit-ticket-bundle exited with operational error (exit 2):\n${result.stderr}`,
    );

    assert.ok(
      fs.existsSync(manifestPath),
      `manifest not written to ${manifestPath}`,
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const expected = JSON.parse(fs.readFileSync(EXPECTED_JSON, 'utf-8'));

    assert.ok(
      manifest.findings.length >= expected.min_total_findings,
      `Expected ≥${expected.min_total_findings} findings, got ${manifest.findings.length}:\n${
        manifest.findings.map((f) => `  ${f.defect_class} — ${f.evidence}`).join('\n')
      }`,
    );

    const foundClasses = new Set(manifest.findings.map((f) => f.defect_class));
    for (const cls of expected.required_classes) {
      assert.ok(
        foundClasses.has(cls),
        `defect class '${cls}' not found in ${manifest.findings.length} findings`,
      );
    }
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
