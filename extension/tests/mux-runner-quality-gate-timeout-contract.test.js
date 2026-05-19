// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const muxRunnerPath = resolve(__dirname, '../src/bin/mux-runner.ts');

test('mux-runner bounds readiness and ticket-audit quality gate subprocesses', () => {
  const source = readFileSync(muxRunnerPath, 'utf8');

  assert.match(source, /const QUALITY_GATE_SUBPROCESS_TIMEOUT_MS = 60_000;/);
  assert.match(
    source,
    /spawnSync\(process\.execPath, args, \{[^}]*timeout:\s*QUALITY_GATE_SUBPROCESS_TIMEOUT_MS[^}]*\}\)/s,
  );
  assert.match(
    source,
    /spawnSync\(process\.execPath, \[binPath, input\.sessionDir\], \{[^}]*timeout:\s*QUALITY_GATE_SUBPROCESS_TIMEOUT_MS[^}]*\}\)/s,
  );
});
