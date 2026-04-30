import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProjectContext, runArchaeology } from '../bin/archaeology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '..');
const fixtureRoot = path.join(__dirname, '__fixtures__', 'archaeology', 'web');

function tmpDir(prefix = 'pickle-archaeology-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeState(sessionDir, backend = 'codex') {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: true,
    working_dir: fixtureRoot,
    step: 'implement',
    iteration: 0,
    max_iterations: 1,
    max_time_minutes: 30,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    backend,
    activity: [],
  }, null, 2));
}

function makeArgs(sessionDir, overrides = {}) {
  return {
    sessionDir,
    repoRoot: fixtureRoot,
    extensionRoot: repoRoot,
    dryRun: false,
    force: false,
    ...overrides,
  };
}

function runWithTempSession(callback, backend = 'codex') {
  const sessionDir = tmpDir();
  try {
    writeState(sessionDir, backend);
    callback(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('archaeology dry-run plans codex worker invocation from session backend', () => runWithTempSession((sessionDir) => {
  const lines = [];
  const result = runArchaeology(makeArgs(sessionDir, { dryRun: true }), {
    stdout: (line) => lines.push(line),
    logActivityFn: () => {},
  });

  assert.equal(result.exitCode, 0);
  const out = JSON.parse(lines[0]);
  assert.equal(out.backend, 'codex');
  assert.equal(out.cmd, 'codex');
  assert.ok(out.args.includes('exec'));
  assert.ok(out.args.includes('--'));
  assert.equal(out.project_type, 'web');
}));

test('archaeology dry-run plans claude worker invocation from session backend', () => runWithTempSession((sessionDir) => {
  const lines = [];
  const result = runArchaeology(makeArgs(sessionDir, { dryRun: true }), {
    stdout: (line) => lines.push(line),
    logActivityFn: () => {},
  });

  assert.equal(result.exitCode, 0);
  const out = JSON.parse(lines[0]);
  assert.equal(out.backend, 'claude');
  assert.equal(out.cmd, 'claude');
  assert.ok(out.args.includes('-p'));
  assert.ok(out.args.includes('--output-format'));
}, 'claude'));

test('normalizeProjectContext enforces first line and required section order', () => {
  const context = normalizeProjectContext([
    'extra preface',
    '## Trap Doors',
    'Avoid generated dist files.',
    '## Architecture',
    'React entry points live under src.',
    '## Data Model',
    'State is local.',
  ].join('\n'), {
    category: 'web',
    confidence: 'high',
    reason: 'fixture',
    registryPath: '/repo/extension/data/project-types.csv',
    scores: [],
  });

  const expectedOrder = [
    '> Project type: web — see /repo/extension/data/project-types.csv for category definition',
    '## Architecture',
    '## Trap Doors',
    '## Unobvious Constraints',
    '## Key Entry Points',
    '## Conventions',
    '## Data Model',
  ];
  let previous = -1;
  for (const marker of expectedOrder) {
    const index = context.indexOf(marker);
    assert.ok(index > previous, `${marker} should appear after prior marker`);
    previous = index;
  }
  assert.match(context, /React entry points live under src\./);
  assert.match(context, /Avoid generated dist files\./);
});

test('archaeology writes schema file, stdout summary, and state metadata on worker success', () => runWithTempSession((sessionDir) => {
  const stdout = [];
  const events = [];
  const result = runArchaeology(makeArgs(sessionDir), {
    stdout: (line) => stdout.push(line),
    now: (() => {
      const times = [
        new Date('2026-04-30T00:00:00.000Z'),
        new Date('2026-04-30T00:00:02.250Z'),
        new Date('2026-04-30T00:00:02.250Z'),
      ];
      return () => times.shift() ?? new Date('2026-04-30T00:00:02.250Z');
    })(),
    spawn: (cmd, args) => {
      assert.equal(cmd, 'codex');
      assert.ok(args.includes('--'));
      return {
        status: 0,
        signal: null,
        output: [],
        pid: 123,
        stdout: [
          '## Architecture',
          'Component tree starts in src/App.tsx.',
          '## Trap Doors',
          'Do not edit build artifacts.',
          '## Unobvious Constraints',
          'Fixture dependencies imply Vite.',
          '## Key Entry Points',
          'src/App.tsx',
          '## Conventions',
          'TSX components use PascalCase.',
          '## Data Model',
          'No persistent database.',
        ].join('\n'),
        stderr: '',
      };
    },
    logActivityFn: (event) => events.push(event),
  });

  assert.equal(result.exitCode, 0);
  const contextPath = path.join(sessionDir, 'project-context.md');
  const context = fs.readFileSync(contextPath, 'utf8');
  assert.match(context, /^> Project type: web — see .*extension\/data\/project-types\.csv for category definition/m);
  assert.match(stdout[0], /^\[archaeology\] complete — project type: web \(confidence: high, .+\); duration: 2s; bytes: [\d,]+; written: /);

  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.archaeology.project_context_path, contextPath);
  assert.equal(state.archaeology.project_type, 'web');
  assert.equal(typeof state.archaeology.file_count, 'number');
  assert.equal(state.activity.at(-1).event, 'archaeology_complete');
  assert.equal(state.activity.at(-1).backend, 'codex');
  assert.equal(events[0].event, 'archaeology_complete');
}));

test('archaeology records skipped activity and leaves no context file on worker failure', () => runWithTempSession((sessionDir) => {
  const stderr = [];
  const events = [];
  const result = runArchaeology(makeArgs(sessionDir), {
    stderr: (line) => stderr.push(line),
    spawn: () => ({
      status: 42,
      signal: null,
      output: [],
      pid: 123,
      stdout: '',
      stderr: 'worker crashed\n',
    }),
    logActivityFn: (event) => events.push(event),
  });

  assert.equal(result.exitCode, 42);
  assert.equal(fs.existsSync(path.join(sessionDir, 'project-context.md')), false);
  assert.match(stderr[0], /^\[archaeology\] skipped — worker crashed/);
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  assert.equal(state.activity.at(-1).event, 'archaeology_skipped');
  assert.equal(state.activity.at(-1).error, 'worker crashed');
  assert.equal(events[0].event, 'archaeology_skipped');
}));
