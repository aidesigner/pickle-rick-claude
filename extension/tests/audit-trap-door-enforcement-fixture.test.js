// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

test('audit-trap-door-enforcement exits 0 at HEAD', () => {
  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('audit-trap-door-enforcement fails when R-CNAR-7 PATTERN_SHAPE is blanked in fixture CLAUDE.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-'));

  try {
    const sourcePath = path.join(EXTENSION_ROOT, 'CLAUDE.md');
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const fixture = source.replace(
      /(R-CNAR-1 part 2 cap split\)[\s\S]*?)PATTERN_SHAPE:\s*[\s\S]*?(?=\sBREAKS:)/,
      '$1PATTERN_SHAPE: '
    );

    assert.notEqual(fixture, source, 'fixture must remove the PATTERN_SHAPE clause body');
    fs.writeFileSync(fixturePath, fixture);

    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
      },
    });

    assert.notEqual(result.status, 0, 'audit should fail when PATTERN_SHAPE is blank');
    assert.match(result.stderr, /PATTERN_SHAPE/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
