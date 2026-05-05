// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_RESUME_SH = path.resolve(__dirname, '..', 'scripts', 'auto-resume.sh');

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'ar-sc-'));
}

function makeFixture({ ticket = 'abc123' } = {}) {
  const tmp = makeTmpDir();
  const extRoot = path.join(tmp, 'ext');
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    current_ticket: ticket,
  }));
  return { tmp, extRoot, sessionDir };
}

function writeMuxRunner(extRoot, cjsBody) {
  writeFileSync(path.join(extRoot, 'extension', 'bin', 'mux-runner.js'), cjsBody);
}

function runScript(sessionDir, extRoot, envOverrides = {}) {
  return spawnSync('bash', [AUTO_RESUME_SH, sessionDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PICKLE_AUTO_RESUME_ON_CAP_HIT: '1',
      PICKLE_INSTALL_ROOT: extRoot,
      ...envOverrides,
    },
    timeout: 30000,
  });
}

// CJS mock: always sets exit_reason to the given value
function incompleteRunner() {
  return `const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`;
}

describe('auto-resume.stop-conditions', () => {
  test('--help exits 0', () => {
    const result = spawnSync('bash', [AUTO_RESUME_SH, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('PICKLE_AUTO_RESUME_MAX_RETRIES'), 'help text missing MAX_RETRIES env');
    assert.ok(result.stdout.includes('pipeline_phase_incomplete'), 'help text missing stop-condition mention');
  });

  test('halts on non-pipeline_phase_incomplete exit_reason', () => {
    const { tmp, extRoot, sessionDir } = makeFixture();
    try {
      writeMuxRunner(extRoot, `const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'ticket_audit_failed';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`);
      const result = runScript(sessionDir, extRoot);
      assert.ok(
        result.stderr.includes("exit_reason='ticket_audit_failed'"),
        `expected stop on non-incomplete reason; stderr:\n${result.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('halts when MAX_RETRIES exhausted', () => {
    const { tmp, extRoot, sessionDir } = makeFixture();
    try {
      writeMuxRunner(extRoot, incompleteRunner());
      const result = runScript(sessionDir, extRoot, { PICKLE_AUTO_RESUME_MAX_RETRIES: '2' });
      assert.ok(
        result.stderr.includes('exhausted max retries (2)'),
        `expected max-retries stop; stderr:\n${result.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('halts on no-progress past PROGRESS_THRESHOLD', () => {
    // PROGRESS_THRESHOLD=3 hardcoded; same ticket + 0 done → fires at retry 3
    const { tmp, extRoot, sessionDir } = makeFixture({ ticket: 'stuck-ticket' });
    try {
      writeMuxRunner(extRoot, `const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
s.current_ticket = 'stuck-ticket';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`);
      const result = runScript(sessionDir, extRoot, { PICKLE_AUTO_RESUME_MAX_RETRIES: '20' });
      assert.ok(
        result.stderr.includes('no progress'),
        `expected no-progress stop; stderr:\n${result.stderr}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('prints [warn] banner past retry 3', () => {
    // Rotate ticket each call so no-progress stop does not fire before retry 4
    const { tmp, extRoot, sessionDir } = makeFixture();
    try {
      writeMuxRunner(extRoot, `const fs = require('fs');
const cf = process.argv[2] + '/.n';
let n = 0;
try { n = parseInt(fs.readFileSync(cf, 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync(cf, String(n));
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
s.current_ticket = 'ticket_' + n;
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`);
      // MAX_RETRIES=5 → banner fires at retry 4, stop fires at retry 5
      const result = runScript(sessionDir, extRoot, { PICKLE_AUTO_RESUME_MAX_RETRIES: '5' });
      assert.ok(
        result.stderr.includes('[warn] auto-resume retry'),
        `expected [warn] banner; stderr:\n${result.stderr}`,
      );
      const bannerLines = result.stderr.split('\n').filter(l => l.includes('[warn] auto-resume retry'));
      for (const line of bannerLines) {
        assert.match(
          line,
          /\[warn\] auto-resume retry \d+\/\d+ \(no progress for \d+ cycles\)/,
          `banner format mismatch: ${line}`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
