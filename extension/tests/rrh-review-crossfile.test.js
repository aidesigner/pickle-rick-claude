// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractRemovedDeclSymbols,
  extractChangedGateCommands,
  auditCrossfileBehaviorDrift,
} from '../services/citadel/crossfile-behavior-drift-audit.js';

// PICKLE_DATA_ROOT-sandboxed: pin the data root to a throwaway dir so nothing in
// this fast-tier test can read or write a real session tree.
let DATA_ROOT;
let ORIGINAL_DATA_ROOT;

before(() => {
  ORIGINAL_DATA_ROOT = process.env.PICKLE_DATA_ROOT;
  DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-crossfile-dataroot-'));
  process.env.PICKLE_DATA_ROOT = DATA_ROOT;
});

after(() => {
  if (ORIGINAL_DATA_ROOT === undefined) delete process.env.PICKLE_DATA_ROOT;
  else process.env.PICKLE_DATA_ROOT = ORIGINAL_DATA_ROOT;
  fs.rmSync(DATA_ROOT, { recursive: true, force: true });
});

function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-crossfile-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: tmp, timeout: 10_000, encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { tmp, git };
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('rrh-review-crossfile: pure token extractors', () => {
  test('extractRemovedDeclSymbols keeps symbols removed-and-not-readded', () => {
    const diff = [
      '@@ -1,2 +1,1 @@',
      '-export function oldBehaviorX() { return 1; }',
      '-export const keptName = 2;',
      '+export const keptName = 3;',
    ].join('\n');
    const removed = extractRemovedDeclSymbols(diff);
    assert.ok(removed.includes('oldBehaviorX'), 'truly removed symbol is extracted');
    assert.ok(!removed.includes('keptName'), 'symbol re-added on a + line is NOT drift');
  });

  test('extractChangedGateCommands keeps gate commands removed-and-not-readded', () => {
    const diff = [
      '@@ -1,1 +1,1 @@',
      '-GATE="a && bash scripts/audit-oldgate.sh && npm run test:fast"',
      '+GATE="a && npm run test:fast"',
    ].join('\n');
    const commands = extractChangedGateCommands(diff);
    assert.ok(commands.includes('bash scripts/audit-oldgate.sh'), 'removed gate command extracted');
    assert.ok(!commands.includes('npm run test:fast'), 'gate command present on both sides is NOT drift');
  });
});

describe('rrh-review-crossfile: AC1 pre-existing test pins old-X', () => {
  test('flags a pre-existing test that asserts a symbol the bundle removed from production', () => {
    const { tmp, git } = makeRepo();
    try {
      // Baseline HEAD: production exports oldBehaviorX; a PRE-EXISTING test pins it.
      write(tmp, 'extension/src/foo.ts', 'export function oldBehaviorX() { return 1; }\n');
      write(
        tmp,
        'extension/tests/pre-existing.test.js',
        "import { oldBehaviorX } from '../src/foo.js';\ntest('x', () => { oldBehaviorX(); });\n",
      );
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      const base = git('rev-parse', 'HEAD').trim();

      // Bundle change: REMOVE oldBehaviorX from production (behavior X changed).
      write(tmp, 'extension/src/foo.ts', 'export function newBehaviorY() { return 2; }\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'bundle change');

      const result = auditCrossfileBehaviorDrift({
        range: `${base}..HEAD`, base, head: 'HEAD', repoRoot: tmp,
        changedFiles: [
          { path: 'extension/src/foo.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
        ],
        claudeFiles: [],
      });

      const hit = result.findings.find(
        (f) => f.file === 'extension/tests/pre-existing.test.js' && f.message.includes('oldBehaviorX'),
      );
      assert.ok(hit, 'pre-existing test pinning the removed symbol must be flagged');
      assert.equal(hit.severity, 'Medium');
      assert.match(hit.id, /^crossfile-behavior-drift:.*oldbehaviorx$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('rrh-review-crossfile: AC2 canonical-config pins old gate wiring', () => {
  test('flags check-wired.sh when a gate command it pins is removed by the bundle', () => {
    const { tmp, git } = makeRepo();
    try {
      // Baseline HEAD: check-wired.sh canonical pins the gate chain; CLAUDE.md mirrors it.
      const gate = 'GATE="npx tsc && bash scripts/audit-oldgate.sh && npm run test:fast"\n';
      write(tmp, 'extension/scripts/check-wired.sh', `#!/usr/bin/env bash\n${gate}`);
      write(tmp, 'CLAUDE.md', `# gate\n${gate}`);
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      const base = git('rev-parse', 'HEAD').trim();

      // Bundle change: gate-chain edit in CLAUDE.md drops audit-oldgate.sh; check-wired.sh untouched.
      write(tmp, 'CLAUDE.md', '# gate\nGATE="npx tsc && npm run test:fast"\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'bundle change');

      const result = auditCrossfileBehaviorDrift({
        range: `${base}..HEAD`, base, head: 'HEAD', repoRoot: tmp,
        changedFiles: [
          { path: 'CLAUDE.md', status: 'M', kind: 'production', changedLines: [], blame: [] },
        ],
        claudeFiles: [],
      });

      const hit = result.findings.find(
        (f) => f.file === 'extension/scripts/check-wired.sh' && f.message.includes('audit-oldgate.sh'),
      );
      assert.ok(hit, 'check-wired.sh pinning the removed gate command must be flagged');
      assert.equal(hit.severity, 'Medium');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('rrh-review-crossfile: AC3 precision / negative', () => {
  test('does NOT flag an unrelated pre-existing file that never references the changed token', () => {
    const { tmp, git } = makeRepo();
    try {
      write(tmp, 'extension/src/foo.ts', 'export function oldBehaviorX() { return 1; }\n');
      // Unrelated pre-existing test — references something else entirely.
      write(
        tmp,
        'extension/tests/unrelated.test.js',
        "test('y', () => { const z = somethingElseEntirely(); });\n",
      );
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      const base = git('rev-parse', 'HEAD').trim();

      write(tmp, 'extension/src/foo.ts', 'export function newBehaviorY() { return 2; }\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'bundle change');

      const result = auditCrossfileBehaviorDrift({
        range: `${base}..HEAD`, base, head: 'HEAD', repoRoot: tmp,
        changedFiles: [
          { path: 'extension/src/foo.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
        ],
        claudeFiles: [],
      });

      assert.ok(
        !result.findings.some((f) => f.file === 'extension/tests/unrelated.test.js'),
        'a file that does not pin the changed token must NOT be flagged (no false positive)',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('does NOT flag a renamed-but-still-present symbol (still defined in production)', () => {
    const { tmp, git } = makeRepo();
    try {
      // keptHelper is removed from foo.ts but STILL defined in bar.ts at head → not drift.
      write(tmp, 'extension/src/foo.ts', 'export function keptHelper() { return 1; }\n');
      write(tmp, 'extension/src/bar.ts', 'export const placeholder = 0;\n');
      write(
        tmp,
        'extension/tests/pins-helper.test.js',
        "import { keptHelper } from '../src/bar.js';\ntest('k', () => { keptHelper(); });\n",
      );
      git('add', '-A');
      git('commit', '-q', '-m', 'baseline');
      const base = git('rev-parse', 'HEAD').trim();

      // Move the declaration: removed from foo.ts, added to bar.ts (still present at head).
      write(tmp, 'extension/src/foo.ts', 'export const placeholder = 1;\n');
      write(tmp, 'extension/src/bar.ts', 'export function keptHelper() { return 1; }\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'bundle change');

      const result = auditCrossfileBehaviorDrift({
        range: `${base}..HEAD`, base, head: 'HEAD', repoRoot: tmp,
        changedFiles: [
          { path: 'extension/src/foo.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
          { path: 'extension/src/bar.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
        ],
        claudeFiles: [],
      });

      assert.ok(
        !result.findings.some((f) => f.message.includes('keptHelper')),
        'a symbol still defined in production at head must NOT be flagged',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('silent on empty diff', () => {
    const { tmp } = makeRepo();
    try {
      const result = auditCrossfileBehaviorDrift({
        range: 'HEAD..HEAD', base: 'HEAD', head: 'HEAD', repoRoot: tmp,
        changedFiles: [], claudeFiles: [],
      });
      assert.deepEqual(result.findings, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
