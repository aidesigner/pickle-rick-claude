import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStateFile } from '../hooks/resolve-state.js';

// ---------------------------------------------------------------------------
// writeStateFile
// ---------------------------------------------------------------------------

test('writeStateFile: writes content and reads back correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const state = { active: true, iteration: 5, step: 'prd' };
    writeStateFile(statePath, state);
    const readBack = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(readBack, state);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateFile: no .tmp file left behind after successful write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, { active: true });
    assert.equal(fs.existsSync(statePath + '.tmp'), false, 'tmp file must be cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateFile: output is pretty-printed JSON (contains newlines)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, { active: true, iteration: 0 });
    const raw = fs.readFileSync(statePath, 'utf-8');
    assert.ok(raw.includes('\n'), 'output must be pretty-printed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateFile: overwrites existing state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, iteration: 1 }));
    writeStateFile(statePath, { active: false, iteration: 2 });
    const readBack = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(readBack.active, false);
    assert.equal(readBack.iteration, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateFile: handles nested objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    const state = { active: true, history: [{ step: 'prd', timestamp: '2024-01-01' }] };
    writeStateFile(statePath, state);
    const readBack = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(readBack.history, state.history);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateFile: target file is complete JSON after write (not partial)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
  try {
    const statePath = path.join(dir, 'state.json');
    writeStateFile(statePath, { active: true, step: 'research', iteration: 42 });
    // Must parse without error — partial write would throw
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.iteration, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
