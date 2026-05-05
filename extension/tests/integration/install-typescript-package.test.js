// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

test('install-typescript-package: pipeline-runner module-load smoke exits 0 (R-DTS-3)', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-dts3-'));
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');

  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');

  try {
    const install = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: homeDir,
        PICKLE_INSTALL_ROOT: prefix,
        PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
      },
    });
    assert.equal(install.status, 0, `install.sh failed (exit ${install.status}):\n${install.stderr}`);

    const script = `require(process.env.HOME + '/.claude/pickle-rick/extension/bin/pipeline-runner.js')`;
    const probe = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: homeDir },
    });

    assert.equal(
      probe.status,
      0,
      `pipeline-runner module-load exited ${probe.status}:\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    );
    assert.ok(
      !probe.stderr.includes('ERR_MODULE_NOT_FOUND'),
      `ERR_MODULE_NOT_FOUND in pipeline-runner module-load stderr:\n${probe.stderr}`,
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
