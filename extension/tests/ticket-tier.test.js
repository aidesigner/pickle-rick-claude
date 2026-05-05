// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyTicketTierBudget } from '../bin/mux-runner.js';
import {
  parseTicketFrontmatter,
  ticketInfoBudget,
  ticketTierBudget,
} from '../services/pickle-utils.js';

function tempRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ticket-tier-')));
}

function writeTicket(sessionDir, id, tierLine) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${id}`,
    'title: Tier test',
    'status: Todo',
    'order: 1',
  ];
  if (tierLine !== null) frontmatter.push(tierLine);
  frontmatter.push('---', '', '# Test');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), frontmatter.join('\n'));
}

function stateFor(ticketId) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 0,
    max_iterations: 99,
    max_time_minutes: 60,
    worker_timeout_seconds: 99,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: ticketId,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: '',
  };
}

test('ticket-tier.budget-mapping: all tiers map to documented iteration and worker timeout budgets', () => {
  const cases = [
    ['trivial', 5, 5 * 60],
    ['small', 10, 10 * 60],
    ['medium', 30, 20 * 60],
    ['large', 60, 80 * 60],
  ];

  const root = tempRoot();
  try {
    for (const [tier, maxIterations, workerTimeoutSeconds] of cases) {
      const id = `ticket-${tier}`;
      writeTicket(root, id, `complexity_tier: ${tier}`);
      const ticketPath = path.join(root, id, `linear_ticket_${id}.md`);
      const parsed = parseTicketFrontmatter(ticketPath);
      assert.deepEqual(ticketInfoBudget(parsed), {
        tier,
        max_iterations: maxIterations,
        worker_timeout_seconds: workerTimeoutSeconds,
      });

      const state = stateFor(id);
      assert.deepEqual(applyTicketTierBudget(state, root), {
        tier,
        max_iterations: maxIterations,
        worker_timeout_seconds: workerTimeoutSeconds,
      });
      // R-CNAR-1 part 2: state.max_iterations is the GLOBAL manager-loop cap
      // (operator-set) and MUST be preserved across applyTicketTierBudget calls.
      // The per-ticket tier ceiling lives in state.current_ticket_max_iterations.
      assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
      assert.equal(state.worker_timeout_seconds, workerTimeoutSeconds);
      assert.equal(state.current_ticket_tier, tier);
      assert.equal(state.current_ticket_max_iterations, maxIterations);
      assert.equal(state.current_ticket_worker_timeout_seconds, workerTimeoutSeconds);
      assert.equal(state.current_ticket_budget_start_iteration, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ticket-tier.default: missing and invalid tiers default to medium budget', () => {
  const expected = {
    tier: 'medium',
    max_iterations: 30,
    worker_timeout_seconds: 20 * 60,
  };

  assert.deepEqual(ticketTierBudget(undefined), expected);
  assert.deepEqual(ticketTierBudget('bogus'), expected);

  const root = tempRoot();
  try {
    for (const [id, tierLine] of [['missing', null], ['invalid', 'complexity_tier: bogus']]) {
      writeTicket(root, id, tierLine);
      const parsed = parseTicketFrontmatter(path.join(root, id, `linear_ticket_${id}.md`));
      assert.deepEqual(ticketInfoBudget(parsed), expected);

      const state = stateFor(id);
      assert.deepEqual(applyTicketTierBudget(state, root), expected);
      // R-CNAR-1 part 2: global max_iterations preserved; per-ticket cache holds tier value.
      assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
      assert.equal(state.current_ticket_max_iterations, expected.max_iterations);
      assert.equal(state.worker_timeout_seconds, expected.worker_timeout_seconds);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ticket-tier.budget-mapping: cached tier is stable when frontmatter changes mid-execution', () => {
  const root = tempRoot();
  try {
    writeTicket(root, 't1', 'complexity_tier: large');
    const state = stateFor('t1');
    assert.equal(applyTicketTierBudget(state, root).tier, 'large');

    writeTicket(root, 't1', 'complexity_tier: trivial');
    const budget = applyTicketTierBudget(state, root);
    assert.deepEqual(budget, {
      tier: 'large',
      max_iterations: 60,
      worker_timeout_seconds: 80 * 60,
    });
    // R-CNAR-1 part 2: global max_iterations preserved (still 99 from stateFor);
    // per-ticket cache holds the cached large-tier value.
    assert.equal(state.max_iterations, 99, 'global max_iterations preserved');
    assert.equal(state.current_ticket_max_iterations, 60);
    assert.equal(state.worker_timeout_seconds, 80 * 60);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
