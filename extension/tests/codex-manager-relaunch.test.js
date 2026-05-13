// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCodexManagerRelaunch,
  recordCodexManagerRelaunch,
} from '../services/codex-manager-relaunch.js';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../services/manager-relaunch.js';

test('codex-manager-relaunch shim preserves deprecated aliases', () => {
  assert.equal(evaluateCodexManagerRelaunch, evaluateManagerRelaunch);
  assert.equal(recordCodexManagerRelaunch, recordManagerRelaunch);
});
