// @tier: fast
// R-PGI-7: tests for per-ticket graph context injection and corrected GITNEXUS block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    extractScopeSymbols,
    readGitNexusRepoName,
    buildGraphContextSlice,
    buildWorkerPrompt,
} from '../bin/spawn-morty.js';

function makeTmpDir(prefix = 'pgi7-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeTmpDirWithGitNexus(repoName = 'test-repo') {
    const tmpDir = makeTmpDir();
    const gnDir = path.join(tmpDir, '.gitnexus');
    fs.mkdirSync(gnDir, { recursive: true });
    fs.writeFileSync(path.join(gnDir, 'meta.json'), JSON.stringify({
        repoPath: path.join('/fake/repos', repoName),
        stats: { nodes: 100, edges: 200 },
    }));
    return tmpDir;
}

function makeTicketSpec(overrides = {}) {
    return {
        task: 'test task',
        ticketContent: '',
        ticketId: 'test-001',
        ticketPath: os.tmpdir(),
        sessionRoot: os.tmpdir(),
        backend: 'claude',
        isReviewTicket: false,
        ...overrides,
    };
}

const SAMPLE_TICKET_WITH_SCOPE = `
## Files to modify:
- \`extension/src/bin/spawn-morty.ts\`:
  - Rewrite \`buildWorkerPrompt\` to inject the slice.
  - Keep \`hasGitNexusIndex\` as the gate.
  - Also update \`BuildWorkerPromptOptions\`.
`;

const FAKE_IMPACT_RESPONSE = JSON.stringify({
    target: {
        id: 'Function:extension/src/bin/spawn-morty.ts:buildWorkerPrompt',
        name: 'buildWorkerPrompt',
        type: 'Function',
        filePath: 'extension/src/bin/spawn-morty.ts',
    },
    direction: 'upstream',
    impactedCount: 1,
    risk: 'LOW',
    summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
    byDepth: {
        'd=1': [{ name: 'main', filePath: 'extension/src/bin/spawn-morty.ts' }],
    },
});

const FAKE_NOT_FOUND_RESPONSE = JSON.stringify({
    error: 'Target not found',
    impactedCount: 0,
    risk: 'UNKNOWN',
});

// ---------------------------------------------------------------------------
// extractScopeSymbols
// ---------------------------------------------------------------------------

test('extractScopeSymbols: extracts function names from Files to modify section', () => {
    const symbols = extractScopeSymbols(SAMPLE_TICKET_WITH_SCOPE);
    assert.ok(symbols.includes('buildWorkerPrompt'), 'includes buildWorkerPrompt');
    assert.ok(symbols.includes('hasGitNexusIndex'), 'includes hasGitNexusIndex');
    assert.ok(symbols.includes('BuildWorkerPromptOptions'), 'includes BuildWorkerPromptOptions');
});

test('extractScopeSymbols: excludes file paths (tokens with /)', () => {
    const symbols = extractScopeSymbols(SAMPLE_TICKET_WITH_SCOPE);
    assert.ok(!symbols.some(s => s.includes('/')), 'no file paths in symbols');
});

test('extractScopeSymbols: strips trailing () from function names', () => {
    const content = `## Files to modify:\n- \`foo.ts\`: update \`doTheThing()\`.`;
    const symbols = extractScopeSymbols(content);
    assert.ok(symbols.includes('doTheThing'), 'strips ()');
    assert.ok(!symbols.includes('doTheThing()'), 'does not keep ()');
});

test('extractScopeSymbols: returns empty array when no Files to modify section', () => {
    const symbols = extractScopeSymbols('No scope information here.');
    assert.deepEqual(symbols, []);
});

test('extractScopeSymbols: caps output at 5 symbols', () => {
    const content = `## Files to modify:\n` +
        ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(s => `  - update \`${s}Fn\``).join('\n');
    const symbols = extractScopeSymbols(content);
    assert.ok(symbols.length <= 5, 'max 5 symbols');
});

// ---------------------------------------------------------------------------
// readGitNexusRepoName
// ---------------------------------------------------------------------------

test('readGitNexusRepoName: reads basename from meta.json repoPath', () => {
    const tmp = makeTmpDirWithGitNexus('my-cool-repo');
    const name = readGitNexusRepoName(tmp);
    assert.equal(name, 'my-cool-repo');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('readGitNexusRepoName: falls back to repoRoot basename when meta.json missing', () => {
    const tmp = makeTmpDir('no-gitnexus-');
    const name = readGitNexusRepoName(tmp);
    assert.equal(name, path.basename(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildGraphContextSlice
// ---------------------------------------------------------------------------

test('buildGraphContextSlice: returns null when no .gitnexus dir', () => {
    const tmp = makeTmpDir('no-idx-');
    const result = buildGraphContextSlice(SAMPLE_TICKET_WITH_SCOPE, tmp);
    assert.equal(result, null, 'null when no gitnexus index');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildGraphContextSlice: returns null when ticket has no scope symbols', () => {
    const tmp = makeTmpDirWithGitNexus();
    const result = buildGraphContextSlice('No Files to modify section.', tmp);
    assert.equal(result, null, 'null when no scope symbols');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildGraphContextSlice: returns null when gitnexus returns not-found for all symbols', () => {
    const tmp = makeTmpDirWithGitNexus();
    const fakeSpawn = () => ({
        stdout: FAKE_NOT_FOUND_RESPONSE,
        stderr: '',
        status: 0,
        error: null,
        pid: 0,
        signal: null,
        output: [],
    });
    const result = buildGraphContextSlice(SAMPLE_TICKET_WITH_SCOPE, tmp, fakeSpawn);
    assert.equal(result, null, 'null when all gitnexus queries return not-found');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// AC-PGI-7-1: ticket with known scope receives an impact/dependency slice when graph is available
test('AC-PGI-7-1: buildGraphContextSlice returns slice when graph available and scope known', () => {
    const tmp = makeTmpDirWithGitNexus('test-repo');
    let callCount = 0;
    const fakeSpawn = (_cmd, args) => {
        callCount++;
        // Return impact data for the first symbol, not-found for others
        if (callCount === 1) {
            return { stdout: FAKE_IMPACT_RESPONSE, stderr: '', status: 0, error: null, pid: 0, signal: null, output: [] };
        }
        return { stdout: FAKE_NOT_FOUND_RESPONSE, stderr: '', status: 0, error: null, pid: 0, signal: null, output: [] };
    };
    const slice = buildGraphContextSlice(SAMPLE_TICKET_WITH_SCOPE, tmp, fakeSpawn);
    assert.ok(slice !== null, 'slice is non-null when graph available and scope known');
    assert.ok(slice.includes('GRAPH CONTEXT'), 'slice includes GRAPH CONTEXT header');
    assert.ok(slice.includes('buildWorkerPrompt'), 'slice includes the symbol name');
    assert.ok(slice.includes('LOW'), 'slice includes risk level');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildGraphContextSlice: gracefully skips symbols when spawnSync errors', () => {
    const tmp = makeTmpDirWithGitNexus();
    const fakeSpawn = () => {
        return { stdout: null, stderr: 'error', status: 1, error: new Error('spawn failed'), pid: 0, signal: null, output: [] };
    };
    const result = buildGraphContextSlice(SAMPLE_TICKET_WITH_SCOPE, tmp, fakeSpawn);
    assert.equal(result, null, 'null when all spawns fail');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildWorkerPrompt — GITNEXUS block correctness (R-PGI-7 fix)
// ---------------------------------------------------------------------------

test('buildWorkerPrompt: includes graphContextSlice in prompt when provided', () => {
    const slice = '# GRAPH CONTEXT (pre-fetched)\n**`buildWorkerPrompt`** — risk: LOW, upstream callers: 1\n  - d=1: `main` (spawn-morty.ts)';
    const prompt = buildWorkerPrompt({
        ticket: makeTicketSpec({ backend: 'claude' }),
        model: 'sonnet',
        graphContextSlice: slice,
    });
    assert.ok(prompt.includes('GRAPH CONTEXT'), 'prompt includes GRAPH CONTEXT header');
    assert.ok(prompt.includes('buildWorkerPrompt'), 'prompt includes the symbol data');
});

test('buildWorkerPrompt: no graphContextSlice means no GRAPH CONTEXT block', () => {
    const tmp = makeTmpDir('no-idx-prompt-');
    const prompt = buildWorkerPrompt({
        ticket: makeTicketSpec({ backend: 'claude' }),
        model: 'sonnet',
        repoRoot: tmp,
    });
    assert.ok(!prompt.includes('GRAPH CONTEXT'), 'no GRAPH CONTEXT when no slice');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildWorkerPrompt: GITNEXUS block names mcp__gitnexus__ tools for claude backend', () => {
    const tmp = makeTmpDirWithGitNexus();
    const prompt = buildWorkerPrompt({
        ticket: makeTicketSpec({ backend: 'claude' }),
        model: 'sonnet',
        repoRoot: tmp,
    });
    assert.ok(prompt.includes('MCP tools are active'), 'claude prompt: MCP tools are active');
    assert.ok(prompt.includes('mcp__gitnexus__query'), 'claude prompt: correct mcp__gitnexus__ tool names');
    assert.ok(!prompt.includes('MCP tools are NOT available'), 'claude prompt: no "NOT available" language');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('buildWorkerPrompt: GITNEXUS block says NOT available for codex backend', () => {
    const tmp = makeTmpDirWithGitNexus();
    const prompt = buildWorkerPrompt({
        ticket: makeTicketSpec({ backend: 'codex' }),
        model: 'sonnet',
        repoRoot: tmp,
    });
    assert.ok(prompt.includes('MCP tools are NOT available'), 'codex prompt: NOT available language');
    assert.ok(!prompt.includes('mcp__gitnexus__query'), 'codex prompt: no MCP tool names');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// Preserve AC-PGI-4-1: no GITNEXUS block when no .gitnexus dir
test('buildWorkerPrompt: no GITNEXUS block when no gitnexus index (AC-PGI-4-1)', () => {
    const tmp = makeTmpDir('no-idx-ac4-');
    const prompt = buildWorkerPrompt({
        ticket: makeTicketSpec({ backend: 'claude' }),
        model: 'sonnet',
        repoRoot: tmp,
    });
    assert.ok(!prompt.includes('GITNEXUS CODE INTELLIGENCE'), 'no GITNEXUS block when index absent');
    fs.rmSync(tmp, { recursive: true, force: true });
});
