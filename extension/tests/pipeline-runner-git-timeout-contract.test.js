// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelineRunnerPath = resolve(__dirname, '../src/bin/pipeline-runner.ts');

test('pipeline-runner bounds phase commit counting git calls with an explicit timeout', () => {
  const source = readFileSync(pipelineRunnerPath, 'utf8');

  assert.match(source, /const GIT_PHASE_COMMIT_COUNT_TIMEOUT_MS = 10_000;/);
  assert.match(
    source,
    /execFileSync\('git', \['rev-list', '--count', `\$\{startCommit\}\.\.HEAD`\], \{[^}]*timeout:\s*GIT_PHASE_COMMIT_COUNT_TIMEOUT_MS[^}]*\}\)/s,
  );
});
