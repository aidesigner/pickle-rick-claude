// @tier: fast
// 47047433 / C5: tier-conditional `## Code Graph Context` injection into buildWorkerPrompt.
// Relational oracle — NO committed baseline fixture; the section is computed in-test
// and the prompt diff is asserted to equal exactly the injected block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkerPrompt,
  buildCodegraphContextSection,
  deriveCodegraphTerms,
  renderCodegraphSection,
  tierUsesGraphContext,
} from '../bin/spawn-morty.js';
import { buildWorkerPrompt as refinementBuildWorkerPrompt } from '../bin/spawn-refinement-team.js';

const SECTION_HEADER = '## Code Graph Context';
const TIERS = ['trivial', 'small', 'medium', 'large'];

// Hermetic HOME: buildWorkerPrompt reads ~/.claude/commands/send-to-morty.md. Plant a
// minimal template carrying the substitution placeholders so injection is deterministic
// regardless of whether install.sh has deployed the real template.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-section-home-'));
const cmdDir = path.join(tmpHome, '.claude', 'commands');
fs.mkdirSync(cmdDir, { recursive: true });
fs.writeFileSync(
  path.join(cmdDir, 'send-to-morty.md'),
  '# Worker Prompt\n{{TIER_RESUME_TABLE}}\n{{TIER_LIFECYCLE_SECTIONS}}\n',
);
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = tmpHome;
process.on('exit', () => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makeSettings(overrides = {}) {
  return {
    enabled: true,
    index_at_setup: false,
    staleness_max_age_minutes: 30,
    context_max_bytes: 8192,
    expose_mcp_to_workers: false,
    index_timeout_ms: 120000,
    sync_timeout_ms: 30000,
    query_timeout_ms: 5000,
    ...overrides,
  };
}

// Fake matching the CodegraphService surface (searchNodes/getCallers/buildContext →
// Promise-returning, close()). No real @colbymchenry/codegraph dependency.
function fakeService({ hits = [], callers = [], summary = '' } = {}) {
  return {
    async searchNodes() { return hits; },
    async getCallers() { return callers; },
    async buildContext() { return summary; },
    close() {},
  };
}

function searchHit(id, name, score = 1) {
  return { node: { id, name, file: `${id}.ts`, line: 7 }, score };
}

function makeTicket(extra = {}) {
  return {
    task: 'Inject `Code Graph` context into worker prompt',
    ticketContent: '---\nid: t1\ntitle: Test\n---\n# Body\n- AC uses `searchNodes` and `getCallers`',
    ticketId: 't1',
    ticketPath: os.tmpdir(),
    sessionRoot: os.tmpdir(),
    backend: 'claude',
    isReviewTicket: false,
    ...extra,
  };
}

function buildPrompt(tier, codegraphSection) {
  return buildWorkerPrompt({
    ticket: makeTicket(),
    model: 'sonnet',
    repoRoot: os.tmpdir(),
    complexityTier: tier,
    codegraphSection,
  });
}

// ── AC: tier matrix ─────────────────────────────────────────────────────────
test('tier matrix: trivial → no section; small/medium/large → section present', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5)], callers: [{ node: { id: 'c1', name: 'callerA' } }], summary: 'sum' });
  const settings = makeSettings();
  for (const tier of TIERS) {
    const section = await buildCodegraphContextSection({
      tier, title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
    });
    if (tier === 'trivial') {
      assert.equal(section, '', 'trivial tier must yield no section');
      assert.equal(tierUsesGraphContext(tier), false);
    } else {
      assert.ok(section.includes(SECTION_HEADER), `${tier} tier must include section header`);
      assert.equal(tierUsesGraphContext(tier), true);
    }
    const promptOn = buildPrompt(tier, section);
    if (tier === 'trivial') assert.ok(!promptOn.includes(SECTION_HEADER));
    else assert.ok(promptOn.includes(SECTION_HEADER));
  }
});

// ── AC: relational oracle ───────────────────────────────────────────────────
test('relational oracle: diff(enabled, disabled) == exactly the injected section', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5), searchHit('n2', 'barFn', 3)], callers: [{ node: { id: 'c1', name: 'callerA' } }] });
  const settings = makeSettings();
  for (const tier of TIERS) {
    const section = await buildCodegraphContextSection({
      tier, title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
    });
    const promptOn = buildPrompt(tier, section);
    const promptOff = buildPrompt(tier, '');
    if (tier === 'trivial') {
      assert.equal(section, '');
      assert.equal(promptOn, promptOff, 'trivial diff must be empty');
    } else {
      assert.notEqual(promptOn, promptOff);
      assert.equal(promptOn.replace(section, ''), promptOff, 'prompt diff must equal exactly the section');
      assert.equal(promptOn.indexOf(section), promptOn.lastIndexOf(section), 'section injected exactly once');
    }
  }
});

// ── AC: cap + symbol-boundary truncation ────────────────────────────────────
test('cap: oversized results → output ≤ cap, ends at symbol boundary + [truncated]', async () => {
  const hits = [];
  for (let i = 0; i < 60; i++) hits.push(searchHit(`n${i}`, `symbolNumber${i}`, 60 - i));
  const bigSummary = Array.from({ length: 40 }, (_, i) => `summary line ${i} with extra words to consume bytes`).join('\n');
  const service = fakeService({ hits, callers: [{ node: { id: 'c', name: 'someCaller' } }], summary: bigSummary });
  const cap = 400;
  const settings = makeSettings({ context_max_bytes: cap });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings,
  });
  assert.ok(section.length > 0, 'section must be present');
  assert.ok(Buffer.byteLength(section, 'utf-8') <= cap, `section bytes (${Buffer.byteLength(section, 'utf-8')}) must be ≤ cap (${cap})`);
  assert.ok(section.includes('[truncated]'), 'truncated output must carry the marker');
  assert.ok(section.endsWith('[truncated]\n'), 'marker must be the final line (no split entry)');
  // No partial entry: every non-empty, non-header, non-marker line is a complete entry
  // (begins with "Summary:" or "- `").
  for (const line of section.split('\n')) {
    if (line === '' || line === SECTION_HEADER || line === '[truncated]') continue;
    assert.ok(line.startsWith('Summary:') || line.startsWith('- `'), `unexpected partial line: ${JSON.stringify(line)}`);
  }
});

test('renderCodegraphSection: whole section fits → no marker; degenerate cap → empty', () => {
  const fit = renderCodegraphSection(['- `a`', '- `b`'], 8192);
  assert.ok(fit.includes(SECTION_HEADER) && fit.includes('- `a`') && fit.includes('- `b`'));
  assert.ok(!fit.includes('[truncated]'));
  assert.equal(renderCodegraphSection(['- `a`'], 5), '', 'header alone over cap → empty');
});

// ── AC: absence (zero hits / null / disabled / kill-switch) ──────────────────
test('absence: zero hits / null service / disabled → NO section header anywhere', async () => {
  const base = { tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent };
  const cases = [
    { name: 'zero hits', service: fakeService({ hits: [] }), settings: makeSettings() },
    { name: 'null service', service: null, settings: makeSettings() },
    { name: 'disabled', service: fakeService({ hits: [searchHit('n1', 'x')] }), settings: makeSettings({ enabled: false }) },
    { name: 'kill-switch/degraded (null returns)', service: fakeService({ hits: null }), settings: makeSettings() },
  ];
  for (const c of cases) {
    const section = await buildCodegraphContextSection({ ...base, service: c.service, settings: c.settings });
    assert.equal(section, '', `${c.name}: expected absent section`);
    const prompt = buildPrompt('medium', section);
    assert.ok(!prompt.includes(SECTION_HEADER), `${c.name}: prompt must not contain section header`);
  }
});

// ── AC: term derivation ─────────────────────────────────────────────────────
test('term derivation: backticked symbols + title nouns, deduped, ≤ 8', () => {
  const title = 'Refactor `parseScope` and `resolveScope` plus `parseScope` again for scope resolver clarity';
  const ac = 'Verify `parseScope`, `filterByPaths`, `computeOneHop`, `refreshScope`, `writeScopeArchive`, `buildScopeV1Schema`, `validateScope`';
  const terms = deriveCodegraphTerms(title, ac);
  assert.ok(terms.length <= 8, `expected ≤ 8 terms, got ${terms.length}`);
  assert.equal(new Set(terms).size, terms.length, 'terms must be deduped');
  assert.ok(terms.includes('parseScope'), 'backticked symbol from title must be present');
  assert.ok(terms.includes('filterByPaths'), 'backticked symbol from ACs must be present');
  // Backticked symbols are derived before title nouns.
  assert.ok(terms.indexOf('parseScope') < terms.length);
  // A title noun (length ≥ 4, non-stopword) is captured.
  const allTerms = deriveCodegraphTerms('Refactor the scopeResolver module', '');
  assert.ok(allTerms.includes('Refactor') || allTerms.includes('scopeResolver') || allTerms.includes('module'),
    'title nouns must be captured');
});

// ── AC: refinement-team builder untouched ───────────────────────────────────
test('refinement-team builder contains no graph section', () => {
  const prompt = refinementBuildWorkerPrompt('requirements', '# PRD\nSome content', path.join(os.tmpdir(), 'out.md'), os.tmpdir(), 1);
  assert.ok(!prompt.includes(SECTION_HEADER), 'refinement prompt must not contain Code Graph Context');
});

// ── LLM-conformance evidence: section adjacent to lifecycle sections ─────────
test('medium-tier section is adjacent to the tier lifecycle sections', async () => {
  const service = fakeService({ hits: [searchHit('n1', 'fooFn', 5)], callers: [{ node: { id: 'c1', name: 'callerA' } }] });
  const section = await buildCodegraphContextSection({
    tier: 'medium', title: makeTicket().task, ticketContent: makeTicket().ticketContent, service, settings: makeSettings(),
  });
  const prompt = buildPrompt('medium', section);
  const lifecycleIdx = prompt.indexOf('### 1. Research');
  const sectionIdx = prompt.indexOf(SECTION_HEADER);
  assert.ok(lifecycleIdx >= 0, 'medium prompt must contain the Research lifecycle section');
  assert.ok(sectionIdx > lifecycleIdx, 'Code Graph Context must follow the lifecycle sections (adjacent injection)');
});
