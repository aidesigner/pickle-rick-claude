// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const microverseRunnerPath = resolve(__dirname, '../src/bin/microverse-runner.ts');

test('microverse temporary checkout git calls use explicit timeouts', () => {
  const source = readFileSync(microverseRunnerPath, 'utf8');

  assert.match(source, /const GIT_TEMP_CHECKOUT_TIMEOUT_MS = 10_000;/);
  assert.match(
    source,
    /execFileSync\('git', \['rev-parse', 'HEAD'\], \{[^}]*timeout:\s*GIT_TEMP_CHECKOUT_TIMEOUT_MS[^}]*\}\)/s,
  );
  assert.match(
    source,
    /execFileSync\('git', \['symbolic-ref', '--quiet', '--short', 'HEAD'\], \{[^}]*timeout:\s*GIT_TEMP_CHECKOUT_TIMEOUT_MS[^}]*\}\)/s,
  );
  assert.match(
    source,
    /execFileSync\('git', \['checkout', '--quiet', sha\], \{[^}]*timeout:\s*GIT_TEMP_CHECKOUT_TIMEOUT_MS[^}]*\}\)/s,
  );
  assert.match(
    source,
    /execFileSync\('git', restoreArgs, \{[^}]*timeout:\s*GIT_TEMP_CHECKOUT_TIMEOUT_MS[^}]*\}\)/s,
  );
});
