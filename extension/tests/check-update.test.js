import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseVersion,
    compareSemver,
    readCache,
    writeCache,
    readSettings,
    isCacheStale,
    checkForUpdate,
    downloadRelease,
    extractAndInstall,
    performUpgrade,
} from '../bin/check-update.js';

function makeTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-test-')));
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
    test('strips v prefix', () => {
        assert.equal(parseVersion('v1.2.3'), '1.2.3');
    });

    test('accepts bare semver', () => {
        assert.equal(parseVersion('1.2.3'), '1.2.3');
    });

    test('rejects non-semver', () => {
        assert.equal(parseVersion('1.2'), null);
        assert.equal(parseVersion('abc'), null);
        assert.equal(parseVersion('v1.2.3-beta'), null);
    });

    test('rejects empty/null-ish', () => {
        assert.equal(parseVersion(''), null);
    });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
    test('equal versions', () => {
        assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    });

    test('a < b (patch)', () => {
        assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
    });

    test('a > b (minor)', () => {
        assert.equal(compareSemver('1.3.0', '1.2.9'), 1);
    });

    test('a < b (major)', () => {
        assert.equal(compareSemver('1.9.9', '2.0.0'), -1);
    });

    test('multi-digit versions', () => {
        assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
    });
});

// ---------------------------------------------------------------------------
// readCache / writeCache
// ---------------------------------------------------------------------------

describe('readCache', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
        assert.equal(cache.latest_version, '');
        assert.equal(cache.current_version, '');
    });

    test('returns defaults when file corrupted', () => {
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), '{broken');
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
    });

    test('round-trips correctly', () => {
        const data = { last_check_epoch: 1000, latest_version: '2.0.0', current_version: '1.0.0' };
        writeCache(data);
        const result = readCache();
        assert.deepEqual(result, data);
    });
});

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

describe('readSettings', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('respects overrides', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false, update_check_interval_hours: 12 }),
        );
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, false);
        assert.equal(settings.update_check_interval_hours, 12);
    });

    test('returns defaults on corrupt file', () => {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), 'not json');
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('ignores invalid interval', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ update_check_interval_hours: -5 }),
        );
        const settings = readSettings();
        assert.equal(settings.update_check_interval_hours, 24);
    });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe('isCacheStale', () => {
    test('zero epoch is stale', () => {
        assert.equal(isCacheStale({ last_check_epoch: 0, latest_version: '', current_version: '' }, 24), true);
    });

    test('old cache is stale', () => {
        const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
        assert.equal(isCacheStale({ last_check_epoch: twoDaysAgo, latest_version: '', current_version: '' }, 24), true);
    });

    test('recent cache is fresh', () => {
        const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
        assert.equal(isCacheStale({ last_check_epoch: fiveMinAgo, latest_version: '', current_version: '' }, 24), false);
    });
});

// ---------------------------------------------------------------------------
// checkForUpdate (integration-ish, using EXTENSION_DIR override)
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
        // Create a fake package.json so getCurrentVersion works
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns up-to-date when auto_update disabled', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
        assert.equal(result.currentVersion, '1.7.0');
    });

    test('uses cached result when fresh', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '2.0.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'update-available');
        assert.equal(result.latestVersion, '2.0.0');
    });

    test('uses cached result showing up-to-date', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '1.7.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
    });

    test('force bypasses disabled setting', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        // Force will try to call gh api which may fail, but should not crash
        const result = checkForUpdate({ force: true });
        // Either error (no gh/no network) or a valid result — never throws
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
    });

    test('returns error status on API failure, never throws', () => {
        // Stale cache forces API call, which will likely fail in test env
        const result = checkForUpdate();
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
        assert.equal(result.currentVersion, '1.7.0');
    });
});

// ---------------------------------------------------------------------------
// downloadRelease
// ---------------------------------------------------------------------------

describe('downloadRelease', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns null on invalid tag, never throws', () => {
        const result = downloadRelease('v999.999.999-nonexistent');
        assert.equal(result, null);
    });

    test('returns string path on valid release', () => {
        // Empty tag downloads latest release — gh treats it as "latest"
        // This validates the happy path when gh is available
        const result = downloadRelease('');
        if (result !== null) {
            assert.ok(result.endsWith('.tar.gz'));
            // Clean up downloaded file
            try { fs.rmSync(path.dirname(result), { recursive: true, force: true }); } catch { /* */ }
        }
    });
});

// ---------------------------------------------------------------------------
// extractAndInstall
// ---------------------------------------------------------------------------

describe('extractAndInstall', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns error for nonexistent tarball', () => {
        const result = extractAndInstall('/tmp/nonexistent-pickle-fakefile.tar.gz');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('returns error for invalid tarball', () => {
        const fakeTarball = path.join(tmpDir, 'fake.tar.gz');
        fs.writeFileSync(fakeTarball, 'not a real tarball');
        const result = extractAndInstall(fakeTarball);
        assert.equal(result.success, false);
    });
});

// ---------------------------------------------------------------------------
// performUpgrade
// ---------------------------------------------------------------------------

describe('performUpgrade', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('fails gracefully when download fails', () => {
        const result = performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('never throws', () => {
        assert.doesNotThrow(() => {
            performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        });
    });
});
