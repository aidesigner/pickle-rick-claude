import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_BIN = path.resolve(__dirname, '../hooks/dispatch.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated temp directory for EXTENSION_DIR.
 * Resolves macOS /var -> /private/var symlinks for path consistency.
 */
function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-dispatch-')));
}

/**
 * Create the handlers directory inside a temp EXTENSION_DIR.
 * Returns the full path to extension/hooks/handlers/.
 */
function makeHandlersDir(extRoot) {
  const handlersDir = path.join(extRoot, 'extension', 'hooks', 'handlers');
  fs.mkdirSync(handlersDir, { recursive: true });
  return handlersDir;
}

/**
 * Write a mock handler .js file into the handlers directory.
 * @param {string} handlersDir - path to handlers directory
 * @param {string} hookName - name of the hook (file will be hookName.js)
 * @param {string} script - Node.js script content
 */
function writeHandler(handlersDir, hookName, script) {
  const filePath = path.join(handlersDir, `${hookName}.js`);
  fs.writeFileSync(filePath, script, { mode: 0o755 });
  return filePath;
}

/**
 * Run dispatch.js as a subprocess via spawnSync.
 * @param {object} opts
 * @param {string} opts.extRoot - EXTENSION_DIR value
 * @param {string[]} [opts.args] - arguments after dispatch.js
 * @param {string} [opts.input] - stdin data to pipe
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runDispatch(opts) {
  const { extRoot, args = [], input } = opts;
  const spawnOpts = {
    encoding: 'utf-8',
    env: { ...process.env, EXTENSION_DIR: extRoot },
    timeout: 10000,
  };
  if (input !== undefined) {
    spawnOpts.input = input;
  }
  const result = spawnSync(process.execPath, [DISPATCH_BIN, ...args], spawnOpts);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('dispatch: missing hook name exits with code 1 and prints Usage', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const { stdout, stderr, status } = runDispatch({ extRoot: tmpRoot, args: [] });
    assert.equal(status, 1, 'should exit with code 1');
    assert.ok(stderr.includes('Usage'), `stderr should contain "Usage", got: ${stderr}`);
    // Should not output any approve/block JSON
    assert.ok(!stdout.includes('"decision"'), 'should not output a decision on missing args');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: non-existent handler outputs approve (fail-open)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    // Create the handlers dir but no handler file
    makeHandlersDir(tmpRoot);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['nonexistent-hook'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'missing handler should fail-open with approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: valid handler returning approve forwards it to stdout', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    writeHandler(handlersDir, 'test-approve', `
      console.log(JSON.stringify({ decision: 'approve' }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-approve'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should forward approve decision');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: valid handler returning block forwards it to stdout', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    writeHandler(handlersDir, 'test-block', `
      console.log(JSON.stringify({ decision: 'block', reason: 'test block reason' }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-block'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'block', 'should forward block decision');
    assert.equal(parsed.reason, 'test block reason', 'should forward block reason');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler crash with no output falls back to approve', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that exits non-zero with no stdout
    writeHandler(handlersDir, 'test-crash', `
      process.exit(1);
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-crash'],
      input: '{}',
    });

    // Dispatcher exits with the child's exit code, but still outputs approve
    assert.equal(status, 1, 'should propagate the handler exit code');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should fail-open with approve on handler crash');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler that throws with no output falls back to approve', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    writeHandler(handlersDir, 'test-throw', `
      throw new Error('handler exploded');
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-throw'],
      input: '{}',
    });

    // Node exits with code 1 on uncaught exceptions
    assert.equal(status, 1, 'should propagate the non-zero exit code');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should fail-open with approve on handler throw');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: stdin is forwarded to the handler subprocess', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that reads stdin and echoes it wrapped in a decision JSON
    writeHandler(handlersDir, 'test-stdin', `
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const input = Buffer.concat(chunks).toString();
        console.log(JSON.stringify({ decision: 'approve', forwarded: input }));
      });
    `);

    const payload = JSON.stringify({ last_assistant_message: 'hello from dispatch' });
    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-stdin'],
      input: payload,
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should have approve decision');
    assert.equal(parsed.forwarded, payload, 'stdin should be forwarded to handler');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler stderr is forwarded to dispatcher stderr', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    writeHandler(handlersDir, 'test-stderr', `
      console.error('handler debug info');
      console.log(JSON.stringify({ decision: 'approve' }));
    `);

    const { stdout, stderr, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-stderr'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    assert.ok(stderr.includes('handler debug info'), 'handler stderr should be forwarded');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should still forward the decision');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: extra args are forwarded to the handler', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that reads process.argv and includes them in the output
    writeHandler(handlersDir, 'test-args', `
      const extra = process.argv.slice(2);
      console.log(JSON.stringify({ decision: 'approve', args: extra }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-args', '--flag', 'value'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve');
    assert.deepEqual(parsed.args, ['--flag', 'value'], 'extra args should be forwarded to handler');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler returning invalid JSON falls back to approve', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that outputs garbage (not JSON)
    writeHandler(handlersDir, 'test-garbage', `
      process.stdout.write('this is not json');
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-garbage'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'invalid JSON output should fall back to approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler returning invalid decision field falls back to approve', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that outputs valid JSON but with a bad decision value
    writeHandler(handlersDir, 'test-bad-decision', `
      console.log(JSON.stringify({ decision: 'allow', reason: 'wrong value' }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-bad-decision'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'invalid decision value should fall back to approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path traversal rejection (deep review pass 5)
// ---------------------------------------------------------------------------

test('dispatch: hook name with ../ path traversal outputs approve and exits 0', () => {
  const tmpRoot = makeTmpRoot();
  try {
    // Create handlers dir so the test environment is valid
    makeHandlersDir(tmpRoot);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['../../bin/setup'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'path traversal should be rejected with approve (fail-open)');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: hook name with / outputs approve (path traversal)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    makeHandlersDir(tmpRoot);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['foo/bar'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'slash in hook name should be rejected with approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: hook name with backslash outputs approve (path traversal)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    makeHandlersDir(tmpRoot);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['foo\\bar'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'backslash in hook name should be rejected with approve');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler output whitespace is normalized (clean JSON forwarded)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that outputs JSON with extra whitespace/newlines
    writeHandler(handlersDir, 'test-whitespace', `
      process.stdout.write('  {"decision":"approve","extra":"data"}  \\n');
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-whitespace'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve', 'should have approve decision');
    // The forwarded output should be clean JSON (re-serialized), not the raw whitespace-padded version
    assert.ok(
      stdout.trim().startsWith('{'),
      `output should start with { (no leading whitespace), got: ${JSON.stringify(stdout)}`
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler with debug output before JSON decision still works', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that writes debug text to stdout before the real decision
    writeHandler(handlersDir, 'test-multiline', `
      console.log('DEBUG: processing hook...');
      console.log('some other debug line');
      console.log(JSON.stringify({ decision: 'block', reason: 'test reason' }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-multiline'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'block', 'should find the block decision despite debug lines before it');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: handler with debug output after JSON decision uses last valid JSON (backward scan)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that writes the decision then more debug text
    writeHandler(handlersDir, 'test-trailing', `
      console.log(JSON.stringify({ decision: 'block', reason: 'real decision' }));
      console.log('trailing debug output');
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-trailing'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'block', 'should find block decision even with trailing output');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: two valid JSON decisions → last one wins (backward scan)', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // First line: approve; last line: block — backward scan should pick block
    writeHandler(handlersDir, 'test-two-decisions', `
      console.log(JSON.stringify({ decision: 'approve', reason: 'first' }));
      console.log('some debug output');
      console.log(JSON.stringify({ decision: 'block', reason: 'last wins' }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-two-decisions'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'block', 'last valid JSON decision wins (backward scan)');
    assert.equal(parsed.reason, 'last wins');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('dispatch: EXTENSION_DIR env var is passed to the handler', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const handlersDir = makeHandlersDir(tmpRoot);
    // Handler that reads EXTENSION_DIR from its environment
    writeHandler(handlersDir, 'test-env', `
      console.log(JSON.stringify({
        decision: 'approve',
        ext_dir: process.env.EXTENSION_DIR,
      }));
    `);

    const { stdout, status } = runDispatch({
      extRoot: tmpRoot,
      args: ['test-env'],
      input: '{}',
    });

    assert.equal(status, 0, 'should exit with code 0');
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.decision, 'approve');
    assert.equal(parsed.ext_dir, tmpRoot, 'EXTENSION_DIR should be passed to the handler');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
