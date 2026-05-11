// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateSymbolAudit,
  runSymbolAuditEnforcement,
} from '../bin/spawn-refinement-team.js';

function buildPrd(annotation = '') {
  return `# Bundle PRD

## Activity Events

Activity events: \`my_new_event\`${annotation}.
`;
}

function buildHelperPrd(symbol = 'detectManagerMaxTurnsExitForwardCreateFixture', annotation = '') {
  return `# Bundle PRD

## Helpers And Sentinels

Helpers: \`${symbol}\`${annotation}.
`;
}

function buildSentinelPrd(annotation = '') {
  return `# Bundle PRD

## Helpers And Sentinels

Sentinels: \`SENTINEL_X\`${annotation}.
`;
}

function makeTmpDir(prefix = 'pickle-symbol-annotations-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function captureStderr(run) {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const stderr = [];
  process.stderr.write = (chunk, encoding, cb) => {
    stderr.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof cb === 'function') cb();
    return true;
  };
  try {
    return { result: run(), stderr: stderr.join('') };
  } finally {
    process.stderr.write = originalWrite;
  }
}

const SYMBOL_AUDIT_FAILURE_WORKAROUND_LINES = [
  '[pickle-rick] To allow forward-create symbols, either (a) annotate with (forward-created)',
  'or (created by R-<CODE>-N) outside the backticks, or (b) ensure the symbol is declared',
  "in a PRD listed in this bundle's `composes:` frontmatter.",
];

test('forward-create event annotation: accepts `(forward-created)` and reports forward-create', () => {
  const report = evaluateSymbolAudit(buildPrd(' (forward-created)'), process.cwd(), { tickets: [] });
  const event = report.activityEvents.find((ref) => ref.symbol === 'my_new_event');

  assert.ok(event, 'expected my_new_event reference');
  assert.equal(event.status, 'forward-create');
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('forward-create event annotation variants: accepts ticket and requirement-code suffixes', () => {
  const prd = `# Bundle PRD

## Activity Events

Activity events: \`my_new_event\` (forward-created), \`other_new_event\` (introduced by ticket abcd1234), \`third_new_event\` (created by R-SAOV-1).
`;
  const report = evaluateSymbolAudit(prd, process.cwd(), { tickets: [] });
  const statuses = Object.fromEntries(report.activityEvents.map((ref) => [ref.symbol, ref.status]));

  assert.deepEqual(statuses, {
    my_new_event: 'forward-create',
    other_new_event: 'forward-create',
    third_new_event: 'forward-create',
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('unannotated forward-create: unknown event still reports phantom', () => {
  const report = evaluateSymbolAudit(buildPrd(), process.cwd(), { tickets: [] });
  const event = report.activityEvents.find((ref) => ref.symbol === 'my_new_event');

  assert.ok(event, 'expected my_new_event reference');
  assert.equal(event.status, 'phantom');
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.category === 'activity_event' && finding.symbol === 'my_new_event'));
});

test('forward-create helper annotation: accepts `(forward-created)` and reports forward-create', () => {
  const symbol = 'detectManagerMaxTurnsExitForwardCreateFixture';
  const report = evaluateSymbolAudit(buildHelperPrd(symbol, ' (forward-created)'), process.cwd(), { tickets: [] });
  const helper = report.helperSentinels.find((ref) => ref.symbol === symbol);

  assert.ok(helper, `expected ${symbol} reference`);
  assert.equal(helper.status, 'forward-create');
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('sentinel annotation accepted: requirement-code suffix reports forward-create', () => {
  const report = evaluateSymbolAudit(buildSentinelPrd(' (created by R-SAOV-2)'), process.cwd(), { tickets: [] });
  const sentinel = report.helperSentinels.find((ref) => ref.symbol === 'SENTINEL_X');

  assert.ok(sentinel, 'expected SENTINEL_X reference');
  assert.equal(sentinel.status, 'forward-create');
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
});

test('unannotated helper still fails', () => {
  const symbol = 'totallyUnknownHelperForwardCreateFixture';
  const report = evaluateSymbolAudit(buildHelperPrd(symbol), process.cwd(), { tickets: [] });
  const helper = report.helperSentinels.find((ref) => ref.symbol === symbol);

  assert.ok(helper, `expected ${symbol} reference`);
  assert.equal(helper.status, 'phantom');
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.category === 'helper_sentinel' && finding.symbol === symbol));
});

test('composes chain symbol resolves', () => {
  const repo = makeTmpDir();
  try {
    const sourcePrd = path.join(repo, 'source-prd.md');
    const wrapperPrd = path.join(repo, 'wrapper-prd.md');
    fs.writeFileSync(sourcePrd, `# Source PRD

## Activity Events

Activity events: \`event_foo\`.

## Helpers And Sentinels

Helpers: \`helperFoo\`.
`);
    const wrapperContent = `---
composes:
  - ./source-prd.md
---
# Wrapper PRD

## Activity Events

Activity events: \`event_foo\`.

## Helpers And Sentinels

Helpers: \`helperFoo\`.
`;
    fs.writeFileSync(wrapperPrd, wrapperContent);

    const report = evaluateSymbolAudit(wrapperContent, repo, { tickets: [] }, wrapperPrd);

    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
    assert.equal(report.activityEvents.find((ref) => ref.symbol === 'event_foo')?.status, 'valid');
    assert.equal(report.helperSentinels.find((ref) => ref.symbol === 'helperFoo')?.status, 'valid');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('no composes frontmatter preserves phantom behavior', () => {
  const repo = makeTmpDir();
  try {
    const wrapperPrd = path.join(repo, 'wrapper-prd.md');
    const wrapperContent = `# Wrapper PRD

## Activity Events

Activity events: \`event_foo\`.
`;
    fs.writeFileSync(wrapperPrd, wrapperContent);

    const report = evaluateSymbolAudit(wrapperContent, repo, { tickets: [] }, wrapperPrd);

    assert.equal(report.ok, false);
    assert.equal(report.activityEvents.find((ref) => ref.symbol === 'event_foo')?.status, 'phantom');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('missing composed PRD warns and audit proceeds', () => {
  const repo = makeTmpDir();
  try {
    const wrapperPrd = path.join(repo, 'wrapper-prd.md');
    const wrapperContent = `---
composes:
  - ./missing-prd.md
---
# Wrapper PRD

## Activity Events

Activity events: \`event_foo\` (forward-created).
`;
    fs.writeFileSync(wrapperPrd, wrapperContent);

    const { result: report, stderr } = captureStderr(() =>
      evaluateSymbolAudit(wrapperContent, repo, { tickets: [] }, wrapperPrd)
    );

    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
    assert.match(stderr, /warning: composed PRD not found: \.\/missing-prd\.md/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('enum false-positive filter: ignores enum/state values on trigger-phrase lines with non-event context markers', () => {
  const prd = `# Bundle PRD

## Activity Events

Activity events: gate outcome G ∈ {\`passed\`, \`wall_clock\`, \`output_stall\`, \`infrastructure_failure\`}.
Activity events: enum value \`output_stall\` lives in the state field while phase outcome \`passed\` remains non-event prose.
`;
  const report = evaluateSymbolAudit(prd, process.cwd(), { tickets: [] });

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.deepEqual(report.activityEvents, []);
  assert.deepEqual(report.findings, []);
});

test('true-positive event preserved: emitted activity event still reports phantom when unannotated', () => {
  const prd = `# Bundle PRD

## Activity Events

The activity event \`mystery_event\` is emitted without annotation or composes support.
`;
  const report = evaluateSymbolAudit(prd, process.cwd(), { tickets: [] });

  assert.equal(report.ok, false);
  assert.equal(report.activityEvents.find((ref) => ref.symbol === 'mystery_event')?.status, 'phantom');
  assert.ok(
    report.findings.some((finding) => finding.category === 'activity_event' && finding.symbol === 'mystery_event')
  );
});

test('failure prose', () => {
  const report = evaluateSymbolAudit(buildPrd(), process.cwd(), { tickets: [] });

  const { stderr } = captureStderr(() => runSymbolAuditEnforcement(report));

  assert.match(stderr, /^\[pickle-rick\] symbol audit failed: 1 phantom symbol\(s\)\.\n/m);
  assert.match(
    stderr,
    new RegExp(
      SYMBOL_AUDIT_FAILURE_WORKAROUND_LINES.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\n')
    )
  );
});

test('failure exit code preserved', () => {
  const report = evaluateSymbolAudit(buildPrd(), process.cwd(), { tickets: [] });

  const { result: exitCode } = captureStderr(() => runSymbolAuditEnforcement(report));

  assert.notEqual(exitCode, 0);
});
