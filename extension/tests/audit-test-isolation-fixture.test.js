// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';

test('audit-test-isolation fixture deliberately touches home without sentinel', () => {
  const deployedRoot = `${os.homedir()}/.claude/pickle-rick/extension`;
  assert.ok(deployedRoot.includes('.claude/pickle-rick/extension'));
});
