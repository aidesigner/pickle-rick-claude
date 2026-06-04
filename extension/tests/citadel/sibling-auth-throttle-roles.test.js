// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

function withController(content, fn) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-tr-'));
  try {
    const filePath = 'src/runs.controller.ts';
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, filePath), content);
    const diff = {
      range: 'main..HEAD', base: 'main', head: 'HEAD', repoRoot,
      changedFiles: [{ path: filePath, status: 'M', kind: 'production', changedLines: [], blame: [] }],
      claudeFiles: [],
    };
    return fn(diff);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('sibling-auth: @Throttle parity', () => {
  test('fires when one sibling route has @Throttle and the other does not', () => {
    const report = withController([
      '@Controller("runs/:id")',
      'export class RunsController {',
      '  @Throttle({ default: { limit: 3, ttl: 60 } })',
      '  @Get("comparison")',
      '  getComparison() { return true; }',
      '',
      '  @Get("summary")',
      '  getSummary() { return true; }',
      '}',
      '',
    ].join('\n'), (diff) => auditSiblingAuthPreconditions(diff));

    assert.equal(report.guardParityFindings.length, 1);
    assert.ok(report.guardParityFindings[0].missingGuards.includes('throttle'));
  });

  test('silent when both sibling routes carry @Throttle', () => {
    const report = withController([
      '@Controller("runs/:id")',
      'export class RunsController {',
      '  @Throttle({ default: { limit: 3, ttl: 60 } })',
      '  @Get("comparison")',
      '  getComparison() { return true; }',
      '',
      '  @Throttle({ default: { limit: 3, ttl: 60 } })',
      '  @Get("summary")',
      '  getSummary() { return true; }',
      '}',
      '',
    ].join('\n'), (diff) => auditSiblingAuthPreconditions(diff));

    assert.equal(report.guardParityFindings.length, 0);
  });
});

describe('sibling-auth: destructive-verb weaker-@Roles (nestjs-api gated)', () => {
  const controller = [
    '@Controller("runs/:id")',
    'export class RunsController {',
    '  @Roles("admin")',
    '  @Delete("runs")',
    '  deleteRun() { return true; }',
    '',
    '  @Roles("admin", "ops")',
    '  @Delete("purge")',
    '  purgeRun() { return true; }',
    '}',
    '',
  ].join('\n');

  test('fires for the weaker (superset) destructive sibling when nestjs-api', () => {
    const report = withController(controller, (diff) =>
      auditSiblingAuthPreconditions(diff, { projectShapes: ['nestjs-api'] }));
    assert.equal(report.weakerDestructiveRoleFindings.length, 1);
    const finding = report.weakerDestructiveRoleFindings[0];
    assert.equal(finding.severity, 'High');
    assert.match(finding.method, /purgeRun/);
    assert.deepEqual(finding.roles, ['admin', 'ops']);
    assert.deepEqual(finding.stricterSiblingRoles, ['admin']);
    assert.ok(report.findings.some((f) => f.id === finding.id));
  });

  test('silent (gated off) when project shape is not nestjs-api', () => {
    const report = withController(controller, (diff) =>
      auditSiblingAuthPreconditions(diff, { projectShapes: ['node-cli'] }));
    assert.deepEqual(report.weakerDestructiveRoleFindings, []);
  });

  test('silent when no options are supplied (default off)', () => {
    const report = withController(controller, (diff) => auditSiblingAuthPreconditions(diff));
    assert.deepEqual(report.weakerDestructiveRoleFindings, []);
  });
});

describe('sibling-auth: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.sibling_auth_preconditions;
    assert.ok(section, 'sibling_auth_preconditions section must exist');
    assert.deepEqual(section.findings, []);
    assert.deepEqual(section.weakerDestructiveRoleFindings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'sibling_auth_preconditions');
    assert.deepEqual(leaked, []);
  });
});
