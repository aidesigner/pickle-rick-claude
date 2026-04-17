import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, '..', 'package.json');

test('no test file is silently unregistered', () => {
  const onDisk = readdirSync(__dirname)
    .filter(f => f.endsWith('.test.js'))
    .sort();

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const registeredSet = new Set(
    pkg.scripts.test
      .split(/\s+/)
      .filter(p => /tests\/.*\.test\.js$/.test(p))
      .map(p => path.basename(p)),
  );

  const missing = onDisk.filter(f => !registeredSet.has(f));
  assert.deepStrictEqual(
    missing,
    [],
    `Unregistered test files (add to package.json scripts.test): ${missing.join(', ')}`,
  );
});
