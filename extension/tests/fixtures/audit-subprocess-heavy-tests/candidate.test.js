// @tier: integration
// Synthetic fixture for audit-subprocess-heavy-tests.test.js
// This file is a CANDIDATE: bash script spawn with timeout <= 5000ms, no SERIAL comment.
import { spawnSync } from 'node:child_process';
export function runHeavyScript(scriptPath) {
  return spawnSync('bash', [scriptPath, '--flag'], {
    encoding: 'utf-8',
    timeout: 3000,
  });
}
