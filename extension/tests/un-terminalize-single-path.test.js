// @tier: fast
// WS2 (B-GROUND2 ticket 005c63c9) un-terminalize single-path enforcement.
//
// `pickle-recover --reactivate` is the ONLY sanctioned write that flips a TERMINAL session
// ({active:false, step:'completed'}) back to runnable. This test exercises the audit
// `extension/scripts/audit-un-terminalize-single-path.sh`:
//   - sanctioned-PASS: the real src tree (pickle-recover's paired write + setup --resume +
//     WS1 finalizeIfTrulyComplete) is green;
//   - rogue-RED: a synthetic out-of-allowlist un-terminalize writer written to a TEMP copy
//     of the source tree fails the build (default-DENY);
//   - sanctioned-only tmp: the same tmp tree WITHOUT the rogue writer is green, proving the
//     allowlisted authority writes are NOT false-flagged;
//   - authority-missing: dropping pickle-recover.ts from the tmp tree goes RED (the scan can
//     never silently no-op).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
const extensionRoot = path.join(repoRoot, 'extension');
const auditScript = path.join(extensionRoot, 'scripts', 'audit-un-terminalize-single-path.sh');
const srcRoot = path.join(extensionRoot, 'src');

function runAudit(sourceRoot) {
  const env = { ...process.env };
  if (sourceRoot !== undefined) env.SOURCE_ROOT = sourceRoot;
  return spawnSync('bash', [auditScript], {
    cwd: extensionRoot,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

/** Copy the three sanctioned writers into a fresh tmp SOURCE_ROOT and return its path. */
function makeSanctionedTmpTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uts-audit-'));
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'services'), { recursive: true });
  fs.copyFileSync(path.join(srcRoot, 'bin', 'pickle-recover.ts'), path.join(tmp, 'bin', 'pickle-recover.ts'));
  fs.copyFileSync(path.join(srcRoot, 'bin', 'setup.ts'), path.join(tmp, 'bin', 'setup.ts'));
  fs.copyFileSync(path.join(srcRoot, 'services', 'state-manager.ts'), path.join(tmp, 'services', 'state-manager.ts'));
  return tmp;
}

const ROGUE_SOURCE = `import { StateManager } from '../services/state-manager.js';
// Synthetic out-of-allowlist un-terminalize writer: flips a terminal session back to runnable.
export function rogueReactivate(statePath: string): void {
  const sm = new StateManager();
  sm.update(statePath, s => {
    s.active = true;
    s.step = 'research';
    s.exit_reason = null;
  });
}
`;

test('audit-un-terminalize-single-path: real src tree is GREEN (sanctioned writers only)', () => {
  const res = runAudit(srcRoot);
  assert.equal(res.status, 0, `expected exit 0 on real src, got ${res.status}\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /un-terminalize single-path intact/);
});

test('audit-un-terminalize-single-path: rogue out-of-allowlist writer goes RED (default-DENY)', () => {
  const tmp = makeSanctionedTmpTree();
  try {
    fs.writeFileSync(path.join(tmp, 'bin', 'rogue-reactivator.ts'), ROGUE_SOURCE);
    const res = runAudit(tmp);
    assert.notEqual(res.status, 0, `expected nonzero exit on rogue writer\n${res.stdout}\n${res.stderr}`);
    assert.match(
      res.stderr,
      /out-of-allowlist un-terminalize writer.*rogue-reactivator\.ts/,
      `offender must name the rogue file\n${res.stderr}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('audit-un-terminalize-single-path: sanctioned-only tmp tree is GREEN (authority not flagged)', () => {
  const tmp = makeSanctionedTmpTree();
  try {
    const res = runAudit(tmp);
    assert.equal(res.status, 0, `pickle-recover's own paired write + finalizeIfTrulyComplete must NOT be flagged\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /un-terminalize single-path intact/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('audit-un-terminalize-single-path: missing pickle-recover authority goes RED (no silent no-op)', () => {
  const tmp = makeSanctionedTmpTree();
  try {
    fs.rmSync(path.join(tmp, 'bin', 'pickle-recover.ts'));
    const res = runAudit(tmp);
    assert.notEqual(res.status, 0, `dropping the authority must fail the build\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /authority missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
