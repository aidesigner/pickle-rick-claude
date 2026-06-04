// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findSchemaRegistryDrift,
  auditSchemaRegistryDrift,
} from '../../services/citadel/schema-registry-drift-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

const POSITIVE = `
import { pgEnum } from 'drizzle-orm/pg-core';

export const ticketStatus = pgEnum('ticket_status', ['Todo', 'InProgress', 'Done']);

// registry-mirror: ticket_status
export const TICKET_STATUS_VALUES = ['Todo', 'Done', 'Cancelled'] as const;
`;

const NEGATIVE = `
import { pgEnum } from 'drizzle-orm/pg-core';

export const ticketStatus = pgEnum('ticket_status', ['Todo', 'InProgress', 'Done']);

// registry-mirror: ticket_status
export const TICKET_STATUS_VALUES = ['Todo', 'InProgress', 'Done'] as const;
`;

describe('schema-registry-drift-audit: positive fixture', () => {
  test('fires when mirror members drift from pgEnum members', () => {
    const findings = findSchemaRegistryDrift([{ path: 'src/schema.ts', content: POSITIVE }]);
    assert.equal(findings.length, 1);
    assert.match(findings[0].id, /^schema-registry-drift:/);
    assert.equal(findings[0].severity, 'Medium');
    // drift: mirror missing InProgress, mirror has extra Cancelled
    assert.match(findings[0].message, /InProgress/);
    assert.match(findings[0].message, /Cancelled/);
  });

  test('also detects check(... in (...)) constraints', () => {
    const content = `
      export const t = pgTable('t', { s: text('s') }, (tbl) => ({
        sCheck: check('s_kind', sql\`s in ('a', 'b')\`),
      }));
      // registry-mirror: s_kind
      export const S_KIND = ['a', 'c'] as const;
    `;
    const findings = findSchemaRegistryDrift([{ path: 'src/t.ts', content }]);
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /'s_kind'/);
  });
});

describe('schema-registry-drift-audit: negative fixture', () => {
  test('silent when mirror matches pgEnum exactly', () => {
    const findings = findSchemaRegistryDrift([{ path: 'src/schema.ts', content: NEGATIVE }]);
    assert.deepEqual(findings, []);
  });

  test('silent when enum has no declared registry mirror', () => {
    const content = `export const e = pgEnum('e', ['a', 'b']);\n`;
    const findings = findSchemaRegistryDrift([{ path: 'src/e.ts', content }]);
    assert.deepEqual(findings, []);
  });

  test('auditSchemaRegistryDrift silent on empty diff', () => {
    const result = auditSchemaRegistryDrift({
      range: 'HEAD..HEAD',
      base: 'HEAD',
      head: 'HEAD',
      repoRoot: REPO_ROOT,
      changedFiles: [],
      claudeFiles: [],
    });
    assert.deepEqual(result.findings, []);
  });
});

describe('schema-registry-drift-audit: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.schema_registry_drift;
    assert.ok(section, 'schema_registry_drift section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'schema_registry_drift');
    assert.deepEqual(leaked, []);
  });
});
