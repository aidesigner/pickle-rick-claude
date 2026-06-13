// @tier: fast
// W1b (forward-created): refiner Step 7 auto-emits canonical forward-creation
// annotations. Two halves:
//   (A) PROMPT contract — the `.claude/commands/pickle-refine-prd.md` Step 7c
//       hygiene block instructs canonical emission, forbids the bare
//       `(ticket <hash>)` form, and covers event-literal forward-refs.
//   (B) READINESS contract (AC-W1b-2) — a forward-creating bundle where an
//       order-70 ticket references a file / symbol / event-literal declared by
//       an order-10 ticket, each carrying the canonical annotation, passes the
//       compiled check-readiness.js (exit 0, no findings, no skip-flag).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_CMD = path.resolve(REPO_ROOT, '..', '.claude/commands/pickle-refine-prd.md');
const BIN = path.resolve(REPO_ROOT, 'bin/check-readiness.js');

function tmpDir(prefix = 'pickle-w1b-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, lines) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), lines.join('\n'));
}

function runReadiness(sessionDir, repoRoot) {
    return spawnSync(process.execPath, [
        BIN,
        '--session-dir', sessionDir,
        '--repo-root', repoRoot,
        '--contract-only',
    ], { encoding: 'utf-8', timeout: 15000 });
}

// ── (A) PROMPT contract ────────────────────────────────────────────────────

test('W1b: Step 7 prompt instructs canonical forward-creation emission', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    // R-FRA-1 anchor + auto-emit directive.
    assert.match(content, /🚦 Forward-reference hygiene/);
    assert.match(content, /AUTO-EMIT the canonical forward-reference annotation/);
    // All three canonical forms present as worked guidance.
    assert.match(content, /\(forward-created\)/);
    assert.match(content, /\(created by ticket/);
    assert.match(content, /\(introduced by ticket/);
});

test('W1b: Step 7 prompt forbids the non-canonical bare (ticket <hash>) form', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    assert.match(content, /NEVER emit the bare `\(ticket <hash>\)` form/);
    // The decomposer prompt itself must contain ZERO bare forward-refs (the
    // AC-W1b-1 lint) — a concrete 8-hex bare form would be a regression.
    assert.doesNotMatch(content, /\(ticket [0-9a-f]{8}\)/);
    assert.doesNotMatch(content, /\(ticket [0-9a-f]{6,12}\)/);
});

test('W1b: Step 7 prompt covers event-literal forward-refs (R-RTRC-7 gap)', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    assert.match(content, /event literal/i);
    // The worked event-literal example carries the canonical annotation.
    assert.match(content, /`worker_auto_skip_oversized` \(created by ticket/);
});

// ── (B) READINESS contract (AC-W1b-2) ──────────────────────────────────────

test('W1b AC-W1b-2: order-70 forward-refs to order-10 artifacts pass readiness (exit 0, no findings)', () => {
    const sessionDir = tmpDir();
    const repoRoot = tmpDir('pickle-w1b-repo-');
    try {
        // Fresh repo: the forward-created path/symbol/event do NOT exist at HEAD.
        spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.email', 'w1b@example.com'], { cwd: repoRoot });
        spawnSync('git', ['config', 'user.name', 'w1b'], { cwd: repoRoot });
        fs.writeFileSync(path.join(repoRoot, 'README.md'), 'seed\n');
        spawnSync('git', ['add', '-A'], { cwd: repoRoot });
        spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

        // Order-10 ticket DECLARES the forward-created artifacts.
        writeTicket(sessionDir, 'w1border10', [
            '---',
            'id: w1border10',
            'key: W1B-10',
            'order: 10',
            'ac_ids: []',
            '---',
            '',
            '# Order 10: create the helper, symbol, and event',
            '',
            '## Implementation Details',
            '',
            '**Files to modify/create:** `src/services/forward-w1b-helper.ts` (forward-created)',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command writes a JSON file with field `kind` matching exactly `bundle`.',
            '',
        ]);

        // Order-70 ticket REFERENCES the order-10 artifacts via canonical
        // cross-ticket annotations (path, symbol, AND event-literal).
        writeTicket(sessionDir, 'w1border70', [
            '---',
            'id: w1border70',
            'key: W1B-70',
            'order: 70',
            'ac_ids: []',
            '---',
            '',
            '# Order 70: consume the order-10 artifacts',
            '',
            '## Research Seeds',
            '',
            '- **Files:** `src/services/forward-w1b-helper.ts` (created by ticket w1border10)',
            '',
            '## Interface Contracts',
            '',
            '- `ForwardW1bHelper.build()` (introduced by ticket w1border10) is the entry point.',
            '- emits `worker_auto_skip_oversized` (created by ticket w1border10) on overflow.',
            '',
            '## Acceptance Criteria',
            '',
            '- [ ] Command writes a JSON file with field `kind` matching exactly `bundle`.',
            '',
        ]);

        const result = runReadiness(sessionDir, repoRoot);
        assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.status, 'pass', `expected pass; out=${result.stdout}`);
        assert.deepEqual(out.findings, [], 'forward-creating refs must produce zero findings');
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
