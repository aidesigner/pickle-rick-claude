// @tier: fast
//
// W5a (ticket 6e81cd21) — regression lock for p1-strip-excessive-defense-deploy-reversion.
//
// The ~480 LOC of speculative deploy-reversion hardening (cron sampler, finalize-bundle,
// verify-launch, mux-runner SHA-256 drift detection + deploy_drift_detected event) was already
// stripped. The ONE load-bearing AC — `bin/release-gate.sh --pre-tag` version parity — remains and
// prevents the v1.66.0-class reversion (tag whose extension/package.json version != the tag). This
// suite proves the load-bearing fix survives the strip AND that the speculative surface stays gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_GATE = path.join(REPO_ROOT, 'bin', 'release-gate.sh');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function writePackage(repoDir, version) {
  const extensionDir = path.join(repoDir, 'extension');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
}

// A git fixture: tagged commit carries `tagVersion`; HEAD carries `headVersion`.
function makeGitFixture({ headVersion, tagVersion, tagName }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-reversion-'));
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['config', 'user.email', 'dr@example.com'], { cwd: dir });
  run('git', ['config', 'user.name', 'DR'], { cwd: dir });
  writePackage(dir, tagVersion);
  run('git', ['add', 'extension/package.json'], { cwd: dir });
  run('git', ['commit', '-q', '-m', 'tag version'], { cwd: dir });
  run('git', ['tag', tagName], { cwd: dir });
  if (headVersion !== tagVersion) {
    writePackage(dir, headVersion);
    run('git', ['add', 'extension/package.json'], { cwd: dir });
    run('git', ['commit', '-q', '-m', 'head version'], { cwd: dir });
  }
  return dir;
}

// --- Test A: the load-bearing fix PASSES when versions are consistent.
test('load-bearing: release-gate --pre-tag exits 0 when tag/package versions agree', () => {
  const dir = makeGitFixture({ headVersion: '1.68.0', tagVersion: '1.68.0', tagName: 'v1.68.0' });
  try {
    const result = run('bash', [RELEASE_GATE, '--pre-tag', 'v1.68.0'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /version 1\.68\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Test B: the load-bearing fix CATCHES the v1.66.0 reversion class (tag pkg version != tag name).
test('load-bearing: release-gate --pre-tag rejects a tag whose package.json version is reverted', () => {
  // Tagged commit ships 1.64.0 code while the tag claims v1.66.0 — the exact reversion the
  // load-bearing AC prevents. The strip MUST NOT have removed this guard.
  const dir = makeGitFixture({ headVersion: '1.66.0', tagVersion: '1.64.0', tagName: 'v1.66.0' });
  try {
    const result = run('bash', [RELEASE_GATE, '--pre-tag', 'v1.66.0'], { cwd: dir });
    assert.equal(result.status, 10, `expected exit 10, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /1\.64\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Test C: the speculative hardening surface stays gone after the strip.
test('speculative deploy-reversion files are absent on disk', () => {
  for (const rel of ['bin/verify-deploy-parity.js', 'bin/finalize-bundle.js', 'bin/verify-launch.js']) {
    assert.ok(!existsSync(path.join(REPO_ROOT, rel)), `${rel} must not exist after strip`);
  }
});

test('install.sh contains no cron sampler and no deploy-baseline.json write', () => {
  const installSh = readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
  assert.ok(!installSh.includes('crontab'), 'install.sh must not install a cron sampler');
  assert.ok(!installSh.includes('deploy-baseline.json'), 'install.sh must not write a deploy baseline');
});

test('mux-runner.ts has no deploy_drift_detected emission; types omit the event', () => {
  const muxSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'src', 'bin', 'mux-runner.ts'), 'utf8');
  assert.ok(!muxSrc.includes('deploy_drift_detected'), 'mux-runner must not emit deploy_drift_detected');
  const typesSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'src', 'types', 'index.ts'), 'utf8');
  assert.ok(
    !typesSrc.includes('deploy_drift_detected'),
    'VALID_ACTIVITY_EVENTS must not contain deploy_drift_detected',
  );
});

// --- Test D: the load-bearing release-gate.sh script itself survives on disk.
test('load-bearing release-gate.sh is present', () => {
  assert.ok(existsSync(RELEASE_GATE), 'bin/release-gate.sh (the actual fix) must exist');
});
