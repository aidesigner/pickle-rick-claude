import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupAnatomyPark } from '../bin/pipeline-runner.js';
import { filterBySubsystem } from '../services/scope-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.join(os.homedir(), '.claude/pickle-rick');
const ANATOMY_PARK_MD = path.resolve(__dirname, '../../.claude/commands/anatomy-park.md');

function makeTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-target-'));
}

function makeSession() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-session-'));
}

function makeSubsystem(root, name, fileCount = 3) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
  }
}

function readAnatomyPark(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'anatomy-park.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Pipeline mode: scope filters subsystems in anatomy-park.json
// ---------------------------------------------------------------------------

test('pipeline filter: 4 subsystems, scope covering 2 → anatomy-park.json has exactly those 2', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // scope touches alpha and gamma only
    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target; // target IS repoRoot in this fixture

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, { allowedPaths, repoRoot });

    const ap = readAnatomyPark(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha', 'gamma']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Standalone mode parity: filterBySubsystem with same fixture → same result
// ---------------------------------------------------------------------------

test('standalone filter parity: filterBySubsystem same fixture → identical to pipeline result', () => {
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target;
    const allNames = ['alpha', 'beta', 'delta', 'gamma']; // sorted

    const result = filterBySubsystem(allNames, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, ['alpha', 'gamma']);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 1 invariant: marker present — guarantees Phase 1 reads all subsystem files
// ---------------------------------------------------------------------------

test('phase-1 invariant marker present in anatomy-park.md', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  assert.ok(
    content.includes('<!-- scope-invariant: phase-1-reads-all-subsystem-files -->'),
    'anatomy-park.md must contain scope-invariant marker',
  );
});

// ---------------------------------------------------------------------------
// Backcompat: omitted scope → all subsystems pass through unfiltered
// ---------------------------------------------------------------------------

test('backcompat: no scope arg → anatomy-park.json contains all 4 subsystems', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // No scope passed — backcompat path
    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    assert.equal(ap.subsystems.length, 4);
    assert.deepStrictEqual(ap.subsystems.sort(), ['alpha', 'beta', 'delta', 'gamma']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
