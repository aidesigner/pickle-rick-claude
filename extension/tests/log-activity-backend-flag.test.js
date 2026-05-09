// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_ACTIVITY_BIN = path.resolve(__dirname, '../bin/log-activity.js');
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');
const CODEX_RESCUE_MD = path.resolve(__dirname, '../../.claude/commands/codex-rescue.md');
const SEND_TO_MORTY_MD = path.resolve(__dirname, '../../.claude/commands/send-to-morty.md');

function runCapture(args, env = {}) {
  const extRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-log-activity-be-')));
  const baseEnv = { ...process.env, PICKLE_DATA_ROOT: extRoot, FORCE_COLOR: '0' };
  // Strip any inherited PICKLE_BACKEND so the env-fallback path in resolveActivityBackend
  // cannot mask the absence of the --backend flag in the negative tests.
  delete baseEnv.PICKLE_BACKEND;
  const result = spawnSync(process.execPath, [LOG_ACTIVITY_BIN, ...args], {
    env: { ...baseEnv, ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  const activityDir = path.join(extRoot, 'activity');
  const events = [];
  if (fs.existsSync(activityDir)) {
    for (const f of fs.readdirSync(activityDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const lines = fs.readFileSync(path.join(activityDir, f), 'utf-8').trim().split('\n').filter(Boolean);
      for (const l of lines) events.push(JSON.parse(l));
    }
  }
  fs.rmSync(extRoot, { recursive: true, force: true });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status, events };
}

test('log-activity --backend: forwards value into emitted backend field', () => {
  const { status, events } = runCapture([
    'subtool_backend_override',
    'codex sub-tool invoked',
    '--backend',
    'codex',
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'subtool_backend_override');
  assert.equal(events[0].backend, 'codex');
});

test('log-activity --backend: emitted subtool_backend_override satisfies schema required fields', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const def = schema.definitions.subtool_backend_override;
  assert.ok(def, 'schema must define subtool_backend_override');

  const { events } = runCapture([
    'subtool_backend_override',
    'codex sub-tool invoked',
    '--backend',
    'codex',
  ]);
  assert.equal(events.length, 1);
  for (const field of def.required) {
    assert.ok(field in events[0], `emitted event missing required field: ${field}`);
  }
  // Verify backend value is in BACKENDS enum
  const backendEnum = schema.definitions.backendEnum.enum;
  assert.ok(backendEnum.includes(events[0].backend), `backend value '${events[0].backend}' not in enum`);
});

test('log-activity --backend: rejects unknown backend with exit 1', () => {
  const { status, stderr } = runCapture([
    'subtool_backend_override',
    'title',
    '--backend',
    'gpt5',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('--backend must be one of'), `stderr should mention valid backends, got: ${stderr}`);
});

test('log-activity --backend: rejects missing value with exit 1', () => {
  const { status, stderr } = runCapture([
    'subtool_backend_override',
    'title',
    '--backend',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('--backend requires'), `stderr should mention required value, got: ${stderr}`);
});

test('log-activity --backend: rejects --flag value', () => {
  const { status, stderr } = runCapture([
    'subtool_backend_override',
    'title',
    '--backend',
    '--something',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('--backend requires'), `stderr should mention required value, got: ${stderr}`);
});

test('log-activity: omitting --backend without env fallback omits backend field (negative)', () => {
  // With PICKLE_BACKEND scrubbed, omitting --backend means no backend resolution path.
  // For subtool_backend_override this reproduces the pre-fix schema-non-conformance.
  const { status, events } = runCapture([
    'subtool_backend_override',
    'codex sub-tool invoked',
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.equal('backend' in events[0], false, 'pre-fix shape: omitting flag and env yields no backend field');
});

test('log-activity --backend: flag accepted before positional args', () => {
  const { status, events } = runCapture([
    '--backend',
    'codex',
    'subtool_backend_override',
    'codex sub-tool invoked',
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].backend, 'codex');
});

test('log-activity --backend: composes with --gate-payload independently', () => {
  const payload = {
    forensic_artifact_path: '/tmp/audit/x.json',
    suspected_hypothesis: 'h-a',
    src_version: '1.73.0',
    deployed_version: '1.72.5',
  };
  const { status, events } = runCapture([
    'pkgjson_revert_forensic_captured',
    'composed',
    '--gate-payload',
    JSON.stringify(payload),
    '--backend',
    'claude',
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].gate_payload, payload);
  assert.equal(events[0].backend, 'claude');
});

test('codex-rescue.md: documented log-activity invocation passes --backend codex', () => {
  const md = fs.readFileSync(CODEX_RESCUE_MD, 'utf-8');
  const lines = md.split('\n');
  const matches = lines.filter(
    (l) => l.includes('log-activity.js') && l.includes('subtool_backend_override'),
  );
  assert.ok(matches.length >= 1, 'codex-rescue.md must document at least one subtool_backend_override emission');
  for (const line of matches) {
    assert.ok(
      line.includes('--backend codex'),
      `codex-rescue.md emission line missing --backend codex: ${line}`,
    );
  }
});

test('send-to-morty.md: documented log-activity invocation passes --backend codex', () => {
  const md = fs.readFileSync(SEND_TO_MORTY_MD, 'utf-8');
  const lines = md.split('\n');
  const matches = lines.filter(
    (l) => l.includes('log-activity.js') && l.includes('subtool_backend_override'),
  );
  assert.ok(matches.length >= 1, 'send-to-morty.md must document at least one subtool_backend_override emission');
  for (const line of matches) {
    assert.ok(
      line.includes('--backend codex'),
      `send-to-morty.md emission line missing --backend codex: ${line}`,
    );
  }
});
