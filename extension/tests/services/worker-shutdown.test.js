// @tier: fast
// R-WSE-1 — flushAndExit helper: verifies close event fires before process.exit.
// Uses a child-process subtest to observe exit code and stdout ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SHUTDOWN_JS = path.resolve(__dirname, '../../services/worker-shutdown.js');

test('flushAndExit: close event fires before process.exit', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wse1-flush-exit-'));
  const logPath = path.join(tmpDir, 'test.log');

  // Child script:
  // 1. Creates a write stream and writes some data
  // 2. Registers a 'close' listener that emits 'CLOSE_EVENT' to stdout
  // 3. Calls flushAndExit(stream, 42) — must flush, emit close, then exit(42)
  // 4. The line after flushAndExit is unreachable; emitting it would be a bug
  const script = `
import { createWriteStream } from 'node:fs';
import { flushAndExit } from ${JSON.stringify(WORKER_SHUTDOWN_JS)};

const stream = createWriteStream(${JSON.stringify(logPath)}, { flags: 'w' });
stream.write('some worker output');

stream.once('close', () => {
  process.stdout.write('CLOSE_EVENT\\n');
});

await flushAndExit(stream, 42);
process.stdout.write('UNREACHABLE\\n');
`;

  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: script,
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(result.status, 42, `expected exit code 42, got ${result.status}; stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('CLOSE_EVENT'), `expected CLOSE_EVENT in stdout; got: ${JSON.stringify(result.stdout)}`);
    assert.ok(!result.stdout.includes('UNREACHABLE'), `UNREACHABLE was reached — flushAndExit did not exit; stdout: ${result.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
