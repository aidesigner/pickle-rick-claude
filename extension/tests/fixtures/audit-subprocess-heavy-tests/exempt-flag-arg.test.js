// @tier: fast
// Synthetic fixture for audit-subprocess-heavy-tests.test.js
// This file is EXEMPT: first arg to bash spawn starts with '-' (flag, not script path).
import { spawnSync } from 'node:child_process';
export function checkGitAvailable() {
  return spawnSync('bash', ['-lc', 'command -v git'], {
    encoding: 'utf-8',
    timeout: 3000,
  });
}
