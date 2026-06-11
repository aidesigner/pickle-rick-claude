// @tier: fast
// Ticket 931c492f — prerelease semver tolerance in check-update.
// Pure parse/compare matrices run in-process; env-dependent caller surfaces
// (EXTENSION_DIR / PATH / HOME) run in child node processes so no
// process-global state is mutated (fast-tier safe, R-TSPF pattern from
// force-vs-allow-downgrade.test.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseVersion, compareSemver } from '../bin/check-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_UPDATE = path.resolve(__dirname, '../bin/check-update.js');
const CHECK_UPDATE_URL = JSON.stringify(pathToFileURL(CHECK_UPDATE).href);
const SPAWN_TIMEOUT_MS = 30_000;
const PRERELEASE_CURRENT = '2.0.0-beta.1';

describe('check-update prerelease: parseVersion matrix', () => {
    test('accepts X.Y.Z-<ident>.<N> with exact components', () => {
        const parsed = parseVersion('2.0.0-beta.1');
        assert.equal(parsed, '2.0.0-beta.1');
        const [triple, prerelease] = parsed.split('-');
        assert.deepEqual(triple.split('.'), ['2', '0', '0']);
        assert.deepEqual(prerelease.split('.'), ['beta', '1']);
    });

    test('strips v prefix on prerelease tags', () => {
        assert.equal(parseVersion('v2.0.0-beta.1'), '2.0.0-beta.1');
    });

    test('release-only parsing unchanged', () => {
        assert.equal(parseVersion('2.0.0'), '2.0.0');
        assert.equal(parseVersion('v1.106.0'), '1.106.0');
    });

    test('genuinely malformed input still returns null', () => {
        for (const bad of ['', 'abc', '2.0', '2.0.0-', '2.0.0-beta', '2.0.0-beta.x', 'v', '2.0.0-beta.1.2']) {
            assert.equal(parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
        }
    });
});

describe('check-update prerelease: compareSemver matrix', () => {
    const MATRIX = [
        ['1.106.0', '2.0.0-beta.1', -1],
        ['2.0.0-beta.1', '1.106.0', 1],
        ['2.0.0-beta.1', '2.0.0', -1],
        ['2.0.0', '2.0.0-beta.1', 1],
        ['2.0.0-beta.1', '2.0.0-beta.2', -1],
        ['2.0.0-beta.2', '2.0.0-beta.1', 1],
        ['2.0.0-beta.1', '2.0.0-beta.1', 0],
        ['2.0.0-beta.1', 'v2.0.0-beta.1', 0],
        ['2.0.0-beta.10', '2.0.0-beta.2', 1],
        // release-only rows must stay byte-identical to legacy behavior
        ['1.2.3', '1.2.3', 0],
        ['1.2.3', '1.2.4', -1],
        ['2.0.0', '1.106.0', 1],
    ];

    for (const [a, b, expected] of MATRIX) {
        test(`compareSemver('${a}', '${b}') === ${expected} without throwing`, () => {
            let result;
            assert.doesNotThrow(() => { result = compareSemver(a, b); });
            assert.equal(result, expected);
        });
    }

    test('still throws on genuinely malformed input', () => {
        assert.throws(() => compareSemver('abc', '1.0.0'), /Invalid semver comparison/);
        assert.throws(() => compareSemver('1.0.0', 'abc'), /Invalid semver comparison/);
    });
});

function makeFixture(name) {
    const root = mkdtempSync(path.join(tmpdir(), `check-update-prerelease-${name}-`));
    const extensionDir = path.join(root, 'extension-root');
    const dataRoot = path.join(root, 'data-root');
    const homeDir = path.join(root, 'home');
    const binDir = path.join(root, 'shim-bin');
    mkdirSync(path.join(extensionDir, 'extension', 'bin'), { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    // extension-root sentinel (pickle-utils EXTENSION_ROOT_SENTINEL)
    writeFileSync(path.join(extensionDir, 'extension', 'bin', 'log-watcher.js'), '');
    writeFileSync(
        path.join(extensionDir, 'extension', 'package.json'),
        JSON.stringify({ version: PRERELEASE_CURRENT }),
    );
    return { root, extensionDir, dataRoot, homeDir, binDir };
}

function childEnv(fixture, { systemPath = true } = {}) {
    return {
        ...process.env,
        EXTENSION_DIR: fixture.extensionDir,
        PICKLE_DATA_ROOT: fixture.dataRoot,
        HOME: fixture.homeDir,
        PATH: systemPath ? `${fixture.binDir}:${process.env.PATH}` : fixture.binDir,
    };
}

function runChildModule(fixture, script, opts) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fixture.root,
        encoding: 'utf8',
        env: childEnv(fixture, opts),
        timeout: SPAWN_TIMEOUT_MS,
    });
    assert.equal(result.status, 0, `child failed: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
}

function writeGhApiShim(fixture, tagName) {
    const shim = [
        '#!/bin/bash',
        'if [ "$1" = "api" ]; then',
        `  echo '{"tag_name":"${tagName}","assets":[]}'`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
    ].join('\n');
    writeFileSync(path.join(fixture.binDir, 'gh'), shim);
    chmodSync(path.join(fixture.binDir, 'gh'), 0o755);
}

function makeReleaseTarball(fixture, version) {
    const stage = path.join(fixture.root, 'tarball-stage');
    const payloadRoot = path.join(stage, 'pkg');
    mkdirSync(path.join(payloadRoot, 'extension'), { recursive: true });
    writeFileSync(path.join(payloadRoot, 'extension', 'package.json'), JSON.stringify({ version }));
    writeFileSync(path.join(payloadRoot, 'install.sh'), '#!/bin/bash\nexit 0\n');
    chmodSync(path.join(payloadRoot, 'install.sh'), 0o755);
    const tarball = path.join(fixture.root, 'release.tar.gz');
    const tar = spawnSync('tar', ['-czf', tarball, '-C', stage, 'pkg'], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
    });
    assert.equal(tar.status, 0, `tar failed: ${tar.stderr}`);
    return tarball;
}

function writeGhDownloadShim(fixture, tagName, tarball) {
    const shim = [
        '#!/bin/bash',
        'if [ "$1" = "api" ]; then',
        `  echo '{"tag_name":"${tagName}","assets":[]}'`,
        '  exit 0',
        'fi',
        'if [ "$1" = "release" ] && [ "$2" = "download" ]; then',
        '  dest=""',
        '  prev=""',
        '  for arg in "$@"; do',
        '    if [ "$prev" = "-D" ]; then dest="$arg"; fi',
        '    prev="$arg"',
        '  done',
        `  cp ${JSON.stringify(tarball)} "$dest/"`,
        '  exit 0',
        'fi',
        'exit 1',
        '',
    ].join('\n');
    writeFileSync(path.join(fixture.binDir, 'gh'), shim);
    chmodSync(path.join(fixture.binDir, 'gh'), 0o755);
}

function writeCacheFile(fixture, cache) {
    writeFileSync(path.join(fixture.extensionDir, 'update-check.json'), JSON.stringify(cache));
}

describe('check-update prerelease: caller surfaces no-throw with prerelease current version', () => {
    test('checkForUpdate fresh-cache path (checkFreshCache caller)', () => {
        const fixture = makeFixture('fresh-cache');
        writeCacheFile(fixture, {
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: '2.0.0',
            current_version: PRERELEASE_CURRENT,
        });
        const script = `
            import { checkForUpdate } from ${CHECK_UPDATE_URL};
            console.log(JSON.stringify(checkForUpdate()));
        `;
        // PATH has no gh and no system dirs: proves the fresh-cache branch ran
        const output = runChildModule(fixture, script, { systemPath: false });
        assert.equal(output.status, 'update-available');
        assert.equal(output.currentVersion, PRERELEASE_CURRENT);
        assert.equal(output.latestVersion, '2.0.0');
        assert.equal(output.error, undefined);
    });

    test('checkForUpdate stale-cache path (applyAvailableUpdate caller)', () => {
        const fixture = makeFixture('stale-cache');
        writeGhApiShim(fixture, 'v1.0.0');
        const script = `
            import { checkForUpdate } from ${CHECK_UPDATE_URL};
            console.log(JSON.stringify(checkForUpdate()));
        `;
        const output = runChildModule(fixture, script);
        assert.equal(output.status, 'up-to-date');
        assert.equal(output.currentVersion, PRERELEASE_CURRENT);
        assert.equal(output.latestVersion, '1.0.0');
    });

    test('performUpgrade inspection path (inspectReleaseForUpgrade caller)', () => {
        const fixture = makeFixture('perform-upgrade');
        const tarball = makeReleaseTarball(fixture, '2.0.0');
        writeGhDownloadShim(fixture, 'v2.0.0', tarball);
        const script = `
            import { performUpgrade } from ${CHECK_UPDATE_URL};
            const result = performUpgrade('${PRERELEASE_CURRENT}', '2.0.0', 'v2.0.0', { force: true });
            console.log(JSON.stringify(result));
        `;
        const output = runChildModule(fixture, script);
        assert.equal(output.success, true);
        // updateCacheAfterInstall round-trips the prerelease current version
        const cache = JSON.parse(readFileSync(path.join(fixture.extensionDir, 'update-check.json'), 'utf8'));
        assert.equal(cache.latest_version, '2.0.0');
        assert.equal(cache.current_version, PRERELEASE_CURRENT);
    });

    test('CLI --upgrade path exits 0 (previously uncaught throw)', () => {
        const fixture = makeFixture('cli-upgrade');
        writeGhApiShim(fixture, 'v1.0.0');
        const result = spawnSync(process.execPath, [CHECK_UPDATE, '--upgrade'], {
            cwd: fixture.root,
            encoding: 'utf8',
            env: childEnv(fixture),
            timeout: SPAWN_TIMEOUT_MS,
        });
        assert.equal(result.status, 0, `CLI failed: ${result.stderr || result.stdout}`);
        const output = JSON.parse(result.stdout);
        assert.equal(output.status, 'up-to-date');
        assert.equal(output.currentVersion, PRERELEASE_CURRENT);
    });
});

describe('check-update prerelease: cache round-trip', () => {
    test('writeCache then readCache preserves prerelease strings unchanged', () => {
        const fixture = makeFixture('cache-roundtrip');
        const epoch = Math.floor(Date.now() / 1000);
        const script = `
            import { writeCache, readCache } from ${CHECK_UPDATE_URL};
            writeCache({
                last_check_epoch: ${epoch},
                latest_version: '${PRERELEASE_CURRENT}',
                current_version: '${PRERELEASE_CURRENT}',
            });
            console.log(JSON.stringify(readCache()));
        `;
        const output = runChildModule(fixture, script, { systemPath: false });
        assert.equal(output.latest_version, PRERELEASE_CURRENT);
        assert.equal(output.current_version, PRERELEASE_CURRENT);
        assert.equal(output.last_check_epoch, epoch);
    });
});
