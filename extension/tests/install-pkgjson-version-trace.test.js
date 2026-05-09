// @tier: fast
// Trap-door conformance test for R-PJV-6.
// Verifies that the pkgjson_revert_forensic_captured event is registered and
// the trap-door entry is present in extension/CLAUDE.md.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_MD = path.resolve(__dirname, '..', 'CLAUDE.md');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'activity-events.schema.json');
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'activity-event-payloads', 'pkgjson_revert_forensic_captured.json');

const claudeMd = readFileSync(CLAUDE_MD, 'utf8');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('R-PJV-6 trap-door: pkgjson_revert_forensic_captured', () => {
  test('CLAUDE.md contains R-PJV-6 trap-door entry', () => {
    assert.ok(
      claudeMd.includes('R-PJV-6'),
      'extension/CLAUDE.md must contain R-PJV-6 trap-door reference',
    );
  });

  test('CLAUDE.md trap-door references pkgjson_revert_forensic_captured', () => {
    assert.ok(
      claudeMd.includes('pkgjson_revert_forensic_captured'),
      'extension/CLAUDE.md trap-door must reference the pkgjson_revert_forensic_captured event',
    );
  });

  test('CLAUDE.md trap-door references the conformance test', () => {
    assert.ok(
      claudeMd.includes('install-pkgjson-version-trace.test.js'),
      'extension/CLAUDE.md trap-door ENFORCE line must reference extension/tests/install-pkgjson-version-trace.test.js',
    );
  });

  test('activity-events.schema.json defines pkgjson_revert_forensic_captured', () => {
    assert.ok(
      schema.definitions && schema.definitions.pkgjson_revert_forensic_captured,
      'activity-events.schema.json must have a definitions.pkgjson_revert_forensic_captured entry',
    );
    const def = schema.definitions.pkgjson_revert_forensic_captured;
    assert.ok(
      def.required && def.required.includes('gate_payload'),
      'definition must require gate_payload',
    );
    const gp = def.properties && def.properties.gate_payload;
    assert.ok(gp, 'definition must have gate_payload property');
    for (const field of ['forensic_artifact_path', 'suspected_hypothesis', 'src_version', 'deployed_version']) {
      assert.ok(
        gp.required && gp.required.includes(field),
        `gate_payload must require field: ${field}`,
      );
    }
  });

  test('schema oneOf includes pkgjson_revert_forensic_captured', () => {
    const oneOf = schema.oneOf || [];
    const refs = oneOf.map((e) => e.$ref || '');
    assert.ok(
      refs.includes('#/definitions/pkgjson_revert_forensic_captured'),
      'schema.oneOf must include $ref to pkgjson_revert_forensic_captured',
    );
  });

  test('fixture file has required payload fields', () => {
    assert.strictEqual(fixture.event, 'pkgjson_revert_forensic_captured');
    assert.ok(fixture.ts, 'fixture must have ts field');
    const gp = fixture.gate_payload;
    assert.ok(gp, 'fixture must have gate_payload');
    assert.ok(typeof gp.forensic_artifact_path === 'string', 'forensic_artifact_path must be string');
    assert.ok(typeof gp.suspected_hypothesis === 'string', 'suspected_hypothesis must be string');
    assert.ok(typeof gp.src_version === 'string', 'src_version must be string');
    assert.ok(typeof gp.deployed_version === 'string', 'deployed_version must be string');
  });
});
