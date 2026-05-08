// @tier: integration
//
// R-APBN-5 — End-to-end regression for the anatomy-park silent-skip-baseline
// failure mode (PRD: prds/p1-anatomy-park-detectproject-null-skips-baseline.md).
//
// Synthesizes a minimal repo layout that mimics this repo's failure mode: no
// project-type marker at the workingDir root, but an `extension/package.json`
// nested one level down. Invokes runGate({mode:'baseline', ...}) directly
// (lighter than the full pipeline-runner) and asserts the no-project-type
// early-return path WRITES `gate/baseline.json` so downstream
// pathExists(baselinePath) consumers (microverse-runner trap door) survive.
//
// If Agent 1's convergence-gate.ts fix has not landed yet, this test fails
// with the original "no baseline written" symptom — that's expected; the
// orchestrator re-runs after the fix lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runGate } = await import(
  path.resolve(__dirname, '../../services/convergence-gate.js')
);

function makeFixtureRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Repo root mimics pickle-rick-claude: bin/ at root with placeholders, no
  // package.json or lockfile here, no Cargo.toml, no go.mod. The only project
  // marker lives under extension/.
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'foo.js'), '// placeholder\n');
  fs.writeFileSync(path.join(dir, 'bin', 'bar.js'), '// placeholder\n');
  fs.writeFileSync(path.join(dir, 'bin', 'baz.js'), '// placeholder\n');

  fs.mkdirSync(path.join(dir, 'extension', 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension', 'package.json'),
    JSON.stringify({ name: 'fixture-extension', private: true, version: '0.0.1' }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'extension', 'src', 'hello.ts'),
    'export const hello = () => "world";\n',
  );

  fs.mkdirSync(path.join(dir, 'prds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prds', 'sample.md'), '# placeholder\n');

  return dir;
}

test('R-APBN-5: runGate({mode:baseline}) at no-project-type root WRITES baseline.json', async () => {
  const tmpdir = makeFixtureRepo('ap-no-project-root-');
  const baselinePath = path.join(tmpdir, 'gate', 'baseline.json');

  try {
    const result = await runGate({
      mode: 'baseline',
      workingDir: tmpdir,
      baselinePath,
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
    });

    // (1) Gate succeeded — early-return path treats a no-project-type tree
    // as a vacuously green baseline.
    assert.equal(
      result.status,
      'green',
      `gate must return green for no-project-type workingDir, got: ${JSON.stringify(result)}`,
    );

    // (2) No failures recorded.
    assert.equal(
      result.failures.length,
      0,
      `gate must report zero failures for no-project-type workingDir, got: ${JSON.stringify(result.failures)}`,
    );

    // (3) baseline.json file MUST exist on disk post-write — this is the
    // operative assertion that catches the original silent-skip bug. Without
    // the R-APBN-1 fix, runGate's early-return path returns a green result
    // without ever writing baselinePath, and the microverse-runner trap door
    // throws gate_baseline_init_failed downstream.
    assert.ok(
      fs.existsSync(baselinePath),
      `gate/baseline.json MUST exist on disk after baseline-mode runGate, expected at ${baselinePath}`,
    );

    // (4) The written baseline.json is parseable JSON with empty checks +
    // empty failures arrays. project_type may be null (R-APBN-1 schema
    // extension) or any string Agent 1 chose; both are accepted because the
    // operative invariant is empty arrays, not the precise project-type
    // sentinel.
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.ok(
      Array.isArray(baseline.checks),
      `baseline.checks must be an array, got: ${JSON.stringify(baseline.checks)}`,
    );
    assert.equal(
      baseline.checks.length,
      0,
      `baseline.checks must be empty for no-project-type workingDir, got: ${JSON.stringify(baseline.checks)}`,
    );
    assert.ok(
      Array.isArray(baseline.failures),
      `baseline.failures must be an array, got: ${JSON.stringify(baseline.failures)}`,
    );
    assert.equal(
      baseline.failures.length,
      0,
      `baseline.failures must be empty for no-project-type workingDir, got: ${JSON.stringify(baseline.failures)}`,
    );
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});
