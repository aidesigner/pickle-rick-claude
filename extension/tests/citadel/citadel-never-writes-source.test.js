// @tier: fast
// TD-1 / TD-3 surface-only invariant: Citadel analyzers are read-only. No module
// under extension/src/services/citadel/ may mutate a repo-root-derived source path.
//
// Static source-scan, modeled on completion-authority-single-source.test.js:
// recurse the citadel dir for .ts files, strip comment lines, and fail on a
// source-mutation primitive (writeFileSync / fs.promises.writeFile / an Edit call).
// Report-write helpers that target a session-dir path are EXEMPT — they write
// reports under the session directory, not the repo source tree.
//
// A FAIL-INJECTION sub-test proves the scanner flags a real violation and spares a
// session-dir report writer, so the predicate cannot silently rot to always-green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// testDir = extension/tests/citadel → extensionRoot is two levels up.
const extensionRoot = path.resolve(testDir, '..', '..');
const citadelSrcDir = path.join(extensionRoot, 'src', 'services', 'citadel');

/** Recursively collect every non-`.d.ts` `.ts` file under `dir`. */
function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkTs(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(full);
    }
  }
  return result;
}

// A source-mutation primitive: a write call against a path. The precise predicate
// fires only when the write is NOT against a session/report target. We treat a write
// as a report write (EXEMPT) when the call + its argument lines reference a
// session/report path token (sessionDir, reportPath, outDir, getDataRoot, .tmp., or a
// known *_report / *_findings.json report filename). The argument is often on a
// continuation line after the `writeFileSync(`, so the exempt scan covers a small
// window (the call line plus the next two lines). Any write whose target is NOT one
// of those report tokens — i.e. a repo-root-derived source path — is a violation.
const SOURCE_WRITE_PRIMITIVE_RE = /\b(?:fs\.)?writeFileSync\s*\(|fs\.promises\.writeFile\s*\(|\bEdit\s*\(/;
const REPORT_TARGET_EXEMPT_RE =
  /sessionDir|session_dir|reportPath|report_path|outDir|getDataRoot|getActivityDir|activityDir|\.tmp\.|_report\b|_findings\.json|citadel_report/;

/**
 * Returns the citadel-dir-relative paths of `.ts` files under `scanRoot` that
 * call a source-mutation primitive on a NON-COMMENT line whose write target is
 * NOT a session/report path. Comment lines and report writers (whose target token
 * appears on the call line or its next two argument lines) are spared.
 */
function findSourceWriters(scanRoot) {
  const violations = [];
  for (const filePath of walkTs(scanRoot)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const writes = lines.some((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      if (!SOURCE_WRITE_PRIMITIVE_RE.test(trimmed)) return false;
      // Inspect the call line + its next two lines for a report-target token.
      const window = lines.slice(i, i + 3).join('\n');
      return !REPORT_TARGET_EXEMPT_RE.test(window);
    });
    if (writes) violations.push(path.relative(scanRoot, filePath));
  }
  return violations;
}

test('no citadel src module mutates a repo-root source path', () => {
  const violations = findSourceWriters(citadelSrcDir);
  assert.deepStrictEqual(
    violations,
    [],
    'Citadel analyzers must be read-only. Source-mutation primitive(s) detected ' +
      `under extension/src/services/citadel/ (not a session-dir report write):\n` +
      violations.map((v) => `  ${v}`).join('\n'),
  );
});

test('the new mechanical-finding-classifier is in scan scope and is clean', () => {
  const scanned = walkTs(citadelSrcDir).map((f) => path.relative(citadelSrcDir, f));
  assert.ok(
    scanned.includes('mechanical-finding-classifier.ts'),
    'mechanical-finding-classifier.ts not picked up by the citadel-dir scan',
  );
});

test('FAIL-INJECTION: scanner flags a real source writer and spares a session-dir report writer', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'csor-t10-inject-'));
  try {
    // Violation: a writeFileSync against a repo-root-derived path.
    fs.writeFileSync(
      path.join(tmpRoot, 'evil-writer.ts'),
      "writeFileSync(path.join(repoRoot, 'foo.ts'), patched, 'utf8');\n",
      'utf8',
    );
    // Violation: an fs.promises.writeFile, also non-session.
    fs.writeFileSync(
      path.join(tmpRoot, 'evil-async-writer.ts'),
      "await fs.promises.writeFile(targetPath, contents);\n",
      'utf8',
    );
    // EXEMPT: a session-dir report writer.
    fs.writeFileSync(
      path.join(tmpRoot, 'report-writer.ts'),
      "writeFileSync(path.join(sessionDir, 'citadel_report.json'), json, 'utf8');\n",
      'utf8',
    );
    // Decoy: a commented-out write must not trip.
    fs.writeFileSync(
      path.join(tmpRoot, 'comment-decoy.ts'),
      "// writeFileSync(path.join(repoRoot, 'foo.ts'), patched);\n",
      'utf8',
    );

    const violations = findSourceWriters(tmpRoot);

    assert.ok(violations.includes('evil-writer.ts'), `evil-writer.ts not flagged: ${JSON.stringify(violations)}`);
    assert.ok(violations.includes('evil-async-writer.ts'), `evil-async-writer.ts not flagged: ${JSON.stringify(violations)}`);
    assert.ok(!violations.includes('report-writer.ts'), 'session-dir report writer was wrongly flagged');
    assert.ok(!violations.includes('comment-decoy.ts'), 'commented-out write was wrongly flagged');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
