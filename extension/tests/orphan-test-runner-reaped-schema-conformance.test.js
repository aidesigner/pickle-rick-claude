// @tier: fast
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

const EVENT = 'orphan_test_runner_reaped';

describe(`${EVENT} schema conformance`, () => {
  it('schema has a definition', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions[EVENT];
    assert.ok(def, `activity-events.schema.json must define ${EVENT}`);
    assert.equal(def.type, 'object');
    assert.deepEqual(
      def.required.slice().sort(),
      ['argv_summary', 'etime_seconds', 'event', 'pid', 'ts'],
    );
    assert.equal(def.properties.event.const, EVENT);
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.pid.type, 'integer');
    assert.equal(def.properties.etime_seconds.type, 'integer');
    assert.equal(def.properties.argv_summary.type, 'string');
  });

  it('schema oneOf includes the event', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(refs.includes(`#/definitions/${EVENT}`));
  });

  it('VALID_ACTIVITY_EVENTS (TS source) registers the event', () => {
    const types = readFileSync(TYPES_TS_PATH, 'utf8');
    assert.ok(new RegExp(`['"]${EVENT}['"]`).test(types));
  });

  it('VALID_ACTIVITY_EVENTS (deployed JS mirror) registers the event', () => {
    const types = readFileSync(TYPES_JS_PATH, 'utf8');
    assert.ok(new RegExp(`['"]${EVENT}['"]`).test(types));
  });

  it('analyst prompt catalog documents the event', () => {
    const prompt = readFileSync(REFINEMENT_PATH, 'utf8');
    assert.ok(new RegExp(`\\\\\`${EVENT}\\\\\``).test(prompt));
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions[EVENT];
    const broken = {
      event: EVENT,
      pid: 111,
      etime_seconds: 601,
      argv_summary: '/tmp/pickle/extension/node_modules/.bin/npm run test:fast',
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts']);
  });
});
