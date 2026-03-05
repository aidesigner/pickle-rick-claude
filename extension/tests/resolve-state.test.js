import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveStateFile, loadActiveState, approve } from '../hooks/resolve-state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-state-'));
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 0,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveStateFile
// ---------------------------------------------------------------------------

test('resolveStateFile: returns env PICKLE_STATE_FILE when set and file exists', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, '{}');
    const orig = process.env.PICKLE_STATE_FILE;
    process.env.PICKLE_STATE_FILE = stateFile;
    try {
      const result = resolveStateFile(tmp);
      assert.equal(result, stateFile);
    } finally {
      if (orig === undefined) delete process.env.PICKLE_STATE_FILE;
      else process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when env points to non-existent file', () => {
  const tmp = tmpDir();
  try {
    const orig = process.env.PICKLE_STATE_FILE;
    process.env.PICKLE_STATE_FILE = path.join(tmp, 'nope.json');
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig === undefined) delete process.env.PICKLE_STATE_FILE;
      else process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: falls back to sessions map when env not set', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'session1');
    fs.mkdirSync(sessionDir);
    const stateFile = path.join(sessionDir, 'state.json');
    fs.writeFileSync(stateFile, '{}');
    const map = { [process.cwd()]: sessionDir };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));

    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      const result = resolveStateFile(tmp);
      assert.equal(result, stateFile);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when sessions map is missing', () => {
  const tmp = tmpDir();
  try {
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when sessions map is corrupt JSON', () => {
  const tmp = tmpDir();
  try {
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), '{{{bad');
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when cwd not in sessions map', () => {
  const tmp = tmpDir();
  try {
    const map = { '/some/other/dir': path.join(tmp, 'session1') };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('resolveStateFile: returns null when session dir from map has no state.json', () => {
  const tmp = tmpDir();
  try {
    const sessionDir = path.join(tmp, 'session-empty');
    fs.mkdirSync(sessionDir);
    const map = { [process.cwd()]: sessionDir };
    fs.writeFileSync(path.join(tmp, 'current_sessions.json'), JSON.stringify(map));
    const orig = process.env.PICKLE_STATE_FILE;
    delete process.env.PICKLE_STATE_FILE;
    try {
      assert.equal(resolveStateFile(tmp), null);
    } finally {
      if (orig !== undefined) process.env.PICKLE_STATE_FILE = orig;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadActiveState
// ---------------------------------------------------------------------------

test('loadActiveState: returns state when active and working_dir matches cwd', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: process.cwd() });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
    assert.equal(result.active, true);
    assert.equal(result.step, 'prd');
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns state when working_dir is empty (matches any cwd)', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: '' });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns state when working_dir is null (matches any cwd)', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: null });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = loadActiveState(stateFile);
    assert.ok(result);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when working_dir does not match cwd', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ working_dir: '/some/other/project' });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when session is inactive', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    const state = baseState({ active: false });
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when state.json is corrupt', () => {
  const tmp = tmpDir();
  try {
    const stateFile = path.join(tmp, 'state.json');
    fs.writeFileSync(stateFile, '!!!not json!!!');
    assert.equal(loadActiveState(stateFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true });
  }
});

test('loadActiveState: returns null when file does not exist', () => {
  assert.equal(loadActiveState('/tmp/nonexistent-state-xyz.json'), null);
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

test('approve: outputs JSON with decision "approve" to stdout', () => {
  const origLog = console.log;
  let output = '';
  console.log = (msg) => { output = msg; };
  try {
    approve();
    const parsed = JSON.parse(output);
    assert.equal(parsed.decision, 'approve');
  } finally {
    console.log = origLog;
  }
});

test('approve: never outputs "allow"', () => {
  const origLog = console.log;
  let output = '';
  console.log = (msg) => { output = msg; };
  try {
    approve();
    assert.ok(!output.includes('allow'), 'approve() must not contain "allow"');
  } finally {
    console.log = origLog;
  }
});
