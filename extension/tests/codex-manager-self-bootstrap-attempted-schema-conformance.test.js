// @tier: fast
//
// Trap-door conformance test for `codex_manager_self_bootstrap_attempted` activity event.
// Verifies registry (VALID_ACTIVITY_EVENTS), schema definition, top-level oneOf membership,
// deployed JS mirror, and analyst prompt catalog all agree. R-CCPM-5 registered this event
// so R-CCPM-1 emitters can ship without breaking the test gate.
//
// The R-PDD-oneOf invariant: every event-type definition must also appear in oneOf.
// The R-WSE-2 ts-stamp invariant: producers using writeActivityEntry must pass ts explicitly.
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
const REFINEMENT_PATH = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');

const EVENT = 'codex_manager_self_bootstrap_attempted';

describe(`${EVENT} schema conformance`, () => {
  it('schema has a definition', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions[EVENT];
    assert.ok(def, `activity-events.schema.json must define ${EVENT}`);
    assert.equal(def.type, 'object');
    assert.deepEqual(
      def.required.slice().sort(),
      ['action_taken', 'attempted_argv', 'event', 'iteration', 'ticket', 'ts'],
    );
    assert.equal(def.properties.event.const, EVENT);
    assert.equal(def.properties.ts.type, 'string');
    assert.deepEqual(def.properties.ticket.type, ['string', 'null']);
    assert.equal(def.properties.attempted_argv.type, 'array');
    assert.equal(def.properties.iteration.type, 'integer');
    assert.equal(def.properties.action_taken.const, 'logged');
  });

  it('schema oneOf includes the event', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes(`#/definitions/${EVENT}`),
      `oneOf must reference ${EVENT} so payload validation covers it`,
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

  it('VALID_ACTIVITY_EVENTS (TS source) registers the event', () => {
    const types = readFileSync(TYPES_TS_PATH, 'utf8');
    assert.ok(
      new RegExp(`['"]${EVENT}['"]`).test(types),
      `src/types/index.ts:VALID_ACTIVITY_EVENTS must list ${EVENT}`,
    );
  });

  it('VALID_ACTIVITY_EVENTS (deployed JS mirror) registers the event', () => {
    const types = readFileSync(TYPES_JS_PATH, 'utf8');
    assert.ok(
      new RegExp(`['"]${EVENT}['"]`).test(types),
      `extension/types/index.js mirror must list ${EVENT}`,
    );
  });

  it('analyst prompt catalog documents the event', () => {
    const prompt = readFileSync(REFINEMENT_PATH, 'utf8');
    assert.ok(
      new RegExp(`\\\\\`${EVENT}\\\\\``).test(prompt),
      `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION must include a row for ${EVENT}`,
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions[EVENT];
    const broken = {
      event: EVENT,
      ticket: 'abc123',
      attempted_argv: ['node', 'foo.js'],
      iteration: 1,
      action_taken: 'logged',
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], `schema must reject ${EVENT} without ts`);
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions[EVENT];
    const valid = {
      event: EVENT,
      ts: new Date().toISOString(),
      ticket: 'abc123',
      attempted_argv: ['node', 'spawn-morty.js'],
      iteration: 2,
      action_taken: 'logged',
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});
