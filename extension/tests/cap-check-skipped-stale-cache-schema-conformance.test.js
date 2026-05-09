// @tier: fast
//
// Trap-door conformance test for `cap_check_skipped_stale_cache` activity event.
// Verifies producer (mux-runner.ts R-CNAR-7 stale-cache guard), registry
// (VALID_ACTIVITY_EVENTS), and schema (activity-events.schema.json) — including
// top-level oneOf membership — all agree.
//
// Iter-11 (phantom_done_detected) caught the oneOf-membership regression class:
// definition exists under definitions[] but the top-level oneOf $ref entry was
// never added, so any schema-walking consumer (Ajv compile + validate against
// the full schema) rejects every emission because no oneOf branch matches.
// cap_check_skipped_stale_cache had the same drift since commit a8c4ecb5
// (R-CNAR-7); this test seals the gap and arms the R-PDD-oneOf trap door.
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

describe('cap_check_skipped_stale_cache schema conformance', () => {
  it('schema has a definition for cap_check_skipped_stale_cache', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.cap_check_skipped_stale_cache;
    assert.ok(def, 'activity-events.schema.json must define cap_check_skipped_stale_cache');
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.sort(), ['event', 'gate_payload', 'ts']);
    assert.equal(def.properties.event.const, 'cap_check_skipped_stale_cache');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.gate_payload.type, 'object');
    assert.deepEqual(
      def.properties.gate_payload.required.sort(),
      [
        'current_ticket',
        'current_ticket_budget_start_iteration',
        'current_ticket_max_iterations',
        'current_ticket_tier',
      ],
    );
  });

  it('schema oneOf includes cap_check_skipped_stale_cache', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/cap_check_skipped_stale_cache'),
      'oneOf must reference cap_check_skipped_stale_cache so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers cap_check_skipped_stale_cache', () => {
    const types = readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]cap_check_skipped_stale_cache['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list cap_check_skipped_stale_cache',
    );
  });

  it('mux-runner R-CNAR-7 stale-cache guard emits cap_check_skipped_stale_cache with schema-required gate_payload quartet', () => {
    const src = readFileSync(MUX_RUNNER_PATH, 'utf8');
    const guardRe = /shouldEmitStalePerTicketCapSkip\(state\)\)\s*\{[\s\S]*?logActivity\(\{[\s\S]*?\}\);/m;
    const match = src.match(guardRe);
    assert.ok(match, 'mux-runner.ts must contain the R-CNAR-7 stale-cache guard with logActivity emit');
    const body = match[0];
    assert.match(body, /event:\s*['"]cap_check_skipped_stale_cache['"]/, 'emitter must set event');
    assert.match(body, /gate_payload:\s*\{/, 'emitter must include gate_payload object');
    assert.match(body, /current_ticket:\s*state\.current_ticket/, 'gate_payload must include current_ticket');
    assert.match(
      body,
      /current_ticket_max_iterations:\s*state\.current_ticket_max_iterations/,
      'gate_payload must include current_ticket_max_iterations',
    );
    assert.match(
      body,
      /current_ticket_budget_start_iteration:\s*state\.current_ticket_budget_start_iteration/,
      'gate_payload must include current_ticket_budget_start_iteration',
    );
    assert.match(
      body,
      /current_ticket_tier:\s*state\.current_ticket_tier/,
      'gate_payload must include current_ticket_tier',
    );
  });

  it('payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.cap_check_skipped_stale_cache;
    const broken = {
      event: 'cap_check_skipped_stale_cache',
      gate_payload: {
        current_ticket: null,
        current_ticket_max_iterations: 10,
        current_ticket_budget_start_iteration: 0,
        current_ticket_tier: 'small',
      },
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject cap_check_skipped_stale_cache without ts');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.cap_check_skipped_stale_cache;
    const valid = {
      event: 'cap_check_skipped_stale_cache',
      ts: new Date().toISOString(),
      gate_payload: {
        current_ticket: null,
        current_ticket_max_iterations: 10,
        current_ticket_budget_start_iteration: 0,
        current_ticket_tier: 'small',
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
