// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mux-halt-copy-')));
}

function run(args, extDir) {
  const env = { ...process.env, EXTENSION_DIR: extDir, PICKLE_BACKEND: 'claude' };
  delete env.PICKLE_ROLE;
  return spawnSync(process.execPath, [TMUX_RUNNER_BIN, ...args], {
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

test('command docs surface Skip-flag overrides in /pickle-tmux and /pickle-pipeline', () => {
  // R-PNTR-5: pickle.md deleted; skip-flag docs now required only in pickle-tmux and pickle-pipeline
  for (const relPath of [
    '.claude/commands/pickle-tmux.md',
    '.claude/commands/pickle-pipeline.md',
  ]) {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    assert.match(text, /## Skip-flag overrides/);
    assert.match(text, /state\.flags\.skip_readiness_reason/);
    assert.match(text, /state\.flags\.skip_ticket_audit_reason/);
  }
});

test('mux-runner readiness halt error names state.flags.skip_readiness_reason', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketDir = path.join(sessionDir, 'bad001');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'linear_ticket_bad001.md'), [
      '---',
      'id: bad001',
      'key: BAD-1',
      'ac_ids: []',
      '---',
      '',
      '# Ticket',
      '',
      '## Acceptance Criteria',
      '- [ ] verify_pre: The workflow should feel intuitive.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
      tickets: [{ id: 'bad001', key: 'BAD-1' }],
    }, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      active: true,
      step: 'research',
      iteration: 0,
      max_iterations: 5,
      worker_timeout_seconds: 1200,
      original_prompt: 'test readiness gate',
      working_dir: tmpRoot,
      command_template: 'pickle.md',
    }, null, 2));

    const result = run([sessionDir], REPO_ROOT);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /state\.flags\.skip_readiness_reason/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('mux-runner ticket-audit halt error mentions skip flag name', () => {
  const tmpRoot = makeTmpRoot();
  try {
    const sessionDir = path.join(tmpRoot, 'session');
    const ticketDir = path.join(sessionDir, 'deadbeef');
    fs.mkdirSync(ticketDir, { recursive: true });
    // .xyz extension is not in check-readiness.js PATH_RE extension allowlist so
    // readiness passes without a bypass flag; audit-ticket-bundle.js still flags
    // the path as path-drift (starts with extension/, not in gitListFiles(tmpRoot)
    // which returns empty for a non-git working_dir).
    fs.writeFileSync(path.join(ticketDir, 'linear_ticket_deadbeef.md'), [
      '---',
      'id: deadbeef',
      'title: Phantom File Ticket',
      'status: Todo',
      'mapped_requirements: []',
      '---',
      '',
      '# Description',
      '',
      'Modify `extension/src/does-not-exist-phantom.xyz` to add a function.',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      active: true,
      step: 'research',
      iteration: 0,
      max_iterations: 5,
      worker_timeout_seconds: 1200,
      original_prompt: 'test audit gate',
      working_dir: tmpRoot,
      command_template: 'pickle.md',
    }, null, 2));

    const result = run([sessionDir], REPO_ROOT);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /state\.flags\.skip_(ticket_audit|quality_gates)_reason/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
