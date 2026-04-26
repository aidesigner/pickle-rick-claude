/**
 * Verifies the all-pending guard error message includes the absolute iteration
 * log path. Runs mux-runner.js as a subprocess with a fake `claude` that emits
 * EPIC_COMPLETED while a second ticket remains pending.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-guard-log-')));
}

function buildSession(tmpRoot) {
    const extDir = path.join(tmpRoot, 'ext');
    const templatesDir = path.join(extDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });

    // Minimal pickle_settings.json with CB disabled so the guard path is not blocked.
    fs.writeFileSync(
        path.join(extDir, 'pickle_settings.json'),
        JSON.stringify({
            default_max_iterations: 3,
            default_max_time_minutes: 720,
            default_worker_timeout_seconds: 1200,
            default_manager_max_turns: 50,
            default_tmux_max_turns: 200,
            default_refinement_cycles: 3,
            default_refinement_max_turns: 100,
            default_meeseeks_model: 'sonnet',
            default_meeseeks_min_passes: 10,
            default_meeseeks_max_passes: 20,
            circuit_breaker: { enabled: false },
        })
    );

    // Minimal template so runIteration can build a prompt without install.sh.
    fs.writeFileSync(path.join(templatesDir, 'pickle.md'), '# Test\n$ARGUMENTS\n');

    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Ticket A — current ticket (still Todo; guard excludes it from pending check).
    const tickADir = path.join(sessionDir, 'tickA');
    fs.mkdirSync(tickADir, { recursive: true });
    fs.writeFileSync(
        path.join(tickADir, 'linear_ticket_tickA.md'),
        ['---', 'id: tickA', 'title: Ticket A', 'status: Todo', 'order: 1', '---', '', '# Ticket A'].join('\n')
    );

    // Ticket B — pending; will cause the guard to fire.
    const tickBDir = path.join(sessionDir, 'tickB');
    fs.mkdirSync(tickBDir, { recursive: true });
    fs.writeFileSync(
        path.join(tickBDir, 'linear_ticket_tickB.md'),
        ['---', 'id: tickB', 'title: Ticket B', 'status: Todo', 'order: 2', '---', '', '# Ticket B'].join('\n')
    );

    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({
            active: true,
            working_dir: tmpRoot,
            step: 'implement',
            iteration: 0,
            max_iterations: 3,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000),
            completion_promise: null,
            original_prompt: 'guard logging test',
            current_ticket: 'tickA',
            history: [],
            started_at: new Date().toISOString(),
            session_dir: sessionDir,
            schema_version: 1,
            chain_meeseeks: false,
        }, null, 2)
    );

    // Fake claude: emits EPIC_COMPLETED in stream-json assistant format then exits 0.
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaudePath = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(
        fakeClaudePath,
        '#!/bin/sh\necho \'{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>EPIC_COMPLETED</promise>"}]}}\'\n'
    );
    fs.chmodSync(fakeClaudePath, 0o755);

    return { extDir, sessionDir, fakeBinDir };
}

test('guard-logging: pending-guard error message includes absolute iteration log path', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { extDir, sessionDir, fakeBinDir } = buildSession(tmpRoot);
        const expectedLogPath = path.join(sessionDir, 'tmux_iteration_1.log');

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: extDir,
                PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
            },
            encoding: 'utf-8',
            // 20s → 60s: budget for system load when run alongside concurrent
            // codex/tmux work. Test validates error message content, not wall-clock.
            timeout: 60000,
        });

        const output = (result.stderr ?? '') + (result.stdout ?? '');

        assert.ok(
            result.status === 1,
            `Expected exit code 1, got ${result.status}. Output:\n${output}`
        );

        assert.ok(
            output.includes('still pending'),
            `Expected "still pending" in output. Got:\n${output}`
        );

        assert.ok(
            output.includes('Iteration log:'),
            `Expected "Iteration log:" in guard error. Got:\n${output}`
        );

        assert.ok(
            output.includes(expectedLogPath),
            `Expected absolute log path "${expectedLogPath}" in guard error. Got:\n${output}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guard-logging: compiled mux-runner.js embeds iterLogFile in the pending-guard message', () => {
    const compiled = fs.readFileSync(path.resolve(__dirname, '../bin/mux-runner.js'), 'utf-8');
    assert.ok(
        /Iteration log:.*iterLogFile|iterLogFile.*Iteration log:/.test(compiled),
        'Expected "Iteration log:" + iterLogFile concatenation in compiled mux-runner.js'
    );
});
