import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function loadGateCommands() {
    const dataPath = path.resolve(__dirname, '../data/gate-commands.json');
    return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}
export class GateError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = 'GateError';
        this.kind = kind;
    }
}
export function detectProjectType(workingDir) {
    const has = (f) => fs.existsSync(path.join(workingDir, f));
    if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml'))
        return 'pnpm';
    if (has('yarn.lock'))
        return 'yarn';
    if (has('package-lock.json'))
        return 'npm';
    if (has('package.json'))
        return 'npm';
    if (has('Cargo.toml'))
        return 'cargo';
    if (has('go.mod'))
        return 'go';
    return null;
}
function parsePnpmWorkspaceYaml(content) {
    const patterns = [];
    let inPackages = false;
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'packages:') {
            inPackages = true;
            continue;
        }
        if (!inPackages)
            continue;
        if (trimmed.startsWith('- ')) {
            patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ''));
        }
        else if (trimmed && !trimmed.startsWith('#')) {
            inPackages = false;
        }
    }
    return patterns;
}
function resolveWorkspaceGlobs(workingDir, patterns) {
    const results = [];
    for (const pattern of patterns) {
        const parts = pattern.split('/');
        const starIdx = parts.findIndex(p => p.includes('*'));
        if (starIdx === -1) {
            const resolved = path.resolve(workingDir, pattern);
            if (fs.existsSync(path.join(resolved, 'package.json')))
                results.push(resolved);
            continue;
        }
        const base = path.resolve(workingDir, parts.slice(0, starIdx).join('/') || '.');
        let entries;
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const candidate = path.join(base, entry.name);
            if (fs.existsSync(path.join(candidate, 'package.json')))
                results.push(candidate);
        }
    }
    return results;
}
export function getWorkspacePackages(workingDir) {
    const pnpmYaml = path.join(workingDir, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmYaml)) {
        const patterns = parsePnpmWorkspaceYaml(fs.readFileSync(pnpmYaml, 'utf-8'));
        return resolveWorkspaceGlobs(workingDir, patterns);
    }
    const pkgJsonPath = path.join(workingDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            const ws = pkg.workspaces;
            if (ws) {
                const patterns = Array.isArray(ws) ? ws : (ws.packages ?? []);
                return resolveWorkspaceGlobs(workingDir, patterns);
            }
        }
        catch {
            /* not a valid package.json with workspaces */
        }
    }
    return [];
}
function globToRegex(pattern) {
    // Strip trailing /** so the base dir itself matches: packages/b/** → ^packages/b(/.*)?$
    const pat = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    const re = pat
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\x00/g, '.*')
        .replace(/\?/g, '[^/]');
    return new RegExp(`^${re}(/.*)?$`);
}
export function filterByScope(files, opts) {
    if (!opts.allowedPaths || opts.allowedPaths.length === 0)
        return files;
    const regexes = opts.allowedPaths.map(globToRegex);
    return files.filter(f => regexes.some(re => re.test(f)));
}
function getChangedSince(workingDir, since) {
    const result = spawnSync('git', ['diff', '--name-only', `${since}..HEAD`], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
    });
    if ((result.status ?? 1) !== 0)
        return [];
    return (result.stdout || '').split('\n').filter(Boolean);
}
async function runCheckCommand(cmd, cwd) {
    const parts = cmd.split(' ');
    const bin = parts[0];
    const args = parts.slice(1);
    try {
        const { stdout, stderr } = await execFileAsync(bin, args, {
            cwd,
            timeout: 300_000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
    }
    catch (err) {
        const e = err;
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: typeof e.code === 'number' ? e.code : 1,
        };
    }
}
function buildFailures(result, check, pkgDir) {
    if (result.exitCode === 0)
        return [];
    const output = (result.stderr || result.stdout).trim();
    return [{
            check,
            file: pkgDir,
            line: 0,
            ruleOrCode: String(result.exitCode),
            message: output.slice(0, 500) || `${check} failed with exit code ${result.exitCode}`,
            severity: 'error',
            occurrence_index: 0,
        }];
}
const CHECK_KEY_MAP = {
    typecheck: 'typecheck',
    lint: 'lint',
    tests: 'test',
};
export async function runGate(opts) {
    const start = Date.now();
    const empty = {
        status: 'green',
        failures: [],
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 0,
        total_raw_failure_count: 0,
        new_failures_vs_baseline: 0,
    };
    const projectType = detectProjectType(opts.workingDir);
    if (!projectType)
        return { ...empty, elapsed_ms: Date.now() - start };
    const commands = loadGateCommands();
    const cmdMap = commands[projectType];
    if (!cmdMap)
        return { ...empty, elapsed_ms: Date.now() - start };
    const workspacePackages = getWorkspacePackages(opts.workingDir);
    const allowedPathsUsed = Boolean(opts.allowedPaths && opts.allowedPaths.length > 0);
    let targetDirs;
    if (workspacePackages.length > 0) {
        let candidates = workspacePackages;
        if (opts.scope === 'changed' && opts.since) {
            const changedFiles = getChangedSince(opts.workingDir, opts.since);
            candidates = workspacePackages.filter(pkgDir => changedFiles.some(f => {
                const absFile = path.resolve(opts.workingDir, f);
                return absFile.startsWith(pkgDir + path.sep) || absFile === pkgDir;
            }));
        }
        if (allowedPathsUsed) {
            const relCandidates = candidates.map(p => path.relative(opts.workingDir, p));
            const filtered = filterByScope(relCandidates, { scope: opts.scope, allowedPaths: opts.allowedPaths });
            candidates = filtered.map(rel => path.resolve(opts.workingDir, rel));
        }
        targetDirs = candidates;
    }
    else {
        // Single-package: run checks in workingDir
        if (opts.scope === 'changed' && opts.since) {
            const changedFiles = getChangedSince(opts.workingDir, opts.since);
            if (changedFiles.length === 0)
                return { ...empty, elapsed_ms: Date.now() - start };
        }
        targetDirs = [opts.workingDir];
    }
    const allFailures = [];
    for (const dir of targetDirs) {
        for (const check of opts.checks) {
            const cmdKey = CHECK_KEY_MAP[check];
            const cmd = cmdMap[cmdKey];
            if (!cmd)
                continue;
            const result = await runCheckCommand(cmd, dir);
            const failures = buildFailures(result, check, dir);
            allFailures.push(...failures);
        }
    }
    const status = allFailures.length === 0 ? 'green' : 'red';
    return {
        status,
        failures: allFailures,
        baseline_used: false,
        allowed_paths_used: allowedPathsUsed,
        elapsed_ms: Date.now() - start,
        total_raw_failure_count: allFailures.length,
        new_failures_vs_baseline: 0,
    };
}
