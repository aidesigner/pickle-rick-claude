// @tier: integration
// R-SSDF-FW — asserts AGENTS.md firewall detection in buildWorkerPrompt.
// Verifies: (1) AGENTS.md with firewall regex injects FIREWALL_DETECTED=true
// into the rendered worker prompt; (2) absent AGENTS.md produces no flag;
// (3) AGENTS.md without firewall keywords produces no flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkerPrompt } from '../../bin/spawn-morty.js';

function makeTmpDir(prefix = 'pickle-ssdf-fw-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function baseTicket(repoRoot) {
  const ticketDir = path.join(repoRoot, 'ticket-fw-test');
  fs.mkdirSync(ticketDir, { recursive: true });
  return {
    task: 'firewall detection test',
    ticketContent: '# Ticket\n',
    ticketId: 'ticket-fw-test',
    ticketPath: ticketDir,
    sessionRoot: repoRoot,
    backend: 'claude',
    isReviewTicket: false,
  };
}

test('R-SSDF-FW: AGENTS.md with firewall content injects FIREWALL_DETECTED=true', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(repoRoot, 'AGENTS.md'),
      '# Agent Rules\n\nThis is a firewall — stay inside the repo.\nStay inside the assigned working directory.\n',
    );
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(
      prompt.includes('FIREWALL_DETECTED=true'),
      `expected FIREWALL_DETECTED=true in prompt; got:\n${prompt.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('R-SSDF-FW: missing AGENTS.md produces no FIREWALL_DETECTED flag', () => {
  const repoRoot = makeTmpDir();
  try {
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(
      !prompt.includes('FIREWALL_DETECTED'),
      `expected no FIREWALL_DETECTED in prompt; got:\n${prompt.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('R-SSDF-FW: AGENTS.md without firewall keywords produces no FIREWALL_DETECTED flag', () => {
  const repoRoot = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(repoRoot, 'AGENTS.md'),
      '# Agent Rules\n\nBe helpful. Write clean code.\n',
    );
    const prompt = buildWorkerPrompt({ ticket: baseTicket(repoRoot), model: 'sonnet', repoRoot });
    assert.ok(
      !prompt.includes('FIREWALL_DETECTED'),
      `expected no FIREWALL_DETECTED in prompt; got:\n${prompt.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
