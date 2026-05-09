// @tier: fast
//
// Trap-door conformance test for `phantom_done_detected` activity event.
// Verifies producer (mux-runner.ts:emitRevertEvent), registry
// (VALID_ACTIVITY_EVENTS), and schema (activity-events.schema.json) — including
// top-level oneOf membership — all agree.
//
// Iter-7 (ticket_audit_failed), iter-8 (time_cap_disabled_default), and iter-9
// (worker_partial_lifecycle_exit) caught the same producer/schema disconnect
// class. This test extends the pattern: phantom_done_detected was added in
// commit a70db8f0 with a definitions[] entry but the top-level `oneOf` $ref was
// missed, so any consumer compiling the entire schema (Ajv, jsonschema lint)
// would reject every emission because no oneOf branch matches.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');
const MUX_RUNNER_PATH = path.join(ROOT, 'src/bin/mux-runner.ts');

describe('phantom_done_detected schema conformance', () => {
  it('schema has a definition for phantom_done_detected', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.phantom_done_detected;
    assert.ok(def, 'activity-events.schema.json must define phantom_done_detected');
    assert.equal(def.type, 'object');
    assert.deepEqual(
      def.required.sort(),
      ['completion_commit_present', 'event', 'ticket', 'ts'],
    );
    assert.equal(def.properties.event.const, 'phantom_done_detected');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.ticket.type, 'string');
    assert.equal(def.properties.completion_commit_present.type, 'boolean');
  });

  it('schema oneOf includes phantom_done_detected', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/phantom_done_detected'),
      'oneOf must reference phantom_done_detected so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers phantom_done_detected', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]phantom_done_detected['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list phantom_done_detected',
    );
  });

  it('mux-runner emitRevertEvent emits phantom_done_detected with the schema-required quartet', () => {
    const src = readFileSync(MUX_RUNNER_PATH, 'utf8');
    // emitRevertEvent uses writeActivityEntry, which validates only the event
    // NAME and does NOT auto-stamp ts (R-WSE-2 invariant). The producer MUST
    // pass ts explicitly. Locate the body of emitRevertEvent (declaration
    // through final `}`) and verify all four required fields appear inside it.
    const fnStartRe = /const emitRevertEvent\s*=\s*\([^)]*\)[^{]*\{/;
    const fnStart = src.match(fnStartRe);
    assert.ok(fnStart, 'must find emitRevertEvent declaration');
    const startIdx = fnStart.index + fnStart[0].length;
    let depth = 1;
    let endIdx = startIdx;
    for (; endIdx < src.length && depth > 0; endIdx++) {
      const ch = src[endIdx];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = src.slice(startIdx, endIdx);
    assert.match(body, /writeActivityEntry\(/, 'function body must call writeActivityEntry');
    assert.match(body, /event:\s*['"]phantom_done_detected['"]/, 'emitter must set event');
    assert.match(
      body,
      /ts,/,
      'emitter must pass ts — writeActivityEntry does not auto-stamp it',
    );
    assert.match(body, /ticket:\s*ticketId/, 'emitter must pass ticket');
    assert.match(
      body,
      /completion_commit_present:\s*false/,
      'emitter must pass completion_commit_present',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.phantom_done_detected;
    const broken = {
      event: 'phantom_done_detected',
      ticket: 'abc123',
      completion_commit_present: false,
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject phantom_done_detected without ts');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.phantom_done_detected;
    const valid = {
      event: 'phantom_done_detected',
      ts: new Date().toISOString(),
      ticket: 'abc123',
      completion_commit_present: false,
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});
