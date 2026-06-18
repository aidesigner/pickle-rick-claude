// @tier: fast
//
// WS4 (b7cc6081): recurrence dashboard for the three refused-and-recovered events
// (completion_finalize_refused, phase_graduation_refused, gate_parity_divergence).
// Proves: (1) registration at all 7 touchpoints, (2) count==N over a synthetic
// activity log, (3) empty log => 0 labelled "no refusals recorded" (NOT "no
// recurrence"), (4) gate_parity_divergence actually emits from the WS3 resolver.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

import { VALID_ACTIVITY_EVENTS } from '../types/index.js';
import {
  REFUSED_RECOVERED_EVENT_NAMES,
  scanRefusedRecoveredCounts,
} from '../services/metrics-utils.js';
import { resolveExtensionRelativePath } from '../services/forward-ref-annotation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const EVENTS = ['completion_finalize_refused', 'phase_graduation_refused', 'gate_parity_divergence'];

describe('WS4 refused-and-recovered: registration (7 touchpoints)', () => {
  for (const event of EVENTS) {
    it(`${event} is registered in VALID_ACTIVITY_EVENTS + schema.definitions + schema.oneOf`, () => {
      assert.ok(VALID_ACTIVITY_EVENTS.includes(event), `VALID_ACTIVITY_EVENTS must list ${event}`);
      assert.ok(event in schema.definitions, `schema.definitions must define ${event}`);
      assert.ok(
        schema.oneOf.some((r) => r.$ref === `#/definitions/${event}`),
        `schema.oneOf must reference ${event}`,
      );
    });
  }

  it('REFUSED_RECOVERED_EVENT_NAMES matches the three registered events', () => {
    assert.deepEqual([...REFUSED_RECOVERED_EVENT_NAMES].sort(), [...EVENTS].sort());
  });

  it('schema payload contracts match the ticket spec', () => {
    assert.deepEqual(
      schema.definitions.completion_finalize_refused.properties.gate_payload.required.slice().sort(),
      ['pending_count', 'seam', 'ticket_count'],
    );
    assert.deepEqual(
      schema.definitions.phase_graduation_refused.properties.gate_payload.required.slice().sort(),
      ['done_count', 'exit_code', 'pending_count'],
    );
    assert.deepEqual(
      schema.definitions.gate_parity_divergence.properties.gate_payload.required.slice().sort(),
      ['gate_a', 'gate_b', 'ref'],
    );
  });
});

describe('WS4 refused-and-recovered: scanRefusedRecoveredCounts', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ws4-scan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts N occurrences per event within the window', () => {
    const ts = '2026-06-18T12:00:00.000Z';
    const lines = [
      ...Array(3).fill(`{"event":"completion_finalize_refused","ts":"${ts}","gate_payload":{"pending_count":1,"ticket_count":2,"seam":"graduation_halt"}}`),
      ...Array(2).fill(`{"event":"phase_graduation_refused","ts":"${ts}","gate_payload":{"pending_count":1,"done_count":1,"exit_code":0}}`),
      `{"event":"gate_parity_divergence","ts":"${ts}","gate_payload":{"gate_a":"/a","gate_b":"/b","ref":"x"}}`,
      // noise: an unrelated event must NOT be counted
      `{"event":"gate_skipped","ts":"${ts}","source":"pickle","gate_payload":{"reason":"kill_switch"}}`,
    ];
    writeFileSync(path.join(dir, '2026-06-18.jsonl'), lines.join('\n') + '\n');

    const report = scanRefusedRecoveredCounts(dir, '2026-06-18', '2026-06-18');
    assert.equal(report.completion_finalize_refused, 3);
    assert.equal(report.phase_graduation_refused, 2);
    assert.equal(report.gate_parity_divergence, 1);
    assert.equal(report.total, 6);
  });

  it('excludes events outside the [since, until] window', () => {
    writeFileSync(
      path.join(dir, '2026-06-10.jsonl'),
      `{"event":"completion_finalize_refused","ts":"2026-06-10T12:00:00.000Z","gate_payload":{"pending_count":1,"ticket_count":1,"seam":"scan_null"}}\n`,
    );
    const report = scanRefusedRecoveredCounts(dir, '2026-06-18', '2026-06-18');
    assert.equal(report.total, 0);
  });

  it('empty / absent log yields 0 (a healthy "no refusals" window, NOT "no recurrence")', () => {
    const emptyReport = scanRefusedRecoveredCounts(dir, '2026-06-18', '2026-06-18');
    assert.equal(emptyReport.total, 0);
    assert.equal(emptyReport.completion_finalize_refused, 0);
    assert.equal(emptyReport.phase_graduation_refused, 0);
    assert.equal(emptyReport.gate_parity_divergence, 0);

    const absentReport = scanRefusedRecoveredCounts(path.join(dir, 'does-not-exist'), '2026-06-18', '2026-06-18');
    assert.equal(absentReport.total, 0);
  });
});

describe('WS4 dashboard label: empty prints "no refusals recorded", never "no recurrence"', () => {
  it('the metrics print branch uses the inverted-semantics wording', () => {
    const metricsSrc = readFileSync(path.join(ROOT, 'src/bin/metrics.ts'), 'utf8');
    assert.match(metricsSrc, /No refusals recorded in window\./);
    // Inverted-semantics guard: the refused-recovered table must NOT borrow the
    // skip-flag "recurrence"/"removal candidate" framing.
    const tableFn = metricsSrc.slice(metricsSrc.indexOf('function printRefusedRecoveredTable'));
    const tableBody = tableFn.slice(0, tableFn.indexOf('\n}\n'));
    assert.doesNotMatch(tableBody, /no recurrence/i);
    assert.doesNotMatch(tableBody, /removal candidate/i);
    assert.doesNotMatch(tableBody, /over budget/i);
  });
});

describe('WS4 emit: gate_parity_divergence fires from the WS3 resolver on a flip', () => {
  let tmp;
  let prevDataRoot;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ws4-emit-'));
    prevDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = path.join(tmp, 'data');
  });
  afterEach(() => {
    if (prevDataRoot === undefined) { delete process.env.PICKLE_DATA_ROOT; }
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  function readActivityLines() {
    const activityDir = path.join(tmp, 'data', 'activity');
    let files;
    try {
      files = readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      for (const line of readFileSync(path.join(activityDir, f), 'utf8').split('\n')) {
        if (line.trim()) { out.push(JSON.parse(line)); }
      }
    }
    return out;
  }

  it('emits when the shared extension dir differs from the legacy fallback AND the outcome flips', () => {
    // Layout: outer/extension/package.json (the real package), and a child repoRoot
    // without its own extension/. From repoRoot the up-walk resolves the shared dir
    // to outer/extension (≠ repoRoot/extension). A ref present only under the shared
    // dir resolves true via the shared resolver but false via the legacy fallback → flip.
    const outer = path.join(tmp, 'outer');
    const sharedExt = path.join(outer, 'extension');
    mkdirSync(sharedExt, { recursive: true });
    writeFileSync(path.join(sharedExt, 'package.json'), '{}');
    writeFileSync(path.join(sharedExt, 'marker.ts'), 'export const x = 1;\n');
    const repoRoot = path.join(outer, 'child');
    mkdirSync(repoRoot, { recursive: true });

    const resolved = resolveExtensionRelativePath('marker.ts', repoRoot);
    assert.equal(resolved, true, 'shared resolver should resolve the ref under outer/extension');

    const events = readActivityLines().filter((e) => e.event === 'gate_parity_divergence');
    assert.equal(events.length, 1, 'exactly one gate_parity_divergence should be emitted on the flip');
    const gp = events[0].gate_payload;
    assert.equal(gp.gate_a, sharedExt);
    assert.equal(gp.gate_b, path.join(repoRoot, 'extension'));
    assert.equal(gp.ref, 'marker.ts');
  });

  it('does NOT emit when both gates resolve identically (no divergence)', () => {
    // repoRoot/extension/package.json present → shared dir == legacy fallback.
    const repoRoot = path.join(tmp, 'plain');
    const ext = path.join(repoRoot, 'extension');
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, 'package.json'), '{}');
    writeFileSync(path.join(ext, 'marker.ts'), 'export const x = 1;\n');

    resolveExtensionRelativePath('marker.ts', repoRoot);
    const events = readActivityLines().filter((e) => e.event === 'gate_parity_divergence');
    assert.equal(events.length, 0, 'no divergence event when both gates agree');
  });
});
