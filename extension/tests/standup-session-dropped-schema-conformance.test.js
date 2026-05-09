// @tier: fast
//
// Trap-door conformance test for `standup_session_dropped` activity event.
// Verifies registry (VALID_ACTIVITY_EVENTS), schema definition, and top-level
// oneOf membership all agree. AC-PSU-01 added the definition + registry row but
// missed the oneOf $ref entry, which is the same R-PDD-oneOf regression class
// iter-11 (phantom_done_detected) and iter-12 (cap_check_skipped_stale_cache)
// caught. With this fix the R-PDD-oneOf pattern grep emits zero unguarded
// siblings.
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

describe('standup_session_dropped schema conformance', () => {
  it('schema has a definition for standup_session_dropped', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.standup_session_dropped;
    assert.ok(def, 'activity-events.schema.json must define standup_session_dropped');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['drop_reason', 'event', 'session_name', 'ts']);
    assert.equal(def.properties.event.const, 'standup_session_dropped');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.session_name.type, 'string');
    assert.equal(def.properties.drop_reason.type, 'string');
  });

  it('schema oneOf includes standup_session_dropped', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/standup_session_dropped'),
      'oneOf must reference standup_session_dropped so payload validation covers it',
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
      (k) => !SHARED.has(k) && !refs.has(k),
    );
    assert.deepEqual(
      unguarded,
      [],
      `definitions missing from oneOf: ${unguarded.join(', ')}`,
    );
  });

  it('VALID_ACTIVITY_EVENTS (TS source) registers standup_session_dropped', () => {
    const types = readFileSync(TYPES_TS_PATH, 'utf8');
    assert.ok(
      /['"]standup_session_dropped['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list standup_session_dropped',
    );
  });

  it('VALID_ACTIVITY_EVENTS (deployed JS mirror) registers standup_session_dropped', () => {
    const types = readFileSync(TYPES_JS_PATH, 'utf8');
    assert.ok(
      /['"]standup_session_dropped['"]/.test(types),
      'extension/types/index.js mirror must list standup_session_dropped',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.standup_session_dropped;
    const broken = {
      event: 'standup_session_dropped',
      session_name: 'pickle-debate-foo',
      drop_reason: 'noise-filter',
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(
      missing,
      ['ts'],
      'schema must reject standup_session_dropped without ts',
    );
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.standup_session_dropped;
    const valid = {
      event: 'standup_session_dropped',
      ts: new Date().toISOString(),
      session_name: 'pickle-debate-foo',
      drop_reason: 'noise-filter',
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});
