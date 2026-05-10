// @tier: fast
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCitadelAuditReport,
  __setAnalyzerOverridesForTests,
} from '../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_RUNNER_SRC = path.resolve(__dirname, '../src/services/citadel/audit-runner.ts');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

const EXPECTED_IMPORTS = [
  "from './ac-coverage-scorecard",
  "from './allowlist-dead-entry-detector",
  "from './state-transition-audit",
  "from './trap-door-coverage-audit",
];

const NEW_SECTION_KEYS = ['ac_coverage', 'allowlist_dead', 'state_transitions', 'trap_door_coverage'];

afterEach(() => {
  __setAnalyzerOverridesForTests(null);
});

describe('citadel audit-runner wiring', () => {
  test('all 4 new analyzers are imported in audit-runner.ts source', () => {
    const src = fs.readFileSync(AUDIT_RUNNER_SRC, 'utf-8');
    for (const importFragment of EXPECTED_IMPORTS) {
      assert.ok(
        src.includes(importFragment),
        `Expected import not found: ${importFragment}`,
      );
    }
  });

  test('all 4 new sections present in report from clean HEAD..HEAD diff', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file in prds/');
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    for (const key of NEW_SECTION_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.sections, key),
        `sections missing key: ${key}`,
      );
    }
  });

  test('per-analyzer error isolation: one throws, other 3 sections still present with correct shapes', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    __setAnalyzerOverridesForTests(new Map([
      ['citadel-ac-coverage', () => { throw new Error('injected ac-coverage failure'); }],
    ]));

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    // Failed section has analyzer_threw
    const failedSection = report.sections['ac_coverage'];
    assert.ok(failedSection, 'ac_coverage section should exist even when analyzer throws');
    assert.ok(
      Array.isArray(failedSection.findings) && failedSection.findings.length > 0,
      'failed section should have at least one finding',
    );
    assert.equal(failedSection.findings[0].analyzer_threw, true, 'finding should have analyzer_threw=true');
    assert.equal(failedSection.findings[0].severity, 'Low');

    // Other 3 sections still present
    const otherKeys = NEW_SECTION_KEYS.filter((k) => k !== 'ac_coverage');
    for (const key of otherKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.sections, key),
        `sections missing key after ac_coverage throw: ${key}`,
      );
    }
  });
});
