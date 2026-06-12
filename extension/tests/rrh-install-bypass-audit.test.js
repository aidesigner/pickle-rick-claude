// @tier: fast
// Ticket 612217e2 (B-RRH AC-E9b): install.sh must emit the documented
// INSTALL_BYPASS_ACTIVE_SESSION deploy-audit event on the active-session
// bypass path (--override-active / --closer-context with a live session).
//
// We do NOT run full install.sh (it deploys + trips the active-session guard
// and is bash-scanner-blocked from workers). Instead we extract the single
// audit helper and source it in isolation against a tmp EXTENSION_ROOT, then
// assert the emitted JSONL line. Static assertions cover the bypass-branch
// wiring and README <-> install.sh event-name parity.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const README = path.join(REPO_ROOT, 'README.md');
const EVENT = 'INSTALL_BYPASS_ACTIVE_SESSION';

describe('install.sh INSTALL_BYPASS_ACTIVE_SESSION audit (612217e2)', () => {
  test('isolated helper appends a conformant audit line on bypass', () => {
    const extensionRoot = mkdtempSync(path.join(tmpdir(), 'rrh-bypass-audit-'));
    try {
      // Extract just the helper body so we never execute the full installer.
      const harness = `
set -euo pipefail
EXTENSION_ROOT='${extensionRoot}'
SRC_V='2.3.4'
DEP_V='2.3.4'
INVOCATION='install.sh --override-active'
OVERRIDE_ACTIVE=1
NO_CONFIRM=0
CLOSER_CONTEXT=0
eval "$(awk '/^append_bypass_active_session_audit\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}' '${INSTALL_SH}')"
append_bypass_active_session_audit 'fake-session-123'
`;
      const result = spawnSync('bash', ['-c', harness], {
        encoding: 'utf-8',
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `harness exited non-zero: ${result.stderr}`);

      const auditFile = path.join(extensionRoot, 'deploy-audit.log');
      const lines = readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1, 'expected exactly one audit line');
      const event = JSON.parse(lines[0]);

      assert.equal(event.event, EVENT);
      assert.equal(event.session_id, 'fake-session-123');
      assert.equal(event.src_version, '2.3.4');
      assert.equal(event.dep_version, '2.3.4');
      assert.equal(event.invocation, 'install.sh --override-active');
      assert.equal(event.override_active, true);
      assert.equal(event.no_confirm, false);
      assert.equal(event.closer_context, false);
      assert.ok(typeof event.operator === 'string');
      assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      rmSync(extensionRoot, { recursive: true, force: true });
    }
  });

  test('empty session_id coerces to null (DOWNGRADE field-shape parity)', () => {
    const extensionRoot = mkdtempSync(path.join(tmpdir(), 'rrh-bypass-audit-'));
    try {
      const harness = `
set -euo pipefail
EXTENSION_ROOT='${extensionRoot}'
SRC_V='1.0.0'
DEP_V='1.0.0'
INVOCATION='install.sh --closer-context'
OVERRIDE_ACTIVE=0
NO_CONFIRM=1
CLOSER_CONTEXT=1
eval "$(awk '/^append_bypass_active_session_audit\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}' '${INSTALL_SH}')"
append_bypass_active_session_audit ''
`;
      const result = spawnSync('bash', ['-c', harness], { encoding: 'utf-8', timeout: 30_000 });
      assert.equal(result.status, 0, `harness exited non-zero: ${result.stderr}`);
      const event = JSON.parse(
        readFileSync(path.join(extensionRoot, 'deploy-audit.log'), 'utf8').trim(),
      );
      assert.equal(event.session_id, null);
      assert.equal(event.closer_context, true);
      assert.equal(event.no_confirm, true);
      assert.equal(event.override_active, false);
    } finally {
      rmSync(extensionRoot, { recursive: true, force: true });
    }
  });

  test('source: helper exists and emits the documented event literal', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(src, /append_bypass_active_session_audit\(\)\s*\{/);
    assert.match(src, /--arg event "INSTALL_BYPASS_ACTIVE_SESSION"/);
  });

  test('source: bypass branch invokes the helper after the refuse exit', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    // Guard restructured to detect-first: refuse on non-bypass, else emit.
    assert.match(
      src,
      /if active_session_id="\$\(find_active_session\)"; then[\s\S]*?exit 2[\s\S]*?append_bypass_active_session_audit "\$active_session_id"/,
      'bypass branch must call append_bypass_active_session_audit with the live session id',
    );
  });

  test('source: the R-ITS-5-MIN REFUSE message is preserved (no guard regression)', () => {
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.match(
      src,
      /❌ REFUSE: install\.sh blocked — active session \$active_session_id is in flight\./,
    );
  });

  test('README <-> install.sh event-name parity', () => {
    const readme = readFileSync(README, 'utf8');
    const src = readFileSync(INSTALL_SH, 'utf8');
    assert.ok(readme.includes(EVENT), 'README must document the event');
    assert.ok(src.includes(EVENT), 'install.sh must emit the event');
  });
});
