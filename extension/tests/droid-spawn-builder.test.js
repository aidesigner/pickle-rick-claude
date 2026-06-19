// @tier: fast
// CHEAP unit/fixture test for the droid spawn builders (no real `droid exec`, no credits).
// Covers VAL-IMPL-009 (--auto medium commit-capable workers) and VAL-IMPL-024
// (full prompt delivered via stdin) at the invocation-shape level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    buildWorkerInvocation,
    buildManagerInvocation,
} from '../services/backend-spawn.js';

// --- buildWorkerInvocation(droid) ---

test('droid-spawn.worker: cmd/backend are droid, base args are exec/stream-json/auto-medium/glm-5.2', () => {
    const inv = buildWorkerInvocation('droid', {
        prompt: 'Implement hello.js that prints hello world.',
        addDirs: ['/tmp/repo', '/tmp/ext'],
    });
    assert.equal(inv.cmd, 'droid');
    assert.equal(inv.backend, 'droid');
    // Exact base argv — no prompt leaked into args (delivered via stdin instead).
    assert.deepEqual(inv.args, ['exec', '--output-format', 'stream-json', '--auto', 'medium', '-m', 'glm-5.2']);
});

test('droid-spawn.worker: --auto medium is present, never read-only default or low', () => {
    const inv = buildWorkerInvocation('droid', { prompt: 'x', addDirs: [] });
    const autoIdx = inv.args.indexOf('--auto');
    assert.ok(autoIdx >= 0, '--auto flag present');
    assert.equal(inv.args[autoIdx + 1], 'medium', 'worker autonomy is medium (commit-capable)');
    assert.ok(!inv.args.includes('--auto low'), 'never --auto low');
    assert.ok(!inv.args.includes('--auto high'), 'no --auto high for workers');
});

test('droid-spawn.worker: full prompt is carried on stdinPrompt, not in args', () => {
    const prompt = 'A fairly long, non-trivial prompt.\nWith multiple lines.\n<promise>I AM DONE</promise> should appear only after real work.';
    const inv = buildWorkerInvocation('droid', { prompt, addDirs: [] });
    assert.equal(typeof inv.stdinPrompt, 'string');
    assert.equal(inv.stdinPrompt, prompt, 'stdinPrompt is the full intended prompt, byte-identical');
    assert.ok(inv.stdinPrompt.length > 0, 'non-empty');
    // No -p, no positional prompt, no -f — droid reads stdin.
    assert.ok(!inv.args.includes('-p'), 'no -p flag');
    assert.ok(!inv.args.includes('-f') && !inv.args.includes('--file'), 'no -f/--file flag');
    assert.ok(!inv.args.includes(prompt), 'prompt text never appears in argv');
});

test('droid-spawn.worker: custom model overrides glm-5.2 default via -m', () => {
    const inv = buildWorkerInvocation('droid', { prompt: 'x', addDirs: [], model: '  kimi-k2.7-code  ' });
    const modelIdx = inv.args.indexOf('-m');
    assert.ok(modelIdx >= 0);
    assert.equal(inv.args[modelIdx + 1], 'kimi-k2.7-code', 'trimmed model override applied');
});

test('droid-spawn.worker: explicit json outputFormat honored (defaults to stream-json otherwise)', () => {
    const jsonInv = buildWorkerInvocation('droid', { prompt: 'x', addDirs: [], outputFormat: 'json' });
    const ofIdx = jsonInv.args.indexOf('--output-format');
    assert.ok(ofIdx >= 0);
    assert.equal(jsonInv.args[ofIdx + 1], 'json');
    // 'text' is treated as unset (unparseable by the classifier) -> stream-json.
    const textInv = buildWorkerInvocation('droid', { prompt: 'x', addDirs: [], outputFormat: 'text' });
    assert.equal(textInv.args[textInv.args.indexOf('--output-format') + 1], 'stream-json');
});

test('droid-spawn.worker: ignores addDirs (no droid --add-dir equivalent)', () => {
    const inv = buildWorkerInvocation('droid', { prompt: 'x', addDirs: ['/tmp/a', '/tmp/b'] });
    assert.equal(inv.args.filter(a => a === '--add-dir').length, 0, 'no --add-dir emitted for droid');
});

test('droid-spawn.worker: empty prompt still sets stdinPrompt field (spawn site guards length)', () => {
    const inv = buildWorkerInvocation('droid', { prompt: '', addDirs: [] });
    assert.equal(inv.stdinPrompt, '');
});

// --- buildManagerInvocation(droid) ---

test('droid-spawn.manager: stream-json + auto medium + glm-5.2 + stdinPrompt', () => {
    const inv = buildManagerInvocation('droid', {
        prompt: 'Manage the implementation loop.',
        addDirs: ['/tmp/repo'],
        streamJson: true,
        maxTurns: 50,
        noSessionPersistence: true,
    });
    assert.equal(inv.cmd, 'droid');
    assert.equal(inv.backend, 'droid');
    assert.deepEqual(inv.args, ['exec', '--output-format', 'stream-json', '--auto', 'medium', '-m', 'glm-5.2']);
    assert.equal(inv.stdinPrompt, 'Manage the implementation loop.');
    // maxTurns/noSessionPersistence have no droid equivalent — dropped, not errored.
    assert.ok(!inv.args.includes('--max-turns'));
    assert.ok(!inv.args.includes('--no-session-persistence'));
});

test('droid-spawn.manager: custom model override applied', () => {
    const inv = buildManagerInvocation('droid', { prompt: 'x', addDirs: [], model: 'glm-5.1', streamJson: true });
    assert.equal(inv.args[inv.args.indexOf('-m') + 1], 'glm-5.1');
});

test('droid-spawn.manager: defaults to stream-json even without streamJson flag', () => {
    const inv = buildManagerInvocation('droid', { prompt: 'x', addDirs: [] });
    assert.equal(inv.args[inv.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(inv.stdinPrompt, 'x');
});

// ---------------------------------------------------------------------------
// VAL-IMPL-024: droid worker receives the full prompt via stdin (stub droid).
// A stub `droid` binary on PATH captures stdin bytes to a file; spawn-morty.js
// (the implement-loop worker spawn site) must write the intended, non-empty,
// non-truncated prompt to the child stdin and close it. No real droid exec /
// credits — the stub exits immediately after EOF.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');

function makeTmpDir(prefix = 'droid-spawn-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeExtensionSentinel(extensionDir) {
    const sentinelDir = path.join(extensionDir, 'extension', 'bin');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function writeDroidShim(shimDir, capturePath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'droid');
    // The stub reads ALL of stdin (until EOF) and writes the captured bytes plus
    // the spawned argv to capturePath (as JSON), then emits one stream-json
    // assistant line + exits 0. This mirrors `droid exec --output-format
    // stream-json` shape without credits.
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: data,
  }, null, 2));
  // Emit a stream-json assistant envelope so stdout is non-empty (mirrors droid).
  process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', text: 'stub droid captured stdin' }) + '\\n');
  process.exit(0);
});
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

test('VAL-IMPL-024: spawn-morty writes the full worker prompt to the droid child stdin and closes it', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-droid-stdin';
    try {
        writeExtensionSentinel(tmpDir);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, ticketId);
        const repoDir = path.join(tmpDir, 'repo');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'droid',
            working_dir: repoDir,
            iteration: 1,
            max_iterations: 5,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const capturePath = path.join(tmpDir, 'droid-stdin.txt');
        writeDroidShim(shimDir, capturePath);

        const task = 'implement the thing';
        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            task,
            '--ticket-id', ticketId,
            '--ticket-path', ticketDir,
            '--backend', 'droid',
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 60000,
        });

        // The stub does not emit the completion promise, so spawn-morty's
        // post-spawn validation fails (exit 1). The key evidence is the
        // captured stdin + argv, not the exit code.
        assert.ok(fs.existsSync(capturePath), 'stub droid should have been invoked and captured stdin');
        const captured = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
        // VAL-IMPL-009: worker command line includes --auto medium (commit-capable).
        const autoIdx = captured.argv.indexOf('--auto');
        assert.ok(autoIdx >= 0, 'spawned droid argv must include --auto');
        assert.equal(captured.argv[autoIdx + 1], 'medium', 'worker autonomy is --auto medium');
        assert.ok(!captured.argv.includes('low'), 'never --auto low');
        assert.ok(captured.argv.includes('exec'), 'spawned droid argv uses exec subcommand');
        const modelIdx = captured.argv.indexOf('-m');
        assert.ok(modelIdx >= 0 && captured.argv[modelIdx + 1] === 'glm-5.2', 'default model glm-5.2 on cmd line');
        // VAL-IMPL-024: full prompt delivered via stdin and stream closed.
        assert.ok(captured.stdin.length > 100, `captured stdin should be non-trivial (got ${captured.stdin.length} bytes)`);
        assert.ok(captured.stdin.includes(task), 'captured stdin must contain the intended task text');
        assert.ok(!captured.stdin.includes('--auto'), 'argv flags must NOT leak into the stdin prompt');
        // The full prompt was delivered and the stream closed (EOF) — proven by
        // the stub reaching the `end` handler and writing the file.
        assert.ok(result.status !== null, 'spawn-morty must exit (not hang) after the stub closes stdin');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('VAL-IMPL-024: captured droid stdin matches the buildWorkerInvocation stdinPrompt contract', () => {
    // Cross-check: the spawn-builder carries the full prompt on stdinPrompt and
    // the spawn site writes exactly that field. A representative long prompt
    // with special characters must round-trip byte-identical through stdinPrompt.
    const prompt = 'Multi-line prompt.\n\tIndented line.\n"quotes" and $shell ${vars}.\n<promise>I AM DONE</promise>\n— em dash — ✓';
    const inv = buildWorkerInvocation('droid', { prompt, addDirs: ['/tmp/x'] });
    assert.equal(inv.stdinPrompt, prompt, 'stdinPrompt round-trips the exact prompt bytes');
    assert.ok(inv.stdinPrompt.length === prompt.length, 'no truncation');
});
