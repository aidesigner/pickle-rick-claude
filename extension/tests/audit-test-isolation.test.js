// @tier: integration
// SERIAL: runs audit-test-isolation.sh as a subprocess (~10-20s under load)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-test-isolation.sh');
const FIXTURES = path.resolve(__dirname, 'fixtures/audit-test-isolation');

test('audit-test-isolation: bad-unsandboxed fixture trips detector', () => {
    const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'bad-unsandboxed.test.js')], {
        encoding: 'utf-8',
        timeout: 30000,
    });
    assert.notEqual(
        result.status,
        0,
        `expected non-zero exit for unsandboxed fixture; stderr=${result.stderr}`,
    );
    assert.match(
        result.stderr,
        /bad-unsandboxed\.test\.js:\d+/,
        `expected file:line in stderr; got: ${result.stderr}`,
    );
    assert.match(
        result.stderr,
        /session-writing bin without PICKLE_DATA_ROOT sandbox/,
        `expected violation message in stderr; got: ${result.stderr}`,
    );
});

test('audit-test-isolation: good-sandboxed fixture passes', () => {
    const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'good-sandboxed.test.js')], {
        encoding: 'utf-8',
        timeout: 30000,
    });
    assert.equal(
        result.status,
        0,
        `expected exit 0 for sandboxed fixture; stderr=${result.stderr}`,
    );
});

test('audit-test-isolation: bad-working-dir-real-repo fixture trips detector', () => {
    const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'bad-working-dir-real-repo.test.js')], {
        encoding: 'utf-8',
        timeout: 30000,
    });
    assert.notEqual(
        result.status,
        0,
        `expected non-zero exit for real-repo working_dir; stderr=${result.stderr}`,
    );
    assert.match(
        result.stderr,
        /bad-working-dir-real-repo\.test\.js:\d+/,
        `expected file:line in stderr; got: ${result.stderr}`,
    );
    assert.match(
        result.stderr,
        /session-writing bin with real-repo working_dir/,
        `expected violation message in stderr; got: ${result.stderr}`,
    );
});

test('audit-test-isolation: good-extension-dir-repo-root fixture passes', () => {
    const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'good-extension-dir-repo-root.test.js')], {
        encoding: 'utf-8',
        timeout: 30000,
    });
    assert.equal(
        result.status,
        0,
        `expected exit 0 for EXTENSION_DIR: REPO_ROOT fixture; stderr=${result.stderr}`,
    );
});

test('audit-test-isolation: good-no-session-bin fixture passes', () => {
    const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'good-no-session-bin.test.js')], {
        encoding: 'utf-8',
        timeout: 30000,
    });
    assert.equal(
        result.status,
        0,
        `expected exit 0 for no-session-bin fixture; stderr=${result.stderr}`,
    );
});

test('audit-test-isolation: real tests/ directory exits 0 (no violations)', () => {
    const result = spawnSync('bash', [SCRIPT], {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf-8',
        timeout: 60000,
    });
    assert.equal(
        result.status,
        0,
        `audit found violations in real tests/; stderr=${result.stderr}`,
    );
});
