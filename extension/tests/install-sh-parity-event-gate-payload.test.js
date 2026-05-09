// @tier: fast
// Trap-door conformance test for install.sh:install_sh_parity_check emission.
// Verifies that install.sh emits the install_sh_parity_check activity event
// with a schema-conformant `gate_payload` (files_checked, mismatches, status)
// instead of burying parity data in the title field.
//
// Iter-2 trap door (src/bin/log-activity.ts gate_payload invariant) requires
// any event with required gate_payload to be CLI-emittable via --gate-payload.
// This test enforces that install.sh's two emission sites actually use the
// flag.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'activity-events.schema.json');
const LOG_ACTIVITY_BIN = path.resolve(__dirname, '..', 'bin', 'log-activity.js');

describe('install.sh install_sh_parity_check emits schema-conformant gate_payload', () => {
  test('install.sh source: both parity emission sites pass --gate-payload', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    const lines = src.split('\n');

    const emitterIdxs = lines
      .map((l, i) => (l.includes('log-activity.js') && l.includes('install_sh_parity_check') ? i : -1))
      .filter((i) => i >= 0);

    assert.equal(
      emitterIdxs.length,
      2,
      `expected exactly 2 install_sh_parity_check emission sites, found ${emitterIdxs.length}`,
    );

    for (const idx of emitterIdxs) {
      // Either the same line carries --gate-payload, or one of the next two
      // continuation lines does (bash backslash continuation).
      const window = lines.slice(idx, idx + 3).join('\n');
      assert.match(
        window,
        /--gate-payload\s+"\$_parity_payload"/,
        `install.sh:${idx + 1} install_sh_parity_check emission must include --gate-payload "$_parity_payload"`,
      );
    }
  });

  test('install.sh source: jq construction sets files_checked, mismatches, status', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(
      src,
      /jq -nc[\s\S]*?--argjson files_checked[\s\S]*?--arg status\s+pass[\s\S]*?\{files_checked:[\s\S]*?mismatches: \[\][\s\S]*?status: \$status\}/,
      'install.sh must construct pass payload with files_checked, mismatches=[], status=pass',
    );
    assert.match(
      src,
      /jq -nc[\s\S]*?--argjson files_checked[\s\S]*?--argjson mismatches[\s\S]*?--arg status\s+fail[\s\S]*?\{files_checked:[\s\S]*?mismatches: \$mismatches[\s\S]*?status: \$status\}/,
      'install.sh must construct fail payload with files_checked, mismatches array, status=fail',
    );
  });

  test('emission fixture: pass-path produces schema-conformant JSONL line', () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'pickle-install-parity-event-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          LOG_ACTIVITY_BIN,
          'install_sh_parity_check',
          'parity=pass files_checked=5',
          '--gate-payload',
          JSON.stringify({
            files_checked: ['types/index.js', 'services/state-manager.js'],
            mismatches: [],
            status: 'pass',
          }),
        ],
        {
          env: { ...process.env, PICKLE_DATA_ROOT: dataRoot, FORCE_COLOR: '0' },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 0, `log-activity exited non-zero: ${result.stderr}`);

      const activityDir = path.join(dataRoot, 'activity');
      assert.ok(existsSync(activityDir), 'activity dir must exist');
      const files = readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
      assert.equal(files.length, 1, 'expected exactly one activity log file');

      const lines = readFileSync(path.join(activityDir, files[0]), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(lines.length, 1);
      const event = JSON.parse(lines[0]);

      const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
      const def = schema.definitions.install_sh_parity_check;
      for (const field of def.required) {
        assert.ok(field in event, `emitted event missing required field: ${field}`);
      }
      const gpDef = def.properties.gate_payload;
      for (const field of gpDef.required) {
        assert.ok(field in event.gate_payload, `gate_payload missing required field: ${field}`);
      }
      assert.equal(event.gate_payload.status, 'pass');
      assert.deepEqual(event.gate_payload.mismatches, []);
      assert.ok(Array.isArray(event.gate_payload.files_checked));
      assert.equal(event.gate_payload.files_checked.length, 2);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test('emission fixture: fail-path produces schema-conformant JSONL line with mismatches', () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), 'pickle-install-parity-event-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          LOG_ACTIVITY_BIN,
          'install_sh_parity_check',
          'parity=fail mismatches=2',
          '--gate-payload',
          JSON.stringify({
            files_checked: ['types/index.js', 'bin/spawn-morty.js'],
            mismatches: ['types/index.js (src=abc dst=def)', 'bin/spawn-morty.js (src=ghi dst=jkl)'],
            status: 'fail',
          }),
        ],
        {
          env: { ...process.env, PICKLE_DATA_ROOT: dataRoot, FORCE_COLOR: '0' },
          encoding: 'utf-8',
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 0, `log-activity exited non-zero: ${result.stderr}`);

      const activityDir = path.join(dataRoot, 'activity');
      const files = readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
      const lines = readFileSync(path.join(activityDir, files[0]), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      const event = JSON.parse(lines[0]);

      assert.equal(event.event, 'install_sh_parity_check');
      assert.equal(event.gate_payload.status, 'fail');
      assert.equal(event.gate_payload.mismatches.length, 2);
      assert.equal(event.gate_payload.files_checked.length, 2);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

});
