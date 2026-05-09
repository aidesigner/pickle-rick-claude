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

function runCapture(args) {
  const extRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-log-activity-gp-')));
  const result = spawnSync(process.execPath, [LOG_ACTIVITY_BIN, ...args], {
    env: { ...process.env, PICKLE_DATA_ROOT: extRoot, FORCE_COLOR: '0' },
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

test('log-activity --gate-payload: forwards JSON object into emitted gate_payload field', () => {
  const payload = {
    forensic_artifact_path: '/tmp/audit/pkgjson-revert-2026-05-09.json',
    suspected_hypothesis: 'h-c',
    src_version: '1.73.0',
    deployed_version: '1.72.0',
  };
  const { status, events } = runCapture([
    'pkgjson_revert_forensic_captured',
    'pkgjson revert captured',
    '--gate-payload',
    JSON.stringify(payload),
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'pkgjson_revert_forensic_captured');
  assert.deepEqual(events[0].gate_payload, payload);
});

test('log-activity --gate-payload: emitted event satisfies schema definition for pkgjson_revert_forensic_captured', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const def = schema.definitions.pkgjson_revert_forensic_captured;
  assert.ok(def, 'schema must define pkgjson_revert_forensic_captured');

  const payload = {
    forensic_artifact_path: '/tmp/audit/pkgjson-revert-x.json',
    suspected_hypothesis: 'h-a',
    src_version: '1.73.0',
    deployed_version: '1.72.5',
  };
  const { events } = runCapture([
    'pkgjson_revert_forensic_captured',
    'capture title',
    '--gate-payload',
    JSON.stringify(payload),
  ]);
  assert.equal(events.length, 1);
  for (const field of def.required) {
    assert.ok(field in events[0], `emitted event missing required field: ${field}`);
  }
  const gpDef = def.properties.gate_payload;
  for (const field of gpDef.required) {
    assert.ok(field in events[0].gate_payload, `gate_payload missing required field: ${field}`);
  }
});

test('log-activity --gate-payload: rejects malformed JSON with exit 1', () => {
  const { status, stderr } = runCapture([
    'commit',
    'title',
    '--gate-payload',
    '{not-json',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('not valid JSON'), `stderr should mention invalid JSON, got: ${stderr}`);
});

test('log-activity --gate-payload: rejects JSON array with exit 1', () => {
  const { status, stderr } = runCapture([
    'commit',
    'title',
    '--gate-payload',
    '[1,2,3]',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('must be a JSON object'), `stderr should mention object requirement, got: ${stderr}`);
});

test('log-activity --gate-payload: rejects scalar JSON with exit 1', () => {
  const { status, stderr } = runCapture([
    'commit',
    'title',
    '--gate-payload',
    '"just-a-string"',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('must be a JSON object'), `stderr should mention object requirement, got: ${stderr}`);
});

test('log-activity --gate-payload: rejects missing value with exit 1', () => {
  const { status, stderr } = runCapture([
    'commit',
    'title',
    '--gate-payload',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('--gate-payload requires'), `stderr should mention required value, got: ${stderr}`);
});

test('log-activity --gate-payload: rejects --flag value', () => {
  const { status, stderr } = runCapture([
    'commit',
    'title',
    '--gate-payload',
    '--something',
  ]);
  assert.equal(status, 1);
  assert.ok(stderr.includes('--gate-payload requires'), `stderr should mention required value, got: ${stderr}`);
});

test('log-activity: omitting --gate-payload preserves existing behavior (no gate_payload field)', () => {
  const { status, events } = runCapture(['commit', 'plain title']);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'plain title');
  assert.equal('gate_payload' in events[0], false, 'gate_payload should not be present when flag omitted');
});

test('log-activity --gate-payload: flag accepted before positional args', () => {
  const payload = { src_version: '1.73.0', deployed_version: '1.72.0', suspected_hypothesis: 'h-b', forensic_artifact_path: '/tmp/x.json' };
  const { status, events } = runCapture([
    '--gate-payload',
    JSON.stringify(payload),
    'pkgjson_revert_forensic_captured',
    'capture title',
  ]);
  assert.equal(status, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].gate_payload, payload);
});
