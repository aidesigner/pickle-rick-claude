// CI parity check: the hand-maintained `extension/schemas/scope-v1.json`
// must match `buildScopeV1Schema()` byte-by-byte (via deep equality). Any
// TS type change without a schema update trips this and fails release.

import * as fs from 'fs';
import * as path from 'path';
import { buildScopeV1Schema } from '../services/scope-resolver.js';

function isComparableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

function objectEntriesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual(a[ak[i]], b[bk[i]])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isComparableObject(a) || !isComparableObject(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return arraysEqual(a, b);
  }
  return objectEntriesEqual(a, b);
}

export function runParityCheck(schemaPath: string): { ok: boolean; message: string } {
  const expected = buildScopeV1Schema();
  const committed = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  if (deepEqual(expected, committed)) {
    return { ok: true, message: `scope-v1.json parity OK (${schemaPath})` };
  }
  return {
    ok: false,
    message:
      `scope-v1.json drift vs buildScopeV1Schema():\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  committed: ${JSON.stringify(committed)}`,
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-scope-schema-parity.js') {
  const here = path.dirname(process.argv[1]);
  const schemaPath = path.resolve(here, '..', 'schemas', 'scope-v1.json');
  const result = runParityCheck(schemaPath);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}
