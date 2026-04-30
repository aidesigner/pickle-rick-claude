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
    continueDebate: false,
    acceptStale: false,
    dryRun: false,
    agentsDir: AGENTS_DIR,
  };
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
