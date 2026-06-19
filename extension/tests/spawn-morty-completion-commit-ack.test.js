// @tier: fast
/**
 * R-CCEM (#126): readAnnouncedCompletionSha recovers a worker's self-declared
 * commit SHA (from its COMPLETION_COMMIT_RECORDED: line -> the
 * `worker_completion_commit_announced` activity event in state.activity) so the
 * manager's Done-flip guard can attribute a gate-clean codex commit whose
 * message omitted the ticket id — instead of FATAL-halting the whole pickle
 * phase. The worker named the SHA; this is not a guess (no #94 R-CXOR risk).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { readAnnouncedCompletionSha } = await import('../bin/mux-runner.js');

const SHA = '1381d1db8834fa356fcaedfecc73b2e56e5b2be0';

function sessionWith(activity) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ccem-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true, activity }));
  return dir;
}

function announce(ticketId, sha) {
  return { event: 'worker_completion_commit_announced', source: 'pickle', ticket_id: ticketId, sha };
}

test('R-CCEM: returns the announced SHA for the matching ticket', () => {
  const dir = sessionWith([announce('aabbccdd', SHA)]);
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), SHA);
});

test('R-CCEM: returns the LATEST announcement when several exist for the ticket', () => {
  const older = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const dir = sessionWith([announce('aabbccdd', older), announce('aabbccdd', SHA)]);
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), SHA);
});

test('R-CCEM: returns null when no announcement matches the ticket', () => {
  const dir = sessionWith([announce('99887766', SHA)]);
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), null);
});

test('R-CCEM: ignores a non-sha-shaped announcement (no junk attributed)', () => {
  const dir = sessionWith([announce('aabbccdd', 'not-a-sha')]);
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), null);
});

test('R-CCEM: returns null when state.json is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ccem-'));
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), null);
});

test('R-CCEM: returns null when activity is empty', () => {
  const dir = sessionWith([]);
  assert.equal(readAnnouncedCompletionSha(dir, 'aabbccdd'), null);
});
