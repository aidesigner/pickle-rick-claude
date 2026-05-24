// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-ticket-forward-refs.sh');
const FIXTURES = path.resolve(__dirname, 'fixtures/audit-ticket-forward-refs');

test('audit-ticket-forward-refs: pass/ fixture exits 0', () => {
  const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'pass')], {
    encoding: 'utf-8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}`);
});

test('audit-ticket-forward-refs: fail/ fixture exits 2', () => {
  const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'fail')], {
    encoding: 'utf-8',
    timeout: 10000,
  });
  assert.equal(result.status, 2, `expected exit 2; stderr=${result.stderr}; stdout=${result.stdout}`);
});
