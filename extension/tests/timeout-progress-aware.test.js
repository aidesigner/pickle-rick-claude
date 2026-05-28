// @tier: integration
//
// R-WTB-A1 integration tests: artifact-progress-aware timeout wiring.
//
// Tests the detector with real git repos and verifies the `progressed` flag
// logic that gates whether the mux-runner timeout counter is reset or the halt
// fires. Also verifies the two new activity events are schema-registered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');

import {
  detectArtifactProgress,
  resolveNoProgressWindowSeconds,
  NO_PROGRESS_WINDOW_ENV,
  NO_PROGRESS_WINDOW_DEFAULT_S,
} from '../services/artifact-progress-detector.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tpa-test-')));
}

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function gitCommit(dir, file, msg) {
  const fullPath = path.join(dir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `content ${Date.now()}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-m', msg, '--quiet'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

// --- Activity event registration ---

test('R-WTB-A1 ticket_timeout_progress_extension registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(VALID_ACTIVITY_EVENTS.includes('ticket_timeout_progress_extension'),
    'ticket_timeout_progress_extension must be in VALID_ACTIVITY_EVENTS');
});

test('R-WTB-A1 ticket_timeout_halted_no_progress registered in VALID_ACTIVITY_EVENTS', () => {
  assert.ok(VALID_ACTIVITY_EVENTS.includes('ticket_timeout_halted_no_progress'),
    'ticket_timeout_halted_no_progress must be in VALID_ACTIVITY_EVENTS');
});

// --- Schema R-PDD-oneOf invariant ---

test('R-WTB-A1 schema R-PDD-oneOf: no definition missing from oneOf', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  const refs = new Set(schema.oneOf.map(o => o.$ref.replace('#/definitions/', '')));
  const SHARED = new Set(['backendEnum', 'backendResolutionSourceEnum', 'workerBackendResolutionSourceEnum']);
  const missing = Object.keys(schema.definitions).filter(k => !SHARED.has(k) && !refs.has(k));
  assert.deepEqual(missing, [], `Definitions without oneOf entry: ${missing.join(', ')}`);
});

test('R-WTB-A1 schema has ticket_timeout_progress_extension definition', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  assert.ok('ticket_timeout_progress_extension' in schema.definitions);
  const def = schema.definitions.ticket_timeout_progress_extension;
  assert.deepEqual(def.required.sort(), ['event', 'gate_payload', 'ts'].sort());
});

test('R-WTB-A1 schema has ticket_timeout_halted_no_progress definition', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  assert.ok('ticket_timeout_halted_no_progress' in schema.definitions);
  const def = schema.definitions.ticket_timeout_halted_no_progress;
  assert.deepEqual(def.required.sort(), ['event', 'gate_payload', 'ts'].sort());
});

// --- Integration: no halt while artifacts mutate ---

test('R-WTB-A1 no halt while artifacts mutate: detectArtifactProgress returns progressed=true when mtime advances', () => {
  const root = makeTmpDir();
  try {
    const repoDir = root;
    initGit(repoDir);
    const ticketDir = path.join(repoDir, 'abc123');
    fs.mkdirSync(ticketDir);

    // Start with empty snapshot
    const snapshot = { latestMtimeEpoch: 0, latestCommitSha: null };

    // Worker writes a research file (simulates progress)
    fs.writeFileSync(path.join(ticketDir, 'research_2026-05-28.md'), '# Research\n');

    const result = detectArtifactProgress(ticketDir, snapshot, {
      workingDir: repoDir,
      windowSeconds: resolveNoProgressWindowSeconds({}),
    });

    // mtime advanced → progressed = true → timer should reset, no halt
    assert.equal(result.progressed, true, 'mtime advance should produce progressed=true (prevents halt)');
    assert.ok(result.latestMtimeEpoch > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-WTB-A1 no halt while commits land: detectArtifactProgress returns progressed=true on new commit SHA', () => {
  const root = makeTmpDir();
  try {
    const repoDir = root;
    initGit(repoDir);
    const ticketDir = path.join(repoDir, 'abc123');
    fs.mkdirSync(ticketDir);

    // Prior snapshot from before the commit
    const snapshot = { latestMtimeEpoch: 0, latestCommitSha: 'deadbeef0000' };

    // Worker commits work (simulates progress)
    const newSha = gitCommit(repoDir, 'extension/src/foo.ts', 'feat(abc123): implement');

    const result = detectArtifactProgress(ticketDir, snapshot, {
      workingDir: repoDir,
      windowSeconds: 3600,
    });

    // New commit SHA → progressed = true → timer should reset, no halt
    assert.equal(result.progressed, true, 'new commit should produce progressed=true (prevents halt)');
    assert.ok(result.latestCommitSha !== null);
    assert.notEqual(result.latestCommitSha, 'deadbeef0000');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Integration: halt when no progress for configured window ---

test('R-WTB-A1 halt when no progress: detectArtifactProgress returns progressed=false when nothing changed', () => {
  const root = makeTmpDir();
  try {
    const repoDir = root;
    initGit(repoDir);
    const ticketDir = path.join(repoDir, 'abc123');
    fs.mkdirSync(ticketDir);

    // Write a file and record snapshot NOW — including current HEAD SHA
    fs.writeFileSync(path.join(ticketDir, 'research_2026-05-28.md'), '# Research\n');
    const mtime = Math.floor(fs.statSync(path.join(ticketDir, 'research_2026-05-28.md')).mtimeMs / 1000);
    const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim().slice(0, 7);
    // Snapshot records current mtime AND current SHA → nothing is "new"
    const snapshot = { latestMtimeEpoch: mtime, latestCommitSha: currentSha };

    // Call with wide window — mtime is same, sha is same → not progressed
    const result = detectArtifactProgress(ticketDir, snapshot, {
      workingDir: repoDir,
      windowSeconds: 3600,
    });

    // mtime unchanged, sha unchanged → not progressed → halt should fire
    assert.equal(result.progressed, false, 'no progress should produce progressed=false (allows halt)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Integration: env override applies in detector ---

test('R-WTB-A1 env override PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS is honored', () => {
  assert.equal(
    resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '900' }),
    900,
    'env override 900 should be respected'
  );
  assert.equal(
    resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: 'invalid' }),
    NO_PROGRESS_WINDOW_DEFAULT_S,
    'invalid env should fall back to default'
  );
});

// --- Integration: scope.json path filter ---

test('R-WTB-A1 scope.json allowed_paths used for git log filter when present', () => {
  const root = makeTmpDir();
  try {
    const repoDir = root;
    initGit(repoDir);
    const ticketDir = path.join(repoDir, 'abc123');
    fs.mkdirSync(ticketDir);

    // Commit IN scope
    const inScopeSha = gitCommit(repoDir, 'src/foo.ts', 'feat: in-scope commit');

    // Write scope.json pointing at src/
    const scopeJsonPath = path.join(repoDir, 'scope.json');
    fs.writeFileSync(scopeJsonPath, JSON.stringify({ allowed_paths: ['src/'] }));

    const snapshot = { latestMtimeEpoch: 0, latestCommitSha: 'aaabbbccc' };
    const result = detectArtifactProgress(ticketDir, snapshot, {
      workingDir: repoDir,
      scopeJsonPath,
      windowSeconds: 3600,
    });

    assert.equal(result.progressed, true, 'commit in scope should trigger progressed=true');
    assert.ok(result.latestCommitSha !== null);
    assert.ok(inScopeSha.startsWith(result.latestCommitSha));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
