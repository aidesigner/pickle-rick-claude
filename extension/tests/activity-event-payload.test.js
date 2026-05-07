// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const BACKEND_ENUM = ['claude', 'codex', 'hermes'];
const BACKEND_RESOLUTION_SOURCE_ENUM = ['state', 'env', 'settings', 'default', 'refinement-lock', 'cli-flag-override'];
const WORKER_BACKEND_RESOLUTION_SOURCE_ENUM = ['worker_backend', 'backend', 'env_lock'];

function resolveRef(ref) {
  const name = ref.replace('#/definitions/', '');
  return schema.definitions[name];
}

function resolveSchema(propSchema) {
  if (propSchema.$ref) return resolveRef(propSchema.$ref);
  return propSchema;
}

function validateAgainstDefinition(payload, def) {
  const required = def.required || [];
  for (const field of required) {
    if (!(field in payload)) {
      return { valid: false, error: `missing required field: ${field}` };
    }
  }
  const props = def.properties || {};
  for (const [field, rawPropSchema] of Object.entries(props)) {
    if (!(field in payload)) continue;
    const propSchema = resolveSchema(rawPropSchema);
    if (propSchema.enum) {
      if (!propSchema.enum.includes(payload[field])) {
        return { valid: false, error: `${field} value '${payload[field]}' not in enum [${propSchema.enum.join(', ')}]` };
      }
    }
    if (propSchema.type === 'object' && propSchema.required) {
      const val = payload[field];
      if (typeof val !== 'object' || val === null) {
        return { valid: false, error: `${field} must be an object` };
      }
      const nested = validateAgainstDefinition(val, propSchema);
      if (!nested.valid) return { valid: false, error: `${field}.${nested.error}` };
    }
    if (propSchema.type === 'integer') {
      if (!Number.isInteger(payload[field])) {
        return { valid: false, error: `${field} must be an integer` };
      }
    }
  }
  return { valid: true };
}

function validate(payload, defName) {
  const def = schema.definitions[defName];
  if (!def) return { valid: false, error: `no schema definition for '${defName}'` };
  return validateAgainstDefinition(payload, def);
}

const TS = new Date().toISOString();

const EVENT_CASES = [
  {
    type: 'worker_spawn_backend_resolved',
    valid: { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', source: 'state', pid: 1234 },
    drop: 'backend',
  },
  {
    type: 'worker_spawn_backend_mismatch',
    valid: { event: 'worker_spawn_backend_mismatch', ts: TS, backend: 'codex', gate_payload: { expected_backend: 'claude' } },
    drop: 'gate_payload',
  },
  {
    type: 'worker_spawn_backend_override',
    valid: { event: 'worker_spawn_backend_override', ts: TS, backend: 'codex' },
    drop: 'backend',
  },
  {
    type: 'subtool_backend_override',
    valid: { event: 'subtool_backend_override', ts: TS, backend: 'codex' },
    drop: 'backend',
  },
  {
    type: 'worker_backend_resolved',
    valid: { event: 'worker_backend_resolved', ts: TS, backend: 'claude', worker_backend: 'codex', source: 'worker_backend' },
    drop: 'source',
  },
  {
    type: 'worker_partial_lifecycle_exit',
    valid: {
      event: 'worker_partial_lifecycle_exit',
      ts: TS,
      ticket: 'abc123',
      gate_payload: { artifacts_missing: ['plan.md', 'research.md'], session_log_size: 0 },
    },
    drop: 'ticket',
  },
  {
    type: 'cap_check_skipped_stale_cache',
    valid: {
      event: 'cap_check_skipped_stale_cache',
      ts: TS,
      gate_payload: {
        current_ticket: null,
        current_ticket_max_iterations: 10,
        current_ticket_budget_start_iteration: 8,
        current_ticket_tier: 'small',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'pipeline_auto_resumed',
    valid: {
      event: 'pipeline_auto_resumed',
      ts: TS,
      gate_payload: { retry_index: 1, ticket_id: 'abc123', session_done_count_at_retry: 3 },
    },
    drop: 'gate_payload',
  },
  {
    type: 'bundle_bootstrap_exemption_applied',
    valid: {
      event: 'bundle_bootstrap_exemption_applied',
      ts: TS,
      gate_payload: { skip_readiness_reason: 'bootstrap', skip_ticket_audit_reason: 'bootstrap' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'ticket_audit_bypassed',
    valid: { event: 'ticket_audit_bypassed', ts: TS, reason: 'operator-approved' },
    drop: 'reason',
  },
  {
    type: 'ticket_audit_manual_edit',
    valid: { event: 'ticket_audit_manual_edit', ts: TS, gate_payload: { edit_count: 2 } },
    drop: 'gate_payload',
  },
  {
    type: 'smoke_gate_bypassed',
    valid: { event: 'smoke_gate_bypassed', ts: TS, reason: 'testing' },
    drop: 'reason',
  },
  {
    type: 'bundle_2026_05_04_closer_done',
    valid: {
      event: 'bundle_2026_05_04_closer_done',
      ts: TS,
      gate_payload: { release_url: 'https://github.com/example/repo/releases/tag/v1.70.0' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'manager_idle_backoff_engaged',
    valid: {
      event: 'manager_idle_backoff_engaged',
      ts: TS,
      session: 'session-1',
      ticket: 'abc123',
      consecutive_wait_turns: 3,
      last_worker_pid: 1234,
    },
    drop: 'last_worker_pid',
  },
  {
    type: 'manager_idle_backoff_released',
    valid: {
      event: 'manager_idle_backoff_released',
      ts: TS,
      session: 'session-1',
      ticket: 'abc123',
      duration_ms: 60000,
      release_reason: 'fallback_timer',
    },
    drop: 'release_reason',
  },
];

for (const { type, valid, drop } of EVENT_CASES) {
  test(`activity-event-payload: ${type} valid payload passes required-field check`, () => {
    const result = validate(valid, type);
    assert.equal(result.valid, true, `${type}: ${result.error}`);
  });

  test(`activity-event-payload: ${type} payload missing '${drop}' fails required-field check`, () => {
    const broken = { ...valid };
    delete broken[drop];
    const result = validate(broken, type);
    assert.equal(result.valid, false, `${type}: expected failure when '${drop}' is absent`);
  });
}

// worker_spawn_backend_resolved specific: source enum-of-six and backend enum-of-three
test('activity-event-payload: worker_spawn_backend_resolved source must be one of six BackendResolutionSource values', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', pid: 4567 };
  for (const src of BACKEND_RESOLUTION_SOURCE_ENUM) {
    const result = validate({ ...base, source: src }, 'worker_spawn_backend_resolved');
    assert.equal(result.valid, true, `source '${src}' should be valid`);
  }
  const bad = validate({ ...base, source: 'unknown-source' }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, `source 'unknown-source' should be rejected`);
});

test('activity-event-payload: worker_spawn_backend_resolved backend must be one of three Backend values', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, source: 'state', pid: 4567 };
  for (const be of BACKEND_ENUM) {
    const result = validate({ ...base, backend: be }, 'worker_spawn_backend_resolved');
    assert.equal(result.valid, true, `backend '${be}' should be valid`);
  }
  const bad = validate({ ...base, backend: 'gpt-5' }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, `backend 'gpt-5' should be rejected`);
});

test('activity-event-payload: worker_spawn_backend_resolved pid must be an integer', () => {
  const base = { event: 'worker_spawn_backend_resolved', ts: TS, backend: 'claude', source: 'state' };
  const good = validate({ ...base, pid: 9999 }, 'worker_spawn_backend_resolved');
  assert.equal(good.valid, true, 'integer pid should pass');
  const bad = validate({ ...base, pid: 3.14 }, 'worker_spawn_backend_resolved');
  assert.equal(bad.valid, false, 'float pid should fail');
  const bad2 = validate({ ...base, pid: '1234' }, 'worker_spawn_backend_resolved');
  assert.equal(bad2.valid, false, 'string pid should fail');
});

test('activity-event-payload: worker_backend_resolved source must be one of three worker-backend precedence values', () => {
  const base = { event: 'worker_backend_resolved', ts: TS, backend: 'claude', worker_backend: 'codex' };
  for (const src of WORKER_BACKEND_RESOLUTION_SOURCE_ENUM) {
    const result = validate({ ...base, source: src }, 'worker_backend_resolved');
    assert.equal(result.valid, true, `source '${src}' should be valid`);
  }
  const bad = validate({ ...base, source: 'state' }, 'worker_backend_resolved');
  assert.equal(bad.valid, false, `source 'state' should be rejected`);
});

test('activity-event-payload: worker_lint_gate_failed requires integer error counts and file_list', () => {
  const good = validate({
    event: 'worker_lint_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    lint_errors: 2,
    tsc_errors: 1,
    file_list: ['extension/src/bin/spawn-morty.ts'],
  }, 'worker_lint_gate_failed');
  assert.equal(good.valid, true, 'valid lint gate failure payload should pass');

  const bad = validate({
    event: 'worker_lint_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    lint_errors: '2',
    tsc_errors: 1,
    file_list: ['extension/src/bin/spawn-morty.ts'],
  }, 'worker_lint_gate_failed');
  assert.equal(bad.valid, false, 'string lint_errors should fail');
});

test('activity-event-payload: schema defines exactly 19 event type definitions', () => {
  const EVENT_NAMES = [
    'worker_spawn_backend_resolved',
    'worker_spawn_backend_mismatch',
    'worker_spawn_backend_override',
    'subtool_backend_override',
    'worker_partial_lifecycle_exit',
    'cap_check_skipped_stale_cache',
    'pipeline_auto_resumed',
    'bundle_bootstrap_exemption_applied',
    'ticket_audit_bypassed',
    'ticket_audit_manual_edit',
    'smoke_gate_bypassed',
    'bundle_2026_05_04_closer_done',
    'install_sh_parity_check',
    'worker_backend_resolved',
    'completion_commit_auto_filled',
    'completion_commit_inferred_from_git',
    'worker_lint_gate_passed',
    'worker_lint_gate_failed',
    'worker_lint_autofix_applied',
    'worker_completion_commit_announced',
    'time_cap_disabled_default',
    'manager_idle_backoff_engaged',
    'manager_idle_backoff_released',
  ];
  for (const name of EVENT_NAMES) {
    assert.ok(name in schema.definitions, `schema missing definition for ${name}`);
  }
  const nonSharedDefs = Object.keys(schema.definitions).filter(
    k => k !== 'backendEnum' && k !== 'backendResolutionSourceEnum',
  );
  assert.equal(nonSharedDefs.length, 24, `expected 24 event definitions, got ${nonSharedDefs.length}`);
});
