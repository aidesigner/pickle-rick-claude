import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECK_UPDATE = path.resolve(__dirname, '../bin/check-update.js');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'downgrade-flow-test-')));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function makeReleaseTarball(root, version) {
  const contentRoot = path.join(root, `release-${version}`);
  const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
  fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
  writeJson(path.join(packageRoot, 'extension', 'package.json'), { version });
  fs.writeFileSync(
    path.join(packageRoot, 'install.sh'),
    '#!/bin/sh\nprintf installed > "$EXTENSION_DIR/install-marker.txt"\n',
    { mode: 0o755 },
  );
  const tarball = path.join(root, `release-${version}.tar.gz`);
  execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'pickle-rick-claude']);
  return tarball;
}

function mockGh(root, tarball) {
  const binDir = path.join(root, 'mock-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-D" ]; then
    shift
    dest="$1"
  fi
  shift
done
mkdir -p "$dest"
cp ${JSON.stringify(tarball)} "$dest/pickle-release.tar.gz"
`,
    { mode: 0o755 },
  );
  return binDir;
}

function readAudit(homeDir) {
  const auditPath = path.join(homeDir, '.claude', 'pickle-rick', 'deploy-audit.log');
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('downgrade flow', () => {
  let root;
  let extensionDir;
  let dataRoot;
  let homeDir;
  let binDir;

  beforeEach(() => {
    root = makeTmpDir();
    extensionDir = path.join(root, 'extension-root');
    dataRoot = path.join(root, 'data-root');
    homeDir = path.join(root, 'home');
    fs.mkdirSync(path.join(extensionDir, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(extensionDir, 'extension', 'bin', 'log-watcher.js'), '');
    writeJson(path.join(extensionDir, 'extension', 'package.json'), { version: '1.67.0' });
    binDir = mockGh(root, makeReleaseTarball(root, '1.64.0'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runUpgrade(options, input = '') {
    const script = `
      import { performUpgrade } from ${JSON.stringify(pathToFileURL(CHECK_UPDATE).href)};
      const result = performUpgrade('1.67.0', '1.66.0', 'v1.66.0', ${JSON.stringify(options)});
      console.log(JSON.stringify(result));
      if (!result.success) process.exit(result.exitCode ?? 1);
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf-8',
      input,
      env: {
        ...process.env,
        EXTENSION_DIR: extensionDir,
        PICKLE_DATA_ROOT: dataRoot,
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
  }

  test('downgrade.confirm-yes succeeds and writes audit entry with mode 0600', () => {
    const result = runUpgrade({ allowDowngrade: true }, 'y\n');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Downgrade 1\.67\.0 → 1\.64\.0 — proceed\? \[y\/N\]/);
    assert.equal(fs.readFileSync(path.join(extensionDir, 'install-marker.txt'), 'utf-8'), 'installed');
    const entries = readAudit(homeDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'DOWNGRADE');
    assert.equal(entries[0].src_version, '1.64.0');
    assert.equal(entries[0].dep_version, '1.67.0');
    const auditPath = path.join(homeDir, '.claude', 'pickle-rick', 'deploy-audit.log');
    assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
  });

  test('downgrade.confirm-no exits cleanly without audit entry', () => {
    const result = runUpgrade({ allowDowngrade: true }, 'n\n');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Downgrade 1\.67\.0 → 1\.64\.0 — proceed\? \[y\/N\]/);
    assert.equal(fs.existsSync(path.join(extensionDir, 'install-marker.txt')), false);
    assert.deepEqual(readAudit(homeDir), []);
    assert.equal(JSON.parse(result.stdout).aborted, true);
  });

  test('downgrade.active-session-refused exits 2 without override', () => {
    writeJson(path.join(dataRoot, 'sessions', 'active-abc123', 'state.json'), {
      active: true,
      session_id: 'active-abc123',
    });

    const result = runUpgrade({ allowDowngrade: true, noConfirm: true });

    assert.equal(result.status, 2, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.success, false);
    assert.equal(body.exitCode, 2);
    assert.match(result.stderr, /REFUSE: active session active-abc123 — kill the pipeline first or pass --override-active/);
    assert.equal(fs.existsSync(path.join(extensionDir, 'install-marker.txt')), false);
  });

  test('downgrade.override succeeds with active session and audit override_active true', () => {
    writeJson(path.join(dataRoot, 'sessions', 'active-abc123', 'state.json'), {
      active: true,
      session_id: 'active-abc123',
    });

    const result = runUpgrade({ allowDowngrade: true, overrideActive: true, noConfirm: true });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).success, true);
    const [entry] = readAudit(homeDir);
    assert.equal(entry.override_active, true);
    assert.equal(entry.session_id, 'active-abc123');
  });

  test('downgrade.no-confirm skips prompt and succeeds', () => {
    const result = runUpgrade({ allowDowngrade: true, noConfirm: true });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /proceed\? \[y\/N\]/);
    assert.equal(JSON.parse(result.stdout).success, true);
    const [entry] = readAudit(homeDir);
    assert.equal(entry.no_confirm, true);
  });

  test('downgrade.closer-context bypasses active-session refusal and audits flag', () => {
    writeJson(path.join(dataRoot, 'sessions', 'active-abc123', 'state.json'), {
      active: true,
      session_id: 'active-abc123',
    });

    const result = runUpgrade({ allowDowngrade: true, closerContext: true, noConfirm: true });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).success, true);
    const [entry] = readAudit(homeDir);
    assert.equal(entry.closer_context, true);
    assert.equal(entry.session_id, 'active-abc123');
  });

  test('downgrade.unknown-flag rejects unknown CLI flags', () => {
    const result = spawnSync(process.execPath, [CHECK_UPDATE, '--bogus'], {
      encoding: 'utf-8',
      env: { ...process.env, EXTENSION_DIR: extensionDir, HOME: homeDir },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown flag: --bogus/);
  });
});
