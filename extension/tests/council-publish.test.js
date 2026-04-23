import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import publishCouncilStack, { CouncilPublishError } from '../bin/council-publish.js';

/**
 * withSession(fn) — mirrors withExtensionDir from get-session.test.js.
 * Creates a tmp session dir with a minimal council-stack.json (2 branches +
 * trunk, repo_path pointing at the tmp dir itself), invokes fn(sessionDir),
 * then cleans up.
 */
async function withSession(fn, { stack, summary, directive, skipStack } = {}) {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-cp-')));
    try {
        if (!skipStack) {
            const defaultStack = {
                branches: ['feat/one', 'feat/two', 'main'],
                trunk: 'main',
                repo_path: tmpDir,
                codex_enabled: true,
            };
            fs.writeFileSync(
                path.join(tmpDir, 'council-stack.json'),
                JSON.stringify(stack || defaultStack, null, 2),
            );
        }
        if (summary !== undefined) {
            fs.writeFileSync(path.join(tmpDir, 'council-of-ricks-summary.md'), summary);
        }
        if (directive !== undefined) {
            fs.writeFileSync(path.join(tmpDir, 'council-directive.md'), directive);
        }
        return await fn(tmpDir);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Writes a bash script that mocks the `gh` CLI. Behavior is driven by a JSON
 * control file — each invocation appends its argv to a log and returns stdout
 * / exit code based on a per-subcommand scenario.
 */
function makeGhMock(scenario) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-gh-')));
    const scenarioPath = path.join(dir, 'scenario.json');
    const callLog = path.join(dir, 'calls.log');
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario));
    fs.writeFileSync(stateFile, JSON.stringify({ prCommentCalls: 0 }));
    const ghPath = path.join(dir, 'gh');
    const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioPath)}, 'utf-8'));
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf-8'));

function writeState() { fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state)); }

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(scenario.auth === 'fail' ? 1 : 0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const headIdx = args.indexOf('--head');
  const branch = headIdx >= 0 ? args[headIdx + 1] : '';
  const mapping = scenario.prList || {};
  if (mapping[branch] === undefined) { process.stdout.write(''); process.exit(0); }
  if (mapping[branch] === '__error__') { process.stderr.write('simulated list error'); process.exit(1); }
  process.stdout.write(String(mapping[branch]) + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  state.prCommentCalls = (state.prCommentCalls || 0) + 1;
  writeState();
  const rule = scenario.prComment || {};
  if (rule.failOnCall && rule.failOnCall.includes(state.prCommentCalls)) {
    process.stderr.write('simulated comment error');
    process.exit(1);
  }
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(2);
`;
    fs.writeFileSync(ghPath, script);
    fs.chmodSync(ghPath, 0o755);
    return { ghPath, dir, callLog, stateFile };
}

function cleanupGhMock(mock) {
    fs.rmSync(mock.dir, { recursive: true, force: true });
}

// --- 1. Missing session_root throws ---

test('publishCouncilStack: throws CouncilPublishError for missing session_root', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-session-xyz-' + Date.now());
    assert.throws(
        () => publishCouncilStack(missing),
        (err) => err instanceof CouncilPublishError && /does not exist/.test(err.message),
    );
});

// --- 2. Missing council-stack.json throws ---

test('publishCouncilStack: throws when council-stack.json missing', async () => {
    await withSession((sessionDir) => {
        assert.throws(
            () => publishCouncilStack(sessionDir),
            (err) => err instanceof CouncilPublishError && /council-stack\.json/.test(err.message),
        );
    }, { skipStack: true });
});

// --- 3. gh unavailable → all branches skipped_no_gh ---

test('publishCouncilStack: gh auth fails → all branches skipped_no_gh, bodies still written', async () => {
    const mock = makeGhMock({ auth: 'fail' });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 0);
            assert.equal(report.results.length, 2); // trunk excluded
            for (const r of report.results) {
                assert.equal(r.outcome, 'skipped_no_gh');
                assert.ok(r.body_path && fs.existsSync(r.body_path), 'body file written');
            }
            assert.equal(report.skipped, 2);
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 4. Happy path ---

test('publishCouncilStack: happy path posts each branch exactly once', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 2);
            assert.equal(report.failed, 0);
            assert.equal(report.skipped, 0);
            const pubDir = path.join(sessionDir, '.published');
            assert.ok(fs.existsSync(path.join(pubDir, 'feat__one')));
            assert.ok(fs.existsSync(path.join(pubDir, 'feat__two')));
            const log = fs.readFileSync(path.join(sessionDir, 'publish.log'), 'utf-8').trim().split('\n');
            assert.equal(log.length, 2);
            for (const line of log) {
                const entry = JSON.parse(line);
                assert.equal(entry.outcome, 'posted');
                assert.ok(entry.ts);
            }
        }, {
            summary: '## Round 1: ISSUES\n| Branch |\n| --- |\n| feat/one |\n\n## Round 2: CLEAN\n',
            directive: '# Council Directive\n\n### Findings\n\n| Severity | Branch | File:Line |\n| --- | --- | --- |\n| HIGH | feat/one | a.ts:10 |\n',
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 5. Idempotency ---

test('publishCouncilStack: second run skips already-published branches', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const second = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(second.posted, 0);
            assert.equal(second.skipped, 2);
            for (const r of second.results) {
                assert.equal(r.outcome, 'skipped_already_published');
                assert.ok(r.body_path && fs.existsSync(r.body_path));
            }
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 6. No PR for a branch ---

test('publishCouncilStack: empty pr list → skipped_no_pr, no marker touched', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {}, // every branch returns empty string
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 0);
            assert.equal(report.skipped, 2);
            for (const r of report.results) {
                assert.equal(r.outcome, 'skipped_no_pr');
                assert.ok(r.body_path && fs.existsSync(r.body_path));
            }
            const pubDir = path.join(sessionDir, '.published');
            const markers = fs.existsSync(pubDir) ? fs.readdirSync(pubDir) : [];
            assert.equal(markers.length, 0, 'no markers should be created');
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 7. Prefer OPEN PR over MERGED when multiple share a head branch ---

test('publishCouncilStack: picks OPEN PR over MERGED when both exist for same head', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {
            // JSON array response — MERGED first, OPEN second. Publisher must
            // prefer OPEN regardless of ordering. Also covers a closed PR
            // re-run scenario where the merged one would be silently skipped
            // under the old --state=open default.
            'feat/one': JSON.stringify([
                { number: 101, state: 'MERGED', updatedAt: '2026-04-23T10:00:00Z' },
                { number: 202, state: 'OPEN', updatedAt: '2026-04-20T10:00:00Z' },
            ]),
            'feat/two': JSON.stringify([
                { number: 303, state: 'MERGED', updatedAt: '2026-04-23T10:00:00Z' },
            ]),
        },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 2);
            const one = report.results.find(r => r.branch === 'feat/one');
            const two = report.results.find(r => r.branch === 'feat/two');
            assert.equal(one.pr_number, 202, 'OPEN beats MERGED on same head');
            assert.equal(two.pr_number, 303, 'MERGED-only still posts (no --state=open filter)');
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 8. One branch fails, others succeed ---

test('publishCouncilStack: one pr comment failure does not abort sweep', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: { failOnCall: [2] }, // second pr comment invocation throws
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.equal(report.posted, 1);
            assert.equal(report.failed, 1);
            const posted = report.results.find(r => r.outcome === 'posted');
            const failed = report.results.find(r => r.outcome === 'failed');
            assert.ok(posted && posted.pr_number);
            assert.ok(failed && /pr comment/.test(failed.error || ''));
            assert.ok(posted.body_path && fs.existsSync(posted.body_path));
            assert.ok(failed.body_path && fs.existsSync(failed.body_path));
            // Only the posted branch gets a marker
            const pubDir = path.join(sessionDir, '.published');
            const markers = fs.readdirSync(pubDir);
            assert.equal(markers.length, 1);
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 9. Hardening: trunk must be in branches list ---

test('publishCouncilStack: throws when trunk is not in branches list', async () => {
    await withSession((sessionDir) => {
        assert.throws(
            () => publishCouncilStack(sessionDir),
            (err) => err instanceof CouncilPublishError && /trunk.*not in branches/.test(err.message),
        );
    }, {
        stack: {
            branches: ['feat/a', 'feat/b'], // no `main`
            trunk: 'main',
            repo_path: os.tmpdir(),
            codex_enabled: false,
        },
    });
});

// --- 10. Hardening: Branch-cell match normalizes backticks + padding ---

test('publishCouncilStack: Branch cell with backticks and padding still matches', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const oneBody = fs.readFileSync(
                path.join(sessionDir, 'council-comments', 'feat__one.md'),
                'utf-8',
            );
            // The directive's row (padded + backticked Branch cell) must land
            // in the feat/one body, NOT be treated as "no findings".
            assert.ok(
                /HIGH.*a\.ts:10/.test(oneBody),
                'padded/backticked Branch cell must match',
            );
            assert.ok(
                !/No findings for this branch/.test(oneBody),
                'should not fall through to empty-findings placeholder',
            );
        }, {
            directive: '# Council Directive\n\n### Findings\n\n| Severity | Branch | File:Line |\n| --- | --- | --- |\n| HIGH | ` feat/one ` | a.ts:10 |\n',
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 11. Hardening: zero-byte marker file is rejected as "not published" ---

test('publishCouncilStack: zero-byte .published marker is NOT treated as published', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            // Pre-create a zero-byte marker for feat/one.
            const pubDir = path.join(sessionDir, '.published');
            fs.mkdirSync(pubDir, { recursive: true });
            const fd = fs.openSync(path.join(pubDir, 'feat__one'), 'w');
            fs.closeSync(fd); // zero bytes
            assert.equal(fs.statSync(path.join(pubDir, 'feat__one')).size, 0);

            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'posted', 'zero-byte marker must not skip');
            // After posting, marker should be a real timestamp (non-zero size).
            assert.ok(fs.statSync(path.join(pubDir, 'feat__one')).size > 0);
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 12. Hardening: parsePrList strips non-JSON warning prefix lines ---

test('publishCouncilStack: warning line before JSON array is tolerated', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: {
            'feat/one': 'warning: something happened\n[{"number":42,"state":"OPEN","updatedAt":"2026-04-23T00:00:00Z"}]',
            'feat/two': 99,
        },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const one = report.results.find(r => r.branch === 'feat/one');
            assert.equal(one.outcome, 'posted');
            assert.equal(one.pr_number, 42, 'prefix-stripped JSON parsed correctly');
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 13. Hardening: empty findings across all branches emits a warning ---

test('publishCouncilStack: directive with no Findings table emits empty-findings warning', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    try {
        await withSession(async (sessionDir) => {
            const report = await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            assert.ok(Array.isArray(report.warnings), 'warnings field populated');
            assert.ok(
                report.warnings.some(w => /zero per-branch findings/.test(w)),
                'warning about zero per-branch findings present',
            );
            // Also present in publish.log as a warn-level line.
            const logLines = fs.readFileSync(path.join(sessionDir, 'publish.log'), 'utf-8')
                .trim().split('\n').map(JSON.parse);
            assert.ok(
                logLines.some(e => e.level === 'warn' && /zero per-branch findings/.test(e.message)),
                'warn line written to publish.log',
            );
        }, {
            directive: '# Council Directive — Round 1\n\nStack Overview text but no Findings table.\n',
        });
    } finally {
        cleanupGhMock(mock);
    }
});

// --- 14. Hardening: real Step 17 terminal suffixes produce Round bullets ---

test('publishCouncilStack: extractRoundOutcomes handles real terminal-suffix formats', async () => {
    const mock = makeGhMock({
        auth: 'ok',
        prList: { 'feat/one': 42, 'feat/two': 99 },
        prComment: {},
    });
    const summary = [
        '## Round 1: — clean round.',
        '',
        '## Round 2: — partial round (skipped: B2 CLAUDE.md Compliance, C_correctness:feat/bar).',
        '',
        '## Round 3: — 4 issues (1/2/1/0/0)',
        '',
    ].join('\n');
    try {
        await withSession(async (sessionDir) => {
            await publishCouncilStack(sessionDir, { ghCommand: mock.ghPath });
            const body = fs.readFileSync(
                path.join(sessionDir, 'council-comments', 'feat__one.md'),
                'utf-8',
            );
            // Three round bullets rendered, in order, from the three real suffixes.
            const r1 = body.indexOf('- Round 1:');
            const r2 = body.indexOf('- Round 2:');
            const r3 = body.indexOf('- Round 3:');
            assert.ok(r1 >= 0 && r2 > r1 && r3 > r2, 'three round bullets in order');
            assert.ok(/clean round/.test(body));
            assert.ok(/partial round \(skipped/.test(body));
            assert.ok(/4 issues \(1\/2\/1\/0\/0\)/.test(body));
        }, { summary });
    } finally {
        cleanupGhMock(mock);
    }
});
