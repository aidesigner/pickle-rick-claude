// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  buildRefinementManifest,
} = await import('../bin/spawn-refinement-team.js');

function tmpDir(prefix = 'pickle-refine-quality-warnings-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeCycleResults(root) {
  const refinementDir = path.join(root, 'refinement');
  fs.mkdirSync(refinementDir, { recursive: true });
  return {
    refinementDir,
    cyclesRequested: 1,
    maxTurns: 10,
    allCycleResults: [[]],
    finalResults: [],
    allSuccess: true,
  };
}

test('R-TAQ-7: buildRefinementManifest passes through ticket_quality_warnings when provided', () => {
  const root = tmpDir();
  try {
    const prdPath = path.join(root, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD\n');
    const warnings = [
      { ticket_id: 'abc12345', defect_class: 'path-drift', evidence: 'Files section references non-existent path' },
      { ticket_id: 'def67890', defect_class: 'hallucinated-premise', evidence: 'Ticket assumes R-FOO-1 is shipped but disposition is DROP' },
    ];
    const manifest = buildRefinementManifest(
      { prdPath, sessionDir: root },
      makeCycleResults(root),
      warnings
    );
    assert.ok(Array.isArray(manifest.ticket_quality_warnings), 'ticket_quality_warnings should be an array');
    assert.equal(manifest.ticket_quality_warnings.length, 2);
    assert.deepEqual(manifest.ticket_quality_warnings[0], warnings[0]);
    assert.deepEqual(manifest.ticket_quality_warnings[1], warnings[1]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-TAQ-7: buildRefinementManifest omits ticket_quality_warnings when not provided', () => {
  const root = tmpDir();
  try {
    const prdPath = path.join(root, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD\n');
    const manifest = buildRefinementManifest(
      { prdPath, sessionDir: root },
      makeCycleResults(root)
    );
    assert.equal(manifest.ticket_quality_warnings, undefined, 'ticket_quality_warnings should be absent when not passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-TAQ-7: refinement-manifest.schema.json ticket_quality_warnings entry is valid JSON with required fields', () => {
  const schemaPath = new URL('../src/types/refinement-manifest.schema.json', import.meta.url).pathname;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const warnSchema = schema.properties?.ticket_quality_warnings;
  assert.ok(warnSchema, 'ticket_quality_warnings property must exist in schema');
  assert.equal(warnSchema.type, 'array');
  const itemRequired = warnSchema.items?.required;
  assert.ok(Array.isArray(itemRequired), 'items must have required array');
  assert.ok(itemRequired.includes('ticket_id'), 'ticket_id must be required');
  assert.ok(itemRequired.includes('defect_class'), 'defect_class must be required');
  assert.ok(itemRequired.includes('evidence'), 'evidence must be required');
  const props = warnSchema.items?.properties;
  assert.equal(props?.ticket_id?.type, 'string');
  assert.equal(props?.defect_class?.type, 'string');
  assert.equal(props?.evidence?.type, 'string');
});
