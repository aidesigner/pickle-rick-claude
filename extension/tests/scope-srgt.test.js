// @tier: fast
/**
 * R-SRGT (Finding #50) — scope-resolver import-walk friction.
 *  - R-SRGT-1: an empty seed set short-circuits computeOneHop with no grep
 *    subprocess at all (`--scope branch` on an empty branch diff).
 *  - R-SRGT-2: the aggregate importer walk is bounded by a wall-clock cap, so
 *    a many-export seed file in a large repo cannot run `N × per-grep-timeout`
 *    unbounded (the 67s readiness-gate stall in the bug report).
 *
 * Strategy mirrors scope-one-hop-hang-guard.test.js: real spawnSync paths with
 * hanging `rg`/`grep` shims on PATH, not mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeOneHop } from '../services/scope-resolver.js';

const HANG_SCRIPT = `#!/usr/bin/env node
setTimeout(() => process.exit(0), 60_000);
`;

function withHangingToolsOnPath(fn) {
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-srgt-')));
    try {
        for (const tool of ['rg', 'grep']) {
            const shimPath = path.join(shimDir, tool);
            fs.writeFileSync(shimPath, HANG_SCRIPT);
            fs.chmodSync(shimPath, 0o755);
        }
        const originalPath = process.env.PATH ?? '';
        process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
        try {
            return fn();
        } finally {
            process.env.PATH = originalPath;
        }
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
}

test('R-SRGT-1: computeOneHop short-circuits an empty seed set with no grep spawn', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-srgt-repo-')));
    try {
        withHangingToolsOnPath(() => {
            const start = Date.now();
            const result = computeOneHop([], repo, { findImportersTimeoutMs: 5_000 });
            const elapsed = Date.now() - start;
            assert.deepEqual(result, [], 'empty seed set returns []');
            assert.ok(
                elapsed < 100,
                `empty-seed computeOneHop must not spawn a (hanging) grep; elapsed ${elapsed}ms`,
            );
        });
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('R-SRGT-2: computeOneHop importer walk is bounded by the wall-clock cap', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-srgt-repo-')));
    try {
        // A seed file with 8 exports — without the cap this is 8 × (rg + grep)
        // hanging calls. The injected per-grep timeout is 300ms, so an
        // uncapped walk would take ~8 × 2 × 300ms ≈ 4.8s.
        const exports = Array.from({ length: 8 }, (_, i) => `export function fn${i}() {}`).join('\n');
        fs.writeFileSync(path.join(repo, 'seed.ts'), `${exports}\n`);

        withHangingToolsOnPath(() => {
            const start = Date.now();
            const result = computeOneHop(['seed.ts'], repo, {
                findImportersTimeoutMs: 300,
                walkWallMs: 100,
            });
            const elapsed = Date.now() - start;
            assert.ok(result.includes('seed.ts'), 'seed file returned');
            assert.ok(
                elapsed < 2_000,
                `wall-clock cap must bound the walk well below 8 exports' worth of greps; elapsed ${elapsed}ms`,
            );
        });
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});
