// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gitUtilsPath = resolve(__dirname, '../src/services/git-utils.ts');
const diffHygienePath = resolve(__dirname, '../src/services/citadel/diff-hygiene.ts');

test('git-utils bounds git check-ignore with an explicit timeout', () => {
  const source = readFileSync(gitUtilsPath, 'utf8');

  assert.match(source, /const GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;/);
  assert.match(
    source,
    /spawnSync\('git', \['check-ignore', '--no-index', '--quiet', '--', filePath\], \{[^}]*timeout:\s*GIT_CHECK_IGNORE_TIMEOUT_MS[^}]*\}\)/s,
  );
});

test('diff-hygiene bounds git check-ignore with an explicit timeout', () => {
  const source = readFileSync(diffHygienePath, 'utf8');

  assert.match(source, /const GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;/);
  assert.match(
    source,
    /spawnSync\('git', \['check-ignore', '--quiet', '--', filePath\], \{[^}]*timeout:\s*GIT_CHECK_IGNORE_TIMEOUT_MS[^}]*\}\)/s,
  );
});
