// @tier: fast
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(extensionRoot, 'scripts', 'regression-test-fast-integration-3x.sh');
const packageJsonPath = path.join(extensionRoot, 'package.json');

describe('R-TFP-C3 regression-test-fast-integration-3x.sh', () => {
  test('script file exists and is executable', () => {
    const stat = fs.statSync(scriptPath);
    assert.ok(stat.isFile(), 'script must be a regular file');
    assert.ok((stat.mode & 0o111) !== 0, 'script must have executable bit set');
  });

  test('script has valid bash syntax', () => {
    const result = spawnSync('bash', ['-n', scriptPath], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, `bash -n failed: ${result.stderr}`);
  });

  test('package.json wires test:regression-3x to bash invocation', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const script = pkg.scripts?.['test:regression-3x'];
    assert.ok(script, 'test:regression-3x npm script must exist');
    assert.match(script, /bash\s+scripts\/regression-test-fast-integration-3x\.sh/);
  });

  test('skip-guard: RUN_REGRESSION_3X unset exits 0 with SKIP message', () => {
    const env = { ...process.env };
    delete env.RUN_REGRESSION_3X;
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env,
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'unset RUN_REGRESSION_3X must exit 0');
    assert.match(result.stderr, /SKIP.*RUN_REGRESSION_3X/);
  });

  test('skip-guard: RUN_REGRESSION_3X empty exits 0 with SKIP message', () => {
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, RUN_REGRESSION_3X: '' },
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'empty RUN_REGRESSION_3X must exit 0');
    assert.match(result.stderr, /SKIP.*RUN_REGRESSION_3X/);
  });

  test('script source contains loop count = 3 and JSONL append', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.match(source, /TOTAL_RUNS=3\b/, 'TOTAL_RUNS must equal 3');
    assert.match(source, /r-tfp-regression-log\.jsonl/, 'JSONL log path must be present');
    assert.match(source, />>\s*"\$LOG_FILE"/, 'JSONL append redirection must be present');
    assert.match(source, /"run":/, 'JSONL record must include run key');
    assert.match(source, /\$i/, 'JSONL record must interpolate $i');
    assert.match(source, /"status":/, 'JSONL record must include status key');
    assert.match(source, /\$run_status/, 'JSONL record must interpolate $run_status');
    assert.match(source, /"fast_exit":/, 'JSONL record must include fast_exit key');
    assert.match(source, /\$fast_exit/, 'JSONL record must interpolate $fast_exit');
    assert.match(source, /"integration_exit":/, 'JSONL record must include integration_exit key');
    assert.match(source, /\$integration_exit/, 'JSONL record must interpolate $integration_exit');
    assert.match(source, /"duration_ms":/, 'JSONL record must include duration_ms key');
    assert.match(source, /\$duration_ms/, 'JSONL record must interpolate $duration_ms');
  });

  test('script uses set -euo pipefail for fail-fast semantics', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    assert.match(source, /set -euo pipefail/, 'set -euo pipefail must be present');
  });
});
