// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

test('install-script-real.e2e installs to prefix and leaves home settings.json untouched', () => {
  // Use a fake $HOME so agents, commands, backup, and settings all route to the temp dir
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-real-'));
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');

  // Pre-create settings.json — install.sh exits 1 if it's missing when PICKLE_INSTALL_ROOT == $HOME/.claude/pickle-rick
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');

  const realSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settingsBefore = fs.existsSync(realSettingsPath)
    ? fs.readFileSync(realSettingsPath, 'utf8')
    : null;

  try {
    const result = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PICKLE_INSTALL_ROOT: prefix,
        PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
      },
    });

    assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);

    const deployedPkgPath = path.join(prefix, 'extension', 'package.json');
    assert.ok(fs.existsSync(deployedPkgPath), `expected ${deployedPkgPath} to exist`);
    const pkgVer = JSON.parse(fs.readFileSync(deployedPkgPath, 'utf8')).version;
    const srcVer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8')).version;
    assert.equal(pkgVer, srcVer);

    const settings = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    assert.match(settings, /\$\{PICKLE_INSTALL_ROOT[^}]*\}/);

    const settingsAfter = fs.existsSync(realSettingsPath)
      ? fs.readFileSync(realSettingsPath, 'utf8')
      : null;
    assert.equal(settingsAfter, settingsBefore);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
