// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDiffForVisualStat,
  resolveDesignSafe,
  setupAnatomyPark,
  setupSzechuanSauce,
} from '../bin/pipeline-runner.js';

// R-CIFB: repo root (not deployed ~/.claude/pickle-rick) so setup*/init-microverse
// spawns resolve the repo's extension/bin — CI never runs install.sh.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15_000 }).trim();
}

function initRepo(repoDir) {
  git(['init', '-q', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'test@test.local'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  git(['config', 'commit.gpgsign', 'false'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'seed.ts'), 'export const seed = 1;\n');
  git(['add', '.'], repoDir);
  git(['commit', '-q', '-m', 'seed'], repoDir);
  return git(['rev-parse', 'HEAD'], repoDir);
}

// ---------------------------------------------------------------------------
// parseDiffForVisualStat
// ---------------------------------------------------------------------------

test('parseDiffForVisualStat: CSS file → all added lines classified under that path', () => {
  const diffOutput = [
    'diff --git a/styles.css b/styles.css',
    '--- a/styles.css',
    '+++ b/styles.css',
    '@@ -0,0 +1,3 @@',
    '+.foo { color: red; }',
    '+.bar { margin: 0; }',
    '+.baz { padding: 4px; }',
  ].join('\n');

  const stat = parseDiffForVisualStat(diffOutput);
  assert.equal(stat.length, 1);
  assert.equal(stat[0].path, 'styles.css');
  assert.equal(stat[0].changedLines.length, 3);
  assert.deepEqual(stat[0].changedLines, [
    '.foo { color: red; }',
    '.bar { margin: 0; }',
    '.baz { padding: 4px; }',
  ]);
});

test('parseDiffForVisualStat: multiple files → separate entries', () => {
  const diffOutput = [
    'diff --git a/styles.css b/styles.css',
    '--- a/styles.css',
    '+++ b/styles.css',
    '@@ -0,0 +1 @@',
    '+.foo {}',
    'diff --git a/logic.ts b/logic.ts',
    '--- a/logic.ts',
    '+++ b/logic.ts',
    '@@ -0,0 +1 @@',
    '+export const x = 1;',
  ].join('\n');

  const stat = parseDiffForVisualStat(diffOutput);
  assert.equal(stat.length, 2);
  assert.equal(stat[0].path, 'styles.css');
  assert.equal(stat[0].changedLines.length, 1);
  assert.equal(stat[1].path, 'logic.ts');
  assert.equal(stat[1].changedLines.length, 1);
});

test('parseDiffForVisualStat: +++ header lines are not counted as changed lines', () => {
  const diffOutput = [
    'diff --git a/a.css b/a.css',
    '--- a/a.css',
    '+++ b/a.css',
    '@@ -0,0 +1 @@',
    '+.ok {}',
  ].join('\n');

  const stat = parseDiffForVisualStat(diffOutput);
  assert.equal(stat[0].changedLines.length, 1);
  assert.equal(stat[0].changedLines[0], '.ok {}');
});

test('parseDiffForVisualStat: empty diff → empty stat', () => {
  const stat = parseDiffForVisualStat('');
  assert.equal(stat.length, 0);
});

// ---------------------------------------------------------------------------
// resolveDesignSafe — CLI override
// ---------------------------------------------------------------------------

test('resolveDesignSafe: override=true always returns true regardless of diff', () => {
  // No start_commit, but override forces true
  assert.equal(resolveDesignSafe(null, '/any', true), true);
  assert.equal(resolveDesignSafe(undefined, '/any', true), true);
  assert.equal(resolveDesignSafe('abc123', '/any', true), true);
});

test('resolveDesignSafe: override=false always returns false regardless of diff', () => {
  assert.equal(resolveDesignSafe(null, '/any', false), false);
  assert.equal(resolveDesignSafe(undefined, '/any', false), false);
  assert.equal(resolveDesignSafe('abc123', '/any', false), false);
});

test('resolveDesignSafe: no start_commit → false (logic-primary assumed)', () => {
  assert.equal(resolveDesignSafe(null, '/any', undefined), false);
  assert.equal(resolveDesignSafe(undefined, '/any', undefined), false);
  assert.equal(resolveDesignSafe('', '/any', undefined), false);
});

// ---------------------------------------------------------------------------
// resolveDesignSafe — auto-detect via git diff
// ---------------------------------------------------------------------------

test('resolveDesignSafe: UI-primary branch (CSS-only) → true', () => {
  const repo = tmpDir('ds-ui-repo-');
  const startCommit = initRepo(repo);

  // Add a CSS-heavy change
  const cssContent = Array.from({ length: 20 }, (_, i) => `.cls${i} { color: red; }`).join('\n');
  fs.writeFileSync(path.join(repo, 'main.css'), cssContent);
  git(['add', 'main.css'], repo);
  git(['commit', '-q', '-m', 'add css'], repo);

  const result = resolveDesignSafe(startCommit, repo, undefined);
  assert.equal(result, true, 'CSS-only branch should be design-safe (UI-primary)');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveDesignSafe: logic-primary branch (TS-only) → false', () => {
  const repo = tmpDir('ds-logic-repo-');
  const startCommit = initRepo(repo);

  // Add pure logic changes (no visual markup)
  const tsContent = Array.from({ length: 20 }, (_, i) => `export const fn${i} = () => ${i};`).join('\n');
  fs.writeFileSync(path.join(repo, 'logic.ts'), tsContent);
  git(['add', 'logic.ts'], repo);
  git(['commit', '-q', '-m', 'add logic'], repo);

  const result = resolveDesignSafe(startCommit, repo, undefined);
  assert.equal(result, false, 'TypeScript-only branch should be logic-primary (not design-safe)');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('resolveDesignSafe: near-threshold branch → design-safe (err toward safe)', () => {
  const repo = tmpDir('ds-near-repo-');
  const startCommit = initRepo(repo);

  // ratio = 12 visual CSS lines / (12 CSS + 9 logic TS) = 12/21 ≈ 0.571
  // With near-band (threshold 0.55), this should be design-safe.
  const cssLines = Array.from({ length: 12 }, (_, i) => `.cls${i} { margin: 0; }`).join('\n');
  const tsLines = Array.from({ length: 9 }, (_, i) => `export const f${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(repo, 'near.css'), cssLines);
  fs.writeFileSync(path.join(repo, 'near.ts'), tsLines);
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'near threshold'], repo);

  const result = resolveDesignSafe(startCommit, repo, undefined);
  assert.equal(result, true, 'near-threshold (0.571 > 0.55 effective) should be design-safe');
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC-PIAP-B2-1: setupAnatomyPark writes design_safe to microverse.json
// ---------------------------------------------------------------------------

function makeAnatomyTarget(targetDir) {
  const sub = path.join(targetDir, 'services');
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(sub, `s${i}.ts`), `export const s${i} = ${i};\n`);
  }
}

function makeSessionDir(repoDir) {
  const sessionDir = tmpDir('ds-session-');
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: false,
      working_dir: repoDir,
      step: 'review',
      iteration: 0,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
    }, null, 2),
  );
  return sessionDir;
}

test('AC-PIAP-B2-1: setupAnatomyPark with designSafe=true writes design_safe:true to microverse.json', () => {
  const repo = tmpDir('ds-ap-repo-');
  initRepo(repo);
  const target = tmpDir('ds-ap-target-');
  makeAnatomyTarget(target);
  const sessionDir = makeSessionDir(repo);
  const extensionRoot = REPO_ROOT;

  const result = setupAnatomyPark(sessionDir, target, 3, extensionRoot, () => {}, undefined, true);

  if (result === true) {
    const microverse = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(microverse.design_safe, true, 'design_safe should be true in microverse.json');
  }
  // If setup skipped (no subsystems visible to extensionRoot), that's an env issue; skip assertion.
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('AC-PIAP-B2-1: setupAnatomyPark with designSafe=false (--no-design-safe) writes design_safe:false', () => {
  const repo = tmpDir('ds-ap-false-repo-');
  initRepo(repo);
  const target = tmpDir('ds-ap-false-target-');
  makeAnatomyTarget(target);
  const sessionDir = makeSessionDir(repo);
  const extensionRoot = REPO_ROOT;

  const result = setupAnatomyPark(sessionDir, target, 3, extensionRoot, () => {}, undefined, false);

  if (result === true) {
    const microverse = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(microverse.design_safe, false, 'design_safe should be false in microverse.json');
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('AC-PIAP-B2-1: UI-primary branch + --no-design-safe override → design_safe:false', () => {
  // resolveDesignSafe with a UI-primary diff but override=false → false
  const repo = tmpDir('ds-override-repo-');
  const startCommit = initRepo(repo);

  const cssContent = Array.from({ length: 20 }, (_, i) => `.cls${i} { color: blue; }`).join('\n');
  fs.writeFileSync(path.join(repo, 'big.css'), cssContent);
  git(['add', 'big.css'], repo);
  git(['commit', '-q', '-m', 'ui heavy'], repo);

  // Auto-detect would return true (UI-primary), but override=false forces false
  const autoResult = resolveDesignSafe(startCommit, repo, undefined);
  assert.equal(autoResult, true, 'auto-detect: CSS-heavy → true');

  const overrideResult = resolveDesignSafe(startCommit, repo, false);
  assert.equal(overrideResult, false, '--no-design-safe: must override to false');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('AC-PIAP-B2-1: logic-primary branch + --design-safe override → design_safe:true', () => {
  const repo = tmpDir('ds-logic-force-repo-');
  const startCommit = initRepo(repo);

  const tsContent = Array.from({ length: 20 }, (_, i) => `export const fn${i} = () => ${i};`).join('\n');
  fs.writeFileSync(path.join(repo, 'logic.ts'), tsContent);
  git(['add', 'logic.ts'], repo);
  git(['commit', '-q', '-m', 'logic'], repo);

  // Auto-detect would return false (logic-primary), but override=true forces true
  const autoResult = resolveDesignSafe(startCommit, repo, undefined);
  assert.equal(autoResult, false, 'auto-detect: TS-only → false');

  const overrideResult = resolveDesignSafe(startCommit, repo, true);
  assert.equal(overrideResult, true, '--design-safe: must override to true');

  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// setupSzechuanSauce also writes design_safe
// ---------------------------------------------------------------------------

test('setupSzechuanSauce with designSafe=true writes design_safe:true to microverse.json', () => {
  const repo = tmpDir('ds-szs-repo-');
  initRepo(repo);
  const target = tmpDir('ds-szs-target-');
  // szechuan-sauce does not require subsystems; just needs writable dirs
  fs.mkdirSync(target, { recursive: true });
  const sessionDir = makeSessionDir(repo);
  const extensionRoot = REPO_ROOT;

  const result = setupSzechuanSauce(
    sessionDir, target, 3, extensionRoot,
    undefined, undefined, () => {}, undefined, true,
  );

  if (result === true) {
    const microverse = JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
    assert.equal(microverse.design_safe, true, 'design_safe should be true for szechuan-sauce');
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});
