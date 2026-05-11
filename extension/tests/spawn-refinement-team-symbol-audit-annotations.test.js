// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSymbolAudit } from '../bin/spawn-refinement-team.js';

function buildPrd(annotation = '') {
  return `# Bundle PRD

## Activity Events

Activity events: \`my_new_event\`${annotation}.
`;
}

test('forward-create event annotation: accepts `(forward-created)` and reports forward-create', () => {
  const report = evaluateSymbolAudit(buildPrd(' (forward-created)'), process.cwd(), { tickets: [] });
  const event = report.activityEvents.find((ref) => ref.symbol === 'my_new_event');

  assert.ok(event, 'expected my_new_event reference');
  assert.equal(event.status, 'forward-create');
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('forward-create event annotation variants: accepts ticket and requirement-code suffixes', () => {
  const prd = `# Bundle PRD

## Activity Events

Activity events: \`my_new_event\` (forward-created), \`other_new_event\` (introduced by ticket abcd1234), \`third_new_event\` (created by R-SAOV-1).
`;
  const report = evaluateSymbolAudit(prd, process.cwd(), { tickets: [] });
  const statuses = Object.fromEntries(report.activityEvents.map((ref) => [ref.symbol, ref.status]));

  assert.deepEqual(statuses, {
    my_new_event: 'forward-create',
    other_new_event: 'forward-create',
    third_new_event: 'forward-create',
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('unannotated forward-create: unknown event still reports phantom', () => {
  const report = evaluateSymbolAudit(buildPrd(), process.cwd(), { tickets: [] });
  const event = report.activityEvents.find((ref) => ref.symbol === 'my_new_event');

  assert.ok(event, 'expected my_new_event reference');
  assert.equal(event.status, 'phantom');
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.category === 'activity_event' && finding.symbol === 'my_new_event'));
});
