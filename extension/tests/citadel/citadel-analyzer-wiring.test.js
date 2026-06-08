// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CITADEL_SRC = path.resolve(__dirname, '../../src/services/citadel');
const AUDIT_RUNNER_SRC = path.resolve(__dirname, '../../src/services/citadel/audit-runner.ts');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

const FILENAME_EXCLUDED = new Set([
  'audit-runner.ts',
  'reporter.ts',
  'diff-walker.ts',
  'prd-parser.ts',
  'trap-doors-section.ts',
  // R-HRP-2 adapter (CitadelFinding[] -> GateResult) for the remediation feed —
  // consumed by the gate/remediator path, not an analyzer wired into audit-runner.
  'citadel-findings-to-gate-result.ts',
]);

function isFilenameExcluded(basename) {
  if (FILENAME_EXCLUDED.has(basename)) return true;
  if (basename.endsWith('-helpers.ts')) return true;
  if (basename.endsWith('-types.ts')) return true;
  return false;
}

// A file is an analyzer if it has any non-type runtime export.
// Files with only `export interface` / `export type` declarations are utility-only.
function hasRuntimeExport(content) {
  return (
    /^export\s+(async\s+)?function\s/m.test(content) ||
    /^export\s+const\s/m.test(content) ||
    /^export\s+let\s/m.test(content) ||
    /^export\s+class\s/m.test(content) ||
    /^export\s+default\s/m.test(content)
  );
}

function discoverAnalyzerModules(citadelSrcDir) {
  const files = fs.readdirSync(citadelSrcDir).filter((f) => f.endsWith('.ts'));
  return files
    .filter((f) => !isFilenameExcluded(f))
    .filter((f) => {
      const content = fs.readFileSync(path.join(citadelSrcDir, f), 'utf-8');
      return hasRuntimeExport(content);
    })
    .map((f) => path.basename(f, '.ts'))
    .sort();
}

function findUnwiredModules(moduleNames, auditRunnerContent) {
  return moduleNames.filter((name) => {
    const importRe = new RegExp(`from\\s+['"]\\./${name}(?:\\.js)?['"]`);
    return !importRe.test(auditRunnerContent);
  });
}

describe('citadel-analyzer-wiring: import check', () => {
  test('every non-excluded analyzer module is imported in audit-runner.ts', () => {
    const auditRunnerContent = fs.readFileSync(AUDIT_RUNNER_SRC, 'utf-8');
    const modules = discoverAnalyzerModules(CITADEL_SRC);

    assert.ok(
      modules.length >= 10,
      `Expected at least 10 analyzer modules; got ${modules.length}: ${modules.join(', ')}`,
    );

    const unwired = findUnwiredModules(modules, auditRunnerContent);
    assert.deepStrictEqual(
      unwired,
      [],
      `Unwired analyzer modules detected:\n${unwired.map((m) => `  - ${m}.ts`).join('\n')}\n\nAll discovered modules: ${modules.join(', ')}`,
    );
  });
});

describe('citadel-analyzer-wiring: adversarial', () => {
  test('fake unwired analyzer module is detected as unwired', () => {
    const auditRunnerContent = fs.readFileSync(AUDIT_RUNNER_SRC, 'utf-8');
    const realModules = discoverAnalyzerModules(CITADEL_SRC);
    const adversarialModules = [...realModules, 'fake-unwired-analyzer'];
    const unwired = findUnwiredModules(adversarialModules, auditRunnerContent);
    assert.ok(
      unwired.includes('fake-unwired-analyzer'),
      `Expected fake-unwired-analyzer to be detected; unwired set: ${JSON.stringify(unwired)}`,
    );
  });
});

describe('citadel-analyzer-wiring: exclusion', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('*-helpers.ts excluded by filename pattern', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'my-helpers.ts'),
      'export function helper() { return 1; }\n',
    );
    const modules = discoverAnalyzerModules(tmpDir);
    assert.ok(!modules.includes('my-helpers'), '*-helpers.ts must be excluded by filename');
  });

  test('*-types.ts excluded by filename pattern', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'my-types.ts'),
      'export interface Foo { bar: string; }\n',
    );
    const modules = discoverAnalyzerModules(tmpDir);
    assert.ok(!modules.includes('my-types'), '*-types.ts must be excluded by filename');
  });

  test('named exclusions not present in real CITADEL_SRC discovery', () => {
    const modules = discoverAnalyzerModules(CITADEL_SRC);
    for (const excluded of ['audit-runner', 'reporter', 'diff-walker', 'prd-parser']) {
      assert.ok(!modules.includes(excluded), `${excluded} must be excluded by filename`);
    }
  });

  test('file with only interface exports excluded by runtime-export check', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'pure-types.ts'),
      'export interface Foo { x: number; }\nexport type Bar = string;\n',
    );
    const modules = discoverAnalyzerModules(tmpDir);
    assert.ok(!modules.includes('pure-types'), 'interface-only file must be excluded');
  });

  test('file with export function is included', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'real-analyzer.ts'),
      'export function auditFoo() { return { findings: [] }; }\n',
    );
    const modules = discoverAnalyzerModules(tmpDir);
    assert.ok(modules.includes('real-analyzer'), 'file with export function must be included');
  });
});

describe('citadel-analyzer-wiring: invocation probe', () => {
  const EXPECTED_SECTION_KEYS = [
    'sibling_auth_preconditions',
    'frontend_prop_drift',
    'ac_shape',
    'rule_set_invariants',
    'diff_hygiene',
    'divergence_reconciliation',
    'cross_phase',
    'ac_coverage',
    'allowlist_dead',
    'state_transitions',
    'trap_door_coverage',
    'endpoint_contract_conformance',
    'schema_registry_drift',
    'test_authenticity',
    'stale_reference',
    'banned_constructs',
    'banned_casts',
    'pattern_conformance',
  ];

  test('buildCitadelAuditReport produces all expected section keys on HEAD..HEAD', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file in prds/');
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    const missingSections = EXPECTED_SECTION_KEYS.filter(
      (key) => !Object.prototype.hasOwnProperty.call(report.sections, key),
    );
    assert.deepStrictEqual(
      missingSections,
      [],
      `Missing section keys in report: ${missingSections.join(', ')}`,
    );
  });
});
