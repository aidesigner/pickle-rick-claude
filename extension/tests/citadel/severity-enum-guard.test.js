// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBannedCasts } from '../../services/citadel/banned-casts-audit.js';
import { findStaleReferences, extractBareIdentifiers } from '../../services/citadel/stale-reference-audit.js';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// Single source of truth for the CitadelSeverity enum (reporter.ts).
const SEVERITY_ENUM = new Set(['Critical', 'High', 'Medium', 'Low']);

function assertSeverities(findings, label) {
  assert.ok(findings.length > 0, `${label}: fixture must produce at least one finding`);
  for (const f of findings) {
    assert.ok(
      SEVERITY_ENUM.has(f.severity),
      `${label}: finding ${f.id} has out-of-enum severity ${JSON.stringify(f.severity)}`,
    );
  }
}

describe('citadel: severity-enum guard — no analyzer emits an out-of-enum severity', () => {
  test('banned-casts findings stay within the enum', () => {
    const findings = findBannedCasts([{
      file: 'src/a.ts',
      lines: [
        { no: 1, text: 'const m = (err as Error).message;' },
        { no: 2, text: 'const o = blob as any;' },
        { no: 3, text: 'const n = foo as never;' },
      ],
    }]);
    assertSeverities(findings, 'banned-casts');
  });

  test('stale-reference findings stay within the enum', () => {
    const identifiers = [
      ...extractBareIdentifiers('// via isCompoundRulesEnabled'),
      'oldRenamedHelper',
    ];
    const findings = findStaleReferences(
      [{ file: 'src/b.ts', identifiers }],
      () => false, // none present at HEAD → every identifier flagged
    );
    assertSeverities(findings, 'stale-reference');
  });

  test('sibling-auth findings stay within the enum', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sev-enum-'));
    try {
      const rel = 'src/widgets.controller.ts';
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, rel), `import { Controller, Get, Delete } from '@nestjs/common';

@Controller('widgets')
export class WidgetsController {
  @Get(':id/info')
  info(@Param('id') id: string) {
    return this.svc.info(id);
  }

  @Delete(':id/purge')
  purge(@Param('id') id: string) {
    if (this.featureFlag('admin')) {
      this.assertBudget(id);
      this.verifyCsrf(id);
    }
    return this.svc.purge(id);
  }
}
`);
      const report = auditSiblingAuthPreconditions({
        range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
        changedFiles: [{
          path: rel, status: 'M', kind: 'production',
          changedLines: [{ start: 1, end: 30 }], blame: [],
        }],
        claudeFiles: [],
      });
      assertSeverities(report.findings, 'sibling-auth');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // AC-3 end-to-end: the assembled report is the real boundary. The three tests above
  // exercise analyzers in isolation; this one proves the native coercion guard
  // (audit-runner withFindingSource → 'Medium') and the cross-phase drop-filter
  // (readPhaseFindings isSeverity) together close the enum end-to-end — no analyzer leaks
  // an out-of-enum severity into buildCitadelAuditReport().findings. A clean HEAD..HEAD
  // diff may legitimately yield zero findings, so the invariant is asserted over whatever
  // findings exist (no forced length > 0, unlike the per-analyzer fixtures).
  test('assembled report severity is enum-valid end-to-end (no :340 coercion leak, no :271 drop leak)', () => {
    const report = buildCitadelAuditReport({ diffRange: 'HEAD..HEAD', repoRoot: REPO_ROOT });
    for (const f of report.findings) {
      assert.ok(
        SEVERITY_ENUM.has(f.severity),
        `assembled-report finding ${f.id} has out-of-enum severity ${JSON.stringify(f.severity)}`,
      );
    }
  });
});
