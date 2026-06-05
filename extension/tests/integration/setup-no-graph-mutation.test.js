// @tier: integration
//
// AC-GNXR-1-3: setup.js does NOT mutate tracked CLAUDE.md / AGENTS.md via
// `gitnexus analyze`. Root-fix for R-GNDT (#96): `ensureGraph` ran
// `gitnexus analyze <repoRoot>` which rewrote index-stat lines in tracked
// metadata files, dirtying the working tree before pipeline-runner's
// dirty-tree preflight could run.
//
// This test proves the regression is gone: after setup.js completes, the
// git working tree for both CLAUDE.md and AGENTS.md is clean.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../../bin/setup.js');

const sandboxDirs = [];
after(() => {
    for (const dir of sandboxDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function makeSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnxr1-no-graph-mutation-'));
    sandboxDirs.push(dir);
    return dir;
}

function gitInit(dir) {
    spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { encoding: 'utf-8' });
}

function gitAddAndCommit(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    const names = Object.keys(files);
    spawnSync('git', ['-C', dir, 'add', ...names], { encoding: 'utf-8' });
    spawnSync('git', ['-C', dir, 'commit', '-m', 'initial'], { encoding: 'utf-8' });
}

function gitDirtyFiles(dir) {
    const result = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8' });
    return result.stdout.trim().split('\n').filter(Boolean);
}

function runSetup(repoDir, dataRoot) {
    const deadline = Date.now() + 30_000;
    for (;;) {
        const result = spawnSync(
            process.execPath,
            [SETUP, '--tmux', '--task', 'gnxr-no-graph-mutation-probe'],
            {
                encoding: 'utf-8',
                cwd: repoDir,
                env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
            },
        );
        if (result.status === 0) return result;
        const stderr = result.stderr ?? '';
        if (/session-map collision blocked/.test(stderr) && Date.now() < deadline) {
            // Brief sleep via Atomics — retry on collision
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
            continue;
        }
        return result;
    }
}

test('AC-GNXR-1-3: setup.js does not dirty CLAUDE.md or AGENTS.md in the working tree', () => {
    const repoDir = makeSandbox();
    const dataRoot = makeSandbox();

    gitInit(repoDir);
    gitAddAndCommit(repoDir, {
        'CLAUDE.md': '# Claude instructions\n',
        'AGENTS.md': '# Agents\n',
    });

    // Confirm clean tree before setup
    const before = gitDirtyFiles(repoDir);
    assert.deepEqual(before, [], `tree must be clean before setup; got: ${before.join(', ')}`);

    const result = runSetup(repoDir, dataRoot);
    assert.equal(result.status, 0, `setup.js must exit 0 (stderr: ${result.stderr})`);

    // AC-GNXR-1-3: tree must remain clean — no stat-mutation from gitnexus analyze
    const after = gitDirtyFiles(repoDir);
    const mutated = after.filter((line) => /CLAUDE\.md|AGENTS\.md/.test(line));
    assert.deepEqual(
        mutated,
        [],
        `setup.js must NOT dirty CLAUDE.md or AGENTS.md; dirty: ${mutated.join(', ')}`,
    );
});

test('AC-GNXR-1-3: setup.js source contains no ensureGraph import from graph-preflight', () => {
    const setupSrc = path.resolve(__dirname, '../../src/bin/setup.ts');
    const src = fs.readFileSync(setupSrc, 'utf-8');
    assert.equal(
        /ensureGraph/.test(src),
        false,
        'setup.ts must not import or call ensureGraph (graph-preflight deleted)',
    );
    assert.equal(
        /graph-preflight/.test(src),
        false,
        'setup.ts must not reference graph-preflight module',
    );
});
