// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveScope } from '../services/scope-resolver.js';

function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.invalid',
    },
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stderr}`);
  }
  return (res.stdout || '').trim();
}

function makeSession(repoRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-branch-base-session-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repoRoot,
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
    session_dir: dir,
  }, null, 2));
  return dir;
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

function initOriginCloneRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-branch-base-fixture-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const clone = path.join(root, 'clone');

  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '--bare', '--initial-branch=main', origin], root);
  git(['init', '-q', '-b', 'main'], seed);
  git(['config', 'commit.gpgsign', 'false'], seed);
  fs.writeFileSync(path.join(seed, 'seed.txt'), 'seed\n');
  git(['add', '.'], seed);
  git(['commit', '-qm', 'initial'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-qu', 'origin', 'main'], seed);
  git(['clone', '-q', origin, clone], root);
  git(['config', 'commit.gpgsign', 'false'], clone);

  return { root, origin, seed, clone };
}

function createSelfTrackingFeatureFixture(commitCount = 110) {
  const fixture = initOriginCloneRepo();
  const { clone } = fixture;
  git(['checkout', '-qb', 'feature'], clone);
  for (let i = 0; i < commitCount; i += 1) {
    fs.writeFileSync(path.join(clone, `feature-${i}.txt`), `feature ${i}\n`);
    git(['add', '.'], clone);
    git(['commit', '-qm', `feature ${i}`], clone);
  }
  git(['push', '-qu', 'origin', 'feature'], clone);
  git(['branch', '-D', 'main'], clone);
  return fixture;
}

function createSiblingUpstreamFixture() {
  const fixture = initOriginCloneRepo();
  const { clone } = fixture;
  git(['checkout', '-qb', 'feature-base'], clone);
  fs.writeFileSync(path.join(clone, 'feature-base.txt'), 'base\n');
  git(['add', '.'], clone);
  git(['commit', '-qm', 'feature base'], clone);
  git(['push', '-qu', 'origin', 'feature-base'], clone);

  git(['checkout', '-qb', 'feature-child'], clone);
  fs.writeFileSync(path.join(clone, 'feature-child.txt'), 'child\n');
  git(['add', '.'], clone);
  git(['commit', '-qm', 'feature child'], clone);
  git(['branch', '--set-upstream-to=origin/feature-base', 'feature-child'], clone);
  return fixture;
}

function createMainTrackingFixture() {
  const fixture = initOriginCloneRepo();
  const { clone } = fixture;
  git(['checkout', '-qb', 'feature'], clone);
  fs.writeFileSync(path.join(clone, 'feature.txt'), 'feature\n');
  git(['add', '.'], clone);
  git(['commit', '-qm', 'feature'], clone);
  git(['branch', '--set-upstream-to=origin/main', 'feature'], clone);
  return fixture;
}

test('resolveScope falls back to origin/main when branch tracks origin/<current-branch>', () => {
  const fixture = createSelfTrackingFeatureFixture();
  const session = makeSession(fixture.clone);
  try {
    const scope = resolveScope({
      repoRoot: fixture.clone,
      sessionRoot: session,
      scopeFlag: 'branch',
    });

    assert.equal(scope.base_ref, 'origin/main');
    assert.ok(scope.allowed_paths.length >= 100);
    assert.equal(scope.allowed_paths[0], 'feature-0.txt');
    assert.equal(scope.allowed_paths.at(-1), 'feature-99.txt');
  } finally {
    cleanup(session, fixture.root);
  }
});

test('resolveScope preserves sibling upstream refs for stacked branches', () => {
  const fixture = createSiblingUpstreamFixture();
  const session = makeSession(fixture.clone);
  try {
    const scope = resolveScope({
      repoRoot: fixture.clone,
      sessionRoot: session,
      scopeFlag: 'branch',
    });

    assert.equal(scope.base_ref, 'origin/feature-base');
    assert.deepStrictEqual(scope.allowed_paths, ['feature-child.txt']);
  } finally {
    cleanup(session, fixture.root);
  }
});

test('resolveScope preserves origin/main tracking when upstream already points at main', () => {
  const fixture = createMainTrackingFixture();
  const session = makeSession(fixture.clone);
  try {
    const scope = resolveScope({
      repoRoot: fixture.clone,
      sessionRoot: session,
      scopeFlag: 'branch',
    });

    assert.equal(scope.base_ref, 'origin/main');
    assert.deepStrictEqual(scope.allowed_paths, ['feature.txt']);
  } finally {
    cleanup(session, fixture.root);
  }
});

test('--scope-base override still wins over the default branch base', () => {
  const fixture = createSelfTrackingFeatureFixture();
  const session = makeSession(fixture.clone);
  try {
    const scope = resolveScope({
      repoRoot: fixture.clone,
      sessionRoot: session,
      scopeFlag: 'branch',
      scopeBase: 'HEAD~1',
    });

    assert.equal(scope.base_ref, 'HEAD~1');
    assert.deepStrictEqual(scope.allowed_paths, ['feature-109.txt']);
  } finally {
    cleanup(session, fixture.root);
  }
});
