// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'closer-gate-contract');

const ARTIFACT_GLOBS = [
  /^research_.*\.md$/,
  /^plan_.*\.md$/,
  /^conformance_.*\.md$/,
  /^code_review_.*\.md$/,
];

const CANONICAL_PATTERN = /\bnpm\s+run\s+test:expensive\b/;

/**
 * Discover expensive-tier integration test files by reading their @tier marker.
 * Pure file I/O — no spawn.
 */
function discoverExpensiveIntegrationFiles(integrationDir) {
  const names = [];
  let entries;
  try {
    entries = fs.readdirSync(integrationDir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.test.js') && !entry.name.endsWith('.test.ts')) continue;
    try {
      const content = fs.readFileSync(path.join(integrationDir, entry.name), 'utf8');
      const firstLine = content.split('\n')[0] ?? '';
      if (firstLine.trim() === '// @tier: expensive') {
        names.push(entry.name);
      }
    } catch { /* skip unreadable */ }
  }
  return names;
}

/**
 * Build a regex that detects `node --test <path>` where <path> ends with any of the
 * expensive-tier test filenames. The pattern mirrors the spec in R-CSIS-B2:
 *   /\bnode\s+--test\s+\S*<expensive-file>\b/
 */
function buildForbiddenPattern(expensiveFileNames) {
  if (expensiveFileNames.length === 0) return null;
  const alt = expensiveFileNames
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`\\bnode\\s+--test\\s+\\S*(?:${alt})\\b`);
}

function collectArtifacts(bundleDir) {
  const files = [];
  for (const name of fs.readdirSync(bundleDir)) {
    if (ARTIFACT_GLOBS.some(p => p.test(name))) {
      files.push({ name, fullPath: path.join(bundleDir, name) });
    }
  }
  return files;
}

/**
 * Scan a bundle directory for forbidden commands and canonical commands.
 * Returns { violations: [{file, line, text}], hasCanonical: boolean }.
 */
function scanBundle(bundleDir, forbiddenPattern) {
  const artifacts = collectArtifacts(bundleDir);
  const violations = [];
  let hasCanonical = false;

  for (const { name, fullPath } of artifacts) {
    const content = fs.readFileSync(fullPath, 'utf8');
    if (CANONICAL_PATTERN.test(content)) hasCanonical = true;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (forbiddenPattern.test(lines[i])) {
        violations.push({ file: name, line: i + 1, text: lines[i].trim() });
        forbiddenPattern.lastIndex = 0;
      }
    }
  }

  return { violations, hasCanonical };
}

const INTEGRATION_DIR = path.join(EXTENSION_ROOT, 'tests', 'integration');
const expensiveFiles = discoverExpensiveIntegrationFiles(INTEGRATION_DIR);
const FORBIDDEN_PATTERN = buildForbiddenPattern(expensiveFiles);

test('closer-gate-contract setup: expensive-tier files discovered', () => {
  assert.ok(
    expensiveFiles.length > 0,
    'No expensive-tier files found in tests/integration/ — scanner cannot function',
  );
  assert.ok(
    expensiveFiles.includes('deploy-lifecycle-soak.test.js'),
    'deploy-lifecycle-soak.test.js must be in the expensive-tier list',
  );
  assert.ok(FORBIDDEN_PATTERN !== null, 'Forbidden pattern must be constructable');
});

test('closer-gate-contract: bad bundle detected — scanner finds forbidden command', () => {
  assert.ok(FORBIDDEN_PATTERN, 'forbidden pattern must be built');
  const badDir = path.join(FIXTURES_DIR, 'bad-bundle');
  const { violations } = scanBundle(badDir, new RegExp(FORBIDDEN_PATTERN.source));

  assert.ok(
    violations.length > 0,
    'bad bundle must contain at least one forbidden node --test invocation',
  );

  const offender = violations[0];
  const msg = `Forbidden command in ${offender.file}:${offender.line}: ${offender.text}`;
  assert.ok(offender.file.length > 0, `offender file must be named: ${msg}`);
  assert.ok(
    offender.text.includes('node') && offender.text.includes('--test'),
    `offender line must reference node --test: ${msg}`,
  );
});

test('closer-gate-contract: good bundle passes — no forbidden commands, has canonical', () => {
  assert.ok(FORBIDDEN_PATTERN, 'forbidden pattern must be built');
  const goodDir = path.join(FIXTURES_DIR, 'good-bundle');
  const { violations, hasCanonical } = scanBundle(goodDir, new RegExp(FORBIDDEN_PATTERN.source));

  assert.deepStrictEqual(
    violations,
    [],
    `good bundle must have no forbidden commands but found: ${JSON.stringify(violations)}`,
  );
  assert.ok(
    hasCanonical,
    'good bundle must reference npm run test:expensive (canonical tier runner)',
  );
});
