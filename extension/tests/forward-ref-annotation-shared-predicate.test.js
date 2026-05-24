// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const SRC_BIN = path.join(EXT_ROOT, 'src', 'bin');
const SRC_SVC = path.join(EXT_ROOT, 'src', 'services');

const checkReadinessSrc = fs.readFileSync(path.join(SRC_BIN, 'check-readiness.ts'), 'utf8');
const auditBundleSrc = fs.readFileSync(path.join(SRC_BIN, 'audit-ticket-bundle.ts'), 'utf8');

describe('R-FRA-6 shared forward-ref annotation predicate', () => {
  it('check-readiness.ts imports from ../services/forward-ref-annotation.js', () => {
    assert.ok(
      /from\s+['"]\.\.\/services\/forward-ref-annotation\.js['"]/.test(checkReadinessSrc),
      'check-readiness.ts must import from ../services/forward-ref-annotation.js'
    );
  });

  it('audit-ticket-bundle.ts imports from ../services/forward-ref-annotation.js', () => {
    assert.ok(
      /from\s+['"]\.\.\/services\/forward-ref-annotation\.js['"]/.test(auditBundleSrc),
      'audit-ticket-bundle.ts must import from ../services/forward-ref-annotation.js'
    );
  });

  it('check-readiness.ts contains no inline FORWARD_REF_ANNOTATION_RE = /.../ literal', () => {
    assert.ok(
      !/FORWARD_REF_ANNOTATION_RE\s*=\s*\//.test(checkReadinessSrc),
      'check-readiness.ts must not contain an inline FORWARD_REF_ANNOTATION_RE literal'
    );
  });

  it('audit-ticket-bundle.ts contains no inline FORWARD_REF_ANNOTATION_RE = /.../ literal', () => {
    assert.ok(
      !/FORWARD_REF_ANNOTATION_RE\s*=\s*\//.test(auditBundleSrc),
      'audit-ticket-bundle.ts must not contain an inline FORWARD_REF_ANNOTATION_RE literal'
    );
  });

  it('exported FORWARD_REF_ANNOTATION_RE matches (forward-created) canonical form', async () => {
    const mod = await import(path.join(EXT_ROOT, 'services', 'forward-ref-annotation.js'));
    const re = new RegExp(mod.FORWARD_REF_ANNOTATION_RE.source, mod.FORWARD_REF_ANNOTATION_RE.flags);
    assert.ok(re.test('`extension/src/foo.ts` (forward-created)'), 'should match (forward-created)');
  });

  it('exported FORWARD_REF_ANNOTATION_RE matches (created by ticket <8hex>) canonical form', async () => {
    const mod = await import(path.join(EXT_ROOT, 'services', 'forward-ref-annotation.js'));
    const re = new RegExp(mod.FORWARD_REF_ANNOTATION_RE.source, mod.FORWARD_REF_ANNOTATION_RE.flags);
    assert.ok(re.test('`extension/src/foo.ts` (created by ticket abc12345)'), 'should match (created by ticket <8hex>)');
  });

  it('exported FORWARD_REF_ANNOTATION_RE matches (introduced by ticket <8hex>) canonical form', async () => {
    const mod = await import(path.join(EXT_ROOT, 'services', 'forward-ref-annotation.js'));
    const re = new RegExp(mod.FORWARD_REF_ANNOTATION_RE.source, mod.FORWARD_REF_ANNOTATION_RE.flags);
    assert.ok(re.test('`extension/src/foo.ts` (introduced by ticket abc12345)'), 'should match (introduced by ticket <8hex>)');
  });
});
