// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../../hooks/handlers/config-protection.js');

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: 'test-ticket-01',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

function bootstrapSession({ flags } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-git-'));
  writeExtensionSentinel(tmpDir);
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  const state = baseState({ session_dir: sessionDir });
  if (flags) state.flags = flags;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(
    path.join(tmpDir, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: sessionDir }),
  );
  return { tmpDir, sessionDir, stateFile, dataRoot: tmpDir };
}

function runHandler({ tmpDir, stateFile, toolName, toolInput, extraEnv = {} }) {
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
    ...extraEnv,
  };
  const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input,
    encoding: 'utf-8',
    env,
  });
  return JSON.parse(stdout.trim());
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const file of fs.readdirSync(activityDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const content = fs.readFileSync(path.join(activityDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Block cases — worker context (PICKLE_ROLE=worker)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: worker blocks git reset --hard HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
  assert.match(result.reason, /reset/);
});

test('R-WSRC-GR: worker blocks git reset (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset HEAD file.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /R-WSRC-GR/);
});

test('R-WSRC-GR: worker blocks git reset --soft HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --soft HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git checkout feature-branch (ref)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout feature-branch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /checkout/);
});

test('R-WSRC-GR: worker blocks git checkout -b new-branch (ref after flag)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout -b new-branch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git checkout HEAD~1 (ref)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git switch main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git switch main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /switch/);
});

test('R-WSRC-GR: worker blocks git stash (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /stash/);
});

test('R-WSRC-GR: worker blocks git stash push', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash push' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git stash pop', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git stash pop' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git rebase main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git rebase main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /rebase/);
});

test('R-WSRC-GR: worker blocks git commit --amend', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit --amend -m 'fix: update message'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /commit --amend/);
});

test('R-WSRC-GR: worker blocks git commit --amend --no-edit', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit --amend --no-edit' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git pull origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git pull origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /pull/);
});

test('R-WSRC-GR: worker blocks git push origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /push/);
});

test('R-WSRC-GR: worker blocks git push (bare)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: worker blocks git fetch --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /fetch --prune/);
});

test('R-WSRC-GR: worker blocks git fetch origin --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch origin --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// Allowed variants — worker context (PICKLE_ROLE=worker)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: worker approves git add <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git add src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git commit -m without --amend', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: "git commit -m 'feat: add new thing'" },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git restore <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git restore src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git restore --source HEAD~1 --staged --worktree <path>', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git restore --source HEAD~1 --staged --worktree src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git fetch without --prune', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git fetch origin (no --prune)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch origin' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git checkout -- src/foo.ts (path-mode)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout -- src/foo.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git checkout . (whole-tree restore)', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git checkout .' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git log --oneline', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git log --oneline' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git status', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git status' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: worker approves git diff', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git diff' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Manager context (PICKLE_ROLE not set) — NOT blocked
// ---------------------------------------------------------------------------

test('R-WSRC-GR: manager context approves git reset --hard HEAD~1', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  // Manager: PICKLE_ROLE is deleted from env (not set to 'worker')
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_ROLE;
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input, encoding: 'utf-8', env,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: manager context approves git push origin main', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const env = {
    ...process.env,
    EXTENSION_DIR: tmpDir,
    PICKLE_DATA_ROOT: tmpDir,
    PICKLE_STATE_FILE: stateFile,
    FORCE_COLOR: '0',
  };
  delete env.PICKLE_ROLE;
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  const stdout = execFileSync(process.execPath, [HANDLER], {
    input, encoding: 'utf-8', env,
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Operator override path (AC-WSRC-GR-05)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: allow_git_reset_reason bypasses git reset block and emits worker_git_reset_bypass', () => {
  const { tmpDir, stateFile, dataRoot } = bootstrapSession({
    flags: { allow_git_reset_reason: 'schema migration' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');

  const events = readActivityEvents(dataRoot).filter((e) => e.event === 'worker_git_reset_bypass');
  assert.equal(events.length, 1, 'expected exactly one worker_git_reset_bypass event');
  assert.equal(events[0].gate_payload.reason, 'schema migration');
  assert.equal(typeof events[0].gate_payload.command, 'string');
});

test('R-WSRC-GR: empty allow_git_reset_reason does NOT bypass', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_reset_reason: '   ' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git reset --hard HEAD~1' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'block');
});

test('R-WSRC-GR: allow_git_push_reason bypasses git push block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_push_reason: 'emergency hotfix deploy' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git push origin main' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: allow_git_commit_amend_reason bypasses git commit --amend block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_commit_amend_reason: 'fix author' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git commit --amend --no-edit' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

test('R-WSRC-GR: allow_git_fetch_prune_reason bypasses git fetch --prune block', () => {
  const { tmpDir, stateFile } = bootstrapSession({
    flags: { allow_git_fetch_prune_reason: 'cleanup stale refs' },
  });
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Bash',
    toolInput: { command: 'git fetch --prune' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Non-Bash tools — always approve (not affected by git boundary rules)
// ---------------------------------------------------------------------------

test('R-WSRC-GR: Write tool with git-like path is not affected', () => {
  const { tmpDir, stateFile } = bootstrapSession();
  const result = runHandler({
    tmpDir, stateFile,
    toolName: 'Write',
    toolInput: { file_path: '/project/src/reset.ts' },
    extraEnv: { PICKLE_ROLE: 'worker' },
  });
  assert.equal(result.decision, 'approve');
});
