// @tier: integration
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const EXTENSION_BIN_SRC = path.join(REPO_ROOT, 'extension', 'bin');

let tmpHome = '';

after(() => {
    if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test('install-chmod-coverage: glob makes every extension/bin/*.js executable (R-ICM-1, R-ICM-2)', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chmod-'));
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');

    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');

    // Fixture must exist in source so the rsync+glob covers it (AC-ICM-02)
    const fixtureSrc = path.join(EXTENSION_BIN_SRC, '_test-chmod-fixture.js');
    assert.ok(fs.existsSync(fixtureSrc), '_test-chmod-fixture.js must exist in extension/bin/');

    const install = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            ...process.env,
            HOME: tmpHome,
            PICKLE_INSTALL_ROOT: prefix,
            PICKLE_DATA_ROOT: path.join(tmpHome, '.local', 'share', 'pickle-rick'),
        },
    });

    assert.equal(install.status, 0, `install.sh failed (exit ${install.status}):\n${install.stderr}`);
    assert.ok(
        install.stdout.includes('OK chmod'),
        `install.sh stdout missing 'OK chmod' — post-install loop failed:\n${install.stdout}`,
    );

    const deployedBin = path.join(prefix, 'extension', 'bin');

    // Assert fixture got +x without any explicit install.sh entry (AC-ICM-02)
    const deployedFixture = path.join(deployedBin, '_test-chmod-fixture.js');
    assert.ok(fs.existsSync(deployedFixture), `deployed fixture not found at ${deployedFixture}`);
    const fixtureStat = fs.statSync(deployedFixture);
    assert.ok(fixtureStat.mode & 0o111, '_test-chmod-fixture.js is not executable after install');

    // Assert every deployed bin/*.js is executable (AC-ICM-01)
    for (const entry of fs.readdirSync(deployedBin)) {
        if (!entry.endsWith('.js')) continue;
        const fullPath = path.join(deployedBin, entry);
        if (fs.lstatSync(fullPath).isSymbolicLink()) continue;
        const stat = fs.statSync(fullPath);
        assert.ok(stat.mode & 0o111, `${entry} is not executable after install`);
    }
});
