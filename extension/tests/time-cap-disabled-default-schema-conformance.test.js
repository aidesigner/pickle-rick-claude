// @tier: fast
//
// Trap-door conformance test for `time_cap_disabled_default` activity event.
// Verifies producer (setup.ts), registry (VALID_ACTIVITY_EVENTS), and schema
// (activity-events.schema.json) all agree on the emitter shape.
//
// Without this test, a future schema/emitter divergence (the same class of
// bug iter-7 caught for ticket_audit_failed and iter-8 caught here) passes
// silently because no contract covers the event end-to-end.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');
const SETUP_PATH = path.join(ROOT, 'src/bin/setup.ts');

describe('time_cap_disabled_default schema conformance', () => {
  it('schema has a definition for time_cap_disabled_default', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.time_cap_disabled_default;
    assert.ok(def, 'activity-events.schema.json must define time_cap_disabled_default');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['event', 'ts']);
    assert.equal(def.properties.event.const, 'time_cap_disabled_default');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.session.type, 'string');
  });

  it('schema oneOf includes time_cap_disabled_default', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/time_cap_disabled_default'),
      'oneOf must reference time_cap_disabled_default so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers time_cap_disabled_default', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]time_cap_disabled_default['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list time_cap_disabled_default',
    );
  });

  it('setup.ts emits time_cap_disabled_default with required schema fields', () => {
    const src = readFileSync(SETUP_PATH, 'utf8');
    // Match: event: 'time_cap_disabled_default' inside a logActivity({...}) call.
    // Schema requires only event + ts; logActivity stamps ts automatically.
    // Optional `session` field uses `session` (matches all other recent events,
    // not legacy `session_id` from the original 0b16a707 schema).
    const emitterRe = /logActivity\(\{[^}]*event:\s*['"]time_cap_disabled_default['"][^}]*\}\)/s;
    assert.match(
      src,
      emitterRe,
      'setup.ts must emit time_cap_disabled_default via logActivity({...}) — schema requires event+ts; logActivity supplies ts',
    );
  });

  it('emitter does not write the legacy session_id field', () => {
    const src = readFileSync(SETUP_PATH, 'utf8');
    // The original schema (0b16a707) named the field session_id; sibling
    // event manager_idle_backoff_engaged was retro-fitted to `session` in
    // 162c226f; iter-8 aligned this schema to match that convention.
    // Lock the convention so a future copy-paste from old fixtures cannot
    // re-introduce session_id at the emit site.
    const emitterBlockRe = /logActivity\(\{[^}]*event:\s*['"]time_cap_disabled_default['"][^}]*\}\)/s;
    const match = src.match(emitterBlockRe);
    assert.ok(match, 'time_cap_disabled_default emitter block must exist');
    assert.equal(
      /\bsession_id\s*:/.test(match[0]),
      false,
      'emitter must use `session`, not `session_id` (schema convention since 162c226f)',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.time_cap_disabled_default;
    const broken = { event: 'time_cap_disabled_default', session: 'session-1' };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject time_cap_disabled_default without ts');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.time_cap_disabled_default;
    const valid = {
      event: 'time_cap_disabled_default',
      ts: new Date().toISOString(),
      session: 'session-1',
      backend: 'claude',
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});
