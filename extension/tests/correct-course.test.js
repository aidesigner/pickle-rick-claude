import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCorrectCourseBrief, parseArgs, runCorrectCourse, validateDiscovery } from '../bin/correct-course.js';

function tmpSession(backend = 'codex') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'correct-course-')));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    active: true,
    working_dir: dir,
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
    session_dir: dir,
    schema_version: 3,
    backend,
  }, null, 2));
  return dir;
}

test('correct-course parseArgs resolves session, repo, discovery, and flags', () => {
  const args = parseArgs([
    'New constraint found',
    '--session-dir', '/tmp/session',
    '--repo-root', '/tmp/repo',
    '--dry-run',
    '--auto-apply',
    '--force',
    '--recover-from-ledger',
    '--recover',
    '--ledger', '/tmp/session/change_proposal_apply.log',
  ]);

  assert.equal(args.sessionDir, path.resolve('/tmp/session'));
  assert.equal(args.repoRoot, path.resolve('/tmp/repo'));
  assert.equal(args.discovery, 'New constraint found');
  assert.equal(args.dryRun, true);
  assert.equal(args.autoApply, true);
  assert.equal(args.force, true);
  assert.equal(args.recoverFromLedger, true);
  assert.equal(args.recover, true);
  assert.equal(args.ledgerPath, '/tmp/session/change_proposal_apply.log');
});

test('correct-course parseArgs allows empty discovery for recovery mode', () => {
  const args = parseArgs([
    '--session-dir', '/tmp/session',
    '--recover-from-ledger',
  ]);

  assert.equal(args.discovery, '');
  assert.equal(args.recoverFromLedger, true);
});

test('correct-course validates discovery statement', () => {
  assert.throws(() => validateDiscovery('   '), /Discovery statement is required/);
  assert.throws(() => validateDiscovery('x'.repeat(2001)), /2000 characters or fewer/);
  assert.doesNotThrow(() => validateDiscovery('Fixture constraint discovered'));
});

test('correct-course writes a timestamped brief under the session root', () => {
  const sessionDir = tmpSession('codex');
  try {
    const stdout = [];
    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: 'Fixture constraint discovered',
      dryRun: false,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: false,
    }, {
      stdout: (line) => stdout.push(line),
      now: () => new Date('2026-04-30T12:34:56.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.briefPath, path.join(sessionDir, 'change_proposal_2026-04-30T12-34-56Z_brief.md'));
    assert.deepEqual(stdout, [`BRIEF_PATH=${result.briefPath}`]);
    const content = fs.readFileSync(result.briefPath, 'utf8');
    assert.match(content, /# Course Correction Brief/);
    assert.match(content, /Fixture constraint discovered/);
    assert.match(content, /buildJudgeInvocation\(backend, \.\.\.\)/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('correct-course dry-run emits JSON and does not write the brief', () => {
  const sessionDir = tmpSession('claude');
  try {
    const stdout = [];
    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: 'Dry run discovery',
      dryRun: true,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: false,
    }, {
      stdout: (line) => stdout.push(line),
      now: () => new Date('2026-04-30T12:00:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(result.briefPath), false);
    const parsed = JSON.parse(stdout[0]);
    assert.equal(parsed.backend, 'claude');
    assert.equal(parsed.brief_path, result.briefPath);
    assert.match(parsed.brief, /Dry run discovery/);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('correct-course planned codex invocation is read-only and never bypasses sandbox', () => {
  const sessionDir = tmpSession('codex');
  try {
    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: 'Codex safety discovery',
      dryRun: true,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: false,
    }, { stdout: () => {}, now: () => new Date('2026-04-30T12:00:00.000Z') });

    assert.equal(result.invocation.cmd, 'codex');
    assert.equal(result.invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    const sandboxIndex = result.invocation.args.indexOf('-s');
    assert.ok(sandboxIndex >= 0);
    assert.equal(result.invocation.args[sandboxIndex + 1], 'read-only');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('correct-course planned claude invocation has no Edit, Write, or Bash tools', () => {
  const sessionDir = tmpSession('claude');
  try {
    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: 'Claude safety discovery',
      dryRun: true,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: false,
    }, { stdout: () => {}, now: () => new Date('2026-04-30T12:00:00.000Z') });

    assert.equal(result.invocation.cmd, 'claude');
    const allowedIndex = result.invocation.args.indexOf('--allowedTools');
    assert.ok(allowedIndex >= 0);
    const allowedTools = result.invocation.args[allowedIndex + 1];
    assert.equal(allowedTools, 'Read,Glob,Grep');
    assert.equal(allowedTools.includes('Edit'), false);
    assert.equal(allowedTools.includes('Write'), false);
    assert.equal(allowedTools.includes('Bash'), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('buildCorrectCourseBrief documents proposal-only manager boundary', () => {
  const brief = buildCorrectCourseBrief({
    sessionDir: '/tmp/session',
    repoRoot: '/tmp/repo',
    discovery: 'Boundary discovery',
    dryRun: false,
    autoApply: true,
    force: false,
    recoverFromLedger: false,
    recover: false,
  }, new Date('2026-04-30T00:00:00.000Z'));

  assert.match(brief, /The corrector produces proposal content only/);
  assert.match(brief, /the manager performs any later apply, ledger, ticket, or state changes/);
});

test('correct-course --recover-from-ledger executes reverse recovery', () => {
  const sessionDir = tmpSession('codex');
  try {
    const ticketDir = path.join(sessionDir, 'abc123');
    fs.mkdirSync(ticketDir);
    const ticketPath = path.join(ticketDir, 'linear_ticket_abc123.md');
    const before = [
      '---',
      'id: abc123',
      'status: "Todo"',
      '---',
      '',
    ].join('\n');
    const after = before.replace('status: "Todo"', 'status: "Killed"');
    fs.writeFileSync(ticketPath, after);
    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T18-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      step: 1,
      action: 'write',
      operation: 'kill_ticket',
      ticket_id: 'abc123',
      path: ticketPath,
      status: 'applied',
      recovery_class: 'restore-previous-content',
      beforeContent: before,
      previousContent: before,
      afterContent: after,
      createdAt: '2026-04-30T18:00:00.000Z',
    })}\n`);
    const stdout = [];

    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: '',
      dryRun: false,
      autoApply: false,
      force: false,
      recoverFromLedger: true,
      recover: false,
      ledgerPath,
    }, {
      stdout: (line) => stdout.push(line),
      now: () => new Date('2026-04-30T18:05:00.000Z'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.recovery.mode, 'reverse');
    assert.equal(fs.readFileSync(ticketPath, 'utf-8'), before);
    assert.deepEqual(stdout, [
      `RECOVERY_LEDGER=${ledgerPath}`,
      'RECOVERY_MODE=reverse',
      'RECOVERED_STEPS=1',
    ]);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('correct-course --recover requires --force and executes forward recovery', () => {
  const sessionDir = tmpSession('codex');
  try {
    const ticketDir = path.join(sessionDir, 'abc123');
    fs.mkdirSync(ticketDir);
    const ticketPath = path.join(ticketDir, 'linear_ticket_abc123.md');
    const before = [
      '---',
      'id: abc123',
      'status: "Todo"',
      '---',
      '',
    ].join('\n');
    const after = before.replace('status: "Todo"', 'status: "Killed"');
    fs.writeFileSync(ticketPath, before);
    const ledgerPath = path.join(sessionDir, 'change_proposal_2026-04-30T19-00-00Z_apply.log');
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      step: 1,
      action: 'write',
      operation: 'kill_ticket',
      ticket_id: 'abc123',
      path: ticketPath,
      status: 'failed',
      recovery_class: 'restore-previous-content',
      beforeContent: before,
      previousContent: before,
      afterContent: after,
      createdAt: '2026-04-30T19:00:00.000Z',
    })}\n`);

    assert.throws(() => runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: '',
      dryRun: false,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: true,
      ledgerPath,
    }), /--recover requires --force/);

    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: '',
      dryRun: false,
      autoApply: false,
      force: true,
      recoverFromLedger: false,
      recover: true,
      ledgerPath,
    }, { stdout: () => {}, now: () => new Date('2026-04-30T19:05:00.000Z') });

    assert.equal(result.recovery.mode, 'forward');
    assert.equal(fs.readFileSync(ticketPath, 'utf-8'), after);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
