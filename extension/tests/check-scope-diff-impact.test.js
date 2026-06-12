// @tier: fast
// Tests the warn-only impact-radius preflight added to checkScopeDiff.
// Uses direct module import + injected fake services and _getStagedPaths seam —
// no subprocess or real git repo needed, keeping this in the fast tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScopeDiff } from '../bin/check-scope-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// allowed_paths used in all cells that need a valid scope.json
const ALLOWED_PATHS = ['extension/src'];
// getStagedPaths for ok status (all in scope)
const GET_STAGED_OK = () => ['extension/src/foo.ts'];
// getStagedPaths for outside_scope status (one path outside scope)
const GET_STAGED_OUTSIDE = () => ['extension/src/foo.ts', 'unrelated/leaked.ts'];

// Service that returns dependents with one inside scope and one outside scope.
// extension/src/other.ts is IN scope; docs/readme.md is OUTSIDE.
// Expected transitive_dependents_outside_scope: ['docs/readme.md']
const dependentService = {
  getImpactRadius: () => ['extension/src/other.ts', 'docs/readme.md'],
};

// Service that returns no dependents — no event should fire.
const noneService = {
  getImpactRadius: () => [],
};

// Service that throws — fail-open, no event should fire.
const failService = {
  getImpactRadius: () => {
    throw new Error('service unavailable');
  },
};

function makeSpyService() {
  const spy = {
    called: false,
    getImpactRadius(..._args) {
      spy.called = true;
      return ['docs/readme.md'];
    },
  };
  return spy;
}

function readImpactEvents(activityDir) {
  if (!fs.existsSync(activityDir)) return [];
  const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(activityDir, f), 'utf-8');
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return events.filter((e) => e.event === 'scope_impact_warning');
}

// scopeAllowedPaths: string[] for valid scope, null for no_scope, 'malformed' for bad JSON
function runWithIsolation(scopeAllowedPaths, getStagedPaths, impactService) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'csd-impact-')));
  try {
    const dataRoot = path.join(tmp, 'data');
    const activityDir = path.join(dataRoot, 'activity');

    let scopeJsonPath;
    if (scopeAllowedPaths === null) {
      scopeJsonPath = undefined;
    } else if (scopeAllowedPaths === 'malformed') {
      scopeJsonPath = path.join(tmp, 'scope.json');
      fs.writeFileSync(scopeJsonPath, '{ not valid json !!!');
    } else {
      scopeJsonPath = path.join(tmp, 'scope.json');
      fs.writeFileSync(scopeJsonPath, JSON.stringify({ allowed_paths: scopeAllowedPaths }));
    }

    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    let result;
    let events;
    try {
      result = checkScopeDiff({ scopeJsonPath, impactService, _getStagedPaths: getStagedPaths });
      events = readImpactEvents(activityDir);
    } finally {
      if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = savedDataRoot;
    }
    return { result, events };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── ok × dependents ────────────────────────────────────────────────────────
test('ok × dependents: emits scope_impact_warning for out-of-scope transitive dependents', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, dependentService);
  assert.equal(result.status, 'ok');
  assert.equal(events.length, 1, 'expected exactly 1 scope_impact_warning event');
  const ev = events[0];
  assert.equal(ev.source, 'pickle');
  assert.ok(ev.gate_payload, 'event must have gate_payload');
  assert.deepEqual(ev.gate_payload.staged_paths, ['extension/src/foo.ts']);
  assert.deepEqual(ev.gate_payload.transitive_dependents_outside_scope, ['docs/readme.md']);
  assert.equal(ev.gate_payload.radius_depth, 2);
  assert.equal(typeof ev.ts, 'string', 'event must have ts');
});

// ─── ok × none ──────────────────────────────────────────────────────────────
test('ok × none: no event when service returns empty dependents', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, noneService);
  assert.equal(result.status, 'ok');
  assert.equal(events.length, 0, 'no event expected when no dependents returned');
});

// ─── ok × service-fail ──────────────────────────────────────────────────────
test('ok × service-fail: fail-open — no event when service throws', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, failService);
  assert.equal(result.status, 'ok');
  assert.equal(events.length, 0, 'no event expected on service throw (fail-open)');
});

// ─── outside_scope × dependents ─────────────────────────────────────────────
test('outside_scope × dependents: emits scope_impact_warning alongside outside_scope status', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OUTSIDE, dependentService);
  assert.equal(result.status, 'outside_scope');
  assert.equal(events.length, 1, 'expected exactly 1 scope_impact_warning event');
  const ev = events[0];
  assert.deepEqual(ev.gate_payload.staged_paths, ['extension/src/foo.ts', 'unrelated/leaked.ts']);
  assert.deepEqual(ev.gate_payload.transitive_dependents_outside_scope, ['docs/readme.md']);
  assert.equal(ev.gate_payload.radius_depth, 2);
});

// ─── outside_scope × none ────────────────────────────────────────────────────
test('outside_scope × none: no event when service returns empty dependents', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OUTSIDE, noneService);
  assert.equal(result.status, 'outside_scope');
  assert.equal(events.length, 0);
});

// ─── outside_scope × service-fail ────────────────────────────────────────────
test('outside_scope × service-fail: fail-open — no event when service throws', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OUTSIDE, failService);
  assert.equal(result.status, 'outside_scope');
  assert.equal(events.length, 0);
});

// ─── no_scope × dependents ───────────────────────────────────────────────────
test('no_scope × dependents: service never called — no event when scope absent', () => {
  const spy = makeSpyService();
  const { result, events } = runWithIsolation(null, GET_STAGED_OK, spy);
  assert.equal(result.status, 'no_scope');
  assert.equal(spy.called, false, 'service must not be called for no_scope');
  assert.equal(events.length, 0);
});

// ─── no_scope × none ─────────────────────────────────────────────────────────
test('no_scope × none: no event when scope absent (noneService)', () => {
  const { result, events } = runWithIsolation(null, GET_STAGED_OK, noneService);
  assert.equal(result.status, 'no_scope');
  assert.equal(events.length, 0);
});

// ─── no_scope × service-fail ─────────────────────────────────────────────────
test('no_scope × service-fail: no event when scope absent (failService)', () => {
  const { result, events } = runWithIsolation(null, GET_STAGED_OK, failService);
  assert.equal(result.status, 'no_scope');
  assert.equal(events.length, 0);
});

// ─── malformed_scope × dependents ────────────────────────────────────────────
test('malformed_scope × dependents: service never called — no event when scope malformed', () => {
  const spy = makeSpyService();
  const { result, events } = runWithIsolation('malformed', GET_STAGED_OK, spy);
  assert.equal(result.status, 'malformed_scope');
  assert.equal(spy.called, false, 'service must not be called for malformed_scope');
  assert.equal(events.length, 0);
});

// ─── malformed_scope × none ──────────────────────────────────────────────────
test('malformed_scope × none: no event when scope malformed (noneService)', () => {
  const { result, events } = runWithIsolation('malformed', GET_STAGED_OK, noneService);
  assert.equal(result.status, 'malformed_scope');
  assert.equal(events.length, 0);
});

// ─── malformed_scope × service-fail ──────────────────────────────────────────
test('malformed_scope × service-fail: no event when scope malformed (failService)', () => {
  const { result, events } = runWithIsolation('malformed', GET_STAGED_OK, failService);
  assert.equal(result.status, 'malformed_scope');
  assert.equal(events.length, 0);
});

// ─── Invariance: status values unchanged by impact analysis ──────────────────
test('invariance: ok status unchanged when impactService present', () => {
  const { result } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, dependentService);
  assert.equal(result.status, 'ok');
  assert.equal(typeof result.staged_count, 'number');
  assert.ok(!result.staged_paths_outside_scope, 'ok must not have staged_paths_outside_scope');
});

test('invariance: outside_scope result fields unchanged when impactService present', () => {
  const { result } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OUTSIDE, dependentService);
  assert.equal(result.status, 'outside_scope');
  assert.deepEqual(result.staged_paths_outside_scope, ['unrelated/leaked.ts']);
  assert.equal(typeof result.suggested_remediation, 'string');
  assert.ok(result.suggested_remediation.length > 0);
});

// ─── Fail-open: undefined impactService emits no event ───────────────────────
test('fail-open: no impactService → no scope_impact_warning event for ok status', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, undefined);
  assert.equal(result.status, 'ok');
  assert.equal(events.length, 0);
});

test('fail-open: no impactService → no scope_impact_warning event for outside_scope status', () => {
  const { result, events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OUTSIDE, undefined);
  assert.equal(result.status, 'outside_scope');
  assert.equal(events.length, 0);
});

// ─── Exact payload shape ──────────────────────────────────────────────────────
test('exact payload shape: scope_impact_warning gate_payload has all required fields', () => {
  const { events } = runWithIsolation(ALLOWED_PATHS, GET_STAGED_OK, dependentService);
  assert.equal(events.length, 1);
  const { gate_payload, ts, event, source } = events[0];
  assert.equal(event, 'scope_impact_warning');
  assert.equal(source, 'pickle');
  assert.equal(typeof ts, 'string', 'ts must be a string');
  assert.ok(Array.isArray(gate_payload.staged_paths), 'staged_paths must be an array');
  assert.ok(
    Array.isArray(gate_payload.transitive_dependents_outside_scope),
    'transitive_dependents_outside_scope must be an array',
  );
  assert.equal(typeof gate_payload.radius_depth, 'number', 'radius_depth must be a number');
  assert.equal(gate_payload.radius_depth, 2);
});
