// @tier: fast
//
// Schema conformance test for `concurrent_git_access_detected` activity event.
// Verifies all 7 R-PDD-oneOf registration touchpoints:
//   1. Schema definition present with correct required fields
//   2. Schema oneOf $ref present (R-PDD-oneOf invariant)
//   3. VALID_ACTIVITY_EVENTS in index.ts lists the event
//   4. Compiled mirror (extension/types/index.js) lists the event
//   5. spawn-refinement-team.ts ACTIVITY_EVENT_SCHEMA_SECTION has the row
//   6. Sample payload with all required fields passes manual required-field check
//   7. Payload missing ts fails required-field check
//   (AC-PIWG-5.2.e + AC-PIWG-5.2.d)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_SRC_PATH = path.join(ROOT, 'src/types/index.ts');
const TYPES_COMPILED_PATH = path.join(ROOT, 'types/index.js');
const SPAWN_REFINEMENT_PATH = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');
const SETUP_SRC_PATH = path.join(ROOT, 'src/bin/setup.ts');

describe('concurrent_git_access_detected schema conformance (AC-PIWG-5.2.d/e)', () => {
  it('schema defines concurrent_git_access_detected with correct required fields', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.concurrent_git_access_detected;
    assert.ok(def, 'activity-events.schema.json must define concurrent_git_access_detected');
    assert.equal(def.type, 'object');
    const required = def.required.slice().sort();
    assert.deepEqual(required, ['event', 'gate_payload', 'session', 'ts']);
    assert.equal(def.properties.event.const, 'concurrent_git_access_detected');
    assert.equal(def.properties.ts.type, 'string');
    assert.equal(def.properties.session.type, 'string');
  });

  it('schema gate_payload requires repo_root, holder_pid, holder_command', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.concurrent_git_access_detected;
    assert.ok(def.properties.gate_payload, 'gate_payload must be defined in the schema');
    const gpRequired = def.properties.gate_payload.required.slice().sort();
    assert.deepEqual(gpRequired, ['holder_command', 'holder_pid', 'repo_root']);
    assert.equal(def.properties.gate_payload.properties.repo_root.type, 'string');
    assert.equal(def.properties.gate_payload.properties.holder_pid.type, 'integer');
    assert.equal(def.properties.gate_payload.properties.holder_command.type, 'string');
  });

  it('R-PDD-oneOf: schema oneOf includes concurrent_git_access_detected', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/concurrent_git_access_detected'),
      'oneOf must reference concurrent_git_access_detected so payload validation covers it (R-PDD-oneOf invariant)',
    );
  });

  it('R-PDD-oneOf invariant: no definition is orphaned from oneOf', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = new Set(schema.oneOf.map((o) => o.$ref.replace('#/definitions/', '')));
    const SHARED = new Set(['backendEnum', 'backendResolutionSourceEnum', 'workerBackendResolutionSourceEnum']);
    const orphaned = Object.keys(schema.definitions).filter((k) => !SHARED.has(k) && !refs.has(k));
    assert.deepEqual(
      orphaned,
      [],
      `R-PDD-oneOf: every definition must appear in oneOf — orphaned: ${orphaned.join(', ')}`,
    );
  });

  it('AC-PIWG-5.2.d: VALID_ACTIVITY_EVENTS in index.ts registers concurrent_git_access_detected', () => {
    const types = readFileSync(TYPES_SRC_PATH, 'utf8');
    assert.match(
      types,
      /['"]concurrent_git_access_detected['"]/,
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list concurrent_git_access_detected',
    );
  });

  it('AC-PIWG-5.2.d: compiled mirror extension/types/index.js registers concurrent_git_access_detected', () => {
    const compiled = readFileSync(TYPES_COMPILED_PATH, 'utf8');
    assert.match(
      compiled,
      /['"]concurrent_git_access_detected['"]/,
      'extension/types/index.js (compiled mirror) must list concurrent_git_access_detected',
    );
  });

  it('AC-PIWG-5.2.g: spawn-refinement-team.ts ACTIVITY_EVENT_SCHEMA_SECTION has catalog row', () => {
    const src = readFileSync(SPAWN_REFINEMENT_PATH, 'utf8');
    assert.match(
      src,
      /concurrent_git_access_detected/,
      'spawn-refinement-team.ts ACTIVITY_EVENT_SCHEMA_SECTION must list concurrent_git_access_detected',
    );
    // Row must document the required gate_payload keys
    const rowRe = /concurrent_git_access_detected.*gate_payload\.repo_root.*gate_payload\.holder_pid.*gate_payload\.holder_command/s;
    assert.match(src, rowRe, 'catalog row must list repo_root, holder_pid, holder_command');
  });

  it('setup.ts emitter uses logActivity with correct event and gate_payload fields', () => {
    const src = readFileSync(SETUP_SRC_PATH, 'utf8');
    assert.match(
      src,
      /event:\s*['"]concurrent_git_access_detected['"]/,
      'setup.ts must emit concurrent_git_access_detected via logActivity',
    );
    // gate_payload must carry the three required keys
    assert.match(src, /repo_root:/, 'emitter must include repo_root in gate_payload');
    assert.match(src, /holder_pid:/, 'emitter must include holder_pid in gate_payload');
    assert.match(src, /holder_command:/, 'emitter must include holder_command in gate_payload');
  });

  it('sample payload missing ts fails required-field check', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.concurrent_git_access_detected;
    const broken = {
      event: 'concurrent_git_access_detected',
      session: 'test-session',
      gate_payload: { repo_root: '/repo', holder_pid: 123, holder_command: 'git' },
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['ts'], 'schema must reject payload without ts');
  });

  it('valid sample payload passes all required-field checks', () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.concurrent_git_access_detected;
    const valid = {
      event: 'concurrent_git_access_detected',
      ts: new Date().toISOString(),
      session: 'test-session-abc1',
      gate_payload: {
        repo_root: '/Users/user/project',
        holder_pid: 12345,
        holder_command: 'git',
      },
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include required field: ${field}`);
    }
    for (const gpField of def.properties.gate_payload.required) {
      assert.ok(gpField in valid.gate_payload, `valid gate_payload must include: ${gpField}`);
    }
  });
});
