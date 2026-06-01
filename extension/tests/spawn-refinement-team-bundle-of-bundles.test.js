// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectBundleOfBundlesOverCollapse,
  BUNDLE_OF_BUNDLES_FANOUT_SECTION,
  buildWorkerPrompt,
} from '../bin/spawn-refinement-team.js';

const WORKER_ROLE_IDS = ['requirements', 'codebase', 'risk-scope'];

function makeTmpDir(prefix = 'pickle-bob-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function buildBobFixture(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, 'src-a.md'), [
    '# Source A',
    '',
    '## Atomic decomposition',
    '',
    '- R-A-1: first atomic ticket for source A',
    '- R-A-2: second atomic ticket for source A',
    '- R-A-3: third atomic ticket for source A',
  ].join('\n'));

  fs.writeFileSync(path.join(tmpDir, 'src-b.md'), [
    '# Source B',
    '',
    '## Atomic decomposition',
    '',
    '- R-B-1: first atomic ticket for source B',
    '- R-B-2: second atomic ticket for source B',
    '- R-B-3: third atomic ticket for source B',
  ].join('\n'));

  fs.writeFileSync(path.join(tmpDir, 'src-c.md'), [
    '# Source C',
    '',
    '## Atomic decomposition',
    '',
    '- R-C-1: first atomic ticket for source C',
    '- R-C-2: second atomic ticket for source C',
    '- R-C-3: third atomic ticket for source C',
  ].join('\n'));

  const bundlePath = path.join(tmpDir, 'bundle.md');
  fs.writeFileSync(bundlePath, [
    '---',
    'composes:',
    '  - ./src-a.md',
    '  - ./src-b.md',
    '  - ./src-c.md',
    '---',
    '# Bundle of bundles PRD',
    '',
    '## Overview',
    '',
    'Composes three source PRDs, each with atomic decompositions.',
  ].join('\n'));

  return bundlePath;
}

function minimalManifest(tickets) {
  return {
    prd_path: '',
    refinement_dir: '',
    all_success: true,
    cycles_requested: 1,
    cycles_completed: 1,
    max_turns_per_worker: 10,
    ac_shape_smells: [],
    tickets,
    workers: [],
    completed_at: new Date().toISOString(),
  };
}

test('detectBundleOfBundlesOverCollapse: positive — 3 umbrella tickets <= 3 composed sources detects over-collapse', () => {
  const tmpDir = makeTmpDir();
  try {
    const bundlePath = buildBobFixture(tmpDir);
    const manifest = minimalManifest([
      { id: 'umbrella-a', title: 'Source A umbrella', source_ac_ids: [] },
      { id: 'umbrella-b', title: 'Source B umbrella', source_ac_ids: [] },
      { id: 'umbrella-c', title: 'Source C umbrella', source_ac_ids: [] },
    ]);
    const result = detectBundleOfBundlesOverCollapse(bundlePath, manifest);
    assert.equal(result.detected, true, 'expected over-collapse detection for 3 umbrella tickets vs 3 composed sources');
    assert.equal(result.composedCount, 3, 'composedCount should be 3');
    assert.equal(result.ticketCount, 3, 'ticketCount should be 3');
    assert.ok(result.sourcesWithAtomicSection.length >= 1, 'at least one source should have an atomic section');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectBundleOfBundlesOverCollapse: negative-1 — 9 atomic tickets > 3 composed sources yields no detection', () => {
  const tmpDir = makeTmpDir();
  try {
    const bundlePath = buildBobFixture(tmpDir);
    const atomicTickets = [
      'R-A-1', 'R-A-2', 'R-A-3',
      'R-B-1', 'R-B-2', 'R-B-3',
      'R-C-1', 'R-C-2', 'R-C-3',
    ].map((id) => ({ id, title: id, source_ac_ids: [] }));
    const manifest = minimalManifest(atomicTickets);
    const result = detectBundleOfBundlesOverCollapse(bundlePath, manifest);
    assert.equal(result.detected, false, 'expected no detection when 9 atomic tickets exceed 3 composed sources');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('detectBundleOfBundlesOverCollapse: negative-2 — single PRD without composes never triggers', () => {
  const tmpDir = makeTmpDir();
  try {
    const singlePrdPath = path.join(tmpDir, 'single.md');
    fs.writeFileSync(singlePrdPath, [
      '# Single PRD',
      '',
      '## Atomic decomposition',
      '',
      '- R-S-1: only ticket',
    ].join('\n'));
    const manifest = minimalManifest([
      { id: 'ticket-s-1', title: 'Only ticket', source_ac_ids: [] },
    ]);
    const result = detectBundleOfBundlesOverCollapse(singlePrdPath, manifest);
    assert.equal(result.detected, false, 'expected no detection for single PRD without composes frontmatter');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildWorkerPrompt: BUNDLE_OF_BUNDLES_FANOUT_SECTION present in output for all WORKER_ROLES ids', () => {
  const prdContent = [
    '---',
    'composes:',
    '  - ./src-a.md',
    '---',
    '# Bundle PRD',
    '',
    '## Overview',
    '',
    'A bundle-of-bundles PRD for prompt-section testing.',
  ].join('\n');

  for (const roleId of WORKER_ROLE_IDS) {
    const prompt = buildWorkerPrompt(roleId, prdContent, 'analysis.md', os.tmpdir(), 1);
    assert.ok(
      prompt.includes(BUNDLE_OF_BUNDLES_FANOUT_SECTION),
      `expected BUNDLE_OF_BUNDLES_FANOUT_SECTION in buildWorkerPrompt output for role "${roleId}"`,
    );
  }
});
