// @tier: fast
/**
 * audit-ticket-bundle-cross-doc-drift.test.js — AC-TAQ-05 regression
 *
 * Verifies that detectCrossDocNamingDrift catches matrix-vs-ticket path drift:
 * same basename referenced via different full paths across ticket and doc files.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..', 'bin', 'audit-ticket-bundle.js');

const { detectCrossDocNamingDrift } = await import(BUNDLE);

function tmpDir(prefix = 'pickle-cross-doc-drift-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function gitAdd(dir, ...files) {
  spawnSync('git', ['add', ...files], { cwd: dir });
}

function gitCommit(dir, msg) {
  spawnSync('git', ['commit', '-m', msg, '--allow-empty-message'], { cwd: dir });
}

test('AC-TAQ-05: detectCrossDocNamingDrift flags same-basename path mismatch between ticket and doc', () => {
  const root = tmpDir();
  try {
    initGitRepo(root);

    // ticket cites the canonical deep path
    const ticketPaths = ['extension/src/services/my-service.ts'];

    // doc file references same basename via a shorter path
    const docContent = 'See `src/services/my-service.ts` for details.\n';
    const docFile = path.join(root, 'matrix.md');
    fs.writeFileSync(docFile, docContent);
    gitAdd(root, 'matrix.md');
    gitCommit(root, 'add matrix doc');

    const drifts = detectCrossDocNamingDrift(ticketPaths, root);

    assert.ok(drifts.length >= 1, `Expected at least 1 drift, got ${drifts.length}`);
    const drift = drifts[0];
    assert.equal(drift.ticketPath, 'extension/src/services/my-service.ts');
    assert.equal(path.basename(drift.docPath), 'my-service.ts');
    assert.notEqual(drift.docPath, drift.ticketPath, 'docPath must differ from ticketPath');
    assert.equal(drift.docFile, 'matrix.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-TAQ-05: detectCrossDocNamingDrift returns empty array when no drift exists', () => {
  const root = tmpDir();
  try {
    initGitRepo(root);

    const ticketPaths = ['extension/src/services/my-service.ts'];

    // doc uses the exact same path as the ticket — no drift
    const docContent = 'See `extension/src/services/my-service.ts` for details.\n';
    const docFile = path.join(root, 'matrix.md');
    fs.writeFileSync(docFile, docContent);
    gitAdd(root, 'matrix.md');
    gitCommit(root, 'add matrix doc');

    const drifts = detectCrossDocNamingDrift(ticketPaths, root);
    assert.deepStrictEqual(drifts, [], `Expected no drift, got: ${JSON.stringify(drifts)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-TAQ-05: detectCrossDocNamingDrift returns empty array when ticketPaths is empty', () => {
  const root = tmpDir();
  try {
    initGitRepo(root);
    const drifts = detectCrossDocNamingDrift([], root);
    assert.deepStrictEqual(drifts, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
