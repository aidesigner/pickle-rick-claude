// @tier: fast
//
// R-WSRC-1: Schema-version ceiling at write sites. A worker subprocess that
// constructs a forward-schema state and calls update()/forceWrite() must be
// refused BEFORE any disk write so the running runtime cannot wedge on a
// state.json it can't parse (R-QGSK-3 incident class).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  StateManager,
  SchemaVersionAheadError,
} from '../services/state-manager.js';
import {
  LATEST_SCHEMA_VERSION,
  StateError,
  VALID_ACTIVITY_EVENTS,
} from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';

function tmpDir(prefix = 'sm-ceiling-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test prompt',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: LATEST_SCHEMA_VERSION,
    ...overrides,
  };
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter(entry => entry.endsWith('.jsonl'))
    .flatMap(entry => fs.readFileSync(path.join(activityDir, entry), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)));
}

function withDataRoot(fn) {
  const dataRoot = tmpDir('sm-ceiling-data-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC-1 / AC-7: update() refuses worker-style forward-schema write
// ---------------------------------------------------------------------------

test('StateManager.update: refuses schema_version > LATEST_SCHEMA_VERSION before disk write', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      // Seed with a fully-normalized state at LATEST so read() migration does
      // not rewrite the file — isolates the test to the ceiling-guard refusal.
      writeStateFile(sp, makeState());
      // Prime the migration write by reading once. After this, on-disk bytes
      // reflect the normalized snapshot at LATEST schema_version.
      sm.read(sp);
      const beforeBytes = fs.readFileSync(sp, 'utf-8');

      assert.throws(
        () => sm.update(sp, (s) => { s.schema_version = LATEST_SCHEMA_VERSION + 1; }),
        (err) => {
          assert.ok(err instanceof SchemaVersionAheadError, 'expected SchemaVersionAheadError');
          assert.ok(err instanceof StateError, 'must extend StateError');
          assert.equal(err.code, 'SCHEMA_MISMATCH');
          assert.equal(err.writtenValue, LATEST_SCHEMA_VERSION + 1);
          assert.equal(err.maxSupported, LATEST_SCHEMA_VERSION);
          assert.equal(err.statePath, sp);
          assert.equal(err.callerPid, process.pid);
          return true;
        },
      );

      // AC-7: state.json on disk unchanged after the throw
      const afterBytes = fs.readFileSync(sp, 'utf-8');
      assert.equal(afterBytes, beforeBytes, 'state.json must not be modified by refused write');
      const onDisk = JSON.parse(afterBytes);
      assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: forceWrite() refuses forward-schema write before tmp-rename
// ---------------------------------------------------------------------------

test('StateManager.forceWrite: refuses schema_version > LATEST_SCHEMA_VERSION before disk write', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState());
      const beforeBytes = fs.readFileSync(sp, 'utf-8');

      assert.throws(
        () => sm.forceWrite(sp, makeState({ schema_version: LATEST_SCHEMA_VERSION + 1 })),
        (err) => {
          assert.ok(err instanceof SchemaVersionAheadError, 'expected SchemaVersionAheadError');
          assert.equal(err.writtenValue, LATEST_SCHEMA_VERSION + 1);
          assert.equal(err.maxSupported, LATEST_SCHEMA_VERSION);
          assert.equal(err.statePath, sp);
          return true;
        },
      );

      // state.json on disk unchanged after the throw
      const afterBytes = fs.readFileSync(sp, 'utf-8');
      assert.equal(afterBytes, beforeBytes, 'state.json must not be modified by refused write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: activity event emitted with correct payload shape (both paths)
// ---------------------------------------------------------------------------

test('StateManager.update: emits state_write_schema_version_violation activity event with required payload', () => {
  withDataRoot((dataRoot) => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState());

      try {
        sm.update(sp, (s) => { s.schema_version = LATEST_SCHEMA_VERSION + 2; });
        assert.fail('expected SchemaVersionAheadError');
      } catch (err) {
        assert.ok(err instanceof SchemaVersionAheadError);
      }

      const events = readActivityEvents(dataRoot).filter(e => e.event === 'state_write_schema_version_violation');
      assert.equal(events.length, 1, 'exactly one violation event expected from update()');
      const ev = events[0];
      assert.equal(ev.event, 'state_write_schema_version_violation');
      assert.ok(typeof ev.ts === 'string' && ev.ts.length > 0);
      assert.ok(ev.gate_payload, 'event must carry gate_payload');
      assert.equal(ev.gate_payload.written_value, LATEST_SCHEMA_VERSION + 2);
      assert.equal(ev.gate_payload.max_supported, LATEST_SCHEMA_VERSION);
      assert.equal(ev.gate_payload.statePath, sp);
      assert.equal(ev.gate_payload.caller_pid, process.pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('StateManager.forceWrite: emits state_write_schema_version_violation activity event with required payload', () => {
  withDataRoot((dataRoot) => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState());

      try {
        sm.forceWrite(sp, makeState({ schema_version: LATEST_SCHEMA_VERSION + 5 }));
        assert.fail('expected SchemaVersionAheadError');
      } catch (err) {
        assert.ok(err instanceof SchemaVersionAheadError);
      }

      const events = readActivityEvents(dataRoot).filter(e => e.event === 'state_write_schema_version_violation');
      assert.equal(events.length, 1, 'exactly one violation event expected from forceWrite()');
      const ev = events[0];
      assert.equal(ev.gate_payload.written_value, LATEST_SCHEMA_VERSION + 5);
      assert.equal(ev.gate_payload.max_supported, LATEST_SCHEMA_VERSION);
      assert.equal(ev.gate_payload.statePath, sp);
      assert.equal(ev.gate_payload.caller_pid, process.pid);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-4: event registered in VALID_ACTIVITY_EVENTS
// ---------------------------------------------------------------------------

test('VALID_ACTIVITY_EVENTS includes state_write_schema_version_violation', () => {
  assert.ok(
    VALID_ACTIVITY_EVENTS.includes('state_write_schema_version_violation'),
    'state_write_schema_version_violation must be registered in VALID_ACTIVITY_EVENTS',
  );
});

// ---------------------------------------------------------------------------
// AC-5: SchemaVersionAheadError extends StateError, exported
// ---------------------------------------------------------------------------

test('SchemaVersionAheadError extends StateError and is exported', () => {
  const err = new SchemaVersionAheadError('/tmp/state.json', LATEST_SCHEMA_VERSION + 1, LATEST_SCHEMA_VERSION);
  assert.ok(err instanceof StateError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'SchemaVersionAheadError');
  assert.equal(err.code, 'SCHEMA_MISMATCH');
});

// ---------------------------------------------------------------------------
// AC-6: _internalSchemaBump exemption respected
// ---------------------------------------------------------------------------

test('StateManager.update: _internalSchemaBump=true bypasses the schema ceiling guard', () => {
  withDataRoot((dataRoot) => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState());

      // With the exemption flag, an explicit forward-schema mutation is
      // allowed through. (This is the path reserved for legitimate
      // migrateSchema use only — workers must never set this flag.)
      sm.update(
        sp,
        (s) => { s.schema_version = LATEST_SCHEMA_VERSION + 1; },
        { _internalSchemaBump: true },
      );

      const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION + 1);

      // No violation event emitted for an exempted write.
      const events = readActivityEvents(dataRoot).filter(e => e.event === 'state_write_schema_version_violation');
      assert.equal(events.length, 0, 'exemption must not emit violation event');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('StateManager.forceWrite: _internalSchemaBump=true bypasses the schema ceiling guard', () => {
  withDataRoot((dataRoot) => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');

      sm.forceWrite(
        sp,
        makeState({ schema_version: LATEST_SCHEMA_VERSION + 1 }),
        { _internalSchemaBump: true },
      );

      const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION + 1);

      const events = readActivityEvents(dataRoot).filter(e => e.event === 'state_write_schema_version_violation');
      assert.equal(events.length, 0, 'exemption must not emit violation event');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Equal-to-LATEST is allowed (boundary test — only `>` triggers the guard)
// ---------------------------------------------------------------------------

test('StateManager.update: schema_version === LATEST_SCHEMA_VERSION passes the guard', () => {
  withDataRoot(() => {
    const dir = tmpDir();
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState());

      // No-op mutation (preserve schema_version at LATEST) must succeed.
      const result = sm.update(sp, (s) => { s.iteration = 42; });
      assert.equal(result.iteration, 42);
      assert.equal(result.schema_version, LATEST_SCHEMA_VERSION);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
