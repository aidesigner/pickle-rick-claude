// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectCrossDocNamingDrift } from '../bin/audit-ticket-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function createFixtureRepo(files) {
  const repoRoot = makeTempDir('cross-doc-drift-');
  try {
    assert.equal(runGit(repoRoot, ['init', '-b', 'main']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.email', 'test@example.com']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.name', 'Test User']).status, 0);
    for (const [relPath, content] of Object.entries(files)) {
      writeFile(repoRoot, relPath, content);
    }
    assert.equal(runGit(repoRoot, ['add', '.']).status, 0);
    assert.equal(runGit(repoRoot, ['commit', '-m', 'fixture']).status, 0);
    return repoRoot;
  } catch (err) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    throw err;
  }
}

function withRepo(files, fn) {
  const repoRoot = createFixtureRepo(files);
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('cross-doc-naming-drift: detects basename mismatch across tracked md files', () => {
  withRepo(
    {
      'docs/guide.md': 'Configure via `pickle_settings.json` in the repo root.\n',
      'README.md': 'Edit `extension/pickle_settings.json` for advanced settings.\n',
    },
    (repoRoot) => {
      const drifts = detectCrossDocNamingDrift(['extension/pickle_settings.json'], repoRoot);
      assert.ok(drifts.length >= 1, `Expected ≥1 drift, got ${drifts.length}`);
      const drift = drifts.find((d) => d.docPath === 'pickle_settings.json');
      assert.ok(drift, `Expected drift with docPath 'pickle_settings.json', got: ${JSON.stringify(drifts)}`);
      assert.equal(drift.ticketPath, 'extension/pickle_settings.json');
      assert.ok(drift.docFile.endsWith('.md'), `Expected docFile to be an md path, got ${drift.docFile}`);
    },
  );
});

test('cross-doc-naming-drift: no drift when all paths consistent', () => {
  withRepo(
    {
      'docs/guide.md': 'Configure via `extension/pickle_settings.json`.\n',
      'README.md': 'Edit `extension/pickle_settings.json` directly.\n',
    },
    (repoRoot) => {
      const drifts = detectCrossDocNamingDrift(['extension/pickle_settings.json'], repoRoot);
      assert.equal(drifts.length, 0, `Expected 0 drifts, got: ${JSON.stringify(drifts)}`);
    },
  );
});

test('cross-doc-naming-drift: empty ticketPaths returns no drifts', () => {
  withRepo(
    { 'docs/guide.md': 'Some doc without relevant paths.\n' },
    (repoRoot) => {
      const drifts = detectCrossDocNamingDrift([], repoRoot);
      assert.equal(drifts.length, 0);
    },
  );
});

test('cross-doc-naming-drift: detects drift in fenced code block', () => {
  withRepo(
    {
      'docs/setup.md':
        '# Setup\n\n```bash\nnpm run build\npickle_settings.json\n```\n',
    },
    (repoRoot) => {
      const drifts = detectCrossDocNamingDrift(['extension/pickle_settings.json'], repoRoot);
      assert.ok(drifts.length >= 1, `Expected ≥1 drift from fenced block, got ${drifts.length}`);
      assert.ok(
        drifts.some((d) => d.docPath === 'pickle_settings.json'),
        `Expected drift with docPath 'pickle_settings.json', got: ${JSON.stringify(drifts)}`,
      );
    },
  );
});
