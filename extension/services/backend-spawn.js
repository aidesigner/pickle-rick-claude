import * as fs from 'fs';
import * as path from 'path';
import { BACKENDS } from '../types/index.js';
export function isBackend(value) {
    return typeof value === 'string' && BACKENDS.includes(value);
}
// Dedupe by (source, value) so a bad state.json or typo'd env var warns once
// per process rather than N times per call site. Same silent-fallback trap-door
// class as the spawnSync-no-timeout cluster: a downgrade to 'claude' that should
// have been 'codex' wastes a whole Morty spawn with no signal.
const _warnedBackends = new Set();
export function __resetBackendWarnings() {
    _warnedBackends.clear();
}
function warnBadBackend(sourceLabel, value) {
    const key = `${sourceLabel}:${value}`;
    if (_warnedBackends.has(key))
        return;
    _warnedBackends.add(key);
    process.stderr.write(`[pickle-rick] unrecognized backend ${JSON.stringify(value)} from ${sourceLabel} — falling back to 'claude' (valid: ${BACKENDS.join(', ')})\n`);
}
export function resolveBackend(source) {
    const raw = source ? source.backend : undefined;
    if (isBackend(raw))
        return raw;
    if (typeof raw === 'string' && raw.length > 0)
        warnBadBackend('state', raw);
    const env = process.env.PICKLE_BACKEND;
    if (isBackend(env))
        return env;
    if (typeof env === 'string' && env.length > 0)
        warnBadBackend('PICKLE_BACKEND env', env);
    return 'claude';
}
export function resolveBackendFromStateFile(statePath) {
    try {
        const raw = fs.readFileSync(statePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return resolveBackend(parsed);
    }
    catch {
        return resolveBackend(null);
    }
}
export function buildWorkerInvocation(backend, opts) {
    if (backend === 'codex')
        return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
    return buildClaudeWorkerInvocation(opts);
}
export function buildManagerInvocation(backend, opts) {
    if (backend === 'codex')
        return buildCodexInvocation(opts.prompt, opts.addDirs, opts.model);
    return buildClaudeManagerInvocation(opts);
}
function buildClaudeWorkerInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (opts.outputFormat && opts.outputFormat !== 'text') {
        args.push('--output-format', opts.outputFormat);
    }
    if (opts.model)
        args.push('--model', opts.model);
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildClaudeManagerInvocation(opts) {
    const args = ['--dangerously-skip-permissions'];
    for (const dir of opts.addDirs) {
        if (dir)
            args.push('--add-dir', dir);
    }
    if (opts.noSessionPersistence)
        args.push('--no-session-persistence');
    if (opts.streamJson)
        args.push('--output-format', 'stream-json', '--verbose');
    if (typeof opts.maxTurns === 'number' && opts.maxTurns > 0) {
        args.push('--max-turns', String(opts.maxTurns));
    }
    if (opts.model)
        args.push('--model', opts.model);
    args.push('-p', opts.prompt);
    return { cmd: 'claude', args, backend: 'claude' };
}
function buildCodexInvocation(prompt, addDirs, model) {
    const args = [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--ephemeral',
    ];
    for (const dir of addDirs) {
        if (dir && existsSilently(dir))
            args.push('--add-dir', dir);
    }
    if (model)
        args.push('-m', model);
    args.push('--', prompt);
    return { cmd: 'codex', args, backend: 'codex' };
}
function existsSilently(p) {
    try {
        return fs.existsSync(p);
    }
    catch {
        return false;
    }
}
export function backendEnvOverrides(backend) {
    const env = { PICKLE_BACKEND: backend };
    return env;
}
export function loadBackendFromSession(sessionDir) {
    return resolveBackendFromStateFile(path.join(sessionDir, 'state.json'));
}
