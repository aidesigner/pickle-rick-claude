// @tier: fast
// Regression test for R-LASP-1 ordered-candidate schema resolver.
// Exercises loadSchemaDefinitions() across three temp-dir layouts without
// touching the real deployed tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Probe binary (CJS so __filename is available without package.json "type":"module").
// Mirrors the exact candidate array + resolution logic in loadSchemaDefinitions()
// from extension/bin/log-activity.js (R-LASP-1).
// pathToFileURL(__filename) is equivalent to import.meta.url in ESM.
const PROBE_SCRIPT = `
'use strict';
const fs = require('fs');
const { pathToFileURL } = require('url');

const baseUrl = pathToFileURL(__filename);
const candidates = [
  new URL('../activity-events.schema.json', baseUrl),
  new URL('../src/types/activity-events.schema.json', baseUrl),
];

let found = false;
let candidateUsed = null;
let definitionKeys = [];

for (const candidate of candidates) {
  try {
    const p = candidate.pathname;
    if (!fs.existsSync(p)) continue;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    found = true;
    candidateUsed = p;
    definitionKeys = Object.keys(parsed.definitions ?? {});
    break;
  } catch {
    // try next candidate
  }
}

if (!found) {
  process.stderr.write('Failed to load activity schema: no candidate path resolved — validation skipped\\n');
}
process.stdout.write(JSON.stringify({ found, candidateUsed, definitionKeys }));
`;

const MINIMAL_SCHEMA = JSON.stringify({
  definitions: { test_event: { required: ['event', 'ts'], properties: {} } },
});

function makeLayout(variant) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-lasp-')));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'probe.js'), PROBE_SCRIPT, 'utf8');

  if (variant === 'deployed') {
    // (a) deployed layout: schema at <root>/activity-events.schema.json, src/types/ absent
    fs.writeFileSync(path.join(dir, 'activity-events.schema.json'), MINIMAL_SCHEMA, 'utf8');
  } else if (variant === 'in-repo') {
    // (b) in-repo layout: schema at <root>/src/types/activity-events.schema.json, root absent
    fs.mkdirSync(path.join(dir, 'src', 'types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'types', 'activity-events.schema.json'),
      MINIMAL_SCHEMA,
      'utf8',
    );
  }
  // (c) total miss: no schema written

  return { dir, probePath: path.join(dir, 'bin', 'probe.js') };
}

function runProbe(probePath) {
  const result = spawnSync(process.execPath, [probePath], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  const output = result.stdout ? JSON.parse(result.stdout) : null;
  return { stderr: result.stderr || '', status: result.status, output };
}

test('R-LASP-2 deployed layout: schema at ../activity-events.schema.json, resolver finds it', () => {
  const { dir, probePath } = makeLayout('deployed');
  try {
    const { output, status } = runProbe(probePath);
    assert.equal(status, 0, 'probe should exit 0');
    assert.ok(output?.found, 'resolver should find schema in deployed layout');
    assert.ok(
      output?.candidateUsed && !output.candidateUsed.includes('src/types'),
      'deployed layout must use first candidate, not src/types fallback',
    );
    assert.ok(
      Array.isArray(output?.definitionKeys) && output.definitionKeys.includes('test_event'),
      'should load definitions from deployed schema',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R-LASP-2 in-repo layout: schema at ../src/types/, resolver finds it', () => {
  const { dir, probePath } = makeLayout('in-repo');
  try {
    const { output, status } = runProbe(probePath);
    assert.equal(status, 0, 'probe should exit 0');
    assert.ok(output?.found, 'resolver should find schema in in-repo layout');
    assert.ok(
      output?.candidateUsed?.includes('src/types'),
      'in-repo layout must use src/types candidate',
    );
    assert.ok(
      Array.isArray(output?.definitionKeys) && output.definitionKeys.includes('test_event'),
      'should load definitions from in-repo schema',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R-LASP-2 total miss: neither schema present, graceful fail-open (no throw, warn emitted)', () => {
  const { dir, probePath } = makeLayout('total-miss');
  try {
    const { output, status, stderr } = runProbe(probePath);
    assert.equal(status, 0, 'resolver must not throw — fail-open means exit 0');
    assert.ok(!output?.found, 'resolver should not find schema in total-miss layout');
    assert.ok(
      stderr.includes('no candidate path resolved'),
      'warn message must be emitted to stderr on total miss',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
