// @tier: integration
// SERIAL: synthetic fixture — subprocess-heavy bash spawn; allowlisted via SERIAL comment
// Synthetic fixture for audit-subprocess-heavy-tests.test.js
// This file is EXEMPT because it has a // SERIAL: comment.
import { spawnSync } from 'node:child_process';
export function runHeavyScript(scriptPath) {
  return spawnSync('bash', [scriptPath, '--flag'], {
    encoding: 'utf-8',
    timeout: 3000,
  });
}
