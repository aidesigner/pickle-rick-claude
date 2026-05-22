// @tier: fast
//
// Trap-door conformance test for the R-PSSS empty-scope skip activity events
// `anatomy_park_empty_scope_skip` and `szechuan_sauce_empty_scope_skip`.
// Verifies registry (VALID_ACTIVITY_EVENTS source + deployed mirror), schema
// definition, and top-level oneOf membership all agree — the R-PDD-oneOf
// regression class (iter-11 phantom_done_detected, iter-13 standup_session_dropped).
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

const EVENTS = ['anatomy_park_empty_scope_skip', 'szechuan_sauce_empty_scope_skip'];

describe('R-PSSS empty-scope skip event schema conformance', () => {
  for (const event of EVENTS) {
    it(`schema defines ${event} with the required event/ts/session/gate_payload contract`, () => {
      const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
      const def = schema.definitions[event];
      assert.ok(def, `activity-events.schema.json must define ${event}`);
      assert.equal(def.type, 'object');
      assert.deepEqual(def.required.slice().sort(), ['event', 'gate_payload', 'session', 'ts']);
      assert.equal(def.properties.event.const, event);
      assert.equal(def.properties.gate_payload.properties.in_scope_paths.type, 'array');
    });

    it(`schema oneOf includes ${event}`, () => {
      const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
      const refs = schema.oneOf.map((entry) => entry.$ref);
      assert.ok(
        refs.includes(`#/definitions/${event}`),
        `oneOf must reference ${event} so payload validation covers it`,
      );
    });

    it(`VALID_ACTIVITY_EVENTS (TS source + deployed JS mirror) register ${event}`, () => {
      const re = new RegExp(`['"]${event}['"]`);
      assert.ok(re.test(readFileSync(TYPES_TS_PATH, 'utf8')), `src/types/index.ts must list ${event}`);
      assert.ok(re.test(readFileSync(TYPES_JS_PATH, 'utf8')), `types/index.js mirror must list ${event}`);
    });
  }

  it('anatomy_park_empty_scope_skip gate_payload requires discovered_subsystems', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const gp = schema.definitions.anatomy_park_empty_scope_skip.properties.gate_payload;
    assert.deepEqual(gp.required.slice().sort(), ['discovered_subsystems', 'in_scope_paths']);
  });

  it('R-PDD-oneOf invariant holds (every event-type definition is in oneOf)', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = new Set(schema.oneOf.map((entry) => entry.$ref.replace('#/definitions/', '')));
    const SHARED = new Set([
      'backendEnum',
      'backendResolutionSourceEnum',
      'workerBackendResolutionSourceEnum',
    ]);
    const unguarded = Object.keys(schema.definitions).filter((k) => !SHARED.has(k) && !refs.has(k));
    assert.deepEqual(unguarded, [], `definitions missing from oneOf: ${unguarded.join(', ')}`);
  });
});
