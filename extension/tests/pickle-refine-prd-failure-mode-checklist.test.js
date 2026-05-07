// @tier: fast
/**
 * R-TAQ-4 / Section F — pickle-refine-prd skill must contain the Failure-mode
 * checklist subsection enumerating all 7 defect-class tags, plus the
 * `<!-- audit: 7-class checked YYYY-MM-DD -->` audit-comment contract.
 *
 * AC-TAQ-04: substring lint
 * AC-TAQ-04-2: parametrized 7-class enumeration
 * AC-TAQ-04-3: missing-audit-comment scanner trips on bodies without the comment
 *              and stays silent when the comment is present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'pickle-refine-prd.md');
const { checkMissingAuditComment } = await import('../bin/audit-ticket-bundle.js');

test('AC-TAQ-04: pickle-refine-prd.md contains "Failure-mode checklist"', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf-8');
  const matches = content.match(/Failure-mode checklist/g) || [];
  assert.ok(matches.length >= 1, `expected ≥1 occurrence, got ${matches.length}`);
});

test('AC-TAQ-04: pickle-refine-prd.md documents the audit-comment contract', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf-8');
  assert.ok(
    content.includes('<!-- audit: 7-class checked YYYY-MM-DD -->'),
    'audit-comment template literal must appear in the skill',
  );
});

const SEVEN_CLASS_TAGS = [
  'path-drift',
  'self-referential-AC',
  'missing-deps',
  'wrong-HEAD-assumptions',
  'cross-doc-naming',
  'hallucinated-premise',
  'literal-value-drift',
];

for (const tag of SEVEN_CLASS_TAGS) {
  test(`AC-TAQ-04-2: failure-mode checklist enumerates "${tag}"`, () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf-8');
    assert.ok(content.includes(tag), `tag ${tag} missing from skill`);
  });
}

function makeTicket(body) {
  return {
    id: 'aabbccdd',
    title: 'fixture',
    filePath: '/fake/aabbccdd/linear_ticket_aabbccdd.md',
    relPath: 'aabbccdd/linear_ticket_aabbccdd.md',
    mappedRequirements: [],
    body,
    problemSection: '',
    dependenciesLine: '',
  };
}

test('AC-TAQ-04-3: ticket body without audit comment fires missing-audit-comment finding', () => {
  const findings = checkMissingAuditComment(makeTicket('# Description\n\nNo audit comment here.'));
  assert.equal(findings.length, 1, `expected 1 finding, got ${findings.length}`);
  assert.equal(findings[0].defect_class, 'missing-audit-comment');
  assert.equal(findings[0].severity, 'info');
  assert.equal(findings[0].ticket_id, 'aabbccdd');
});

test('AC-TAQ-04-3: ticket body with valid audit comment produces no finding', () => {
  const body = '# Description\n\n<!-- audit: 7-class checked 2026-05-07 -->\n\nbody text';
  const findings = checkMissingAuditComment(makeTicket(body));
  assert.equal(findings.length, 0, 'expected no finding with valid comment');
});

test('AC-TAQ-04-3: malformed audit comment (missing date) fires the finding', () => {
  const body = '# Description\n\n<!-- audit: 7-class checked -->\n';
  const findings = checkMissingAuditComment(makeTicket(body));
  assert.equal(findings.length, 1, 'expected finding for malformed (no date) comment');
});

test('AC-TAQ-04-3: malformed audit comment (wrong-shape date) fires the finding', () => {
  const body = '# Description\n\n<!-- audit: 7-class checked May 7 -->\n';
  const findings = checkMissingAuditComment(makeTicket(body));
  assert.equal(findings.length, 1, 'expected finding for wrong-shape date');
});
