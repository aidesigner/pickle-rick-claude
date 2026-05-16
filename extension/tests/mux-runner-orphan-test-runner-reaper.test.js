// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseOrphanedFastTestRunnersFromPs,
  reapOrphanedFastTestRunnersOnStartup,
} from '../bin/mux-runner.js';

test('mux-runner orphan fast-test reaper: parses only old launchd-parented extension-local test runners', () => {
  const extensionDir = '/tmp/pickle/extension';
  const psOutput = [
    `111 1 12:34 ${extensionDir}/node_modules/.bin/npm run test:fast`,
    `222 1 00:09:59 ${extensionDir}/node_modules/.bin/npm run test:fast`,
    `333 1 10:30 /usr/local/bin/node --test ${extensionDir}/tests/foo.test.js`,
    `444 99 55:10 /usr/local/bin/node --test ${extensionDir}/tests/bar.test.js`,
    '555 1 11:11 /usr/local/bin/node --test /tmp/other-project/extension/tests/nope.test.js',
  ].join('\n');

  assert.deepEqual(
    parseOrphanedFastTestRunnersFromPs(psOutput, extensionDir),
    [
      {
        pid: 111,
        ppid: 1,
        etime_seconds: 754,
        argv_summary: `${extensionDir}/node_modules/.bin/npm run test:fast`,
      },
      {
        pid: 333,
        ppid: 1,
        etime_seconds: 630,
        argv_summary: `/usr/local/bin/node --test ${extensionDir}/tests/foo.test.js`,
      },
    ],
  );
});

test('mux-runner orphan fast-test reaper: kills matches and emits activity entries', () => {
  const extensionDir = '/tmp/pickle/extension';
  const killed = [];
  const logs = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-orphan-reaper-'));
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'orphan reaper test',
    current_ticket: null,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: root,
    activity: [],
  }, null, 2));

  try {
    const orphans = reapOrphanedFastTestRunnersOnStartup(statePath, extensionDir, (msg) => {
      logs.push(msg);
    }, {
      psOutput: [
        `111 1 12:34 ${extensionDir}/node_modules/.bin/npm run test:fast`,
        `333 1 10:30 /usr/local/bin/node --test ${extensionDir}/tests/foo.test.js`,
      ].join('\n'),
      kill: (pid) => {
        killed.push(pid);
      },
    });

    assert.deepEqual(killed, [111, 333]);
    assert.equal(orphans.length, 2);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      orphans.map((orphan) => orphan.argv_summary),
      [
        `${extensionDir}/node_modules/.bin/npm run test:fast`,
        `/usr/local/bin/node --test ${extensionDir}/tests/foo.test.js`,
      ],
    );

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const reapedEvents = (state.activity ?? []).filter((entry) => entry.event === 'orphan_test_runner_reaped');
    assert.equal(reapedEvents.length, 2);
    assert.deepEqual(
      reapedEvents.map((entry) => ({
        pid: entry.pid,
        etime_seconds: entry.etime_seconds,
        argv_summary: entry.argv_summary,
      })),
      [
        {
          pid: 111,
          etime_seconds: 754,
          argv_summary: `${extensionDir}/node_modules/.bin/npm run test:fast`,
        },
        {
          pid: 333,
          etime_seconds: 630,
          argv_summary: `/usr/local/bin/node --test ${extensionDir}/tests/foo.test.js`,
        },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
