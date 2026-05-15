// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function makeTmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeRepo() {
  const dir = makeTmpRoot('pickle-prcr-repo-');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function bootstrapPausedSession(dataRoot, workingDir) {
  // Use --paused so setup creates the session without launching mux-runner.
  // Run from workingDir so the new session records the right working_dir.
  const out = execFileSync(process.execPath, [SETUP, '--paused', '--task', 'test'], {
    cwd: workingDir,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
  const match = out.match(/SESSION_ROOT=(.+)/);
  if (!match) throw new Error(`SESSION_ROOT not found in setup output:\n${out}`);
  return match[1].trim();
}

function runResumeAndCaptureCwd(sessionRoot, dataRoot, fromDir) {
  // Run setup --resume from `fromDir` and capture process.cwd() reported
  // by a tiny inline node script via stdout. We pipe `--task ""` so the
  // resume parses fine; --paused keeps it from launching a runner.
  return spawnSync(process.execPath, [SETUP, '--resume', sessionRoot, '--paused', '--task', ''], {
    cwd: fromDir,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
}

function readActivityEvents(dataRoot) {
  const dir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(dir)) return [];
  const events = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return events;
}

test('setup-resume-cross-cwd (R-PRCR-1.a/b): chdirs into stored working_dir + emits setup_resume_chdir_applied', () => {
  const dataRoot = makeTmpRoot('pickle-prcr-data-');
  const repoDir = makeRepo();
  const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);

  const elsewhere = makeTmpRoot('pickle-prcr-elsewhere-');
  const result = runResumeAndCaptureCwd(sessionRoot, dataRoot, elsewhere);
  assert.strictEqual(result.status, 0, `resume failed: ${result.stderr || result.stdout}`);

  // Verify state.json's working_dir is preserved (chdir didn't corrupt it).
  const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'state.json'), 'utf-8'));
  assert.strictEqual(state.working_dir, repoDir, 'state.working_dir matches the original repo');

  // Verify the chdir event was emitted with correct from/to.
  const events = readActivityEvents(dataRoot);
  const chdirEvent = events.find((e) => e.event === 'setup_resume_chdir_applied');
  assert.ok(chdirEvent, `expected setup_resume_chdir_applied event; got: ${events.map((e) => e.event).join(', ')}`);
  assert.strictEqual(chdirEvent.gate_payload.from, elsewhere, 'event from = launch cwd');
  assert.strictEqual(chdirEvent.gate_payload.to, repoDir, 'event to = stored working_dir');

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('setup-resume-cross-cwd (R-PRCR-1.c): dies cleanly when stored working_dir no longer exists', () => {
  const dataRoot = makeTmpRoot('pickle-prcr-data-');
  const repoDir = makeRepo();
  const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);

  // Remove the original working_dir so resume must fail
  fs.rmSync(repoDir, { recursive: true, force: true });

  const elsewhere = makeTmpRoot('pickle-prcr-elsewhere-');
  const result = runResumeAndCaptureCwd(sessionRoot, dataRoot, elsewhere);
  assert.notStrictEqual(result.status, 0, `expected non-zero exit when working_dir missing`);
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.match(
    combined,
    /no longer exists or is not a directory/,
    `expected clearer-message about missing working_dir, got: ${combined}`,
  );

  // No chdir event should be recorded
  const events = readActivityEvents(dataRoot);
  assert.ok(
    !events.find((e) => e.event === 'setup_resume_chdir_applied'),
    'no chdir event emitted on missing working_dir',
  );

  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('setup-resume-cross-cwd (R-PRCR-1.d): same-cwd resume is a no-op (no chdir event)', () => {
  const dataRoot = makeTmpRoot('pickle-prcr-data-');
  const repoDir = makeRepo();
  const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);

  // Resume from the SAME working_dir as bootstrap
  const result = runResumeAndCaptureCwd(sessionRoot, dataRoot, repoDir);
  assert.strictEqual(result.status, 0, `same-cwd resume should succeed: ${result.stderr || result.stdout}`);

  const events = readActivityEvents(dataRoot);
  assert.ok(
    !events.find((e) => e.event === 'setup_resume_chdir_applied'),
    'no chdir event emitted when cwd already matches',
  );

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
