// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  evaluateAcShapeEnforcement,
  isParametrizedTicket,
} = await import('../bin/spawn-refinement-team.js');

// AC-ACSG-1a: cross-field recognition — evaluateAcShapeEnforcement returns [] for valid parametrized tickets

test('AC-ACSG-1a: universal quantifier in title, describe.each( only in acceptance_test → no violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'All handlers validate permissions',
      source_ac_ids: ['AC-1'],
      acceptance_test: 'describe.each([["getA"], ["getB"]]) validates permissions',
    }],
  });
  assert.deepEqual(violations, [], 'quantifier in title + describe.each in acceptance_test should pass');
});

test('AC-ACSG-1a: universal quantifier in acceptance_test, describe.each( only in title → no violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-2', ticket_ids: ['T2'] }],
    tickets: [{
      id: 'T2',
      title: 'describe.each([["getA"], ["getB"]]) validates permissions',
      source_ac_ids: ['AC-2'],
      acceptance_test: 'All handlers validate permissions for every input',
    }],
  });
  assert.deepEqual(violations, [], 'describe.each in title + quantifier in acceptance_test should pass');
});

// AC-ACSG-1b: isParametrizedTicket cross-field recognition

test('AC-ACSG-1b: isParametrizedTicket returns true when quantifier and describe.each are in different fields', () => {
  // quantifier in title, describe.each in acceptance_test
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T1',
      title: 'All handlers must validate permissions',
      source_ac_ids: [],
      acceptance_test: 'describe.each([["getA"], ["getB"]]) tests each handler',
    }),
    true,
    'quantifier in title + describe.each in acceptance_test'
  );

  // quantifier in acceptance_test, describe.each in title
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T2',
      title: 'describe.each([["getA"]]) tests handlers',
      source_ac_ids: [],
      acceptance_test: 'Every handler validates permissions',
    }),
    true,
    'describe.each in title + quantifier in acceptance_test'
  );

  // both tokens in justification field
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T3',
      title: 'Handler validation',
      source_ac_ids: [],
      acceptance_test: 'Handlers validate permissions',
      justification: 'All handlers covered — describe.each([["getA"]]) in test',
    }),
    true,
    'both tokens in justification field'
  );
});

test('AC-ACSG-1b: isParametrizedTicket returns false when neither token appears in any field', () => {
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T4',
      title: 'Handler validates permissions',
      source_ac_ids: [],
      acceptance_test: 'getA returns 200',
    }),
    false,
    'no quantifier and no describe.each → should return false'
  );
});

// AC-ACSG-1c: PICKLE_AC_GATE_DEBUG=1 emits matcher lines; unset emits nothing

test('AC-ACSG-1c: PICKLE_AC_GATE_DEBUG=1 emits matcher: lines to stderr', () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  const prev = process.env.PICKLE_AC_GATE_DEBUG;
  process.env.PICKLE_AC_GATE_DEBUG = '1';

  try {
    evaluateAcShapeEnforcement({
      ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
      tickets: [{
        id: 'T1',
        title: 'All handlers validate permissions',
        source_ac_ids: ['AC-1'],
        acceptance_test: 'describe.each([["getA"]]) validates each handler',
      }],
    });
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) {
      delete process.env.PICKLE_AC_GATE_DEBUG;
    } else {
      process.env.PICKLE_AC_GATE_DEBUG = prev;
    }
  }

  const output = captured.join('');
  assert.match(output, /^matcher: regex=.*, field=.*, value=.*, result=(match|no-match)$/m,
    'should emit at least one matcher: line in expected format');
});

test('AC-ACSG-1c: without PICKLE_AC_GATE_DEBUG no matcher: lines emitted', () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  const prev = process.env.PICKLE_AC_GATE_DEBUG;
  delete process.env.PICKLE_AC_GATE_DEBUG;

  try {
    evaluateAcShapeEnforcement({
      ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
      tickets: [{
        id: 'T1',
        title: 'All handlers validate permissions',
        source_ac_ids: ['AC-1'],
        acceptance_test: 'describe.each([["getA"]]) validates each handler',
      }],
    });
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) {
      delete process.env.PICKLE_AC_GATE_DEBUG;
    } else {
      process.env.PICKLE_AC_GATE_DEBUG = prev;
    }
  }

  const matcherLines = captured.join('').split('\n').filter((l) => l.startsWith('matcher:'));
  assert.strictEqual(matcherLines.length, 0, 'no matcher: lines should appear without the debug flag');
});

// AC-ACSG-1c lint check: grep-able sentinel for PICKLE_AC_GATE_DEBUG presence in source
test('AC-ACSG-1c: PICKLE_AC_GATE_DEBUG appears in spawn-refinement-team.ts source', async () => {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const srcPath = path.default.resolve(
    fileURLToPath(import.meta.url),
    '../../src/bin/spawn-refinement-team.ts'
  );

  const rl = createInterface({ input: createReadStream(srcPath, { encoding: 'utf-8' }) });
  let count = 0;
  for await (const line of rl) {
    if (line.includes('PICKLE_AC_GATE_DEBUG')) count++;
  }
  assert.ok(count >= 1, `PICKLE_AC_GATE_DEBUG must appear at least once in spawn-refinement-team.ts (found ${count} times)`);
});
