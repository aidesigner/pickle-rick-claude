// @tier: fast
/**
 * audit-ticket-bundle.test.js — AC-TAQ-02-2
 *
 * Asserts the forward-create-OK invariant for checkPathDrift:
 *   ATB-01 — path under "## Files to create" not in git → no path-drift finding
 *   ATB-02 — path under "## Files to modify" not in git → path-drift finding
 *   ATB-03 — path under "## Files to modify" present in git → no finding
 *   ATB-04 — path with (forward-created) annotation in "## Files to modify" → no finding
 *   ATB-05 — extractForwardCreatePaths only captures paths in the create section
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..', 'bin', 'audit-ticket-bundle.js');

const { checkPathDrift, extractForwardCreatePaths } = await import(BUNDLE);

function makeTicket(id, body) {
  return {
    id,
    title: `Test ticket ${id}`,
    filePath: `/fake/session/${id}/linear_ticket_${id}.md`,
    relPath: `${id}/linear_ticket_${id}.md`,
    mappedRequirements: [],
    body,
    problemSection: '',
    dependenciesLine: '',
  };
}

test('ATB-01: path under ## Files to create not in git produces no path-drift finding', () => {
  const body = `
## Implementation Details

### Files to create

- \`extension/bin/new-tool.js\`
- \`extension/tests/new-tool.test.js\`
`;
  const gitFiles = new Set(); // empty — nothing in git
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(
    pathDrift,
    [],
    `Expected no path-drift for ## Files to create paths, got: ${JSON.stringify(pathDrift)}`,
  );
});

test('ATB-02: path under ## Files to modify not in git produces path-drift finding', () => {
  const body = `
## Implementation Details

### Files to modify

- \`extension/src/bin/mux-runner.ts\`
`;
  const gitFiles = new Set(); // empty — nothing in git
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.equal(
    pathDrift.length,
    1,
    `Expected 1 path-drift finding for missing ## Files to modify path, got: ${JSON.stringify(pathDrift)}`,
  );
  assert.ok(
    pathDrift[0].evidence.includes('extension/src/bin/mux-runner.ts'),
    `Expected evidence to mention the missing path, got: ${pathDrift[0].evidence}`,
  );
});

test('ATB-03: path under ## Files to modify present in git produces no finding', () => {
  const body = `
## Implementation Details

### Files to modify

- \`extension/src/bin/mux-runner.ts\`
`;
  const gitFiles = new Set(['extension/src/bin/mux-runner.ts']);
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(pathDrift, [], `Expected no path-drift when path is in git, got: ${JSON.stringify(pathDrift)}`);
});

test('ATB-04: path with (forward-created) annotation in ## Files to modify produces no finding', () => {
  const body = `
## Implementation Details

### Files to modify

- \`extension/src/bin/new-thing.ts\` (forward-created)
`;
  const gitFiles = new Set(); // empty
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(
    pathDrift,
    [],
    `Expected no path-drift for annotated (forward-created) path, got: ${JSON.stringify(pathDrift)}`,
  );
});

test('ATB-05: extractForwardCreatePaths captures only paths in ## Files to create section', () => {
  const body = `
## Files to create

- \`extension/bin/new-tool.js\`

## Files to modify

- \`extension/src/bin/mux-runner.ts\`

## Other section

- \`extension/tests/something.test.js\`
`;
  const result = extractForwardCreatePaths(body);
  assert.ok(result.has('extension/bin/new-tool.js'), 'create-section path should be in result');
  assert.ok(!result.has('extension/src/bin/mux-runner.ts'), 'modify-section path must NOT be in result');
  assert.ok(!result.has('extension/tests/something.test.js'), 'other-section path must NOT be in result');
});
