// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

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
    if (Object.prototype.hasOwnProperty.call(propSchema, 'const')) {
      if (payload[field] !== propSchema.const) {
        return { valid: false, error: `${field} must equal ${String(propSchema.const)}` };
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
    if (propSchema.type === 'boolean') {
      if (typeof payload[field] !== 'boolean') {
        return { valid: false, error: `${field} must be a boolean` };
      }
    }
    if (propSchema.type === 'string') {
      if (typeof payload[field] !== 'string') {
        return { valid: false, error: `${field} must be a string` };
      }
    }
    if (propSchema.type === 'array') {
      if (!Array.isArray(payload[field])) {
        return { valid: false, error: `${field} must be an array` };
      }
      if (propSchema.items?.type === 'string' && payload[field].some((item) => typeof item !== 'string')) {
        return { valid: false, error: `${field} items must be strings` };
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
    valid: {
      event: 'worker_spawn_backend_mismatch',
      ts: TS,
      source: 'settings',
      pid: 1234,
      ticket: 'abc123',
      session: 'session-1',
      resolved_backend: 'claude',
      state_backend: 'codex',
    },
    drop: 'resolved_backend',
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
    type: 'recoverable_phase_failure',
    valid: {
      event: 'recoverable_phase_failure',
      ts: TS,
      phase: 'pickle',
      exit_code: 1,
      fatal: false,
      reason: 'non-fatal pickle exit, commits present',
      downstream_phases_remaining: ['citadel', 'anatomy-park', 'szechuan-sauce'],
      decision: 'continue',
    },
    drop: 'decision',
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
    type: 'ticket_audit_failed',
    valid: { event: 'ticket_audit_failed', ts: TS, session: 'session-1' },
    drop: 'ts',
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
  {
    type: 'worker_edit_outside_scope',
    valid: {
      event: 'worker_edit_outside_scope',
      ts: TS,
      ticket_id: 'abc12345',
      gate_payload: {
        scope_json_path: '/tmp/session/scope.json',
        staged_paths_outside_scope: ['src/unrelated/file.ts'],
        head_ref: 'HEAD',
        suggested_remediation: 'Unstage outside-scope paths or expand scope.json:allowed_paths before committing.',
      },
    },
    drop: 'gate_payload',
  },
  {
    type: 'time_cap_disabled_default',
    valid: { event: 'time_cap_disabled_default', ts: TS, session: 'session-1', backend: 'claude' },
    drop: 'ts',
  },
  {
    type: 'manager_max_turns_relaunch',
    valid: {
      event: 'manager_max_turns_relaunch',
      ts: TS,
      backend: 'claude',
      relaunch_count: 4,
      cap: 20,
      pending_count: 3,
      last_ticket_seen: '620fea14',
      session: 'session-1',
      iteration: 7,
    },
    drop: 'last_ticket_seen',
  },
  {
    type: 'iteration_classified_at_max_turns',
    valid: {
      event: 'iteration_classified_at_max_turns',
      ts: TS,
      session: 'session-1',
      iteration_num: 3,
      num_turns: 400,
      max_turns: 400,
      wall_seconds: 742.5,
    },
    drop: 'wall_seconds',
  },
  {
    type: 'pipeline_judge_timeout_recovery_attempted',
    valid: {
      event: 'pipeline_judge_timeout_recovery_attempted',
      ts: TS,
      phase: 'anatomy-park',
      fall_through_to_finalize_gate: true,
    },
    drop: 'phase',
  },
  {
    type: 'bundle_preflight_failed',
    valid: {
      event: 'bundle_preflight_failed',
      ts: TS,
      gate_payload: { failed_assertion: 'composes_paths_resolve', reason: 'path not found: prds/foo.md' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_violation_ledger_advanced',
    valid: {
      event: 'judge_violation_ledger_advanced',
      ts: TS,
      gate_payload: { resolved_count: 2, new_count: 1, remaining_count: 5, ledger_size: 8 },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_legacy_shape_inferred',
    valid: {
      event: 'judge_legacy_shape_inferred',
      ts: TS,
      gate_payload: { score: 7.5, raw_keys: ['violations', 'score'] },
    },
    drop: 'gate_payload',
  },
  {
    type: 'judge_json_parse_failed',
    valid: {
      event: 'judge_json_parse_failed',
      ts: TS,
      gate_payload: { raw_output_truncated_512: 'Here is my assessment: score 8', parse_error_message: 'Unexpected token H' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'consecutive_no_progress_warning',
    valid: {
      event: 'consecutive_no_progress_warning',
      ts: TS,
      gate_payload: { count: 2, stall_limit: 3, metric_type: 'command' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_respawn_started',
    valid: {
      event: 'monitor_respawn_started',
      ts: TS,
      gate_payload: { from_phase: 'pickle', to_phase: 'anatomy-park', mode: 'microverse' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_respawn_failed',
    valid: {
      event: 'monitor_respawn_failed',
      ts: TS,
      gate_payload: { phase: 'anatomy-park', error: 'tmux respawn failed: pane 0 not found' },
    },
    drop: 'gate_payload',
  },
  {
    type: 'monitor_mode_swapped',
    valid: { event: 'monitor_mode_swapped', ts: TS, mode: 'microverse' },
    drop: 'mode',
  },
  {
    type: 'setup_resume_ticket_status_preserved',
    valid: {
      event: 'setup_resume_ticket_status_preserved',
      ts: TS,
      ticket_id: 'abc123',
      observed_status: 'Skipped',
      expected_status: 'In Progress',
      reason: 'operator_edit',
    },
    drop: 'ticket_id',
  },
  {
    type: 'setup_resume_overrode_ticket_status',
    valid: {
      event: 'setup_resume_overrode_ticket_status',
      ts: TS,
      ticket_id: 'abc123',
      prior_status: 'Skipped',
      new_status: 'In Progress',
      source: 'force_flag',
    },
    drop: 'ticket_id',
  },
  {
    type: 'head_mismatch_detected',
    valid: {
      event: 'head_mismatch_detected',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        pinned_branch: 'main',
        observed_branch: 'feature/external',
        pinned_sha: 'abc1234abc1234',
        observed_sha: 'def5678def5678',
        detected_at_phase: 'implement',
      },
    },
    drop: 'session',
  },
  {
    type: 'stale_index_lock_cleaned',
    valid: {
      event: 'stale_index_lock_cleaned',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        path: '/tmp/repo/.git/index.lock',
        mtime: TS,
        age_seconds: 12,
      },
    },
    drop: 'session',
  },
  {
    type: 'stale_index_lock_held_by_live_process',
    valid: {
      event: 'stale_index_lock_held_by_live_process',
      ts: TS,
      session: 'session-1',
      gate_payload: {
        path: '/tmp/repo/.git/index.lock',
        mtime: TS,
        age_seconds: 12,
        holder_pid: 4242,
        holder_command: 'git',
      },
    },
    drop: 'session',
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

test('activity-event-payload: recoverable_phase_failure registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('recoverable_phase_failure'),
    'recoverable_phase_failure must be present in VALID_ACTIVITY_EVENTS',
  );
});

test('activity-event-payload: recoverable_phase_failure schema enforces contract fields', () => {
  const good = validate({
    event: 'recoverable_phase_failure',
    ts: TS,
    phase: 'anatomy-park',
    exit_code: 1,
    fatal: false,
    reason: 'non-fatal anatomy-park exit, exit_reason=judge_timeout',
    downstream_phases_remaining: ['szechuan-sauce'],
    decision: 'continue',
  }, 'recoverable_phase_failure');
  assert.equal(good.valid, true, good.error);

  const bad = validate({
    event: 'recoverable_phase_failure',
    ts: TS,
    phase: 'anatomy-park',
    exit_code: '1',
    fatal: true,
    reason: 'bad',
    downstream_phases_remaining: ['szechuan-sauce', 2],
    decision: 'resume',
  }, 'recoverable_phase_failure');
  assert.equal(bad.valid, false, 'invalid exit_code/fatal/downstream_phases_remaining/decision should fail');
});

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

test('activity-event-payload: worker_gate_failed requires structured failures and retry_count', () => {
  const good = validate({
    event: 'worker_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    gate_phase: 'test:integration',
    failures: [{
      name: 'worker integration tier fails',
      file: 'tests/integration-fixture.test.js',
      message: 'integration boom',
    }],
    retry_count: 1,
  }, 'worker_gate_failed');
  assert.equal(good.valid, true, 'valid worker gate failure payload should pass');

  const bad = validate({
    event: 'worker_gate_failed',
    ts: TS,
    ticket_id: 'abc12345',
    gate_phase: 'deploy',
    failures: [{
      name: 'worker fast tier fails',
      file: 'tests/worker-fixture.test.js',
      message: 'boom',
    }],
    retry_count: '1',
  }, 'worker_gate_failed');
  assert.equal(bad.valid, false, 'invalid gate_phase and string retry_count should fail');
});

test('activity-event-payload: cross_ticket_regression_detected requires prior_ticket_id and failing_tests', () => {
  const good = validate({
    event: 'cross_ticket_regression_detected',
    ts: TS,
    ticket_id: 'bbbb2222',
    prior_ticket_id: 'aaaa1111',
    failing_tests: [{
      name: 'boundary detection fires',
      file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
    }],
  }, 'cross_ticket_regression_detected');
  assert.equal(good.valid, true, 'valid cross-ticket regression payload should pass');

  const bad = validate({
    event: 'cross_ticket_regression_detected',
    ts: TS,
    ticket_id: 'bbbb2222',
    failing_tests: [{
      name: 'boundary detection fires',
      file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
    }],
  }, 'cross_ticket_regression_detected');
  assert.equal(bad.valid, false, 'missing prior_ticket_id should fail');
});

const SHARED_ENUM_DEFS = new Set([
  'backendEnum',
  'backendResolutionSourceEnum',
  'workerBackendResolutionSourceEnum',
]);

test('activity-event-payload: schema defines all registered event type definitions', () => {
  const EVENT_NAMES = [
    'worker_spawn_backend_resolved',
    'worker_spawn_backend_mismatch',
    'worker_spawn_backend_override',
    'subtool_backend_override',
    'worker_partial_lifecycle_exit',
    'baseline_attempt_timeout',
    'cap_check_skipped_stale_cache',
    'pipeline_auto_resumed',
    'bundle_bootstrap_exemption_applied',
    'ticket_audit_bypassed',
    'ticket_audit_failed',
    'ticket_audit_manual_edit',
    'smoke_gate_bypassed',
    'bundle_2026_05_04_closer_done',
    'install_sh_parity_check',
    'worker_backend_resolved',
    'completion_commit_auto_filled',
    'completion_commit_inferred_from_git',
    'phantom_done_detected',
    'worker_lint_gate_passed',
    'cross_ticket_regression_detected',
    'worker_gate_failed',
    'worker_lint_gate_failed',
    'worker_lint_autofix_applied',
    'worker_completion_commit_announced',
    'recoverable_phase_failure',
    'time_cap_disabled_default',
    'manager_max_turns_relaunch',
    'iteration_classified_at_max_turns',
    'manager_idle_backoff_engaged',
    'manager_idle_backoff_released',
    'standup_session_dropped',
    'worker_edit_outside_scope',
    'pkgjson_revert_forensic_captured',
    'pipeline_judge_timeout_recovery_attempted',
    'bundle_preflight_failed',
    'consecutive_no_progress_warning',
    'judge_violation_ledger_advanced',
    'judge_legacy_shape_inferred',
    'judge_json_parse_failed',
    'monitor_respawn_started',
    'monitor_respawn_failed',
    'monitor_mode_swapped',
    'setup_resume_ticket_status_preserved',
    'setup_resume_overrode_ticket_status',
    'head_mismatch_detected',
    'stale_index_lock_cleaned',
    'stale_index_lock_held_by_live_process',
  ];
  // Structural drift check — assert set-equality between registered events
  // and asserted EVENT_NAMES rather than a hardcoded count literal.
  const nonSharedDefs = Object.keys(schema.definitions).filter((k) => !SHARED_ENUM_DEFS.has(k));
  const eventNameSet = new Set(EVENT_NAMES);
  const inSchemaNotAsserted = nonSharedDefs.filter((k) => !eventNameSet.has(k));
  const assertedNotInSchema = EVENT_NAMES.filter((n) => !(n in schema.definitions));
  assert.deepStrictEqual(
    inSchemaNotAsserted,
    [],
    `schema defines events absent from EVENT_NAMES: ${inSchemaNotAsserted.join(', ')}`,
  );
  assert.deepStrictEqual(
    assertedNotInSchema,
    [],
    `EVENT_NAMES contains events absent from schema: ${assertedNotInSchema.join(', ')}`,
  );
});
