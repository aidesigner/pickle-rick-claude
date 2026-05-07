// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_RELATIVE_PATH = 'tests/integration/.serial-tests.json';
const MANIFEST_PATH = path.join(EXTENSION_ROOT, MANIFEST_RELATIVE_PATH);
const INTEGRATION_DIR = path.join(EXTENSION_ROOT, 'tests', 'integration');
const HEURISTIC = /child_process\.(?:spawn|exec)|setupSession[\s\S]{0,200}--tmux|spawnMorty\(/;

function normalizeTestPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function auditSubprocessHeavyTests(rootDir) {
  const manifestPath = path.join(rootDir, MANIFEST_RELATIVE_PATH);
  const integrationDir = path.join(rootDir, 'tests', 'integration');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entries = new Set(manifest.entries.map(entry => normalizeTestPath(entry)));
  const failures = [];

  for (const entry of entries) {
    if (!existsSync(path.join(rootDir, entry))) {
      failures.push(`missing serial test: ${entry}`);
    }
  }

  for (const entry of readDirectoryTests(integrationDir, rootDir)) {
    const source = readFileSync(path.join(rootDir, entry), 'utf8');
    if (HEURISTIC.test(source) && !entries.has(entry)) {
      failures.push(`unclassified subprocess-heavy test: ${entry}`);
    }
  }

  return failures;
}

function readDirectoryTests(dir, rootDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectoryTests(fullPath, rootDir);
    }
    if (!entry.isFile() || !entry.name.endsWith('.test.js')) {
      return [];
    }
    return [normalizeTestPath(path.relative(rootDir, fullPath))];
  }).sort();
}

test('serial manifest entries exist at HEAD', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  assert.ok(Array.isArray(manifest.entries), 'serial manifest must expose entries: string[]');
  for (const entry of manifest.entries) {
    assert.equal(typeof entry, 'string', `serial manifest entry must be string: ${entry}`);
    assert.ok(existsSync(path.join(EXTENSION_ROOT, entry)), `serial manifest entry missing at HEAD: ${entry}`);
  }
});

test('synthetic subprocess-heavy file outside serial manifest fails the audit', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'parallel-tier-audit-'));
  try {
    mkdirSync(path.join(root, 'tests', 'integration'), { recursive: true });
    writeFileSync(path.join(root, 'tests', 'integration', '.serial-tests.json'), JSON.stringify({
      entries: ['tests/integration/known-serial.test.js'],
    }, null, 2));
    writeFileSync(path.join(root, 'tests', 'integration', 'known-serial.test.js'), [
      '// @tier: integration',
      "import { test } from 'node:test';",
      "test('known serial', () => {});",
    ].join('\n'));
    writeFileSync(path.join(root, 'tests', 'integration', 'rogue-subprocess.test.js'), [
      '// @tier: integration',
      "import { test } from 'node:test';",
      "const source = 'child_process.spawn';",
      "test('rogue', () => { if (!source) throw new Error('unreachable'); });",
    ].join('\n'));

    const auditScriptPath = path.join(root, 'audit-fixture.mjs');
    writeFileSync(auditScriptPath, `
      import { existsSync, readFileSync, readdirSync } from 'node:fs';
      import path from 'node:path';
      const rootDir = process.argv[2];
      const manifestPath = path.join(rootDir, 'tests', 'integration', '.serial-tests.json');
      const integrationDir = path.join(rootDir, 'tests', 'integration');
      const heuristic = /child_process\\.(?:spawn|exec)|setupSession[\\s\\S]{0,200}--tmux|spawnMorty\\(/;
      const normalize = (filePath) => filePath.split(path.sep).join('/');
      const list = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) return list(fullPath);
        if (!entry.isFile() || !entry.name.endsWith('.test.js')) return [];
        return [normalize(path.relative(rootDir, fullPath))];
      }).sort();
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const entries = new Set(manifest.entries.map((entry) => normalize(entry)));
      const failures = [];
      for (const entry of entries) {
        if (!existsSync(path.join(rootDir, entry))) failures.push(\`missing serial test: \${entry}\`);
      }
      for (const entry of list(integrationDir)) {
        const source = readFileSync(path.join(rootDir, entry), 'utf8');
        if (heuristic.test(source) && !entries.has(entry)) failures.push(\`unclassified subprocess-heavy test: \${entry}\`);
      }
      if (failures.length > 0) {
        process.stderr.write(failures.join('\\n') + '\\n');
        process.exit(1);
      }
    `);

    const result = spawnSync(process.execPath, [auditScriptPath, root], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /unclassified subprocess-heavy test: tests\/integration\/rogue-subprocess\.test\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
