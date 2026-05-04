// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SCRIPT_SOURCE = path.join(EXTENSION_ROOT, 'scripts', 'audit-quarantine.sh');
const MECHANISM = "skipped via tier-discovery helper's exclude-list";

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function makeFixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'audit-quarantine-'));
  mkdirSync(path.join(root, 'extension', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'extension', 'tests'), { recursive: true });
  mkdirSync(path.join(root, 'prds'), { recursive: true });
  copyFileSync(SCRIPT_SOURCE, path.join(root, 'extension', 'scripts', 'audit-quarantine.sh'));
  chmodSync(path.join(root, 'extension', 'scripts', 'audit-quarantine.sh'), 0o755);
  writeFileSync(
    path.join(root, 'extension', 'quarantine-baseline.json'),
    JSON.stringify({ initial_count: 0, captured_at: '2026-05-03' }, null, 2),
  );
  assert.equal(run('git', ['init', '-q'], root).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'test@example.com'], root).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Test User'], root).status, 0);
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function writePrd(root, relativePath, status) {
  const fullPath = path.join(root, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `---\nstatus: ${status}\n---\n\n# Fixture\n`);
}

function writeQuarantine(root, entries) {
  const body = [
    '# Quarantined Tests',
    '',
    ...entries,
    '',
  ].join('\n');
  writeFileSync(path.join(root, 'extension', 'tests', 'QUARANTINE.md'), body);
}

function quarantineEntry(testPath, prdPath) {
  return [
    `## ${testPath}`,
    '- First failure: 2026-05-03',
    '- Failure rate: 1/100 runs',
    `- PRD: ${prdPath}`,
    `- Mechanism: ${MECHANISM}`,
    '',
  ].join('\n');
}

function commitAll(root) {
  assert.equal(run('git', ['add', '.'], root).status, 0);
  const result = run('git', ['commit', '-q', '-m', 'fixture'], root);
  assert.equal(result.status, 0, result.stderr);
}

function runAudit(root) {
  return run('bash', ['extension/scripts/audit-quarantine.sh'], root);
}

test('empty quarantine file exits 0', () => {
  const root = makeFixtureRepo();
  try {
    writeQuarantine(root, []);
    commitAll(root);

    assert.equal(runAudit(root).status, 0);
  } finally {
    cleanup(root);
  }
});

test('6 entries exit 1 above threshold', () => {
  const root = makeFixtureRepo();
  try {
    const entries = [];
    for (let index = 1; index <= 6; index += 1) {
      const prdPath = `prds/open-${index}.md`;
      writePrd(root, prdPath, 'Draft');
      entries.push(quarantineEntry(`tests/flake-${index}.test.js`, prdPath));
    }
    writeQuarantine(root, entries);
    commitAll(root);

    assert.equal(runAudit(root).status, 1);
  } finally {
    cleanup(root);
  }
});

test('zombie quarantine entry exits 1', () => {
  const root = makeFixtureRepo();
  try {
    writePrd(root, 'prds/done.md', 'Done');
    writeQuarantine(root, [quarantineEntry('tests/zombie.test.js', 'prds/done.md')]);
    commitAll(root);

    assert.equal(runAudit(root).status, 1);
  } finally {
    cleanup(root);
  }
});

test('missing PRD path exits 1', () => {
  const root = makeFixtureRepo();
  try {
    writeQuarantine(root, [quarantineEntry('tests/missing-prd.test.js', 'prds/missing.md')]);
    commitAll(root);

    assert.equal(runAudit(root).status, 1);
  } finally {
    cleanup(root);
  }
});

test('missing quarantine file exits 0', () => {
  const root = makeFixtureRepo();
  try {
    commitAll(root);

    assert.equal(runAudit(root).status, 0);
  } finally {
    cleanup(root);
  }
});
