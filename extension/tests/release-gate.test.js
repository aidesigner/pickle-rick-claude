// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
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
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function writePackage(repoDir, version) {
  const extensionDir = path.join(repoDir, 'extension');
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
}

function makeGitFixture({
  headVersion = '1.67.0',
  tagVersion = '1.67.0',
  tagName = `v${tagVersion}`,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-repo-'));
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['config', 'user.email', 'release-gate@example.com'], { cwd: dir });
  run('git', ['config', 'user.name', 'Release Gate'], { cwd: dir });
  writePackage(dir, tagVersion);
  run('git', ['add', 'extension/package.json'], { cwd: dir });
  run('git', ['commit', '-q', '-m', 'tag version'], { cwd: dir });
  run('git', ['tag', tagName], { cwd: dir });
  if (headVersion !== tagVersion) {
    writePackage(dir, headVersion);
    run('git', ['add', 'extension/package.json'], { cwd: dir });
    run('git', ['commit', '-q', '-m', 'head version'], { cwd: dir });
  }
  return { dir, tagName };
}

function makeTarball(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-tar-'));
  const root = path.join(dir, 'pickle-rick-claude');
  writePackage(root, version);
  const tarball = path.join(dir, 'release.tar.gz');
  run('tar', ['-czf', tarball, '-C', dir, 'pickle-rick-claude']);
  return { dir, tarball };
}

function makeGhFixture({ mode = 'ok', tarball }) {
  const binDir = mkdtempSync(path.join(tmpdir(), 'release-gate-bin-'));
  const ghPath = path.join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -u
mode="${mode}"
if [ "$1" = "api" ]; then
  if [ "$mode" = "api-fail" ]; then exit 1; fi
  echo '{"tag_name":"v-test"}'
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  if [ "$mode" = "download-fail" ]; then exit 1; fi
  dest=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-D" ]; then
      shift
      dest="$1"
      break
    fi
    shift
  done
  cp ${JSON.stringify(tarball ?? '/no/such/file')} "$dest/release.tar.gz"
  exit $?
fi
exit 1
`,
    { mode: 0o755 },
  );
  return binDir;
}

function gate(args, { cwd, pathPrefix } = {}) {
  return run('bash', [RELEASE_GATE, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH,
    },
  });
}

describe('release-gate.pre-tag', () => {
  test('passes when tag package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('passes from a nested repo directory when tag package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', tagName], { cwd: path.join(repoDir, 'extension') });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 10 when tag package version is older than HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.64.0' });
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 10);
      assert.match(result.stderr, /exit 10/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 10 when tag name semver does not match HEAD package version', () => {
    const { dir: repoDir } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0', tagName: 'v9.99.0' });
    try {
      const result = gate(['--pre-tag', 'v9.99.0'], { cwd: repoDir });
      assert.equal(result.status, 10);
      assert.match(result.stderr, /match extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 11 when jq cannot parse package JSON', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    writeFileSync(path.join(repoDir, 'extension', 'package.json'), '{broken\n');
    try {
      const result = gate(['--pre-tag', tagName], { cwd: repoDir });
      assert.equal(result.status, 11);
      assert.match(result.stderr, /exit 11/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('exits 12 when the requested tag is missing', () => {
    const { dir: repoDir } = makeGitFixture();
    try {
      const result = gate(['--pre-tag', 'v-missing'], { cwd: repoDir });
      assert.equal(result.status, 12);
      assert.match(result.stderr, /exit 12/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('release-gate.post-tag', () => {
  test('passes when downloaded tarball package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('passes from a nested repo directory when downloaded tarball package version matches HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], {
        cwd: path.join(repoDir, 'extension'),
        pathPrefix: ghDir,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 20 when release asset download fails', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const ghDir = makeGhFixture({ mode: 'download-fail' });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 20);
      assert.match(result.stderr, /exit 20/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when downloaded tarball package version is older than HEAD package version', () => {
    const { dir: repoDir, tagName } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0' });
    const tarFixture = makeTarball('1.64.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /exit 21/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 21 when tag name semver does not match HEAD package version', () => {
    const { dir: repoDir } = makeGitFixture({ headVersion: '1.67.0', tagVersion: '1.67.0', tagName: 'v9.99.0' });
    const tarFixture = makeTarball('1.67.0');
    const ghDir = makeGhFixture({ tarball: tarFixture.tarball });
    try {
      const result = gate(['--post-tag', 'v9.99.0'], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 21);
      assert.match(result.stderr, /match extension\/package\.json version 1\.67\.0/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(tarFixture.dir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });

  test('exits 22 when the GitHub release API check fails', () => {
    const { dir: repoDir, tagName } = makeGitFixture();
    const ghDir = makeGhFixture({ mode: 'api-fail' });
    try {
      const result = gate(['--post-tag', tagName], { cwd: repoDir, pathPrefix: ghDir });
      assert.equal(result.status, 22);
      assert.match(result.stderr, /exit 22/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(ghDir, { recursive: true, force: true });
    }
  });
});
