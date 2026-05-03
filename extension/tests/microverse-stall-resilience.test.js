// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  _deps,
  appendGapAnalysisFixedBlock,
  buildMicroverseHandoff,
  classifyNoCommitExit,
  handleNoCommitStall,
  resetGapAnalysisForAmnesiacBreaker,
} from '../bin/microverse-runner.js';
import { createMicroverseState } from '../services/microverse-state.js';

const TEST_METRIC = {
  description: 'quality score',
  validation: 'printf "1\\n"',
  type: 'command',
  timeout_seconds: 5,
  tolerance: 0,
};

function tmpDir(prefix = 'pickle-mrs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(dir, args) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo() {
  const dir = tmpDir('pickle-mrs-repo-');
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'baseline\n');
  git(dir, ['add', 'file.txt']);
  git(dir, ['commit', '-m', 'baseline']);
  const baseline = git(dir, ['rev-parse', 'HEAD']);
  return { dir, baseline };
}

function commitFile(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeResultLog(dir, name, result) {
  const logPath = path.join(dir, name);
  fs.writeFileSync(logPath, `${JSON.stringify({ type: 'assistant', message: 'working' })}\n${JSON.stringify({
    type: 'result',
    ...result,
  })}\n`);
  return logPath;
}

test('buildMicroverseHandoff includes Recent Changes with at most five commits since baseline', () => {
  const { dir, baseline } = initRepo();
  try {
    for (let i = 1; i <= 6; i++) {
      commitFile(dir, `file${i}.txt`, `change ${i}\n`, `change ${i}`);
    }
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.baseline_score = 1;
    state.convergence.history.push({
      iteration: 1,
      metric_value: '2',
      score: 2,
      action: 'accept',
      description: 'improved',
      pre_iteration_sha: baseline,
      timestamp: new Date().toISOString(),
    });

    const handoff = buildMicroverseHandoff(state, 2, dir, tmpDir('pickle-mrs-session-'));
    assert.match(handoff, /## Recent Changes/);
    assert.match(handoff, /change 6/);
    assert.match(handoff, /change 2/);
    assert.doesNotMatch(handoff, /change 1/);
    const recentSection = handoff.split('## Recent Changes')[1].split('## PRD:')[0];
    const commitLines = recentSection.split('\n').filter((line) => /^[0-9a-f]{7,}\s/.test(line));
    assert.ok(commitLines.length <= 5, `expected at most 5 commits, got ${commitLines.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns amnesiac for fewer than five turns', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', { num_turns: 3, result: 'I stopped early.' });
    assert.equal(classifyNoCommitExit(logPath), 'amnesiac');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns clean_pass for no violations output', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', { num_turns: 8, result: 'No violations remain.' });
    assert.equal(classifyNoCommitExit(logPath), 'clean_pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyNoCommitExit returns stall for many turns without clean signal', () => {
  const dir = tmpDir();
  try {
    const logPath = writeResultLog(dir, 'iter.log', { num_turns: 8, result: 'Tried several changes but could not finish.' });
    assert.equal(classifyNoCommitExit(logPath), 'stall');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendGapAnalysisFixedBlock appends commit SHA, message, and files', () => {
  const { dir } = initRepo();
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    const sha = commitFile(dir, 'fixed.txt', 'fixed\n', 'fix important gap');
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    fs.writeFileSync(gapPath, '# Gap Analysis\n\n- gap A\n');

    appendGapAnalysisFixedBlock({
      gapAnalysisPath: gapPath,
      workingDir: dir,
      iteration: 4,
      commitSha: sha,
    });

    const content = fs.readFileSync(gapPath, 'utf-8');
    assert.match(content, /## Iteration 4 — Fixed/);
    assert.match(content, new RegExp(`- Commit: ${sha.slice(0, 12)} fix important gap`));
    assert.match(content, /- Files: fixed\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('resetGapAnalysisForAmnesiacBreaker sets gap_analysis status and resets file', () => {
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    fs.writeFileSync(gapPath, '# Gap Analysis\n\nstale item\n');
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';
    state.gap_analysis_path = gapPath;
    state.consecutive_amnesiac_exits = 2;

    const next = resetGapAnalysisForAmnesiacBreaker(state, sessionDir);

    assert.equal(next.status, 'gap_analysis');
    assert.equal(next.consecutive_amnesiac_exits, 0);
    const content = fs.readFileSync(gapPath, 'utf-8');
    assert.match(content, /Reset after 2 consecutive amnesiac/);
    assert.doesNotMatch(content, /stale item/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('handleNoCommitStall forces gap analysis rerun after second consecutive amnesiac exit', async () => {
  const sessionDir = tmpDir('pickle-mrs-session-');
  const originalSleep = _deps.sleep;
  _deps.sleep = async () => {};
  try {
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_2.log', { num_turns: 3, result: 'short exit' });
    fs.writeFileSync(gapPath, '# Gap Analysis\n\nstale item\n');
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';
    state.gap_analysis_path = gapPath;
    state.consecutive_amnesiac_exits = 1;

    const result = await handleNoCommitStall(state, {
      sessionDir,
      log: () => {},
    }, logPath);

    assert.equal(result, null);
    assert.equal(state.status, 'gap_analysis');
    assert.equal(state.consecutive_amnesiac_exits, 0);
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8')).status, 'gap_analysis');
    assert.doesNotMatch(fs.readFileSync(gapPath, 'utf-8'), /stale item/);
  } finally {
    _deps.sleep = originalSleep;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('handleNoCommitStall clean pass converges without clearing state object', async () => {
  const sessionDir = tmpDir('pickle-mrs-session-');
  try {
    const logPath = writeResultLog(sessionDir, 'tmux_iteration_3.log', { num_turns: 8, result: 'No violations remain.' });
    const state = createMicroverseState({ prdPath: '/tmp/prd.md', metric: TEST_METRIC, stallLimit: 3 });
    state.status = 'iterating';

    const result = await handleNoCommitStall(state, {
      sessionDir,
      log: () => {},
    }, logPath);

    assert.equal(result, 'converged');
    assert.equal(state.status, 'iterating');
    assert.equal(state.prd_path, '/tmp/prd.md');
    assert.equal(state.convergence.stall_counter, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8')).prd_path, '/tmp/prd.md');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
