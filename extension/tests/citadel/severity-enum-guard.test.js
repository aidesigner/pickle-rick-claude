// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findBannedCasts } from '../../services/citadel/banned-casts-audit.js';
import { findStaleReferences, extractBareIdentifiers } from '../../services/citadel/stale-reference-audit.js';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';

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
});
