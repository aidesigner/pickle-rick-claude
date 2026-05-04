// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const PICKLE_UTILS_JS = path.resolve(__dirname, '../services/pickle-utils.js');

function makePrefix(testId) {
  return mkdtempSync(path.join(tmpdir(), `install-prefix-${testId}-`));
}

/**
 * Build a minimal fixture environment:
 * - fixtureHome: fake $HOME (never touches real ~/.claude/settings.json)
 * - prefix: the --prefix dir
 * - settings.json created in fixtureHome/.claude/ for default-install tests
 */
function makeFixture({ testId, useCustomPrefix = true }) {
  const dir = mkdtempSync(path.join(tmpdir(), `install-prefix-fixture-${testId}-`));
  const fixtureHome = path.join(dir, 'home');
  const claudeDir = path.join(fixtureHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // Create a real settings.json at the default $HOME location
  writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));

  const prefix = useCustomPrefix
    ? path.join(dir, 'prefix')
    : path.join(fixtureHome, '.claude', 'pickle-rick');

  return { dir, fixtureHome, claudeDir, prefix };
}

function runInstall(fixture, extraArgs = []) {
  return spawnSync('bash', [INSTALL_SH, ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.fixtureHome,
      // Prevent check_worktree_head_fresh from failing in worktree CI
      GIT_DIR: undefined,
    },
    timeout: 120_000,
  });
}

describe('install-script-prefix: --prefix flag', () => {
  test('install-script-prefix.prefix-writes-files: --prefix installs extension under prefix', () => {
    const fixture = makeFixture({ testId: 'writes-files' });
    try {
      const result = runInstall(fixture, ['--prefix', fixture.prefix, '--no-confirm']);
      assert.strictEqual(
        result.status, 0,
        `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        existsSync(path.join(fixture.prefix, 'extension', 'package.json')),
        'extension/package.json must exist at prefix',
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script-prefix.sentinel-staged: .pickle-install-root sentinel exists at prefix root', () => {
    const fixture = makeFixture({ testId: 'sentinel' });
    try {
      const result = runInstall(fixture, ['--prefix', fixture.prefix, '--no-confirm']);
      assert.strictEqual(
        result.status, 0,
        `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.ok(
        existsSync(path.join(fixture.prefix, '.pickle-install-root')),
        '.pickle-install-root sentinel must exist at prefix root',
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script-prefix.getExtensionRoot-accepts-sentinel: getExtensionRoot() accepts prefix with sentinel', () => {
    const fixture = makeFixture({ testId: 'get-root' });
    try {
      const result = runInstall(fixture, ['--prefix', fixture.prefix, '--no-confirm']);
      assert.strictEqual(
        result.status, 0,
        `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );

      // Spawn child node process with EXTENSION_DIR pointing at prefix
      const nodeResult = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { getExtensionRoot } from ${JSON.stringify(PICKLE_UTILS_JS)};
process.stdout.write(getExtensionRoot());`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EXTENSION_DIR: fixture.prefix,
            HOME: fixture.fixtureHome,
          },
          timeout: 15_000,
        },
      );
      assert.strictEqual(
        nodeResult.status, 0,
        `node process failed: ${nodeResult.stderr}`,
      );
      assert.strictEqual(
        nodeResult.stdout.trim(),
        fixture.prefix,
        `getExtensionRoot() must return prefix when sentinel exists`,
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script-prefix.settings-untouched-at-home: $HOME/.claude/settings.json is byte-identical after --prefix install', () => {
    const fixture = makeFixture({ testId: 'settings-untouched' });
    const settingsPath = path.join(fixture.claudeDir, 'settings.json');
    const before = readFileSync(settingsPath, 'utf8');

    try {
      const result = runInstall(fixture, ['--prefix', fixture.prefix, '--no-confirm']);
      assert.strictEqual(
        result.status, 0,
        `expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const after = readFileSync(settingsPath, 'utf8');
      assert.strictEqual(after, before, '$HOME/.claude/settings.json must be untouched by --prefix install');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script-prefix.empty-prefix-exits-2: --prefix with no value exits 2', () => {
    const fixture = makeFixture({ testId: 'empty-prefix' });
    try {
      const result = spawnSync('bash', [INSTALL_SH, '--prefix'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fixture.fixtureHome },
        timeout: 10_000,
      });
      assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}`);
      assert.match(result.stderr, /--prefix requires a non-empty/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
