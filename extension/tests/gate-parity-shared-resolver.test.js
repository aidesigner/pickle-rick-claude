// @tier: fast
// WS3 (#120 R-ATPR) gate-parity: check-readiness and audit-ticket-bundle resolve an
// extension-relative path/dir reference through ONE shared resolver in
// services/forward-ref-annotation.ts. This lint forbids re-introducing an inline
// fs.existsSync-based extension-relative walk in either consumer, and proves both gates
// resolve the #120 repro path identically (by sharing the same function).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const SRC_BIN = path.join(EXT_ROOT, 'src', 'bin');

const auditBundleSrc = fs.readFileSync(path.join(SRC_BIN, 'audit-ticket-bundle.ts'), 'utf8');
const checkReadinessSrc = fs.readFileSync(path.join(SRC_BIN, 'check-readiness.ts'), 'utf8');

// The two inline-walk fingerprints the shared resolver replaces.
const EXTENSION_PKG_WALK_RE = /fs\.existsSync\(path\.join\(dir,\s*['"]extension['"]/;
const EXTENSION_BASENAME_WALK_RE = /path\.basename\(dir\)\s*===\s*['"]extension['"]/;

describe('WS3 gate-parity shared extension-relative resolver', () => {
  it('audit-ticket-bundle.ts has NO inline fs.existsSync extension-relative walk', () => {
    assert.ok(
      !EXTENSION_PKG_WALK_RE.test(auditBundleSrc),
      "audit-ticket-bundle.ts must not contain fs.existsSync(path.join(dir, 'extension', ...))"
    );
    assert.ok(
      !EXTENSION_BASENAME_WALK_RE.test(auditBundleSrc),
      "audit-ticket-bundle.ts must not contain an inline path.basename(dir) === 'extension' up-walk"
    );
  });

  it('check-readiness.ts has NO inline fs.existsSync extension-relative walk', () => {
    assert.ok(
      !EXTENSION_PKG_WALK_RE.test(checkReadinessSrc),
      "check-readiness.ts must not contain fs.existsSync(path.join(dir, 'extension', ...))"
    );
    assert.ok(
      !EXTENSION_BASENAME_WALK_RE.test(checkReadinessSrc),
      "check-readiness.ts must not contain an inline path.basename(dir) === 'extension' up-walk"
    );
  });

  it('both consumers import resolveExtensionDir from the shared module', () => {
    const importRe = /import\s*\{[^}]*\bresolveExtensionDir\b[^}]*\}\s*from\s*['"]\.\.\/services\/forward-ref-annotation\.js['"]/;
    assert.ok(importRe.test(auditBundleSrc), 'audit-ticket-bundle.ts must import resolveExtensionDir');
    assert.ok(importRe.test(checkReadinessSrc), 'check-readiness.ts must import resolveExtensionDir');
  });

  it('RED CASE: a re-introduced inline walk is flagged by the lint predicate', () => {
    const rogue = [
      'function findExtensionDir(dir) {',
      "  if (fs.existsSync(path.join(dir, 'extension', 'package.json'))) {",
      "    return path.join(dir, 'extension');",
      '  }',
      '  return null;',
      '}',
    ].join('\n');
    assert.ok(
      EXTENSION_PKG_WALK_RE.test(rogue),
      'the lint predicate must flag a re-introduced inline extension-relative walk'
    );
  });
});

describe('WS3 gate-parity #120 repro resolves identically in both gates', () => {
  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws3-parity-'));

  it('resolveExtensionDir finds the extension package root from repoRoot', async () => {
    const mod = await import(path.join(EXT_ROOT, 'services', 'forward-ref-annotation.js'));
    const tmp = mkTmp();
    try {
      const extDir = path.join(tmp, 'extension');
      fs.mkdirSync(path.join(extDir, 'src', 'services'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'package.json'), '{"name":"x"}');
      assert.equal(mod.resolveExtensionDir(tmp), extDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the #120 repro extension-relative path resolves true; a phantom resolves false', async () => {
    const mod = await import(path.join(EXT_ROOT, 'services', 'forward-ref-annotation.js'));
    const tmp = mkTmp();
    try {
      const extDir = path.join(tmp, 'extension');
      fs.mkdirSync(path.join(extDir, 'src', 'services'), { recursive: true });
      fs.writeFileSync(path.join(extDir, 'package.json'), '{"name":"x"}');
      fs.writeFileSync(path.join(extDir, 'src', 'services', 'forward-ref-annotation.ts'), '// x');

      // The #120 R-ATPR repro path: an extension-relative ref. Both gates derive their
      // extension base from resolveExtensionDir, so this single function IS the parity surface.
      assert.equal(
        mod.resolveExtensionRelativePath('extension/src/services/forward-ref-annotation.ts', tmp),
        true,
        'repoRoot-relative extension path must resolve'
      );
      assert.equal(
        mod.resolveExtensionRelativePath('src/services/forward-ref-annotation.ts', tmp),
        true,
        'extension-dir-relative path must resolve via the shared extension base'
      );
      // Teeth: a genuine phantom must NOT false-pass.
      assert.equal(
        mod.resolveExtensionRelativePath('extension/src/does-not-exist.ts', tmp),
        false,
        'a phantom extension-relative path must not resolve'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
