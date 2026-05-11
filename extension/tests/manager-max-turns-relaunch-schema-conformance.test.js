// @tier: fast
//
// Trap-door conformance test for `manager_max_turns_relaunch` activity event.
// Verifies producer (manager-relaunch.ts), registry (VALID_ACTIVITY_EVENTS),
// schema (activity-events.schema.json), and analyst prompt
// (spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION) all agree.
//
// Without this test, a future emitter regression can drift from the schema or
// prompt catalog and silently break telemetry for the Claude max-turn relaunch path.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  evaluateManagerRelaunch,
  recordManagerRelaunch,
} from '../services/manager-relaunch.js';
import { Defaults } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_PATH = path.join(ROOT, 'src/types/index.ts');
const MANAGER_RELAUNCH_PATH = path.join(ROOT, 'src/services/manager-relaunch.ts');
const REFINEMENT_PATH = path.join(ROOT, 'src/bin/spawn-refinement-team.ts');

const pendingTickets = [
  { id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
  { id: '620fea14', status: 'Todo', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function stateFixture(overrides = {}) {
  return {
    active: true,
    step: 'implement',
    iteration: 1,
    max_iterations: 100,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    max_time_minutes: 720,
    working_dir: process.cwd(),
    backend: 'claude',
    manager_relaunch_count: 2,
    schema_version: 3,
    ...overrides,
  };
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter(entry => entry.endsWith('.jsonl'))
    .flatMap(entry => fs.readFileSync(path.join(activityDir, entry), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)));
}

function resolveRef(schema, ref) {
  const name = ref.replace('#/definitions/', '');
  return schema.definitions[name];
}

function resolveSchema(schema, propSchema) {
  if (propSchema.$ref) return resolveRef(schema, propSchema.$ref);
  return propSchema;
}

function validateAgainstDefinition(schema, payload, def) {
  const required = def.required || [];
  for (const field of required) {
    if (!(field in payload)) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  const props = def.properties || {};
  for (const [field, rawPropSchema] of Object.entries(props)) {
    if (!(field in payload)) continue;
    const propSchema = resolveSchema(schema, rawPropSchema);
    if (propSchema.enum && !propSchema.enum.includes(payload[field])) {
      return { valid: false, error: `${field} value '${payload[field]}' not in enum [${propSchema.enum.join(', ')}]` };
    }
    if (propSchema.type === 'integer' && !Number.isInteger(payload[field])) {
      return { valid: false, error: `${field} must be an integer` };
    }
    if (Array.isArray(propSchema.type) && !propSchema.type.some(type => type === 'null' ? payload[field] === null : typeof payload[field] === type)) {
      return { valid: false, error: `${field} must match one of [${propSchema.type.join(', ')}]` };
    }
    if (propSchema.type === 'string' && typeof payload[field] !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
  }
  return { valid: true };
}

describe('manager_max_turns_relaunch schema conformance', () => {
  it('schema has a definition for manager_max_turns_relaunch', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.manager_max_turns_relaunch;
    assert.ok(def, 'activity-events.schema.json must define manager_max_turns_relaunch');
    assert.equal(def.type, 'object');
    assert.deepEqual(
      def.required.sort(),
      ['backend', 'cap', 'event', 'last_ticket_seen', 'pending_count', 'relaunch_count', 'ts'],
    );
    assert.equal(def.properties.event.const, 'manager_max_turns_relaunch');
    assert.equal(def.properties.backend.$ref, '#/definitions/backendEnum');
    assert.equal(def.properties.relaunch_count.type, 'integer');
    assert.equal(def.properties.pending_count.type, 'integer');
    assert.deepEqual(def.properties.last_ticket_seen.type, ['string', 'null']);
  });

  it('schema oneOf includes manager_max_turns_relaunch', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const refs = schema.oneOf.map((entry) => entry.$ref);
    assert.ok(
      refs.includes('#/definitions/manager_max_turns_relaunch'),
      'oneOf must reference manager_max_turns_relaunch so payload validation covers it',
    );
  });

  it('VALID_ACTIVITY_EVENTS registers manager_max_turns_relaunch', () => {
    const types = fs.readFileSync(TYPES_PATH, 'utf8');
    assert.ok(
      /['"]manager_max_turns_relaunch['"]/.test(types),
      'src/types/index.ts:VALID_ACTIVITY_EVENTS must list manager_max_turns_relaunch',
    );
  });

  it('manager-relaunch emits manager_max_turns_relaunch with required fields', () => {
    const src = fs.readFileSync(MANAGER_RELAUNCH_PATH, 'utf8');
    const emitterRe = /logActivity\(\{[^}]*event:\s*['"]manager_max_turns_relaunch['"][^}]*\}\)/s;
    const match = src.match(emitterRe);
    assert.ok(
      match,
      'manager-relaunch.ts must emit manager_max_turns_relaunch via logActivity({...})',
    );
    assert.match(match[0], /\bbackend:\s*decision\.backend\b/, 'emitter must include backend');
    assert.match(match[0], /\brelaunch_count:\s*decision\.nextRelaunchCount\b/, 'emitter must include relaunch_count');
    assert.match(match[0], /\bcap:\s*decision\.cap\b/, 'emitter must include cap');
    assert.match(match[0], /\bpending_count:\s*decision\.pendingCount\b/, 'emitter must include pending_count');
    assert.match(match[0], /\blast_ticket_seen:\s*lastTicketSeen\b/, 'emitter must include last_ticket_seen');
  });

  it('analyst prompt catalog documents manager_max_turns_relaunch', () => {
    const prompt = fs.readFileSync(REFINEMENT_PATH, 'utf8');
    assert.ok(
      /\|\s*\\?`manager_max_turns_relaunch\\?`\s*\|/.test(prompt),
      'spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION must include a row for manager_max_turns_relaunch',
    );
  });

  it('emitted payload validates against the schema definition', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-manager-max-turns-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-manager-max-turns-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const statePath = path.join(sessionDir, 'state.json');

    try {
      process.env.PICKLE_DATA_ROOT = dataRoot;
      fs.writeFileSync(statePath, JSON.stringify(stateFixture({ current_ticket: '620fea14' }), null, 2));

      const decision = evaluateManagerRelaunch(
        JSON.parse(fs.readFileSync(statePath, 'utf8')),
        pendingTickets,
        null,
        'claude_max_turns',
      );
      assert.equal(decision.shouldRelaunch, true);

      recordManagerRelaunch(statePath, sessionDir, decision, 7, () => {});

      const emitted = readActivityEvents(dataRoot).find(event => event.event === 'manager_max_turns_relaunch');
      assert.ok(emitted, 'recordManagerRelaunch must emit manager_max_turns_relaunch');
      assert.equal(emitted.backend, 'claude');
      assert.equal(emitted.relaunch_count, 3);
      assert.equal(emitted.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);
      assert.equal(emitted.pending_count, 1);
      assert.equal(emitted.last_ticket_seen, '620fea14');

      const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      const def = schema.definitions.manager_max_turns_relaunch;
      assert.deepEqual(validateAgainstDefinition(schema, emitted, def), { valid: true });
    } finally {
      if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = previousDataRoot;
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('payload missing last_ticket_seen fails required-field check', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.manager_max_turns_relaunch;
    const broken = {
      event: 'manager_max_turns_relaunch',
      ts: new Date().toISOString(),
      backend: 'claude',
      relaunch_count: 3,
      cap: 20,
      pending_count: 1,
    };
    const missing = def.required.filter((field) => !(field in broken));
    assert.deepEqual(missing, ['last_ticket_seen'], 'schema must reject payload without last_ticket_seen');
  });

  it('payload with valid shape passes required-field check', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    const def = schema.definitions.manager_max_turns_relaunch;
    const valid = {
      event: 'manager_max_turns_relaunch',
      ts: new Date().toISOString(),
      backend: 'claude',
      relaunch_count: 3,
      cap: 20,
      pending_count: 1,
      last_ticket_seen: '620fea14',
      session: 'session-1',
      iteration: 7,
    };
    for (const field of def.required) {
      assert.ok(field in valid, `valid payload must include ${field}`);
    }
  });
});
