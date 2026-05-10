// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

async function importModule() {
  const { parseTrapDoorDeclarations, auditTrapDoorDeclarations } = await import(
    '../../services/citadel/rule-set-invariant-audit.js'
  );
  return { parseTrapDoorDeclarations, auditTrapDoorDeclarations };
}

describe('parseTrapDoorDeclarations — unit', () => {
  test('valid triple counts as one declaration, zero findings', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo stays stable. BREAKS: bar explodes. ENFORCE: extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 1);
    assert.equal(result.findings.length, 0);
  });

  test('INVARIANT without BREAKS emits malformed finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo must be present. ENFORCE: extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:no-breaks/);
  });

  test('INVARIANT + BREAKS but ENFORCE content has no .test.js or .sh ref emits finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo is invariant. BREAKS: something bad. ENFORCE: see the README for details.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:bad-enforce-ref/);
  });

  test('INVARIANT + BREAKS but no ENFORCE emits finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo stays put. BREAKS: chaos ensues.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:no-enforce/);
  });

  test('ENFORCE with grep-prefixed command still counts when .test.js ref is present', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: x is y. BREAKS: z. ENFORCE: `grep -c "foo" extension/src/bin/mux-runner.ts` ≥ 2; extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 1, 'grep-prefixed ENFORCE with trailing .test.js should count');
    assert.equal(result.findings.length, 0);
  });

  test('multiple valid triples counted correctly', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/a.ts` — INVARIANT: a. BREAKS: b. ENFORCE: extension/tests/a.test.js.',
      '- `src/b.ts` — INVARIANT: c. BREAKS: d. ENFORCE: extension/tests/b.test.js.',
      '- `src/c.ts` — INVARIANT: e. BREAKS: f. ENFORCE: extension/scripts/check.sh.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 3);
    assert.equal(result.findings.length, 0);
  });

  test('entries outside ## Trap Doors section are ignored', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Other Section',
      '',
      '- `src/foo.ts` — INVARIANT: x. BREAKS: y. ENFORCE: extension/tests/foo.test.js.',
      '',
      '## Trap Doors',
      '',
      '- `src/bar.ts` — INVARIANT: a. BREAKS: b. ENFORCE: extension/tests/bar.test.js.',
      '',
      '## state.json Field Invariants',
      '',
      '- INVARIANT: `active` is liveness. ENFORCE: extension/tests/state-field-invariants.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 1, 'only the entry in Trap Doors section counts');
    assert.equal(result.findings.length, 0, 'state.json Field Invariants INVARIANT-only entries do not produce findings');
  });

  test('empty content returns zero declarations and zero findings', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const result = parseTrapDoorDeclarations('');
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 0);
  });
});

describe('auditTrapDoorDeclarations — integration: real extension/CLAUDE.md', () => {
  test('counts at least 130 declarations against HEAD', async () => {
    const { auditTrapDoorDeclarations } = await importModule();
    const result = auditTrapDoorDeclarations({ repoRoot: REPO_ROOT });
    assert.ok(
      result.declarations >= 130,
      `Expected >= 130 declarations; got ${result.declarations}`,
    );
  });

  test('0 findings against clean HEAD catalog', async () => {
    const { auditTrapDoorDeclarations } = await importModule();
    const result = auditTrapDoorDeclarations({ repoRoot: REPO_ROOT });
    assert.deepStrictEqual(
      result.findings,
      [],
      `Expected 0 findings; got:\n${result.findings.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
    );
  });
});
