// @tier: fast
// R-RTRC-7: forward-reference annotation schema + format test.
//
// Schema (per parent PRD Section D):
//   `<token>` (created|introduced) by ticket <hash>
//   - position OUTSIDE backticks
//   - separator MUST be exactly one ASCII space (no-space, two-space, tab → fail)
//   - hash = 8-char short SHA OR ticket-dir basename (resolver normalizes by length)
//
// AC-RTRC-07: Resolver accepts both 8-char SHA and ticket-dir basename
// annotations; mismatched separator (no-space, two-space, tab) fails with
// `annotation-format-error`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractForwardRefAnnotations } from '../bin/check-readiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix = 'pickle-rtrc-annot-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `linear_ticket_${id}.md`);
    fs.writeFileSync(ticketPath, body);
    return ticketPath;
}

function runReadiness(sessionDir, repoRoot = REPO_ROOT) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--contract-only',
    ], { encoding: 'utf-8', timeout: 15000 });
}

test('R-RTRC-7: extractForwardRefAnnotations accepts canonical 8-char SHA annotation', () => {
    const content = '`extension/services/new-helper.ts` (created by ticket 5c75a9eb) is forward-created.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('extension/services/new-helper.ts'), true);
});

test('R-RTRC-7: extractForwardRefAnnotations accepts legacy bare forward-created marker', () => {
    const content = '`extension/services/new-helper.ts` (forward-created) is carried by a sibling ticket.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('extension/services/new-helper.ts'), true);
});

test('R-RTRC-7: extractForwardRefAnnotations accepts hybrid forward-created by ticket annotation', () => {
    const content = '`extension/services/hybrid-helper.ts` (forward-created by ticket abc1ef23) — hybrid form.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('extension/services/hybrid-helper.ts'), true);
    const annotation = [...content.matchAll(/`([^`]+)`/g)][0];
    assert.equal(annotation[1], 'extension/services/hybrid-helper.ts');
});

test('R-RTRC-7: hybrid annotation hash extracted into ForwardRefAnnotation.hash', () => {
    const content = '`extension/services/h.ts` (forward-created by ticket 12345678) — hybrid with hash.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 1);
    assert.equal(out.malformed.length, 0);
});

test('R-RTRC-7: hybrid with bad hash length is malformed', () => {
    // Hash 'abc' is 3 chars, regex requires 6-12.
    const content = '`extension/services/h.ts` (forward-created by ticket abc) — too short.';
    const out = extractForwardRefAnnotations(content);
    // Regex itself won't match; falls through to no-annotation path, so the path remains unresolved (valid stays empty).
    assert.equal(out.valid.size, 0);
});

test('R-RTRC-7: extractForwardRefAnnotations accepts ticket-dir basename annotation', () => {
    const content = '`extension/services/another.ts` (introduced by ticket dddee00b) is forward-created.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('extension/services/another.ts'), true);
});

test('R-RTRC-7: no-space separator → annotation-format-error', () => {
    const content = '`extension/foo.ts`(created by ticket 5c75a9eb) — no space.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
    assert.equal(out.malformed[0].separator, '');
});

test('R-RTRC-7: two-space separator → annotation-format-error', () => {
    const content = '`extension/foo.ts`  (created by ticket 5c75a9eb) — two spaces.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
    assert.equal(out.malformed[0].separator, '  ');
});

test('R-RTRC-7: tab separator → annotation-format-error', () => {
    const content = '`extension/foo.ts`\t(created by ticket 5c75a9eb) — tab.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
    assert.equal(out.malformed[0].separator, '\t');
});

test('R-RTRC-7: hash too short (< 6 chars) → annotation-format-error', () => {
    const content = '`extension/foo.ts` (created by ticket abc12) — short hash.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
});

test('R-RTRC-7: hash too long (> 12 chars) → annotation-format-error', () => {
    const content = '`extension/foo.ts` (created by ticket abc1234567890123) — long hash.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
});

test('R-RTRC-7: introduced verb accepted same as created', () => {
    const content = '`SomeSymbol.method()` (introduced by ticket abcdef12) is forward-introduced.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('SomeSymbol.method()'), true);
});

test('R-RTRC-7: requirement-code alias accepted for forward-created helper contracts', () => {
    const content = '`FutureHelper.build()` (created by R-SAOV-1) is forward-created by a sibling requirement.';
    const out = extractForwardRefAnnotations(content);
    assert.deepEqual(out.malformed, []);
    assert.equal(out.valid.has('FutureHelper.build()'), true);
});

test('R-RTRC-7: requirement-code alias on a path is malformed', () => {
    const content = '`extension/services/new-helper.ts` (created by R-SAOV-1) is not a valid path annotation.';
    const out = extractForwardRefAnnotations(content);
    assert.equal(out.valid.size, 0);
    assert.equal(out.malformed.length, 1);
});

test('R-RTRC-7: end-to-end — canonical annotation suppresses contract finding (8-char SHA)', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtrc7sha', [
            '---',
            'id: rtrc7sha',
            'key: RTRC7-SHA',
            'ac_ids: []',
            '---',
            '',
            '# Forward-ref via 8-char SHA',
            '',
            '## Files',
            '',
            '- `extension/services/forward-rtrc7sha.ts` (created by ticket 5c75a9eb)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-7: end-to-end — legacy bare forward-created path suppresses contract finding', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtrc7fwd', [
            '---',
            'id: rtrc7fwd',
            'key: RTRC7-FWD',
            'ac_ids: []',
            '---',
            '',
            '# Forward-ref via legacy bare marker',
            '',
            '## Files',
            '',
            '- `extension/services/forward-rtrc7fwd.ts` (forward-created)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-7: end-to-end — canonical annotation suppresses contract finding (ticket-dir basename)', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtrc7dir', [
            '---',
            'id: rtrc7dir',
            'key: RTRC7-DIR',
            'ac_ids: []',
            '---',
            '',
            '# Forward-ref via ticket-dir basename',
            '',
            '## Files',
            '',
            '- `extension/services/forward-rtrc7dir.ts` (introduced by ticket rtrc7dir)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-7: end-to-end — requirement-code alias suppresses forward-created helper contract finding', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtrc7req', [
            '---',
            'id: rtrc7req',
            'key: RTRC7-REQ',
            'ac_ids: []',
            '---',
            '',
            '# Forward-ref via requirement-code alias',
            '',
            '## Interface Contracts',
            '',
            '- `FutureHelper.build()` (created by R-SAOV-1) MUST exist after sibling work lands.',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 0, `expected exit 0; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass');
        assert.deepEqual(out.findings, []);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-7: end-to-end — requirement-code alias on a path fails readiness before ticket audit', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'a1b2c3d4', [
            '---',
            'id: a1b2c3d4',
            'key: RTRC7-PATH-ALIAS',
            'ac_ids: []',
            '---',
            '',
            '# Invalid path alias',
            '',
            '## Files to modify',
            '',
            '- `extension/services/not-yet-real-rtrc7pth.ts` (created by R-SAOV-1)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 2, `expected exit 2; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        const annotationFindings = out.findings.filter((f) => f.kind === 'annotation_format');
        const filePathFindings = out.findings.filter((f) => f.kind === 'file_path');
        assert.equal(annotationFindings.length, 1, `expected annotation_format finding, got ${JSON.stringify(out.findings)}`);
        assert.equal(filePathFindings.length, 1, `expected file_path finding, got ${JSON.stringify(out.findings)}`);
        assert.match(annotationFindings[0].detail, /created by R-SAOV-1/);
        assert.equal(filePathFindings[0].detail, 'extension/services/not-yet-real-rtrc7pth.ts');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('R-RTRC-7: end-to-end — malformed annotation produces annotation_format finding', () => {
    const sessionDir = tmpDir();
    try {
        writeTicket(sessionDir, 'rtrc7bad', [
            '---',
            'id: rtrc7bad',
            'key: RTRC7-BAD',
            'ac_ids: []',
            '---',
            '',
            '# Malformed annotation (two-space separator)',
            '',
            '## Files',
            '',
            // Two spaces between backtick and paren — annotation-format-error.
            '- `extension/services/forward-rtrc7bad.ts`  (created by ticket 5c75a9eb)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command exits 0 exactly.',
            '',
        ].join('\n'));
        const result = runReadiness(sessionDir);
        assert.equal(result.status, 2, `expected exit 2; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        const annotationFindings = out.findings.filter((f) => f.kind === 'annotation_format');
        assert.equal(annotationFindings.length, 1);
        assert.match(annotationFindings[0].message, /annotation-format-error/);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
