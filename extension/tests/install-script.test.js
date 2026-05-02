import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

/**
 * Build a minimal install.sh fixture that runs only the F3 schemaVersion
 * parity check from the real install.sh. SCRIPT_DIR is wired to the supplied
 * tmp dir so we can pin source/compiled schemaVersion values per case.
 */
function buildFixtureScript(scriptDir) {
  return `#!/bin/bash
set -e
SCRIPT_DIR="${scriptDir}"
SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
if [ -z "$SOURCE_VERSION" ] || [ -z "$COMPILED_VERSION" ]; then
  echo "❌ Could not extract schemaVersion from source or compiled types/index. Refusing to deploy." >&2
  exit 1
fi
if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
  echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) does not match source TS ($SOURCE_VERSION)." >&2
  echo "   Likely cause: stale tsc build cache. Try: rm extension/types/index.js && bash install.sh" >&2
  exit 1
fi
echo "ok"
`;
}

function makeFixture({ sourceVersion, compiledVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-script-test-'));
  const srcTypes = path.join(dir, 'extension', 'src', 'types');
  const outTypes = path.join(dir, 'extension', 'types');
  mkdirSync(srcTypes, { recursive: true });
  mkdirSync(outTypes, { recursive: true });
  if (sourceVersion !== null) {
    writeFileSync(
      path.join(srcTypes, 'index.ts'),
      `export const STATE_MANAGER_DEFAULTS = {\n  schemaVersion: ${sourceVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(srcTypes, 'index.ts'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  if (compiledVersion !== null) {
    writeFileSync(
      path.join(outTypes, 'index.js'),
      `export const STATE_MANAGER_DEFAULTS = {\n    schemaVersion: ${compiledVersion},\n};\n`,
    );
  } else {
    writeFileSync(path.join(outTypes, 'index.js'), 'export const STATE_MANAGER_DEFAULTS = {};\n');
  }
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildFixtureScript(dir), { mode: 0o755 });
  return { dir, scriptPath };
}

function buildVersionGuardFixtureScript(scriptDir) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"

ALLOW_DOWNGRADE=0
for arg in "$@"; do
  case "$arg" in
    --allow-downgrade) ALLOW_DOWNGRADE=1 ;;
  esac
done

compare_semver() {
  local a="$1"
  local b="$2"
  if [[ ! "$a" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || [[ ! "$b" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    echo "invalid semver comparison: '$a' vs '$b'" >&2
    exit 1
  fi
  local a_major a_minor a_patch b_major b_minor b_patch
  IFS=. read -r a_major a_minor a_patch <<< "$a"
  IFS=. read -r b_major b_minor b_patch <<< "$b"
  if (( 10#$a_major < 10#$b_major )); then echo -1; return; fi
  if (( 10#$a_major > 10#$b_major )); then echo 1; return; fi
  if (( 10#$a_minor < 10#$b_minor )); then echo -1; return; fi
  if (( 10#$a_minor > 10#$b_minor )); then echo 1; return; fi
  if (( 10#$a_patch < 10#$b_patch )); then echo -1; return; fi
  if (( 10#$a_patch > 10#$b_patch )); then echo 1; return; fi
  echo 0
}

read_package_version() {
  local package_json="$1"
  local version
  version="$(jq -r '.version' "$package_json")"
  if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "Could not read version from $package_json" >&2
    exit 1
  fi
  echo "$version"
}

SRC_V="$(read_package_version "$SCRIPT_DIR/extension/package.json")"
DEPLOYED_PACKAGE_JSON="$EXTENSION_ROOT/extension/package.json"
if [ -f "$DEPLOYED_PACKAGE_JSON" ]; then
  DEP_V="$(read_package_version "$DEPLOYED_PACKAGE_JSON")"
  if [ "$(compare_semver "$SRC_V" "$DEP_V")" -lt 0 ] && [ "$ALLOW_DOWNGRADE" -ne 1 ]; then
    echo "REFUSE: source v$SRC_V older than deployed v$DEP_V" >&2
    exit 1
  fi
fi

if [ -d "$SCRIPT_DIR/.git" ]; then
  INSTALL_MODE="git"
else
  INSTALL_MODE="tarball"
fi
echo "mode=$INSTALL_MODE"
`;
}

function makeVersionGuardFixture({ sourceVersion, deployedVersion, gitMode }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-version-guard-'));
  const homeDir = path.join(dir, 'home');
  const sourceExtension = path.join(dir, 'extension');
  const deployedExtension = path.join(homeDir, '.claude', 'pickle-rick', 'extension');
  mkdirSync(sourceExtension, { recursive: true });
  mkdirSync(deployedExtension, { recursive: true });
  if (gitMode) {
    mkdirSync(path.join(dir, '.git'));
  }
  writeFileSync(path.join(sourceExtension, 'package.json'), JSON.stringify({ version: sourceVersion }));
  writeFileSync(path.join(deployedExtension, 'package.json'), JSON.stringify({ version: deployedVersion }));
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildVersionGuardFixtureScript(dir), { mode: 0o755 });
  return { dir, homeDir, scriptPath };
}

function runVersionGuardFixture(fixture, args = []) {
  return spawnSync('bash', [fixture.scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
}

function buildWorktreeGuardFixtureScript() {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

check_worktree_head_fresh() {
  local inside_work_tree wt_top WT_HEAD
  inside_work_tree="$(git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)"
  [ "$inside_work_tree" = "true" ] || return 0

  wt_top="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  case "$wt_top" in
    */.claude/worktrees/agent-*) ;;
    *) return 0 ;;
  esac

  WT_HEAD="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"
  if ! git -C "$SCRIPT_DIR" merge-base --is-ancestor origin/main HEAD; then
    echo "REFUSE: worktree HEAD $WT_HEAD predates main; pull main first" >&2
    exit 1
  fi
}

check_worktree_head_fresh
echo "ok"
`;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(' ')} failed in ${cwd}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function writeWorktreeGuardScript(dir) {
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildWorktreeGuardFixtureScript(), { mode: 0o755 });
  return scriptPath;
}

function makeWorktreeGuardFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-worktree-guard-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['checkout', '-b', 'main']);
  runGit(repo, ['config', 'user.email', 'pickle-rick@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Pickle Rick Tests']);

  writeFileSync(path.join(repo, 'tracked.txt'), 'old\n');
  runGit(repo, ['add', 'tracked.txt']);
  runGit(repo, ['commit', '-m', 'old']);
  const oldHead = runGit(repo, ['rev-parse', 'HEAD']);

  writeFileSync(path.join(repo, 'tracked.txt'), 'current\n');
  runGit(repo, ['add', 'tracked.txt']);
  runGit(repo, ['commit', '-m', 'current']);
  const currentHead = runGit(repo, ['rev-parse', 'HEAD']);
  runGit(repo, ['update-ref', 'refs/remotes/origin/main', currentHead]);

  const worktreesDir = path.join(repo, '.claude', 'worktrees');
  const staleWorktree = path.join(worktreesDir, 'agent-stale');
  const currentWorktree = path.join(worktreesDir, 'agent-current');
  runGit(repo, ['worktree', 'add', '--detach', staleWorktree, oldHead]);
  runGit(repo, ['worktree', 'add', '--detach', currentWorktree, currentHead]);

  return {
    dir,
    repo,
    staleScript: writeWorktreeGuardScript(staleWorktree),
    currentScript: writeWorktreeGuardScript(currentWorktree),
    mainScript: writeWorktreeGuardScript(repo),
  };
}

function runWorktreeGuardScript(scriptPath) {
  return spawnSync('bash', [scriptPath], { encoding: 'utf8' });
}

function buildCacheHygieneFixtureScript(scriptDir) {
  return `#!/bin/bash
set -euo pipefail
SCRIPT_DIR="${scriptDir}"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"

read_package_version() {
  local package_json="$1"
  local version
  version="$(jq -r '.version' "$package_json")"
  if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "Could not read version from $package_json" >&2
    exit 1
  fi
  echo "$version"
}

mkdir -p "$EXTENSION_ROOT/extension"
rsync -a --delete "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"

DEPLOYED_V="$(read_package_version "$EXTENSION_ROOT/extension/package.json")"
UPDATE_CACHE_FILE="$EXTENSION_ROOT/update-check.json"
if [ -f "$UPDATE_CACHE_FILE" ]; then
  CACHE_CURRENT_VERSION="$(jq -r '.current_version // ""' "$UPDATE_CACHE_FILE" 2>/dev/null || echo "")"
  if [ "$CACHE_CURRENT_VERSION" = "1.0.0" ] || [ "$CACHE_CURRENT_VERSION" != "$DEPLOYED_V" ]; then
    rm -f "$UPDATE_CACHE_FILE"
    echo "[install.sh] Removed stale update cache: cached current_version=\${CACHE_CURRENT_VERSION:-<missing>} deployed=$DEPLOYED_V" >&2
  fi
fi
`;
}

function makeCacheHygieneFixture({ sourceVersion, cacheVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'install-cache-hygiene-'));
  const homeDir = path.join(dir, 'home');
  const sourceExtension = path.join(dir, 'extension');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  mkdirSync(sourceExtension, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(path.join(sourceExtension, 'package.json'), JSON.stringify({ version: sourceVersion }));
  writeFileSync(path.join(runtimeRoot, 'update-check.json'), JSON.stringify({
    last_check_epoch: 1,
    latest_version: cacheVersion,
    current_version: cacheVersion,
  }));
  const scriptPath = path.join(dir, 'install.sh');
  writeFileSync(scriptPath, buildCacheHygieneFixtureScript(dir), { mode: 0o755 });
  return {
    dir,
    homeDir,
    scriptPath,
    cachePath: path.join(runtimeRoot, 'update-check.json'),
  };
}

function runCacheHygieneFixture(fixture) {
  return spawnSync('bash', [fixture.scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fixture.homeDir },
  });
}

describe('install.sh worktree freshness guard', () => {
  test('install-script.worktree-stale refuses stale agent worktree', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.staleScript);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: worktree HEAD [0-9a-f]+ predates main; pull main first/);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.worktree-current permits current agent worktree', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.currentScript);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.worktree-main permits normal main checkout', () => {
    const fixture = makeWorktreeGuardFixture();
    try {
      const result = runWorktreeGuardScript(fixture.mainScript);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh update cache hygiene', () => {
  test('install-script.cache-hygiene removes mismatched update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.65.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.match(result.stderr, /Removed stale update cache/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.cache-hygiene removes sentinel update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.0.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.match(result.stderr, /current_version=1[.]0[.]0/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.cache-hygiene keeps matching update cache', () => {
    const fixture = makeCacheHygieneFixture({ sourceVersion: '1.68.0', cacheVersion: '1.68.0' });
    try {
      const result = runCacheHygieneFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), true);
      assert.equal(JSON.parse(readFileSync(fixture.cachePath, 'utf8')).current_version, '1.68.0');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

describe('install.sh source-vs-deployed package version guard', () => {
  test('install-script.refuses-source-older git mode', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: true,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: source v1[.]62[.]0 older than deployed v1[.]67[.]0/);
      assert.doesNotMatch(result.stdout, /mode=/, 'guard must run before INSTALL_MODE branch side effects');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.refuses-source-older tarball mode', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 1, `expected exit 1, got ${result.status}`);
      assert.match(result.stderr, /REFUSE: source v1[.]62[.]0 older than deployed v1[.]67[.]0/);
      assert.doesNotMatch(result.stdout, /mode=/, 'guard must run before INSTALL_MODE branch side effects');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script.allow-downgrade permits older source', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.62.0',
      deployedVersion: '1.67.0',
      gitMode: false,
    });
    try {
      const result = runVersionGuardFixture(fixture, ['--allow-downgrade']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /mode=tarball/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('install-script permits same source and deployed version', () => {
    const fixture = makeVersionGuardFixture({
      sourceVersion: '1.67.0',
      deployedVersion: '1.67.0',
      gitMode: true,
    });
    try {
      const result = runVersionGuardFixture(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /mode=git/);
      assert.equal(result.stderr, '');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains unconditional source-vs-deployed guard before mode detection', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const guardIdx = src.indexOf('REFUSE: source v$SRC_V older than deployed v$DEP_V');
    const modeIdx = src.indexOf('# --- MODE DETECTION ---');
    assert.match(src, /set -euo pipefail/, 'install.sh must use strict shell options');
    assert.ok(guardIdx !== -1, 'install.sh must contain source-vs-deployed refusal');
    assert.ok(modeIdx !== -1, 'install.sh must contain mode detection marker');
    assert.ok(guardIdx < modeIdx, 'source-vs-deployed guard must run before INSTALL_MODE detection');
  });
});

describe('install.sh schemaVersion parity check (F3)', () => {
  test('install.sh aborts if compiled JS schemaVersion differs from source TS', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 2 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
      assert.match(
        result.stderr,
        /schemaVersion/,
        `expected stderr to mention schemaVersion, got: ${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /\(2\).*\(3\)/s,
        `expected stderr to surface mismatched versions, got: ${result.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh passes when source and compiled schemaVersion match', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: 3, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, /ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('install.sh aborts when schemaVersion is missing from either file', () => {
    const { dir, scriptPath } = makeFixture({ sourceVersion: null, compiledVersion: 3 });
    try {
      const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Could not extract schemaVersion/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real install.sh contains the F3 schemaVersion parity check', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(src, /SOURCE_VERSION=.*schemaVersion/, 'install.sh must extract SOURCE_VERSION from src TS');
    assert.match(src, /COMPILED_VERSION=.*schemaVersion/, 'install.sh must extract COMPILED_VERSION from compiled JS');
    assert.match(src, /Compiled JS schemaVersion .* does not match source TS/);
  });

  test('real source TS and compiled JS schemaVersion currently agree', () => {
    const tsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'src', 'types', 'index.ts'), 'utf8');
    const jsSrc = readFileSync(path.join(REPO_ROOT, 'extension', 'types', 'index.js'), 'utf8');
    const tsMatch = tsSrc.match(/schemaVersion:\s*(\d+)/);
    const jsMatch = jsSrc.match(/schemaVersion:\s*(\d+)/);
    assert.ok(tsMatch, 'source TS must declare schemaVersion');
    assert.ok(jsMatch, 'compiled JS must declare schemaVersion');
    assert.strictEqual(
      tsMatch[1],
      jsMatch[1],
      `source TS schemaVersion ${tsMatch[1]} must match compiled JS schemaVersion ${jsMatch[1]} — run bash install.sh to recompile`,
    );
  });
});

describe('install.sh Forward Fix F2: lock serialization', () => {
  test('install.sh contains the lock block', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(
      src.includes('LOCKFILE="$EXTENSION_ROOT/.install.lock"'),
      'install.sh must declare a lockfile under $EXTENSION_ROOT',
    );
    assert.ok(
      src.includes('flock -x'),
      'install.sh must attempt an exclusive flock when flock(1) is available',
    );
    assert.ok(
      src.includes('mkdir "$LOCKDIR"'),
      'install.sh must include a mkdir-based lock fallback for systems without flock',
    );
  });

  test('install.sh has a --dry-run guard after the lock', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const lockIdx = src.indexOf('LOCKFILE="$EXTENSION_ROOT/.install.lock"');
    const dryRunIdx = src.indexOf('--dry-run');
    assert.ok(lockIdx !== -1, 'lock block missing');
    assert.ok(dryRunIdx !== -1, 'install.sh must accept --dry-run');
    assert.ok(
      dryRunIdx > lockIdx,
      '--dry-run guard must follow lock acquisition so the dry-run path still exercises serialization',
    );
  });

  test('two simultaneous invocations serialize on the lock', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'install-lock-'));
    try {
      const extRoot = path.join(dir, 'pickle-rick');
      const fixture = path.join(dir, 'install.sh');

      // Minimal fixture replicating install.sh's lock block + a 2s critical
      // section. Each child prints a millisecond timestamp the moment it
      // acquires the lock; we assert the two timestamps are at least ~2s apart.
      writeFileSync(
        fixture,
        `#!/bin/bash
set -e
EXTENSION_ROOT="${extRoot}"
mkdir -p "$EXTENSION_ROOT"
LOCKFILE="$EXTENSION_ROOT/.install.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -x -n 9; then
    flock -x 9
  fi
else
  LOCKDIR="$EXTENSION_ROOT/.install.lock.d"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    sleep 0.1
  done
  trap 'rmdir "$LOCKDIR"' EXIT
fi
node -e "process.stdout.write(String(Date.now()))"
echo
sleep 2
`,
      );
      chmodSync(fixture, 0o755);

      function runChild() {
        return new Promise((resolve, reject) => {
          let out = '';
          const c = spawn('bash', [fixture], { stdio: ['ignore', 'pipe', 'pipe'] });
          c.stdout.on('data', (d) => {
            out += d.toString();
          });
          c.on('error', reject);
          c.on('close', (code) => {
            if (code !== 0) return reject(new Error(`child exited ${code}; stdout=${out}`));
            const firstLine = out.trim().split('\n')[0];
            resolve(Number(firstLine));
          });
        });
      }

      const [tA, tB] = await Promise.all([runChild(), runChild()]);
      assert.ok(Number.isFinite(tA) && Number.isFinite(tB), `bad timestamps: ${tA}, ${tB}`);
      const delta = Math.abs(tA - tB);
      // Critical section is sleep 2 (≈2000ms). Allow 200ms scheduling slack.
      assert.ok(
        delta >= 1800,
        `expected ≥1800ms between lock acquisitions (serialized), got ${delta}ms`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
