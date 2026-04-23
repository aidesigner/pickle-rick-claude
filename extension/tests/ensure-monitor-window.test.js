import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureMonitorWindow, inferMonitorMode, monitorModesCompatible } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Set up a tmpdir with a fake tmux + fake bash so ensureMonitorWindow can be
 * exercised without a real tmux server. The shims record every invocation to
 * `$TMP/calls.log` so assertions can inspect what happened.
 */
function makeFakes(opts) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-')));
    const callsLog = path.join(tmpRoot, 'calls.log');

    // Session dir with minimal state.json — inferMonitorMode reads it.
    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({ active: true, command_template: opts.commandTemplate || null }),
    );

    // Extension root with a stub tmux-monitor.sh. We don't let the real one
    // run — the fake bash intercepts the shebang-less invocation and just
    // records its argv to the calls log.
    const extRoot = path.join(tmpRoot, 'ext');
    fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
    fs.writeFileSync(
        path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
        '#!/bin/sh\necho "real script would run" >&2\nexit 0\n',
    );

    // Fake tmux: dispatches on subcommand. `display-message` echoes the
    // session name; `list-windows` echoes either "monitor" or "runner"
    // depending on whether $TMP/.monitor-exists marker is present;
    // `show-option @pickle_monitor_mode` echoes whatever is in
    // $TMP/.monitor-mode (empty = unset); `kill-window` and `set-option`
    // drop a marker so assertions can observe them.
    const fakeTmux = path.join(tmpRoot, 'fake-tmux.sh');
    const markerPath = path.join(tmpRoot, '.monitor-exists');
    const modeMarkerPath = path.join(tmpRoot, '.monitor-mode');
    const killMarkerPath = path.join(tmpRoot, '.monitor-killed');
    fs.writeFileSync(
        fakeTmux,
        `#!/bin/sh
echo "tmux $*" >> "${callsLog}"
case "$1" in
  display-message)
    echo "${opts.sessionName || 'pickle-test'}"
    ;;
  list-windows)
    if [ -f "${markerPath}" ]; then
      echo monitor
    else
      echo runner
    fi
    ;;
  show-option)
    if [ -f "${modeMarkerPath}" ]; then
      cat "${modeMarkerPath}"
    fi
    ;;
  kill-window)
    touch "${killMarkerPath}"
    rm -f "${markerPath}"
    rm -f "${modeMarkerPath}"
    ;;
  set-option)
    # Last arg is the mode value; stamp it so subsequent show-option sees it.
    eval "mode=\\\${$#}"
    printf "%s" "$mode" > "${modeMarkerPath}"
    ;;
esac
exit 0
`,
    );
    fs.chmodSync(fakeTmux, 0o755);

    // Fake bash: records invocation, doesn't actually execute the script.
    const fakeBash = path.join(tmpRoot, 'fake-bash.sh');
    fs.writeFileSync(
        fakeBash,
        `#!/bin/sh
echo "bash $*" >> "${callsLog}"
exit 0
`,
    );
    fs.chmodSync(fakeBash, 0o755);

    return {
        tmpRoot,
        sessionDir,
        extRoot,
        callsLog,
        markerPath,
        modeMarkerPath,
        killMarkerPath,
        tmuxBin: fakeTmux,
        bashBin: fakeBash,
        cleanup() {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        },
        readCalls() {
            return fs.existsSync(callsLog) ? fs.readFileSync(callsLog, 'utf-8') : '';
        },
    };
}

test('ensureMonitorWindow: skipped when not inside tmux', () => {
    const f = makeFakes({});
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: false,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'skipped');
        assert.equal(f.readCalls(), '', 'should not invoke tmux or bash when skipped');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: creates monitor when window does not exist', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        const calls = f.readCalls();
        assert.match(calls, /tmux display-message/);
        assert.match(calls, /tmux list-windows -t pickle-abc12345/);
        // bash invocation carries the script path, session name, session dir, mode
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+session pickle/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: no-op when monitor window already exists', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345' });
    // Simulate existing monitor window stamped with the same mode we'll infer.
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'exists');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option/, 'should read stamped mode');
        assert.doesNotMatch(calls, /tmux kill-window/, 'should not kill a compatible window');
        assert.doesNotMatch(calls, /bash .+tmux-monitor\.sh/, 'should not spawn script when monitor exists');
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: kills and recreates when existing window has different @mode', () => {
    const f = makeFakes({ sessionName: 'pickle-abc12345', commandTemplate: 'council-of-ricks.md' });
    // Simulate an existing monitor window stamped for a different mode
    // (e.g. a previous anatomy-park / pickle pipeline phase).
    fs.writeFileSync(f.markerPath, '1');
    fs.writeFileSync(f.modeMarkerPath, 'pickle');
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'recreated');
        const calls = f.readCalls();
        assert.match(calls, /tmux list-windows/);
        assert.match(calls, /tmux show-option -w -qv -t pickle-abc12345:monitor @pickle_monitor_mode/);
        assert.match(calls, /tmux kill-window -t pickle-abc12345:monitor/, 'should kill stale window');
        assert.match(calls, /bash .+tmux-monitor\.sh pickle-abc12345 .+session council/, 'should respawn in council mode');
        assert.match(calls, /tmux set-option -w -t pickle-abc12345:monitor @pickle_monitor_mode council/, 'should stamp new mode');
        assert.ok(fs.existsSync(f.killMarkerPath), 'kill-window must have fired');
    } finally {
        f.cleanup();
    }
});

test('monitorModesCompatible: unset existing => incompatible; matching => compatible', () => {
    assert.equal(monitorModesCompatible(null, 'council'), false);
    assert.equal(monitorModesCompatible('', 'council'), false);
    assert.equal(monitorModesCompatible('pickle', 'council'), false);
    assert.equal(monitorModesCompatible('council', 'council'), true);
    assert.equal(monitorModesCompatible('meeseeks', 'meeseeks'), true);
});

test('ensureMonitorWindow: infers meeseeks mode from state.command_template', () => {
    const f = makeFakes({ sessionName: 'meeseeks-abc', commandTemplate: 'meeseeks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh meeseeks-abc .+session meeseeks/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: infers council mode from state.command_template', () => {
    const f = makeFakes({ sessionName: 'council-abc', commandTemplate: 'council-of-ricks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh council-abc .+session council/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: explicit mode overrides state-inferred mode', () => {
    const f = makeFakes({ sessionName: 'pickle-abc', commandTemplate: 'meeseeks.md' });
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
            mode: 'refinement',
        });
        assert.equal(result.status, 'created');
        assert.match(f.readCalls(), /tmux-monitor\.sh pickle-abc .+session refinement/);
    } finally {
        f.cleanup();
    }
});

test('ensureMonitorWindow: returns error when tmux-monitor.sh is missing', () => {
    const f = makeFakes({});
    // Delete the stub script to simulate a broken install.
    fs.rmSync(path.join(f.extRoot, 'extension', 'scripts', 'tmux-monitor.sh'));
    try {
        const result = ensureMonitorWindow({
            sessionDir: f.sessionDir,
            extensionRoot: f.extRoot,
            inTmux: true,
            tmuxBin: f.tmuxBin,
            bashBin: f.bashBin,
        });
        assert.equal(result.status, 'error');
        assert.match(result.reason, /script missing/);
    } finally {
        f.cleanup();
    }
});

test('inferMonitorMode: defaults to pickle when state.json missing', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('inferMonitorMode: maps command_template values', () => {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mode-')));
    try {
        const write = (tpl) => fs.writeFileSync(
            path.join(tmpRoot, 'state.json'),
            JSON.stringify({ command_template: tpl }),
        );

        write('meeseeks.md');
        assert.equal(inferMonitorMode(tmpRoot), 'meeseeks');

        write('council-of-ricks.md');
        assert.equal(inferMonitorMode(tmpRoot), 'council');

        write('szechuan-sauce.md');
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');

        write(null);
        assert.equal(inferMonitorMode(tmpRoot), 'pickle');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
