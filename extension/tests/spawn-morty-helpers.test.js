import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkerPrompt, resolveEffectiveTimeout } from '../bin/spawn-morty.js';

const GITNEXUS_MARKER = '# GITNEXUS CODE INTELLIGENCE (auto-detected)';

function makeTmpDir(prefix = 'pickle-spawn-morty-helpers-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function baseTicket(repoRoot) {
  return {
    task: 'implement helper tests',
    ticketContent: '# Ticket',
    ticketId: 'ticket-helper',
    ticketPath: path.join(repoRoot, 'ticket-helper'),
    sessionRoot: repoRoot,
    backend: 'claude',
    isReviewTicket: false,
  };
}

test('buildWorkerPrompt: injects GitNexus instructions when .gitnexus is a directory', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.mkdirSync(path.join(repoRoot, '.gitnexus'));
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(prompt.includes(GITNEXUS_MARKER));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits GitNexus instructions when .gitnexus is absent', () => {
  const repoRoot = makeTmpDir();
  try {
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.equal(prompt.includes(GITNEXUS_MARKER), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: omits GitNexus instructions when .gitnexus is a file', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, '.gitnexus'), 'not a directory');
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.equal(prompt.includes(GITNEXUS_MARKER), false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: injects project context before ticket content when available', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(path.join(repoRoot, 'project-context.md'), 'Architecture\n- Existing shape');
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });

    const contextIndex = prompt.indexOf('## Project Context\nArchitecture\n- Existing shape');
    const ticketIndex = prompt.indexOf('# TARGET TICKET CONTENT');
    const executionIndex = prompt.indexOf('# EXECUTION CONTEXT');

    assert.ok(contextIndex > -1, 'should include project context block');
    assert.ok(contextIndex < ticketIndex, 'project context should precede target ticket content');
    assert.ok(ticketIndex < executionIndex, 'target ticket content should precede execution context');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('resolveEffectiveTimeout: clamps configured timeout to remaining wall-clock budget', () => {
  const startEpoch = 1_700_000_000;
  const nowMs = (startEpoch + 555) * 1000;
  const state = {
    max_time_minutes: 10,
    start_time_epoch: startEpoch,
  };

  assert.equal(resolveEffectiveTimeout(300, state, nowMs), 45);
});
