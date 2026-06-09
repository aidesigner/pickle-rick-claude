// @tier: integration
// SERIAL: subprocess-heavy — the audit script itself spawns bash+grep across all test files (~19s
// under no load); R-TFP precedent (cf600408) promotes such tests to integration+serial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-subprocess-heavy-tests.sh');
const FIXTURES = path.resolve(__dirname, 'fixtures/audit-subprocess-heavy-tests');

test('audit-subprocess-heavy-tests: candidate fixture exits 1 (unflagged bash+short-timeout)', () => {
  const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'candidate.test.js')], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(
    result.status,
    1,
    `expected exit 1 for unflagged candidate; stderr=${result.stderr}`,
  );
  assert.match(result.stderr, /subprocess-heavy candidate not serialized/);
});

test('audit-subprocess-heavy-tests: exempt-serial fixture exits 0 (SERIAL comment allowlist)', () => {
  const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'exempt-serial.test.js')], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0 for SERIAL-exempted file; stderr=${result.stderr}`,
  );
});

test('audit-subprocess-heavy-tests: exempt-flag-arg fixture exits 0 (bash -flag not flagged)', () => {
  const result = spawnSync('bash', [SCRIPT, path.join(FIXTURES, 'exempt-flag-arg.test.js')], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(
    result.status,
    0,
    `expected exit 0 for flag-arg bash spawn; stderr=${result.stderr}`,
  );
});

test('audit-subprocess-heavy-tests: real tests/ directory exits 0 (no new violations)', () => {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf-8',
    timeout: 30000,
  });
  assert.equal(
    result.status,
    0,
    `audit found violations in real tests/; stderr=${result.stderr}`,
  );
});

test('audit-subprocess-heavy-tests: 10000ms-band candidate WARNs but does NOT hard-fail (exit 0)', () => {
  const tmpFile = path.join(
    os.tmpdir(),
    `warn-band-candidate.${process.pid}.${Date.now()}.test.js`,
  );
  // Non-serialized (no // SERIAL:) bash spawn with a 10000ms timeout: WARN band.
  fs.writeFileSync(
    tmpFile,
    [
      '// @tier: integration',
      "import { spawnSync } from 'node:child_process';",
      "spawnSync('bash', ['/some/script.sh'], { encoding: 'utf-8', timeout: 10000 });",
      '',
    ].join('\n'),
  );
  try {
    const result = spawnSync('bash', [SCRIPT, tmpFile], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    assert.equal(
      result.status,
      0,
      `WARN-band candidate must NOT hard-fail; stderr=${result.stderr}`,
    );
    assert.match(result.stderr, /WARN:.*6000-15000ms band/);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});
