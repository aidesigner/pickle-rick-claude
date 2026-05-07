// @tier: fast
/**
 * R-PSU-1 / AC-PSU-01 — standup helper drops noise sessions before stdout.
 * Covers the operator-supplied catalogue: effort-*-test, chain-*-test,
 * display-sync-test*, pipeline-dispatch-session-*, citadel-pipeline-session-*,
 * pickle-debate-*.
 *
 * AC-PSU-01 also requires `standup_session_dropped` registered in
 * VALID_ACTIVITY_EVENTS + activity-events.schema.json. Lint-checked here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TYPES_TS = path.resolve(__dirname, '..', 'src', 'types', 'index.ts');
const TYPES_JS = path.resolve(__dirname, '..', 'types', 'index.js');
const SCHEMA = path.resolve(__dirname, '..', 'src', 'types', 'activity-events.schema.json');

const { classifyStandupNoise } = await import('../bin/standup.js');

test('AC-PSU-01: standup_session_dropped registered in VALID_ACTIVITY_EVENTS (TS source)', () => {
  const content = fs.readFileSync(TYPES_TS, 'utf-8');
  assert.ok(/'standup_session_dropped'/.test(content), 'TS source must register the event');
});

test('AC-PSU-01: standup_session_dropped registered in deployed JS mirror', () => {
  const content = fs.readFileSync(TYPES_JS, 'utf-8');
  assert.ok(/'standup_session_dropped'/.test(content), 'JS mirror must include the event');
});

test('AC-PSU-01: standup_session_dropped schema requires session_name and drop_reason', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf-8'));
  const def = schema.definitions.standup_session_dropped;
  assert.ok(def, 'schema definition must exist');
  assert.deepStrictEqual(def.required.sort(), ['drop_reason', 'event', 'session_name', 'ts']);
  assert.equal(def.properties.session_name.type, 'string');
  assert.equal(def.properties.drop_reason.type, 'string');
});

const NOISE_FIXTURES = [
  'effort-foo-test',
  'chain-bar-test',
  'display-sync-test-2026',
  'pipeline-dispatch-session-12345',
  'citadel-pipeline-session-abc',
  'pickle-debate-some-topic',
];

for (const sid of NOISE_FIXTURES) {
  test(`AC-PSU-01: noise pattern drops session "${sid}"`, () => {
    const result = classifyStandupNoise(sid);
    assert.equal(result.dropped, true, `${sid} should be dropped`);
    assert.ok(result.reason.includes('noise pattern'), `reason must explain match`);
  });
}

test('AC-PSU-01: real-ticket session does NOT match any noise pattern', () => {
  const result = classifyStandupNoise('2026-05-07-be6e9179', 'prds/p1-bug-fix-bundle-theme-a-refinement-quality.md');
  assert.equal(result.dropped, false, 'real session must not be dropped');
});

test('AC-PSU-01: noise match by prompt prefix is also caught', () => {
  const result = classifyStandupNoise('regular-sid-12345', 'pickle-debate-foo-vs-bar');
  assert.equal(result.dropped, true, 'prompt-side noise must drop');
});

test('AC-PSU-01: synthetic 5 noise + 2 real → only 2 surface', () => {
  const synth = [
    { sid: 'effort-x-test', prompt: '' },                    // noise
    { sid: 'chain-y-test', prompt: '' },                     // noise
    { sid: 'display-sync-test-z', prompt: '' },              // noise
    { sid: 'pipeline-dispatch-session-1', prompt: '' },      // noise
    { sid: 'pickle-debate-foo', prompt: '' },                // noise
    { sid: '2026-05-07-real1', prompt: 'fix LOA-661' },      // real
    { sid: '2026-05-07-real2', prompt: 'feat LOA-715' },     // real
  ];
  const surfaced = synth.filter((s) => !classifyStandupNoise(s.sid, s.prompt).dropped);
  assert.equal(surfaced.length, 2, `expected 2 real, got ${surfaced.length}`);
  assert.deepStrictEqual(
    surfaced.map((s) => s.sid).sort(),
    ['2026-05-07-real1', '2026-05-07-real2'],
  );
});
