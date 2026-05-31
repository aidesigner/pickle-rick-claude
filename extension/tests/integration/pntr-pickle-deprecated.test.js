// @tier: integration
// R-PNTR-5 (AC-PNTR-05): .claude/commands/pickle.md is deleted; the bare /pickle
// deprecation route exits nonzero with the migration message and emits
// pickle_command_deprecated (in VALID_ACTIVITY_EVENTS).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEPRECATED_BIN = path.resolve(__dirname, '../../bin/pickle-deprecated.js');

test('AC-PNTR-05: .claude/commands/pickle.md is not tracked in git', () => {
    const result = spawnSync('git', ['ls-files', '.claude/commands/pickle.md'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        timeout: 10_000,
    });
    assert.equal(result.status, 0, 'git ls-files must succeed');
    assert.equal(
        result.stdout.trim(),
        '',
        '.claude/commands/pickle.md must not be tracked in git (returned: ' + JSON.stringify(result.stdout.trim()) + ')',
    );
});

test('AC-PNTR-05: pickle-deprecated.js exits non-zero with migration message', () => {
    const result = spawnSync(process.execPath, [DEPRECATED_BIN], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env, PICKLE_DATA_ROOT: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pntr-deprecated-')) },
    });
    assert.notEqual(result.status, 0, 'pickle-deprecated.js must exit non-zero');
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.match(combined, /\/pickle is removed/, 'must print deprecation message');
    assert.match(combined, /pickle-tmux/, 'must mention /pickle-tmux migration target');
    assert.match(combined, /pickle-refine-prd/, 'must mention /pickle-refine-prd migration target');
    assert.match(combined, /pickle-pipeline/, 'must mention /pickle-pipeline migration target');
});

test('AC-PNTR-05: pickle_command_deprecated is in VALID_ACTIVITY_EVENTS', async () => {
    const { VALID_ACTIVITY_EVENTS } = await import(
        path.resolve(__dirname, '../../types/index.js')
    );
    assert.ok(
        VALID_ACTIVITY_EVENTS.includes('pickle_command_deprecated'),
        'pickle_command_deprecated must be registered in VALID_ACTIVITY_EVENTS',
    );
});
