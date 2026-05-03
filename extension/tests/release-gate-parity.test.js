// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

test('release workflow runs fast, integration, and gated expensive test scripts', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');

  assert.match(
    workflow,
    /npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive/,
  );
});
