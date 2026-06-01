// @tier: fast
//
// Tests for R-PIWG-5.2: advisory launch-time probe wiring in setup.ts.
//
// AC-PIWG-5.2.a: probeConcurrentGitAccess invoked only on fresh-bootstrap path
// AC-PIWG-5.2.b: positive detection → stderr WARNING + concurrent_git_access_detected event
// AC-PIWG-5.2.c: positive detection does NOT throw / does NOT change exit code
// AC-PIWG-5.2.f: --paused and --resume sessions emit NO event even with holder present
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETUP = join(__dirname, '..', 'bin', 'setup.js');
const SETUP_SRC = join(__dirname, '..', 'src', 'bin', 'setup.ts');

// AC-PIWG-5.2.a — static: probeConcurrentGitAccess is imported and invoked in setup.ts
// under a !config.pausedMode guard (not on the resume path, which never calls createSession).
test('AC-PIWG-5.2.a: setup.ts imports and calls probeConcurrentGitAccess', () => {
  const src = readFileSync(SETUP_SRC, 'utf8');
  assert.match(src, /probeConcurrentGitAccess/, 'probeConcurrentGitAccess must be imported in setup.ts');
  // Invoked inside createSession, guarded by !config.pausedMode
  const guardRe = /if\s*\(!config\.pausedMode\)[\s\S]*?probeConcurrentGitAccess/;
  assert.match(src, guardRe, 'probeConcurrentGitAccess must be guarded by !config.pausedMode in createSession');
});

// AC-PIWG-5.2.c static: the probe call is wrapped in try/catch so it never throws.
test('AC-PIWG-5.2.c static: probe wrapped in try/catch so it never blocks launch', () => {
  const src = readFileSync(SETUP_SRC, 'utf8');
  // The try/catch wraps the probe inside the !pausedMode block.
  const tryCatchRe = /if\s*\(!config\.pausedMode\)\s*\{[\s\S]*?try\s*\{[\s\S]*?probeConcurrentGitAccess[\s\S]*?\}\s*catch/;
  assert.match(src, tryCatchRe, 'probeConcurrentGitAccess must be inside a try/catch block to ensure non-blocking advisory behavior');
});

// AC-PIWG-5.2.f static: resume path never calls createSession (structural guard).
test('AC-PIWG-5.2.f static: resumeSession never calls createSession', () => {
  const src = readFileSync(SETUP_SRC, 'utf8');
  // resumeSession function body must not contain createSession call.
  const resumeFnMatch = src.match(/function resumeSession\([\s\S]*?^}/m);
  if (resumeFnMatch) {
    assert.equal(
      resumeFnMatch[0].includes('createSession'),
      false,
      'resumeSession must not call createSession — structural probe short-circuit',
    );
  }
  // main() dispatches: resumeMode ? handleResumeSession : initializeNewSession
  assert.match(src, /resumeMode\s*\?.*handleResumeSession.*:.*initializeNewSession/s,
    'main() must route resume away from initializeNewSession/createSession');
});

// ─── runtime helpers ───────────────────────────────────────────────────────

// Creates a fake bin dir with a `lsof` script that exits 0 and outputs fakePid.
// `pgrep` is made to exit 1 (no matches) so the lsof path is exercised.
function makeFakeLsofBin(fakePid) {
  const binDir = realpathSync(mkdtempSync(join(tmpdir(), 'fake-lsof-bin-')));
  // fake lsof: exits 0 and outputs fakePid
  const lsofPath = join(binDir, 'lsof');
  writeFileSync(lsofPath, `#!/bin/sh\nprintf '%d\\n' ${fakePid}\n`);
  spawnSync('chmod', ['+x', lsofPath]);
  // fake pgrep: exits 1 (no matches) so fallback does not fire
  const pgrepPath = join(binDir, 'pgrep');
  writeFileSync(pgrepPath, '#!/bin/sh\nexit 1\n');
  spawnSync('chmod', ['+x', pgrepPath]);
  return binDir;
}

// Read all activity JSONL lines from dataRoot/activity/ and return parsed events.
function readActivityEvents(dataRoot) {
  const activityDir = join(dataRoot, 'activity');
  if (!existsSync(activityDir)) return [];
  const events = [];
  for (const file of readdirSync(activityDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(activityDir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return events;
}

// Run setup.js as a subprocess in repoRoot with fakeLsofBin prepended to PATH.
// Returns { exitCode, stdout, stderr, dataRoot }.
function runSetupWithFakeLsof(fakeLsofBin, repoRoot, args) {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'piwg52-data-')));
  const result = spawnSync(
    process.execPath,
    [SETUP, '--no-graph', ...args],
    {
      encoding: 'utf-8',
      cwd: repoRoot,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        PICKLE_DATA_ROOT: dataRoot,
        PATH: `${fakeLsofBin}:${process.env.PATH}`,
      },
    },
  );
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', dataRoot };
}

// AC-PIWG-5.2.b + AC-PIWG-5.2.c runtime: positive detection → WARNING stderr + event, setup succeeds.
test('AC-PIWG-5.2.b/c: positive detection emits WARNING + event; setup still completes', () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'piwg52-repo-')));
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  // Create .git/index.lock so lsof has a path to report
  writeFileSync(join(repoRoot, '.git', 'index.lock'), '');

  // Use process.pid as the fake holder — ps -p <pid> will find the current node process.
  const fakeLsofBin = makeFakeLsofBin(process.pid);

  let dataRoot;
  try {
    const result = runSetupWithFakeLsof(fakeLsofBin, repoRoot, ['--tmux', '--task', 'concurrent-probe-test']);
    dataRoot = result.dataRoot;

    // AC-PIWG-5.2.c: setup must complete successfully (exit 0, SESSION_ROOT written)
    assert.equal(result.exitCode, 0, `setup must exit 0 even when holder detected (stderr: ${result.stderr})`);
    assert.match(result.stdout, /SESSION_ROOT=/, 'SESSION_ROOT must appear in stdout');

    // Derive session root from stdout
    const sessionMatch = result.stdout.match(/SESSION_ROOT=(.+)/);
    if (sessionMatch) {
      const sessionRoot = sessionMatch[1].trim();
      const statePath = join(sessionRoot, 'state.json');
      assert.ok(existsSync(statePath), 'state.json must exist — setup must write it even with concurrent holder');
    }

    // AC-PIWG-5.2.b: stderr must contain [pickle] WARNING: ...concurrent...
    assert.match(
      result.stderr,
      /\[pickle\] WARNING:.*concurrent/i,
      'stderr must contain [pickle] WARNING: ...concurrent... when holder detected',
    );

    // AC-PIWG-5.2.b: activity log must contain concurrent_git_access_detected
    const events = readActivityEvents(dataRoot);
    const probeEvent = events.find((e) => e.event === 'concurrent_git_access_detected');
    assert.ok(probeEvent, 'concurrent_git_access_detected must be emitted when holder detected');
    assert.ok(probeEvent.gate_payload, 'event must have gate_payload');
    assert.equal(typeof probeEvent.gate_payload.repo_root, 'string', 'gate_payload.repo_root must be a string');
    assert.equal(typeof probeEvent.gate_payload.holder_pid, 'number', 'gate_payload.holder_pid must be a number');
    assert.equal(typeof probeEvent.gate_payload.holder_command, 'string', 'gate_payload.holder_command must be a string');
    assert.equal(probeEvent.gate_payload.holder_pid, process.pid, 'holder_pid must match the fake lsof output');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeLsofBin, { recursive: true, force: true });
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  }
});

// AC-PIWG-5.2.f: --paused prep session must emit NO concurrent_git_access_detected.
test('AC-PIWG-5.2.f: --paused session emits no concurrent_git_access_detected', () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'piwg52-paused-repo-')));
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  writeFileSync(join(repoRoot, '.git', 'index.lock'), '');

  const fakeLsofBin = makeFakeLsofBin(process.pid);

  let dataRoot;
  try {
    const result = runSetupWithFakeLsof(fakeLsofBin, repoRoot, ['--paused', '--task', 'paused-concurrent-probe-test']);
    dataRoot = result.dataRoot;

    assert.equal(result.exitCode, 0, `--paused setup must exit 0 (stderr: ${result.stderr})`);

    // Paused sessions must NOT emit concurrent_git_access_detected
    const events = readActivityEvents(dataRoot);
    const probeEvent = events.find((e) => e.event === 'concurrent_git_access_detected');
    assert.equal(
      probeEvent,
      undefined,
      '--paused session must emit NO concurrent_git_access_detected even with holder present',
    );

    // Paused sessions must also NOT write the WARNING to stderr
    assert.equal(
      /\[pickle\] WARNING:.*concurrent/i.test(result.stderr),
      false,
      '--paused session must not write concurrent-git-access WARNING to stderr',
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fakeLsofBin, { recursive: true, force: true });
    if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  }
});
