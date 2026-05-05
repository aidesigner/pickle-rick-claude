// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER = path.resolve(__dirname, '../bin/refinement-watcher.js');

function tmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refine-rewrite-')));
}

function writeState(sessionDir, overrides = {}) {
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({
            active: true,
            step: 'research',
            working_dir: process.cwd(),
            ...overrides,
        }, null, 2),
    );
}

function writeManifest(sessionDir, manifest) {
    fs.writeFileSync(
        path.join(sessionDir, 'refinement_manifest.json'),
        JSON.stringify(manifest, null, 2),
    );
}

/**
 * R-MWR-5 / AC-MWR-03b: refinement-watcher must SURVIVE manifest
 * rewrite — when refinement_manifest.json is overwritten with new
 * content, the watcher consumes the rewrite without exiting. Exit is
 * owned exclusively by shouldStopForInactiveSession (state.active=false
 * AND step != 'prd', or state.json missing).
 *
 * The R-MWR-6 banner-reservation rule (`◤ FEED TERMINATED ◢`) does NOT
 * apply to refinement-watcher — its terminal banner is the
 * "Session inactive with no manifest" warning when refinement failed,
 * or the green "🥒 Refinement Complete" summary on success.
 */

test('refinement-watcher: survives manifest rewrite while session active (R-MWR-5)', async () => {
    const session = tmpDir();
    try {
        const refinementDir = path.join(session, 'refinement');
        fs.mkdirSync(refinementDir, { recursive: true });
        // Active session keeps the watcher polling; only state flip exits it.
        writeState(session, { active: true, step: 'research' });

        // Spawn watcher as a long-lived child so we can write multiple
        // manifests during its lifecycle.
        const child = spawn(process.execPath, [WATCHER, session], {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });

        // Wait for the watcher banner to land before we start poking.
        await new Promise(r => setTimeout(r, 400));

        // First manifest: cycle 1 of 2.
        writeManifest(session, {
            cycles_completed: 1,
            cycles_requested: 2,
            workers: [
                { role: 'requirements', success: true },
                { role: 'codebase', success: false },
                { role: 'risk-scope', success: true },
            ],
        });
        await new Promise(r => setTimeout(r, 700));

        // Watcher should have rendered the v1 summary by now.
        assert.ok(
            stdout.includes('Refinement Complete'),
            `expected v1 summary, got stdout: ${stdout}`,
        );
        const v1OutputLength = stdout.length;

        // Rewrite the manifest with new content (cycle 2 of 2).
        writeManifest(session, {
            cycles_completed: 2,
            cycles_requested: 2,
            workers: [
                { role: 'requirements', success: true },
                { role: 'codebase', success: true },
                { role: 'risk-scope', success: true },
            ],
        });
        await new Promise(r => setTimeout(r, 800));

        // R-MWR-5 invariant: the watcher must STILL be running. It must
        // NOT have exited just because a manifest was sighted. That
        // proves "polls indefinitely; rewrite consumed without exit".
        assert.equal(
            child.exitCode,
            null,
            `watcher must keep running after manifest rewrite; exited with ${child.exitCode}, stderr=${stderr}`,
        );
        // R-MWR-5 invariant: the rewrite must have been consumed. The
        // summary re-renders, so stdout grows past the v1 size.
        assert.ok(
            stdout.length > v1OutputLength,
            `expected v2 re-render to extend stdout; before=${v1OutputLength} after=${stdout.length}`,
        );

        // R-MWR-6 carve-out: refinement-watcher does NOT print
        // `◤ FEED TERMINATED ◢` on EOF or manifest sightings.
        assert.doesNotMatch(
            stdout,
            /FEED TERMINATED/,
            'refinement-watcher must not print the file-tail banner',
        );

        // Now flip state to inactive — the watcher exits via
        // shouldStopForInactiveSession.
        writeState(session, { active: false, step: 'research' });
        await new Promise(resolve => {
            const timer = setTimeout(() => resolve(), 4000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        if (child.exitCode === null) child.kill('SIGTERM');
        assert.equal(child.exitCode, 0, `expected clean exit on state inactive; got ${child.exitCode}, stderr=${stderr}`);
    } finally {
        fs.rmSync(session, { recursive: true, force: true });
    }
});

test('refinement-watcher: state-active blocks shouldStopForInactiveSession (no exit when busy)', async () => {
    const session = tmpDir();
    try {
        // Write only state.json with active=true (no refinement dir, no
        // manifest). The watcher should keep polling — it must NOT exit
        // just because the refinement dir is missing.
        writeState(session, { active: true, step: 'prd' });

        const child = spawn(process.execPath, [WATCHER, session], {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        await new Promise(r => setTimeout(r, 1500));

        assert.equal(
            child.exitCode,
            null,
            'watcher must keep polling while state is active and step=prd',
        );
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
    } finally {
        fs.rmSync(session, { recursive: true, force: true });
    }
});
