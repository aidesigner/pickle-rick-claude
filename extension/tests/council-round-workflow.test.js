// @tier: fast
//
// R-DWF-4 integration test (AC-DWF-04) for .claude/workflows/council-round.js.
//
// Runs the REAL workflow body with mocked ambient agent()/parallel() — no real agents,
// fully in-process. Asserts:
//   * m-tier 2-branch fan-out = exactly 10 specs (8 stack-wide B + 2 C_correctness), codex off;
//   * every Phase-B / C_correctness judge is dispatched read-only (agentType:'Explore') — the
//     R-DWF-NO-REPO-EDIT tripwire;
//   * the directive the synthesis agent returns passes the canonical validateDirective;
//   * the summary line matches /^## Round \d+: .* — (clean round\.|\d+ issues)/ for both the
//     clean and issues forms;
//   * codexEnabled:true spawns exactly one C-codex sweep WITHOUT inflating the planner B/C count;
//   * the script honors the dynamic-workflow primitive constraints (static).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDirective } from '../services/council-schema.js';

const WORKFLOW_PATH = fileURLToPath(new URL('../../.claude/workflows/council-round.js', import.meta.url));

function readWorkflowSource() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
}

function loadWorkflow() {
  const src = readWorkflowSource();
  const body = src.replace(/^export\s+const\s+meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body);
}

const SESSION_FILES = {
  historicalBriefPath: '/abs/session/round-1/historical-brief.md',
  principlesPath: '/abs/session/council-principles.md',
  claudeRulesPath: '/abs/session/council-claude-rules.json',
  stackPath: '/abs/session/council-stack.json',
  directivePath: '/abs/session/council-directive.json',
  summaryPath: '/abs/session/council-of-ricks-summary.md',
  codexDir: '/abs/session/codex',
  codexCompanionPath: '/abs/codex-companion.mjs',
};

function cleanDirective(round, branches) {
  return {
    schema_version: 1,
    round,
    codex_enabled: false,
    branches: branches.map((name) => ({ name, findings: [] })),
    trap_doors: [],
  };
}

function issuesDirective(round, branches) {
  return {
    schema_version: 1,
    round,
    codex_enabled: false,
    branches: branches.map((name, i) => ({
      name,
      findings: i === 0
        ? [{
          severity: 'P0', confidence: 90, source: 'COUNCIL', file: 'src/auth.ts', line: 42,
          line_range: null, rule: 'auth', description: 'bug', recommendation: 'fix',
          data_flow: null, scenario: null, snippet_before: null, snippet_after: null,
        }]
        : [],
    })),
    trap_doors: [],
  };
}

/** Build a harness that records each agent() call and returns phase-appropriate fixtures. */
function makeHarness(argsObj, opts = {}) {
  const calls = [];
  const agent = async (prompt, agentOpts = {}) => {
    calls.push({ label: agentOpts.label, phase: agentOpts.phase, agentType: agentOpts.agentType, schema: agentOpts.schema, prompt });
    if (agentOpts.phase === 'A-historical') return 'historical: ok\n(brief)';
    if (agentOpts.phase === 'B-categories' || agentOpts.phase === 'C-branches') {
      const [category, branchRaw] = String(agentOpts.label).split(':');
      const branch = branchRaw === 'stack' ? null : branchRaw;
      return { category, branch, status: 'ok', skip_reason: null, findings: [], trap_door_candidates: [], codex_per_branch: null };
    }
    if (agentOpts.phase === 'C-codex') {
      return { category: 'C_codex', branch: null, status: 'ok', skip_reason: null, findings: [], trap_door_candidates: [], codex_per_branch: { 'feat/a': { verdict: 'approve', reason: 'ok' } } };
    }
    // D-synthesis
    return opts.synthReturn(argsObj);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const phase = () => {};
  const log = (msg) => { calls.push({ log: msg }); };
  return { calls, ambient: [agent, parallel, async () => {}, phase, log, argsObj, {}] };
}

function baseArgs(over = {}) {
  return { branches: ['feat/a', 'feat/b'], stackTier: 'm', codexEnabled: false, hasMigrationJournal: false, round: 1, sessionFiles: SESSION_FILES, ...over };
}

test('AC-DWF-04: m-tier 2-branch clean round → 10 read-only judges, valid directive, clean summary', async () => {
  const argsObj = baseArgs();
  const harness = makeHarness(argsObj, {
    synthReturn: (a) => ({
      round: a.round,
      summary: `## Round ${a.round}: feat/a, feat/b — clean round.`,
      directive: cleanDirective(a.round, a.branches),
      directive_path: a.sessionFiles.directivePath,
      issue_counts: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
      codex_verdicts: {},
    }),
  });
  const result = await loadWorkflow()(...harness.ambient);

  const judgeCalls = harness.calls.filter((c) => c.phase === 'B-categories' || c.phase === 'C-branches');
  assert.equal(judgeCalls.length, 10, 'm-tier 2-branch = 8 stack-wide B + 2 C_correctness = 10 specs');
  assert.equal(harness.calls.filter((c) => c.phase === 'C-codex').length, 0, 'no codex sweep when codexEnabled:false');

  for (const c of judgeCalls) {
    assert.equal(c.agentType, 'Explore', `judge ${c.label} must be read-only Explore (R-DWF-NO-REPO-EDIT)`);
    assert.ok(c.schema && c.schema.type === 'object', `judge ${c.label} must pass SUBAGENT_PAYLOAD_SCHEMA`);
  }

  // C_correctness covers both non-trunk branches; B categories are stack-wide (branch null label).
  const cCorr = judgeCalls.filter((c) => c.label.startsWith('C_correctness'));
  assert.deepEqual(cCorr.map((c) => c.label).sort(), ['C_correctness:feat/a', 'C_correctness:feat/b']);

  assert.ok(validateDirective(result.directive), 'returned directive must pass validateDirective');
  assert.match(result.summary, /^## Round \d+: .* — (clean round\.|\d+ issues)/);
});

test('AC-DWF-04: issues round → directive valid + summary matches the issues form', async () => {
  const argsObj = baseArgs();
  const harness = makeHarness(argsObj, {
    synthReturn: (a) => ({
      round: a.round,
      summary: `## Round ${a.round}: feat/a, feat/b — 4 issues (1/2/1/0/0)`,
      directive: issuesDirective(a.round, a.branches),
      directive_path: a.sessionFiles.directivePath,
      issue_counts: { P0: 1, P1: 2, P2: 1, P3: 0, P4: 0 },
      codex_verdicts: {},
    }),
  });
  const result = await loadWorkflow()(...harness.ambient);
  assert.ok(validateDirective(result.directive), 'issues directive must pass validateDirective');
  assert.match(result.summary, /^## Round \d+: .* — (clean round\.|\d+ issues)/);
  assert.match(result.summary, /— \d+ issues/, 'must hit the issues branch of the suffix contract');
});

test('AC-DWF-04: codexEnabled spawns exactly one C-codex sweep without inflating the planner count', async () => {
  const argsObj = baseArgs({ codexEnabled: true });
  const harness = makeHarness(argsObj, {
    synthReturn: (a) => ({
      round: a.round,
      summary: `## Round ${a.round}: feat/a, feat/b — clean round.`,
      directive: { ...cleanDirective(a.round, a.branches), codex_enabled: true },
      directive_path: a.sessionFiles.directivePath,
      issue_counts: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
      codex_verdicts: { 'feat/a': 'approve' },
    }),
  });
  await loadWorkflow()(...harness.ambient);

  const judgeCalls = harness.calls.filter((c) => c.phase === 'B-categories' || c.phase === 'C-branches');
  assert.equal(judgeCalls.length, 10, 'planner is called with codexEnabled:false → B/C count stays 10');
  const codexCalls = harness.calls.filter((c) => c.phase === 'C-codex');
  assert.equal(codexCalls.length, 1, 'exactly one codex sweep when codexEnabled:true');
  assert.equal(codexCalls[0].label, 'C_codex');
  // The codex sweep needs Bash + session-dir Write, so it is NOT the read-only Explore type.
  assert.notEqual(codexCalls[0].agentType, 'Explore', 'codex sweep keeps the default (write-capable) agent type');
});

test('workflow honors the dynamic-workflow primitive constraints (static)', () => {
  const src = readWorkflowSource();
  assert.match(src, /^export\s+const\s+meta\s*=/m, 'must begin with `export const meta =`');
  assert.ok(!/^\s*import\s/m.test(src), 'no module imports allowed');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require() allowed');
  assert.ok(!/\bfs\s*\./.test(src), 'no fs reference (all I/O is delegated to agents)');
  assert.ok(!/\bisolation\b/.test(src), 'no worktree isolation flag');
  assert.ok(!/\bmodel\s*:/.test(src), 'no model-tier pin');
  assert.ok(!/new Date\s*\(/.test(src), 'no new Date()');
  assert.ok(!/Date\.now\s*\(/.test(src), 'no Date.now()');
  assert.ok(!/Math\.random\s*\(/.test(src), 'no Math.random()');
  assert.ok(!src.includes('LATEST_SCHEMA_VERSION'), 'schema-neutral — no schema-version reference (AC-DWF-07)');
});
