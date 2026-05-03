import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getExtensionRoot, _resetExtensionDirFallbackForTests } from '../services/pickle-utils.js';

// Trap-door enforcement for `src/services/pickle-utils.ts` (getExtensionRoot validation):
//   INVARIANT: getExtensionRoot() accepts EXTENSION_DIR only when the
//   extension sentinel exists; otherwise it falls back to the canonical root
//   and emits stderr plus an activity event.
//   PATTERN_SHAPE: `extensionRootSentinelExists`.
// This file is the regression guard for that invariant.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pickleUtilsSrcPath = path.resolve(__dirname, '../src/services/pickle-utils.ts');
const CANONICAL_EXTENSION_ROOT = path.join(homedir(), '.claude/pickle-rick');

test('get-extension-root-fallback: PATTERN_SHAPE extensionRootSentinelExists is referenced inside getExtensionRoot resolver', () => {
  const src = readFileSync(pickleUtilsSrcPath, 'utf8');

  // PATTERN_SHAPE: the sentinel-existence check is the gate that decides
  // whether EXTENSION_DIR is honored or the canonical root wins. If this
  // helper is removed or renamed, fallback semantics break silently.
  assert.match(
    src,
    /function\s+extensionRootSentinelExists\s*\(/,
    'extensionRootSentinelExists() helper must remain defined',
  );

  // The resolver must call the sentinel check before honoring EXTENSION_DIR.
  // Slice the resolver body so we only inspect the right scope.
  const resolverStart = src.indexOf('function resolveExtensionRoot');
  assert.notEqual(resolverStart, -1, 'resolveExtensionRoot() must exist');
  const resolverEnd = src.indexOf('\nfunction ', resolverStart + 1);
  const resolverBody = src.slice(resolverStart, resolverEnd === -1 ? src.length : resolverEnd);
  assert.ok(
    resolverBody.includes('extensionRootSentinelExists'),
    'resolveExtensionRoot() must reference extensionRootSentinelExists() before honoring EXTENSION_DIR',
  );

  // The fallback must emit stderr — string check on the canonical message.
  assert.ok(
    src.includes('EXTENSION_DIR fallback:'),
    'fallback must emit "EXTENSION_DIR fallback:" stderr message',
  );
  assert.ok(
    src.includes('extension_dir_fallback'),
    'fallback must emit an extension_dir_fallback activity event',
  );
});

test('get-extension-root-fallback: getExtensionRoot returns canonical root when EXTENSION_DIR has no sentinel', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pickle-extroot-data-'));
  const fakeExtDir = mkdtempSync(path.join(tmpdir(), 'pickle-extroot-no-sentinel-'));
  const prevExt = process.env.EXTENSION_DIR;
  const prevTest = process.env.EXTENSION_DIR_TEST;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const stderrChunks = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    process.env.EXTENSION_DIR = fakeExtDir;
    // Ensure the test-bypass is OFF so the production fallback path runs.
    delete process.env.EXTENSION_DIR_TEST;
    delete process.env.NODE_ENV;
    // Redirect activity writes into a tmp dir so we don't pollute real data.
    process.env.PICKLE_DATA_ROOT = dataDir;
    _resetExtensionDirFallbackForTests();

    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };

    const resolved = getExtensionRoot();

    process.stderr.write = origStderrWrite;

    assert.equal(
      resolved,
      CANONICAL_EXTENSION_ROOT,
      'must fall back to canonical ~/.claude/pickle-rick when sentinel missing',
    );
    assert.notEqual(resolved, fakeExtDir, 'must NOT honor EXTENSION_DIR without sentinel');

    const stderr = stderrChunks.join('');
    assert.match(
      stderr,
      /\[pickle-rick\] EXTENSION_DIR fallback:/,
      'fallback must emit a stderr warning',
    );
    assert.ok(stderr.includes(fakeExtDir), 'stderr must name the rejected requested path');

    // Activity event must land at $PICKLE_DATA_ROOT/activity/<date>.jsonl.
    const activityDir = path.join(dataDir, 'activity');
    const activityFiles = readdirSync(activityDir).filter(f => f.endsWith('.jsonl'));
    assert.ok(activityFiles.length >= 1, 'an activity jsonl file must be written');
    const activityContent = readFileSync(path.join(activityDir, activityFiles[0]), 'utf8');
    assert.match(
      activityContent,
      /"event":"extension_dir_fallback"/,
      'activity event must be extension_dir_fallback',
    );
    assert.ok(
      activityContent.includes(fakeExtDir),
      'activity event must record the requested path',
    );
  } finally {
    process.stderr.write = origStderrWrite;
    if (prevExt === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = prevExt;
    if (prevTest === undefined) delete process.env.EXTENSION_DIR_TEST;
    else process.env.EXTENSION_DIR_TEST = prevTest;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    _resetExtensionDirFallbackForTests();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeExtDir, { recursive: true, force: true });
  }
});

test('get-extension-root-fallback: getExtensionRoot returns canonical root when EXTENSION_DIR is unset', () => {
  const prevExt = process.env.EXTENSION_DIR;
  try {
    delete process.env.EXTENSION_DIR;
    _resetExtensionDirFallbackForTests();
    const resolved = getExtensionRoot();
    assert.equal(
      resolved,
      CANONICAL_EXTENSION_ROOT,
      'unset EXTENSION_DIR must resolve to canonical root',
    );
  } finally {
    if (prevExt === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = prevExt;
    _resetExtensionDirFallbackForTests();
  }
});
