// @tier: fast
// R-RTRC-6: regression suite — 3 fixture tickets exercising each of:
//   RC-1: forward-ref-annotated bundle artifact (R-RTRC-2 + R-RTRC-7)
//   RC-2: test-defined helper resolves via lifted tests/ exclusion (R-RTRC-3)
//   RC-3: deep repo path resolves via git ls-files suffix-match (R-RTRC-4)
// AC-RTRC-01: contract-only run on a regression fixture exits 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix = 'pickle-rtrc-fixture-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `linear_ticket_${id}.md`);
    fs.writeFileSync(ticketPath, body);
    return ticketPath;
}

function runReadiness(sessionDir, repoRoot = REPO_ROOT, extraArgs = []) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--contract-only',
        ...extraArgs,
    ], { encoding: 'utf-8', timeout: 15000 });
}

test('R-RTRC-6 RC-1: forward-ref-annotated bundle artifact resolves clean', () => {
    const sessionDir = tmpDir();
    try {
        // Forward-created path (does NOT exist at HEAD) annotated per R-RTRC-7
        // schema. Annotation MUST be exactly `(created by ticket <hash>)` with
        // exactly one ASCII space separator. Resolver skips the path (R-RTRC-2).
        writeTicket(sessionDir, 'rc1ann01', [
            '---',
            'id: rc1ann01',
            'key: RC1-ANN',
            'ac_ids: []',
            '---',
            '',
            '# RC-1 forward-ref-annotated artifact',
            '',
            '## Files',
            '',
            '- `extension/services/forward-created-by-ticket-rc1ann01.ts` (created by ticket rc1ann01)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command writes a JSON file with field `kind` matching exactly `bundle`.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-6 RC-2: test-defined helper resolves via lifted tests/ exclusion', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-rtrc-repo-');
    try {
        // Build a tiny git repo whose only source is a test helper. With the
        // pre-fix `tests/` exclusion, the helper would not be in the resolver
        // scope and the contract finding would fire. R-RTRC-3 lifts the
        // exclusion so the symbol resolves.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'rtrc@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'rtrc'], { cwd: repoRoot });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'helper-fixture.test.js'),
            'export class RtrcHelperRune { static buildSeed() { return 42; } }\n',
        );
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const symbol = 'RtrcHelperRune.buildSeed()';
        writeTicket(sessionDir, 'rc2test1', [
            '---',
            'id: rc2test1',
            'key: RC2-TEST',
            'ac_ids: []',
            '---',
            '',
            '# RC-2 test-defined helper',
            '',
            '## Interface Contracts',
            '',
            `- \`${symbol}\` MUST exist.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test tests/helper-fixture.test.js` exits 0.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const contractFindings = out.findings.filter((f) => f.kind === 'contract' && f.detail === symbol);
        assert.equal(contractFindings.length, 0, 'R-RTRC-3 should resolve test-defined helper');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('AC-B1 B1-SUFFIX: declared deep `extension/tests/X` suppresses a bare `tests/X` ref', () => {
    const sessionDir = tmpDir();
    try {
        // Forward-created path declared under ## Files as the DEEP form, then
        // referenced elsewhere as the bare `tests/X` form. Exact membership would
        // miss the bare ref; suffix-symmetric suppression must catch it.
        writeTicket(sessionDir, 'b1suffix1', [
            '---',
            'id: b1suffix1',
            'key: B1-SUFFIX',
            'ac_ids: []',
            '---',
            '',
            '# B1 suffix-symmetric (declared deep, referenced bare)',
            '',
            '## Files to create',
            '',
            '- `extension/tests/b1suffix-fixture.test.js`',
            '',
            '## Description',
            '',
            'The new test lives at `tests/b1suffix-fixture.test.js`.',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test tests/b1suffix-fixture.test.js` exits 0.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, `bare tests/X ref must be suppressed by declared deep path; got ${JSON.stringify(pathFindings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AC-B1 B1-REVERSE: declared bare `tests/X` suppresses a deep `extension/tests/X` ref', () => {
    const sessionDir = tmpDir();
    try {
        // Reverse direction: declared as the BARE form, referenced as the DEEP
        // form. The declared bare path is a suffix of the deep ref.
        writeTicket(sessionDir, 'b1rev001', [
            '---',
            'id: b1rev001',
            'key: B1-REVERSE',
            'ac_ids: []',
            '---',
            '',
            '# B1 reverse direction (declared bare, referenced deep)',
            '',
            '## Files to create',
            '',
            '- `tests/b1reverse-fixture.test.js`',
            '',
            '## Description',
            '',
            'Wired from `extension/tests/b1reverse-fixture.test.js`.',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] `node --test extension/tests/b1reverse-fixture.test.js` exits 0.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, `deep ref must be suppressed by declared bare path; got ${JSON.stringify(pathFindings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('AC-B1 B1-PHANTOM: genuine phantom (no declaration, no HEAD file) still flags', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-b1-repo-');
    try {
        // Empty git repo so the path cannot resolve via bases or git ls-files,
        // and the ticket declares nothing forward-created. Teeth must fire.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'b1@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'b1'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        const phantom = 'extension/services/b1phantom-nonexistent.ts';
        writeTicket(sessionDir, 'b1phan01', [
            '---',
            'id: b1phan01',
            'key: B1-PHANTOM',
            'ac_ids: []',
            '---',
            '',
            '# B1 genuine phantom',
            '',
            '## Description',
            '',
            `Touches \`${phantom}\` but never declares it forward-created.`,
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Field `kind` equals exactly `phantom`.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.notEqual(result.status, 0, `expected non-zero exit for phantom; stdout=${result.stdout}; stderr=${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'fail');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path' && f.detail === phantom);
        assert.equal(pathFindings.length, 1, `genuine phantom must flag exactly once; got ${JSON.stringify(out.findings)}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('R-RTRC-6 RC-3: deep repo path resolves via git ls-files suffix-match', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-rtrc-repo-');
    try {
        // Deep nested file. None of resolvePathRef's static bases (repoRoot,
        // repoRoot/extension, ticket cwd, sessionDir) resolve `nested-deep.ts`
        // alone. R-RTRC-4 falls back to `git ls-files | grep '/<ref>$'`.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'rtrc@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'rtrc'], { cwd: repoRoot });
        const deepDir = path.join(repoRoot, 'packages', 'core', 'src', 'modules', 'rtrc', 'deep');
        fs.mkdirSync(deepDir, { recursive: true });
        fs.writeFileSync(path.join(deepDir, 'nested-deep.ts'), 'export const sigil = true;\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        writeTicket(sessionDir, 'rc3deep1', [
            '---',
            'id: rc3deep1',
            'key: RC3-DEEP',
            'ac_ids: []',
            '---',
            '',
            '# RC-3 deep repo path',
            '',
            '## Files',
            '',
            // Bare basename — only the suffix-match fallback can resolve this.
            '- `nested-deep.ts`',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] File `nested-deep.ts` exists at HEAD.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        const pathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(pathFindings.length, 0, 'R-RTRC-4 suffix-match must resolve deep path');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
