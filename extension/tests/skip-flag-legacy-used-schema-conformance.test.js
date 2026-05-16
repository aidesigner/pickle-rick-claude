// @tier: fast
//
// Trap-door conformance test for `skip_flag_legacy_used`.
// Verifies the event registry, schema definition, top-level oneOf membership,
// and mux-runner emit shape all stay aligned.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_TS_PATH = path.join(ROOT, 'src/types/index.ts');
const TYPES_JS_PATH = path.join(ROOT, 'types/index.js');
const MUX_RUNNER_PATH = path.join(ROOT, 'src/bin/mux-runner.ts');

describe('skip_flag_legacy_used schema conformance', () => {
  it('schema has a definition for skip_flag_legacy_used', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.skip_flag_legacy_used;
    assert.ok(def, 'activity-events.schema.json must define skip_flag_legacy_used');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['event', 'gate_payload', 'ts']);
    assert.equal(def.properties.event.const, 'skip_flag_legacy_used');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.session.type, 'string');
    assert.deepEqual(def.properties.gate_payload.required.sort(), ['callsite', 'legacy_field', 'value']);
    assert.deepEqual(def.properties.gate_payload.properties.legacy_field.enum, [
      'skip_readiness_reason',
      'skip_ticket_audit_reason',
    ]);
    assert.deepEqual(def.properties.gate_payload.properties.callsite.enum, [
      'readiness_gate',
      'ticket_audit_gate',
    ]);
  });

  it('schema oneOf includes skip_flag_legacy_used', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/skip_flag_legacy_used'),
      'oneOf must reference skip_flag_legacy_used so payload validation covers it',
    );
  });

  it('R-PDD-oneOf invariant holds (every event-type definition is in oneOf)', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = new Set(schema.oneOf.map((entry) => entry.$ref.replace('#/definitions/', '')));
    const SHARED = new Set([
      'backendEnum',
      'backendResolutionSourceEnum',
      'workerBackendResolutionSourceEnum',
    ]);
    const unguarded = Object.keys(schema.definitions).filter(
      (key) => !SHARED.has(key) && !refs.has(key),
    );
    assert.deepEqual(
      unguarded,
      [],
      `definitions missing from oneOf: ${unguarded.join(', ')}`,
    );
  });

  it('VALID_ACTIVITY_EVENTS registers skip_flag_legacy_used in TS and JS mirrors', () => {
    const typesTs = readFileSync(TYPES_TS_PATH, 'utf8');
    const typesJs = readFileSync(TYPES_JS_PATH, 'utf8');
    assert.ok(
      /['"]skip_flag_legacy_used['"]/.test(typesTs),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list skip_flag_legacy_used',
    );
    assert.ok(
      /['"]skip_flag_legacy_used['"]/.test(typesJs),
      'extension/types/index.js mirror must list skip_flag_legacy_used',
    );
  });

  it('mux-runner emits the event with the required payload fields', () => {
    const src = readFileSync(MUX_RUNNER_PATH, 'utf8');
    assert.match(
      src,
      /event:\s*'skip_flag_legacy_used'[\s\S]*legacy_field:\s*legacyField[\s\S]*value:\s*legacyValue[\s\S]*callsite/s,
      'mux-runner.ts must emit skip_flag_legacy_used with legacy_field, value, and callsite',
    );
  });

  it('payload with valid shape satisfies required-field checks', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.skip_flag_legacy_used;
    const valid = {
      event: 'skip_flag_legacy_used',
      ts: new Date().toISOString(),
      session: 'session-1',
      gate_payload: {
        legacy_field: 'skip_ticket_audit_reason',
        value: 'operator approved',
        callsite: 'ticket_audit_gate',
      },
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
    for (const field of def.properties.gate_payload.required) {
      assert.ok(field in valid.gate_payload, `valid gate_payload must include ${field}`);
    }
  });
});
