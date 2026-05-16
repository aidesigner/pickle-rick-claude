// @tier: fast
//
// R-WSRC-4 regression: `buildClaudeWorkerInvocation` MUST throw
// `AddDirOutsideSandboxError` when `process.env.PICKLE_TEST_MODE === '1'` AND
// any `addDirs[i]` (after realpath resolution) is outside os.tmpdir().
//
// Production passthrough: with PICKLE_TEST_MODE unset, REPO_ROOT addDirs are
// accepted (the assertion is dormant).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildWorkerInvocation,
    AddDirOutsideSandboxError,
    assertAddDirsUnderTmpdirIfTestMode,
} from '../services/backend-spawn.js';

function withTestMode(fn) {
    const prev = process.env.PICKLE_TEST_MODE;
    process.env.PICKLE_TEST_MODE = '1';
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.PICKLE_TEST_MODE;
        else process.env.PICKLE_TEST_MODE = prev;
    }
}

function withoutTestMode(fn) {
    const prev = process.env.PICKLE_TEST_MODE;
    delete process.env.PICKLE_TEST_MODE;
    try {
        fn();
    } finally {
        if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev;
    }
}

function mkTmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-add-dir-sandbox-')));
}

// AC-1: PICKLE_TEST_MODE=1 + REPO_ROOT addDir → throws
test('R-WSRC-4: PICKLE_TEST_MODE=1 with REPO_ROOT addDir throws AddDirOutsideSandboxError', () => {
    const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    withTestMode(() => {
        assert.throws(
            () => buildWorkerInvocation('claude', {
                prompt: 'test',
                addDirs: [REPO_ROOT],
            }),
            (err) => {
                assert.ok(err instanceof AddDirOutsideSandboxError, `expected AddDirOutsideSandboxError, got ${err.constructor.name}`);
                assert.ok(err.offendingDirs.includes(REPO_ROOT), `expected offendingDirs to include REPO_ROOT, got ${JSON.stringify(err.offendingDirs)}`);
                return true;
            },
        );
    });
});

// AC-1 (multi-dir): assertion lists ALL offenders, not just the first.
test('R-WSRC-4: assertion reports every addDir outside tmpdir, not just the first', () => {
    const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const homeDir = os.homedir();
    const tmp = mkTmpDir();
    let caught = null;
    try {
        withTestMode(() => {
            try {
                buildWorkerInvocation('claude', {
                    prompt: 'test',
                    addDirs: [REPO_ROOT, tmp, homeDir],
                });
            } catch (err) {
                caught = err;
            }
        });
        assert.ok(caught instanceof AddDirOutsideSandboxError, `expected AddDirOutsideSandboxError, got ${caught}`);
        assert.ok(caught.offendingDirs.includes(REPO_ROOT));
        assert.ok(caught.offendingDirs.includes(homeDir));
        assert.ok(!caught.offendingDirs.includes(tmp), 'tmpdir addDir must NOT be in offenders');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// AC-2: PICKLE_TEST_MODE=1 + tmpdir-rooted addDir → no throw
test('R-WSRC-4: PICKLE_TEST_MODE=1 with tmpdir addDirs builds invocation without throwing', () => {
    const tmp1 = mkTmpDir();
    const tmp2 = mkTmpDir();
    try {
        withTestMode(() => {
            const invocation = buildWorkerInvocation('claude', {
                prompt: 'hello',
                addDirs: [tmp1, tmp2],
            });
            assert.equal(invocation.cmd, 'claude');
            assert.equal(invocation.backend, 'claude');
            // both add-dir args present
            const addDirArgs = invocation.args.filter((arg, idx) => invocation.args[idx - 1] === '--add-dir');
            assert.ok(addDirArgs.includes(tmp1));
            assert.ok(addDirArgs.includes(tmp2));
        });
    } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
    }
});

// AC-3: PICKLE_TEST_MODE unset → production passthrough, no throw even on REPO_ROOT
test('R-WSRC-4: PICKLE_TEST_MODE unset is a production passthrough (no assertion)', () => {
    const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    withoutTestMode(() => {
        const invocation = buildWorkerInvocation('claude', {
            prompt: 'prod',
            addDirs: [REPO_ROOT],
        });
        assert.equal(invocation.cmd, 'claude');
        // REPO_ROOT exists, so --add-dir is added
        assert.ok(invocation.args.includes('--add-dir'));
        assert.ok(invocation.args.includes(REPO_ROOT));
    });
});

// AC-4: macOS symlink case — /var/folders/... vs /private/var/folders/...
//
// fs.mkdtempSync(os.tmpdir()) on macOS returns a path under /var/folders/...
// realpath resolves to /private/var/folders/... os.tmpdir() typically returns
// /var/folders/... so realpath-resolution of both sides is mandatory for the
// containment check to work. We construct an addDir that is under /var
// while os.tmpdir() is /var too, then prove realpath-symlink resolution
// doesn't cause a false positive when both sides resolve to /private/var.
test('R-WSRC-4: macOS /var → /private/var symlink realpath-resolves correctly', () => {
    // Build a path that exercises the realpath collapse: mkdtempSync returns
    // a /var-rooted path on Darwin and realpathSync collapses it to
    // /private/var. The assertion must handle both inputs.
    const rawTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-symlink-'));
    try {
        const realPathOfTmp = fs.realpathSync(rawTmp);
        withTestMode(() => {
            // Build invocation using the non-realpathed path. Even if rawTmp
            // is /var/folders/... and realPathOfTmp is /private/var/folders/...,
            // the assertion must accept it because realpath-resolution of
            // rawTmp lands inside realpath(os.tmpdir()).
            const invocation = buildWorkerInvocation('claude', {
                prompt: 'macos symlink',
                addDirs: [rawTmp],
            });
            assert.equal(invocation.cmd, 'claude');
            // Sanity: the realpath collapsed at least one path layer (Darwin)
            // OR the paths are identical (Linux). Either way, no throw.
            assert.ok(typeof realPathOfTmp === 'string');
        });
    } finally {
        fs.rmSync(rawTmp, { recursive: true, force: true });
    }
});

// AC-5: direct helper export — assertAddDirsUnderTmpdirIfTestMode is also a no-op
// when PICKLE_TEST_MODE is unset, even with REPO_ROOT.
test('R-WSRC-4: assertAddDirsUnderTmpdirIfTestMode is no-op without PICKLE_TEST_MODE', () => {
    const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    withoutTestMode(() => {
        // No throw
        assertAddDirsUnderTmpdirIfTestMode([REPO_ROOT, '/etc']);
    });
});

// AC-6: assertion ignores empty / undefined addDirs entries (matches the
// production loop which skips falsy entries).
test('R-WSRC-4: assertion ignores empty-string addDir entries', () => {
    const tmp = mkTmpDir();
    try {
        withTestMode(() => {
            assertAddDirsUnderTmpdirIfTestMode([tmp, '', tmp]);
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
