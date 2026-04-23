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

// --- 7. One branch fails, others succeed ---

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
