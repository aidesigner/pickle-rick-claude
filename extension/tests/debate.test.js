import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDebateBrief,
  parseArgs,
  runDebate,
} from '../bin/debate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '../../.claude/agents');

function tmpSession() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-debate-')));
}

function baseArgs(sessionDir = '/tmp/session') {
  return {
    sessionDir,
    repoRoot: '/tmp/repo',
    question: 'Postgres or DuckDB?',
    personas: ['researcher', 'architect', 'implementer', 'skeptic'],
    n: 4,
    solo: false,
    strictTeams: false,
    noStrictTeams: false,
    continueDebate: false,
    acceptStale: false,
    dryRun: false,
    agentsDir: AGENTS_DIR,
  };
}

function writeState(sessionDir, overrides = {}) {
  const state = {
    active: true,
    working_dir: '/tmp/repo',
    step: 'implement',
    iteration: 1,
    max_iterations: 3,
    max_time_minutes: 60,
    worker_timeout_seconds: 3600,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'debate test',
    current_ticket: null,
    history: [],
    started_at: '2026-04-30T00:00:00.000Z',
    session_dir: sessionDir,
    schema_version: 3,
    flags: {},
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

test('debate parseArgs resolves question, flags, count, and personas', () => {
  const args = parseArgs([
    'Postgres or DuckDB?',
    '--session-dir', '/tmp/session',
    '--repo-root', '/tmp/repo',
    '--personas', 'r,s',
    '--n', '2',
    '--solo',
    '--strict-teams',
    '--no-strict-teams',
    '--continue',
    '--accept-stale',
    '--agents-dir', AGENTS_DIR,
  ]);

  assert.equal(args.sessionDir, path.resolve('/tmp/session'));
  assert.equal(args.repoRoot, path.resolve('/tmp/repo'));
  assert.equal(args.question, 'Postgres or DuckDB?');
  assert.deepEqual(args.personas, ['researcher', 'skeptic']);
  assert.equal(args.n, 2);
  assert.equal(args.solo, true);
  assert.equal(args.strictTeams, true);
  assert.equal(args.noStrictTeams, true);
  assert.equal(args.continueDebate, true);
  assert.equal(args.acceptStale, true);
  assert.equal(args.agentsDir, AGENTS_DIR);
});

test('debate parseArgs defaults to four personas', () => {
  const args = parseArgs([
    'Choose a queue backend',
    '--session-dir', '/tmp/session',
  ]);

  assert.deepEqual(args.personas, ['researcher', 'architect', 'implementer', 'skeptic']);
  assert.equal(args.n, 4);
});

test('debate parseArgs rejects invalid persona and count inputs', () => {
  assert.throws(() => parseArgs(['Question', '--session-dir', '/tmp/session', '--personas', 'x']), /Unknown debate persona/);
  assert.throws(() => parseArgs(['Question', '--session-dir', '/tmp/session', '--n', '7']), /--n must be an integer from 2 to 6/);
  assert.throws(() => parseArgs(['Question', '--session-dir', '/tmp/session', '--n', '5']), /Only 4 debate personas are available/);
});

test('buildDebateBrief documents helper-only boundary and budgets', () => {
  const brief = buildDebateBrief(baseArgs(), new Date('2026-04-30T12:00:00.000Z'), [
    { persona: 'researcher', agentName: 'morty-debater-researcher', sourcePath: '/agents/researcher.md' },
    { persona: 'architect', agentName: 'morty-debater-architect', sourcePath: '/agents/architect.md' },
    { persona: 'implementer', agentName: 'morty-debater-implementer', sourcePath: '/agents/implementer.md' },
    { persona: 'skeptic', agentName: 'morty-debater-skeptic', sourcePath: '/agents/skeptic.md' },
  ]);

  assert.match(brief, /# Debate Brief/);
  assert.match(brief, /Postgres or DuckDB\?/);
  assert.match(brief, /Cap shared context sent to each subagent at 600 words/);
  assert.match(brief, /Cap each persona response at 800 words/);
  assert.match(brief, /This helper only prepares the brief/);
  assert.match(brief, /must not .*synthesize a verdict/i);
});

test('debate writes a timestamped brief under the session root', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'claude' });
    const stdout = [];
    const result = runDebate(baseArgs(sessionDir), {
      stdout: (line) => stdout.push(line),
      now: () => new Date('2026-04-30T12:34:56.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.briefPath, path.join(sessionDir, 'debate_2026-04-30T12-34-56Z_brief.md'));
    assert.deepEqual(stdout, [`BRIEF_PATH=${result.briefPath}`]);
    assert.equal(fs.existsSync(result.briefPath), true);
    assert.match(fs.readFileSync(result.briefPath, 'utf8'), /morty-debater-researcher/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate dry-run emits JSON and does not write the brief', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'claude' });
    const stdout = [];
    const result = runDebate({ ...baseArgs(sessionDir), dryRun: true }, {
      stdout: (line) => stdout.push(line),
      now: () => new Date('2026-04-30T12:00:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(result.briefPath), false);
    const parsed = JSON.parse(stdout[0]);
    assert.equal(parsed.brief_path, result.briefPath);
    assert.deepEqual(parsed.personas, ['researcher', 'architect', 'implementer', 'skeptic']);
    assert.match(parsed.brief, /Debate Brief/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate validates selected agent markdown frontmatter', () => {
  const sessionDir = tmpSession();
  const agentsDir = path.join(sessionDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'morty-debater-researcher.md'), [
    '---',
    'name: morty-debater-researcher',
    'description: bad fixture',
    'tools: Read, Write',
    '---',
    '',
    'Body.',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(agentsDir, 'morty-debater-architect.md'), fs.readFileSync(path.join(AGENTS_DIR, 'morty-debater-architect.md'), 'utf8'));

  try {
    assert.throws(() => runDebate({
      ...baseArgs(sessionDir),
      personas: ['researcher', 'architect'],
      n: 2,
      agentsDir,
    }, { stdout: () => {} }), /tools must be exactly Read, Glob, Grep/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate persists explicit strict-teams flag in session state', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'claude', flags: {} });
    const result = runDebate({ ...baseArgs(sessionDir), strictTeams: true }, {
      stdout: () => {},
      now: () => new Date('2026-04-30T13:00:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.mode, 'teams');
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    assert.equal(state.flags.strict_teams, true);
    assert.match(result.brief, /- strict_teams: true/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate inherits persisted strict-teams unless no-strict-teams is passed', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'claude', flags: { strict_teams: true } });
    const inherited = runDebate(baseArgs(sessionDir), {
      stdout: () => {},
      now: () => new Date('2026-04-30T13:01:00.000Z'),
    });
    const overridden = runDebate({ ...baseArgs(sessionDir), noStrictTeams: true }, {
      stdout: () => {},
      now: () => new Date('2026-04-30T13:02:00.000Z'),
    });

    assert.match(inherited.brief, /- strict_teams: true/);
    assert.match(overridden.brief, /- strict_teams: false/);
    assert.match(overridden.brief, /- no_strict_teams: true/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate auto-promotes codex backend to solo mode and logs activity', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'codex', flags: {} });
    const stdout = [];
    const events = [];
    const result = runDebate(baseArgs(sessionDir), {
      stdout: (line) => stdout.push(line),
      logActivityFn: (event) => events.push(event),
      confirmAutoPromote: () => true,
      now: () => new Date('2026-04-30T13:03:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.mode, 'solo (auto)');
    assert.match(stdout[0], /codex backend detected/);
    assert.match(result.brief, /- mode: solo \(auto\)/);
    assert.match(result.brief, /- solo: true/);
    assert.deepEqual(events.map((event) => event.event), ['debate_solo_auto']);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate fails fast for strict teams on codex backend', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'codex', flags: {} });
    const stderr = [];
    const result = runDebate({ ...baseArgs(sessionDir), strictTeams: true }, {
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      now: () => new Date('2026-04-30T13:04:00.000Z'),
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.briefPath, '');
    assert.match(stderr[0], /--strict-teams requires claude backend/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('debate records declined codex auto-promote without writing a brief', () => {
  const sessionDir = tmpSession();
  try {
    writeState(sessionDir, { backend: 'codex', flags: {} });
    const events = [];
    const result = runDebate(baseArgs(sessionDir), {
      stdout: () => {},
      logActivityFn: (event) => events.push(event),
      confirmAutoPromote: () => false,
      now: () => new Date('2026-04-30T13:05:00.000Z'),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.briefPath, '');
    assert.deepEqual(events.map((event) => event.event), ['debate_user_declined_auto_promote']);
    assert.equal(fs.existsSync(path.join(sessionDir, 'debate_2026-04-30T13-05-00Z_brief.md')), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
