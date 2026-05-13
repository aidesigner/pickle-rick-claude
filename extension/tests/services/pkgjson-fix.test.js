// @tier: fast
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { performUpgrade } from '../../bin/check-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANONICAL_AUDIT_LOG = path.join(os.homedir(), '.claude', 'pickle-rick', 'deploy-audit.log');

function makeTmpDir() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkgjson-fix-test-')));
    fs.mkdirSync(path.join(dir, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension', 'bin', 'log-watcher.js'), '');
    return dir;
}

function writeDeployedPackage(dir, version) {
    fs.writeFileSync(
        path.join(dir, 'extension', 'package.json'),
        JSON.stringify({ version }),
    );
}

function makeReleaseTarball(tmpDir, version) {
    const contentRoot = path.join(tmpDir, `release-${version}`);
    const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
    fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
    fs.writeFileSync(
        path.join(packageRoot, 'extension', 'package.json'),
        JSON.stringify({ version }),
    );
    fs.writeFileSync(
        path.join(packageRoot, 'install.sh'),
        '#!/bin/sh\nprintf installed > "$EXTENSION_DIR/install-marker.txt"\n',
        { mode: 0o755 },
    );
    const tarball = path.join(tmpDir, `release-${version}.tar.gz`);
    execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'pickle-rick-claude']);
    return tarball;
}

function mockGhDownload(tmpDir, tarball) {
    const binDir = path.join(tmpDir, 'mock-bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
        path.join(binDir, 'gh'),
        `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-D" ]; then shift; dest="$1"; fi
  shift
done
mkdir -p "$dest"
cp ${JSON.stringify(tarball)} "$dest/pickle-release.tar.gz"
`,
        { mode: 0o755 },
    );
    return binDir;
}

// ---------------------------------------------------------------------------
// R-PJV-3: audit log isolation
// ---------------------------------------------------------------------------

describe('pkgjson-fix: R-PJV-3 audit log isolation', () => {
    let tmpDir;
    let origEnv;
    let origPath;
    let canonicalStatBefore;

    let origExt;
    beforeEach(() => {
        tmpDir = makeTmpDir();
        // R-PJV-3 audit-log location was repointed from EXTENSION_DIR root to
        // PICKLE_INSTALL_ROOT to match install.sh's actual write target.
        // EXTENSION_DIR still scopes performUpgrade's operations to tmpDir;
        // PICKLE_INSTALL_ROOT scopes the audit-log write target.
        origExt = process.env.EXTENSION_DIR;
        origEnv = process.env.PICKLE_INSTALL_ROOT;
        origPath = process.env.PATH;
        process.env.EXTENSION_DIR = tmpDir;
        process.env.PICKLE_INSTALL_ROOT = tmpDir;

        canonicalStatBefore = fs.existsSync(CANONICAL_AUDIT_LOG)
            ? fs.statSync(CANONICAL_AUDIT_LOG).mtimeMs
            : -1;
    });

    afterEach(() => {
        if (origExt === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origExt;
        if (origEnv === undefined) delete process.env.PICKLE_INSTALL_ROOT;
        else process.env.PICKLE_INSTALL_ROOT = origEnv;
        process.env.PATH = origPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('internal-gate: audit log written to PICKLE_INSTALL_ROOT, not canonical path', () => {
        writeDeployedPackage(tmpDir, '1.67.0');
        const tarball = makeReleaseTarball(tmpDir, '1.64.0');
        const binDir = mockGhDownload(tmpDir, tarball);
        process.env.PATH = `${binDir}:${process.env.PATH}`;

        const result = performUpgrade('1.67.0', '1.66.0', 'v1.66.0', { allowDowngrade: true, noConfirm: true });

        assert.equal(result.success, true);

        const auditLog = path.join(tmpDir, 'deploy-audit.log');
        assert.ok(fs.existsSync(auditLog), 'deploy-audit.log must be written in PICKLE_INSTALL_ROOT');

        const canonicalStatAfter = fs.existsSync(CANONICAL_AUDIT_LOG)
            ? fs.statSync(CANONICAL_AUDIT_LOG).mtimeMs
            : -1;
        assert.equal(canonicalStatAfter, canonicalStatBefore,
            'canonical deploy-audit.log must not be modified when EXTENSION_DIR is set');
    });

    test('atomic write integrity: audit log entry parses as valid JSON', () => {
        writeDeployedPackage(tmpDir, '1.67.0');
        const tarball = makeReleaseTarball(tmpDir, '1.64.0');
        const binDir = mockGhDownload(tmpDir, tarball);
        process.env.PATH = `${binDir}:${process.env.PATH}`;

        performUpgrade('1.67.0', '1.66.0', 'v1.66.0', { allowDowngrade: true, noConfirm: true });

        const auditLog = path.join(tmpDir, 'deploy-audit.log');
        const lines = fs.readFileSync(auditLog, 'utf-8').trim().split('\n');
        assert.ok(lines.length >= 1, 'at least one audit entry written');

        let entry;
        assert.doesNotThrow(() => { entry = JSON.parse(lines[lines.length - 1]); },
            'audit log line must be valid JSON (no torn write)');

        assert.equal(entry.event, 'DOWNGRADE');
        assert.ok(typeof entry.src_version === 'string', 'src_version field present');
        assert.ok(typeof entry.dep_version === 'string', 'dep_version field present');
        assert.ok(typeof entry.ts === 'string', 'ts field present');
    });
});
