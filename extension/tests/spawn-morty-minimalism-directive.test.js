// @tier: fast
// AC-PIAP-A3: minimalism directive injection + diff-envelope soft signal
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkerPrompt, runWorkerGate } from '../bin/spawn-morty.js';

const MINIMALISM_RE = /This is a (trivial|small) ticket\. Make the smallest correct change\./;

function makeTicket(tier) {
  return {
    task: 'Fix the bug',
    ticketContent: '---\nid: abc123\ntitle: Test\n---\n# Test ticket',
    ticketId: 'abc123',
    ticketPath: os.tmpdir(),
    sessionRoot: os.tmpdir(),
    backend: 'claude',
    isReviewTicket: false,
  };
}

// ── AC-PIAP-A3-1: minimalism directive ────────────────────────────────────────

test('AC-PIAP-A3-1: trivial worker prompt contains minimalism directive', () => {
  const prompt = buildWorkerPrompt({
    ticket: makeTicket('trivial'),
    model: 'haiku',
    complexityTier: 'trivial',
  });
  assert.match(prompt, MINIMALISM_RE, 'trivial prompt must contain minimalism directive');
  assert.ok(
    prompt.includes('This is a trivial ticket.'),
    'trivial prompt must name the tier as "trivial"',
  );
});

test('AC-PIAP-A3-1: small worker prompt contains minimalism directive', () => {
  const prompt = buildWorkerPrompt({
    ticket: makeTicket('small'),
    model: 'sonnet',
    complexityTier: 'small',
  });
  assert.match(prompt, MINIMALISM_RE, 'small prompt must contain minimalism directive');
  assert.ok(
    prompt.includes('This is a small ticket.'),
    'small prompt must name the tier as "small"',
  );
});

test('AC-PIAP-A3-1: minimalism directive verbatim text is present for trivial', () => {
  const prompt = buildWorkerPrompt({
    ticket: makeTicket('trivial'),
    model: 'haiku',
    complexityTier: 'trivial',
  });
  assert.ok(
    prompt.includes('Do not refactor adjacent code, do not add abstractions, do not rename or restructure beyond the ticket\'s explicit ask.'),
    'must contain the full minimalism directive body',
  );
  assert.ok(
    prompt.includes('If the fix is one line, it is one line.'),
    'must contain the one-line closer',
  );
});

test('AC-PIAP-A3-1: medium worker prompt does NOT contain minimalism directive', () => {
  const prompt = buildWorkerPrompt({
    ticket: makeTicket('medium'),
    model: 'sonnet',
    complexityTier: 'medium',
  });
  assert.ok(
    !MINIMALISM_RE.test(prompt),
    'medium prompt must NOT contain minimalism directive',
  );
});

test('AC-PIAP-A3-1: large worker prompt does NOT contain minimalism directive', () => {
  const prompt = buildWorkerPrompt({
    ticket: makeTicket('large'),
    model: 'opus',
    complexityTier: 'large',
  });
  assert.ok(
    !MINIMALISM_RE.test(prompt),
    'large prompt must NOT contain minimalism directive',
  );
});

test('AC-PIAP-A3-1: review ticket does NOT receive minimalism directive even for trivial tier', () => {
  const ticket = { ...makeTicket('trivial'), isReviewTicket: true };
  const prompt = buildWorkerPrompt({
    ticket,
    model: 'haiku',
    complexityTier: 'trivial',
  });
  assert.ok(
    !MINIMALISM_RE.test(prompt),
    'review ticket must NOT receive minimalism directive',
  );
});

// ── AC-PIAP-A3-2: diff-envelope soft signal ───────────────────────────────────

function makeTmpDir(prefix = 'pickle-a3-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
}

test('AC-PIAP-A3-2: 200-LOC diff for trivial ticket writes tier_diff_envelope_exceeded event and does NOT hard-block', async () => {
  const root = makeTmpDir();
  try {
    initGitRepo(root);
    // Write a small initial file and commit (preWorkerHead)
    fs.writeFileSync(path.join(root, 'initial.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // Worker adds 200 lines
    const bigContent = Array.from({ length: 200 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'big-change.ts'), bigContent);
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'worker change abc99', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));

    // No extension/ dir → gate returns ok:true immediately after the soft LOC check
    const result = await runWorkerGate([], {
      workingDir: root,
      ticketId: 'abc99',
      statePath,
      preWorkerHead,
      ticketTier: 'trivial',
    });

    // Must NOT hard-block (gate ok===true)
    assert.equal(result.ok, true, 'gate must not hard-block when diff envelope is exceeded');

    // Must have written tier_diff_envelope_exceeded event
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const event = state.activity.find((e) => e.event === 'tier_diff_envelope_exceeded');
    assert.ok(event, `tier_diff_envelope_exceeded event must be written; activity=${JSON.stringify(state.activity)}`);
    assert.equal(event.tier, 'trivial');
    assert.ok(event.changed_loc >= 200, `changed_loc must be >= 200, got ${event.changed_loc}`);
    assert.equal(event.envelope, 20);
    assert.ok(typeof event.ts === 'string', 'event must have ts');
    assert.ok(typeof event.ticket_id === 'string', 'event must have ticket_id');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-PIAP-A3-2: small ticket within 80-LOC envelope does NOT write tier_diff_envelope_exceeded', async () => {
  const root = makeTmpDir();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'initial.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // 10 lines — well within small envelope (80)
    const smallContent = Array.from({ length: 10 }, (_, i) => `export const s${i} = ${i};`).join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'small-change.ts'), smallContent);
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'worker change xyz77', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));

    await runWorkerGate([], {
      workingDir: root,
      ticketId: 'xyz77',
      statePath,
      preWorkerHead,
      ticketTier: 'small',
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const event = state.activity.find((e) => e.event === 'tier_diff_envelope_exceeded');
    assert.ok(!event, 'must NOT write tier_diff_envelope_exceeded when within envelope');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-PIAP-A3-2: medium ticket does NOT trigger diff envelope check', async () => {
  const root = makeTmpDir();
  try {
    initGitRepo(root);
    fs.writeFileSync(path.join(root, 'initial.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });
    const preWorkerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    // 500 lines for a medium ticket — no envelope defined
    const bigContent = Array.from({ length: 500 }, (_, i) => `export const m${i} = ${i};`).join('\n') + '\n';
    fs.writeFileSync(path.join(root, 'big-medium.ts'), bigContent);
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'worker change med01', '--no-gpg-sign'], { cwd: root, stdio: 'ignore' });

    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ activity: [] }, null, 2));

    await runWorkerGate([], {
      workingDir: root,
      ticketId: 'med01',
      statePath,
      preWorkerHead,
      ticketTier: 'medium',
    });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const event = state.activity.find((e) => e.event === 'tier_diff_envelope_exceeded');
    assert.ok(!event, 'medium tier must NOT produce tier_diff_envelope_exceeded (no envelope defined)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
