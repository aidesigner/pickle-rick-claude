import * as path from 'node:path';
import * as fs from 'node:fs';
const CODEX_BANNER_PATTERNS = [
    'Reading additional input from stdin...',
    'chatgpt.com/codex/settings/usage',
];
function detectCodexBanner(content) {
    return CODEX_BANNER_PATTERNS.filter((p) => content.includes(p));
}
function readSessionState(sessionDir) {
    try {
        const raw = fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8');
        const state = JSON.parse(raw);
        const backend = state.backend ?? 'unknown';
        const subtoolOverrideCount = (state.activity ?? []).filter((a) => a.event === 'subtool_backend_override').length;
        return { backend, subtoolOverrideCount };
    }
    catch {
        return { backend: 'unknown', subtoolOverrideCount: 0 };
    }
}
export function scanSession(sessionDir) {
    const { backend: sessionBackend, subtoolOverrideCount } = readSessionState(sessionDir);
    const mismatches = [];
    let scannedLogs = 0;
    let entries;
    try {
        entries = fs.readdirSync(sessionDir, { withFileTypes: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read session dir: ${msg}`);
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const ticketDir = path.join(sessionDir, entry.name);
        let logFiles;
        try {
            logFiles = fs.readdirSync(ticketDir).filter((f) => /^worker_session_\d+\.log$/.test(f));
        }
        catch {
            continue;
        }
        for (const logFile of logFiles) {
            scannedLogs += 1;
            let content;
            try {
                content = fs.readFileSync(path.join(ticketDir, logFile), 'utf-8');
            }
            catch {
                continue;
            }
            const patternsFound = detectCodexBanner(content);
            if (sessionBackend === 'claude' && patternsFound.length > 0) {
                mismatches.push({ ticket: entry.name, log: logFile, patterns_found: patternsFound });
            }
        }
    }
    return {
        session_dir: sessionDir,
        session_backend: sessionBackend,
        scanned_logs: scannedLogs,
        mismatch_count: mismatches.length,
        subtool_override_count: subtoolOverrideCount,
        mismatches,
    };
}
function usage() {
    process.stdout.write('Usage: audit-worker-backends.js <session-dir>\n\n' +
        'Scans <session>/<ticket>/worker_session_*.log files for codex-CLI banner patterns.\n' +
        'Reports cross-backend mismatches as JSON when session backend differs from detected worker backend.\n\n' +
        'Codex-CLI banner patterns:\n' +
        '  "Reading additional input from stdin..."\n' +
        '  "chatgpt.com/codex/settings/usage"\n\n' +
        'Note: subtool_backend_override events are excluded from mismatch_count per AC-BUNDLE-04 carve-out\n' +
        'and reported separately as subtool_override_count.\n\n' +
        'Exit codes:\n' +
        '  0  No mismatches found\n' +
        '  1  Mismatches found\n' +
        '  2  Error\n');
}
if (process.argv[1] && path.basename(process.argv[1]) === 'audit-worker-backends.js') {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        usage();
        process.exit(0);
    }
    const sessionDir = args.find((a) => !a.startsWith('--'));
    if (!sessionDir) {
        process.stderr.write('Error: session-dir is required\n');
        usage();
        process.exit(2);
    }
    try {
        const report = scanSession(path.resolve(sessionDir));
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exit(report.mismatch_count > 0 ? 1 : 0);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${msg}\n`);
        process.exit(2);
    }
}
