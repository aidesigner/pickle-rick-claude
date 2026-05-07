// @tier: fast
/**
 * R-TAQ-7 / Section I — refinement_manifest schema gains ticket_quality_warnings.
 *
 * AC-TAQ-07:   field declared in extension/src/types/refinement-manifest.schema.json
 * AC-TAQ-07-2: each entry has {ticket_id, defect_class, evidence, source?, file_line?}
 *              with source ∈ {analyst, post-decomp} and file_line string|null
 * AC-TAQ-07-3: legacy manifests (no field) load without error; field is optional
 * AC-TAQ-07-4: producer (Section C wiring) populates source: 'post-decomp'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'refinement-manifest.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

test('AC-TAQ-07: schema declares ticket_quality_warnings as an optional array property', () => {
  assert.ok(schema.properties.ticket_quality_warnings, 'property must exist');
  assert.equal(schema.properties.ticket_quality_warnings.type, 'array');
  // ticket_quality_warnings is NOT in required[] — legacy manifests still validate
  assert.ok(
    !schema.required.includes('ticket_quality_warnings'),
    'AC-TAQ-07-3: ticket_quality_warnings must NOT be required (legacy manifests load OK)',
  );
});

test('AC-TAQ-07-2: entry shape requires ticket_id, defect_class, evidence', () => {
  const entry = schema.properties.ticket_quality_warnings.items;
  assert.equal(entry.type, 'object');
  assert.deepStrictEqual(entry.required.sort(), ['defect_class', 'evidence', 'ticket_id'].sort());
  assert.equal(entry.properties.ticket_id.type, 'string');
  assert.equal(entry.properties.defect_class.type, 'string');
  assert.equal(entry.properties.evidence.type, 'string');
});

test('AC-TAQ-07-2: entry shape declares optional source enum (analyst | post-decomp)', () => {
  const sourceProp = schema.properties.ticket_quality_warnings.items.properties.source;
  assert.ok(sourceProp, 'source property must exist');
  assert.equal(sourceProp.type, 'string');
  assert.deepStrictEqual(sourceProp.enum.sort(), ['analyst', 'post-decomp'].sort());
});

test('AC-TAQ-07-2: entry shape declares optional file_line as string|null', () => {
  const fileLineProp = schema.properties.ticket_quality_warnings.items.properties.file_line;
  assert.ok(fileLineProp, 'file_line property must exist');
  assert.deepStrictEqual(fileLineProp.type, ['string', 'null']);
});

// Synthetic-validator harness — minimal schema enforcement for the items shape.
function validateWarningEntry(entry) {
  const failures = [];
  const required = ['ticket_id', 'defect_class', 'evidence'];
  for (const k of required) {
    if (typeof entry[k] !== 'string' || entry[k].length === 0) {
      failures.push(`${k} must be non-empty string`);
    }
  }
  if (entry.source !== undefined && !['analyst', 'post-decomp'].includes(entry.source)) {
    failures.push(`source must be 'analyst' or 'post-decomp'`);
  }
  if (entry.file_line !== undefined && entry.file_line !== null && typeof entry.file_line !== 'string') {
    failures.push(`file_line must be string or null`);
  }
  const allowed = new Set(['ticket_id', 'defect_class', 'evidence', 'source', 'file_line']);
  for (const k of Object.keys(entry)) {
    if (!allowed.has(k)) failures.push(`unexpected property: ${k}`);
  }
  return failures;
}

test('AC-TAQ-07-2: synthetic 3-warning manifest (analyst + 2 post-decomp) validates', () => {
  const warnings = [
    {
      ticket_id: 'aaaa1111',
      defect_class: 'path-drift',
      evidence: 'cited extension/src/services/missing.ts not found in git ls-files',
      source: 'analyst',
      file_line: 'extension/src/services/missing.ts:0',
    },
    {
      ticket_id: 'bbbb2222',
      defect_class: 'cross-doc-naming-drift',
      evidence: 'ticket cites cli-contract.test.js but matrix uses gh-cli-contract.test.js',
      source: 'post-decomp',
      file_line: null,
    },
    {
      ticket_id: 'cccc3333',
      defect_class: 'hallucinated-premise',
      evidence: 'mapped_requirements R-NONEXISTENT-99 not found in source PRDs',
      source: 'post-decomp',
      file_line: null,
    },
  ];

  for (const w of warnings) {
    const failures = validateWarningEntry(w);
    assert.deepStrictEqual(failures, [], `entry ${w.ticket_id} failed: ${failures.join('; ')}`);
  }
});

test('AC-TAQ-07-3: legacy entry (no source / no file_line) validates', () => {
  const legacy = {
    ticket_id: 'dddd4444',
    defect_class: 'path-drift',
    evidence: 'pre-Section-I producer wrote no source field',
  };
  assert.deepStrictEqual(validateWarningEntry(legacy), []);
});

test('AC-TAQ-07-3: missing required fields fail validation', () => {
  const missingTicket = { defect_class: 'path-drift', evidence: 'foo' };
  const failures = validateWarningEntry(missingTicket);
  assert.ok(failures.length >= 1, 'missing ticket_id must fail');
});

test('AC-TAQ-07-2: invalid source enum fails validation', () => {
  const bad = {
    ticket_id: 'eeee5555',
    defect_class: 'path-drift',
    evidence: 'x',
    source: 'unknown-producer',
  };
  const failures = validateWarningEntry(bad);
  assert.ok(failures.some((f) => f.includes('source')), 'invalid source must fail');
});

test('AC-TAQ-07-4: producer (readCrossDocDriftWarnings) emits source: post-decomp', async () => {
  // Smoke-check the actual producer wires the new fields. We exercise the
  // helper indirectly via buildRefinementManifest — caller passes warnings
  // through. Real wiring is in spawn-refinement-team main() and is exercised
  // in the integration suite; here we just bind the contract that buildRefinementManifest
  // preserves source/file_line round-trip.
  const { buildRefinementManifest } = await import('../bin/spawn-refinement-team.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mfest-i-'));
  try {
    const prdPath = path.join(tmp, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD\n');
    const refinementDir = path.join(tmp, 'refinement');
    fs.mkdirSync(refinementDir, { recursive: true });
    const cycleResults = {
      refinementDir,
      cyclesRequested: 1,
      maxTurns: 10,
      allCycleResults: [[]],
      finalResults: [],
      allSuccess: true,
    };
    const warnings = [
      {
        ticket_id: 'ffff6666',
        defect_class: 'cross-doc-naming-drift',
        evidence: 'producer wired test',
        source: 'post-decomp',
        file_line: null,
      },
    ];
    const manifest = buildRefinementManifest(
      { prdPath, sessionDir: tmp },
      cycleResults,
      warnings,
    );
    assert.equal(manifest.ticket_quality_warnings.length, 1);
    assert.equal(manifest.ticket_quality_warnings[0].source, 'post-decomp');
    assert.equal(manifest.ticket_quality_warnings[0].file_line, null);
  } finally {
    const fs = await import('node:fs');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
