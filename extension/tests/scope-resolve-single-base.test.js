// @tier: fast
// AC-RSBI-2-1: same paths:<glob> resolves to same allowed_paths from a
// subpackage directory as from the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'resolve-scope.js');

function git(args, cwd) {
    const res = spawnSync('git', args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid',
            GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid',
        },
        encoding: 'utf-8',
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
    return (res.stdout || '').trim();
}

test('AC-RSBI-2-1: paths:<glob> resolves identically from subpackage vs repo root', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-'));
    const session1 = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-s1-'));
    const session2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-base-s2-'));
    try {
        git(['init', '-q', '-b', 'main'], repo);
        git(['config', 'commit.gpgsign', 'false'], repo);

        // root-level TS file
        fs.writeFileSync(path.join(repo, 'root.ts'), 'export const r = 1;\n');
        // subpackage with TS and JS files
        fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'mod.ts'), 'export const m = 2;\n');
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'util.js'), 'const u = 3;\n');
        git(['add', '.'], repo);
        git(['commit', '-qm', 'initial'], repo);

        const pkgDir = path.join(repo, 'pkg');

        // invoke from repo root
        execFileSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', session1,
        ], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });

        // invoke from subpackage — should produce same result after R-RSBI-2 fix
        execFileSync(process.execPath, [
            CLI_PATH, '--scope', 'paths:**/*.ts', '--session-root', session2,
        ], { cwd: pkgDir, stdio: ['pipe', 'pipe', 'pipe'] });

        const scope1 = JSON.parse(fs.readFileSync(path.join(session1, 'scope.json'), 'utf-8'));
        const scope2 = JSON.parse(fs.readFileSync(path.join(session2, 'scope.json'), 'utf-8'));

        assert.deepStrictEqual(
            scope1.allowed_paths,
            scope2.allowed_paths,
            'paths:<glob> from subpackage must produce same allowed_paths as from repo root (AC-RSBI-2-1)',
        );
        assert.ok(scope1.allowed_paths.includes('root.ts'), 'root.ts in allowed_paths');
        assert.ok(scope1.allowed_paths.includes('pkg/src/mod.ts'), 'pkg/src/mod.ts in allowed_paths');
        assert.ok(!scope1.allowed_paths.includes('pkg/src/util.js'), 'util.js excluded (not .ts)');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(session1, { recursive: true, force: true });
        fs.rmSync(session2, { recursive: true, force: true });
    }
});
