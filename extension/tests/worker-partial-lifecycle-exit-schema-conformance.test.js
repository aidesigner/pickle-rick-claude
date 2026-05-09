// @tier: fast
//
// Trap-door conformance test for `worker_partial_lifecycle_exit` activity event.
// Verifies producer (mux-runner.ts:checkPartialLifecycleExit), registry
// (VALID_ACTIVITY_EVENTS), schema (activity-events.schema.json), and analyst
// prompt (spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION) all agree.
//
// The R-WSE-2 emission site uses `writeActivityEntry` (state-manager.ts:865),
// which validates only the event NAME and does NOT auto-stamp `ts` — unlike
// `logActivity` (activity-logger.ts:48). The schema requires
// ['event','ts','ticket','gate_payload']; producer must pass `ts` explicitly.
// Iter-7 (ticket_audit_failed) and iter-8 (time_cap_disabled_default) caught
// the same producer/schema disconnect class for sibling events.
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
const REFINEMENT_PATH = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');

describe('worker_partial_lifecycle_exit schema conformance', () => {
  it('schema has a definition for worker_partial_lifecycle_exit', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.worker_partial_lifecycle_exit;
    assert.ok(def, 'activity-events.schema.json must define worker_partial_lifecycle_exit');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['event', 'gate_payload', 'ticket', 'ts']);
    assert.equal(def.properties.event.const, 'worker_partial_lifecycle_exit');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.ticket.type, 'string');
    assert.equal(def.properties.gate_payload.type, 'object');
    assert.deepEqual(
      def.properties.gate_payload.required.sort(),
      ['artifacts_missing', 'session_log_size'],
    );
  });

  it('schema oneOf includes worker_partial_lifecycle_exit', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/worker_partial_lifecycle_exit'),
      'oneOf must reference worker_partial_lifecycle_exit so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers worker_partial_lifecycle_exit', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]worker_partial_lifecycle_exit['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list worker_partial_lifecycle_exit',
    );
  });

  it('mux-runner emits worker_partial_lifecycle_exit with the schema-required quartet', () => {
    const src = readFileSync(MUX_RUNNER_PATH, 'utf8');
    // R-WSE-2 emitter at checkPartialLifecycleExit uses writeActivityEntry,
    // which does NOT auto-stamp ts. The producer MUST pass ts explicitly.
    // Locate the body of checkPartialLifecycleExit (declaration through final `}`)
    // and verify all four required fields appear inside it.
    const fnStartRe = /export function checkPartialLifecycleExit\b[^{]*\{/;
    const fnStart = src.match(fnStartRe);
    assert.ok(fnStart, 'must find checkPartialLifecycleExit declaration');
    const startIdx = fnStart.index + fnStart[0].length;
    // Walk braces from the function open until the matching close.
    let depth = 1;
    let endIdx = startIdx;
    for (; endIdx < src.length && depth > 0; endIdx++) {
      const ch = src[endIdx];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    const body = src.slice(startIdx, endIdx);
    assert.match(body, /writeActivityEntry\(/, 'function body must call writeActivityEntry');
    assert.match(body, /event:\s*['"]worker_partial_lifecycle_exit['"]/, 'emitter must set event');
    assert.match(
      body,
      /ts:\s*new Date\(\)\.toISOString\(\)/,
      'emitter must pass ts explicitly — writeActivityEntry does not auto-stamp it',
    );
    assert.match(body, /ticket:\s*ticketId/, 'emitter must pass ticket');
    assert.match(body, /gate_payload:\s*\{[\s\S]*?artifacts_missing/, 'emitter must pass gate_payload.artifacts_missing');
    assert.match(body, /session_log_size/, 'emitter must pass gate_payload.session_log_size');
  });

  it('analyst prompt catalog documents worker_partial_lifecycle_exit', () => {
    const prompt = readFileSync(REFINEMENT_PATH, 'utf8');
    // The catalog is a TS template literal, so backticks are escape-prefixed (\`).
    assert.ok(
      /\|\s*\\?`worker_partial_lifecycle_exit\\?`\s*\|/.test(prompt),
      'spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION must include a row for worker_partial_lifecycle_exit',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.worker_partial_lifecycle_exit;
    const broken = {
      event: 'worker_partial_lifecycle_exit',
      ticket: 'abc123',
      gate_payload: { artifacts_missing: ['plan'], session_log_size: 0 },
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject worker_partial_lifecycle_exit without ts');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.worker_partial_lifecycle_exit;
    const valid = {
      event: 'worker_partial_lifecycle_exit',
      ts: new Date().toISOString(),
      ticket: 'abc123',
      gate_payload: { artifacts_missing: ['plan', 'conformance'], session_log_size: 0 },
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
    for (const field of def.properties.gate_payload.required) {
      assert.ok(field in valid.gate_payload, `valid gate_payload must include ${field}`);
    }
  });
});
