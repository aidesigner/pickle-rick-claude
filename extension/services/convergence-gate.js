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
export class BaselineMissingError extends GateError {
    constructor(baselinePath) {
        super('BASELINE_MISSING', `No baseline at ${baselinePath}`);
        this.name = 'BaselineMissingError';
    }
}
export class BaselineStaleError extends GateError {
    constructor(message) {
        super('BASELINE_STALE', message);
        this.name = 'BaselineStaleError';
    }
}
function buildFingerprint(f) {
    return `${f.file}::${f.ruleOrCode}::${f.occurrence_index}`;
}
export function assignOccurrenceIndices(failures) {
    const groups = new Map();
    for (const f of failures) {
        const key = `${f.file}::${f.ruleOrCode}`;
        const group = groups.get(key) ?? [];
        group.push(f);
        groups.set(key, group);
    }
    const result = [];
    for (const group of groups.values()) {
        group.sort((a, b) => a.line - b.line);
        for (let i = 0; i < group.length; i++) {
            result.push({ ...group[i], occurrence_index: i });
        }
    }
    return result;
}
function validateBaselineStructure(data) {
    if (!data || typeof data !== 'object')
        return false;
    const d = data;
    return (d['schema_version'] === 1 &&
        typeof d['captured_at'] === 'string' &&
        typeof d['working_dir'] === 'string' &&
        typeof d['project_type'] === 'string' &&
        ['pnpm', 'npm', 'yarn', 'cargo', 'go'].includes(d['project_type']) &&
        Array.isArray(d['checks']) &&
        Array.isArray(d['failures']));
}
export function loadBaselineFile(baselinePath) {
    const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    if (!validateBaselineStructure(raw)) {
        throw new GateError('BASELINE_CORRUPT', `Invalid baseline file at ${baselinePath}`);
    }
    return raw;
}
export function subtractBaseline(current, baseline) {
    const baselineSet = new Set(baseline.failures.map(buildFingerprint));
    return current.filter(f => !baselineSet.has(buildFingerprint(f)));
}
export function assertBaselineFresh(baselinePath, opts) {
    if (!fs.existsSync(baselinePath)) {
        const dir = path.dirname(baselinePath);
        fs.mkdirSync(dir, { recursive: true });
        const now = new Date().toISOString();
        const iso = now.replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(dir, `baseline_missing_${iso}.md`), `# Baseline Missing\n\nPath: \`${baselinePath}\`\nCaptured: ${now}\n`);
        throw new BaselineMissingError(baselinePath);
    }
    const stat = fs.statSync(baselinePath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > opts.max_age_seconds * 1000) {
        throw new BaselineStaleError(`Baseline at ${baselinePath} is ${Math.round(ageMs / 1000)}s old (max ${opts.max_age_seconds}s)`);
    }
    if (opts.current_iteration >= opts.max_age_iterations) {
        throw new BaselineStaleError(`current_iteration (${opts.current_iteration}) >= max_age_iterations (${opts.max_age_iterations})`);
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
    if (opts.mode === 'baseline' && opts.baselinePath) {
        const withIndices = assignOccurrenceIndices(allFailures);
        if (!fs.existsSync(opts.baselinePath)) {
            const baseline = {
                schema_version: 1,
                captured_at: new Date().toISOString(),
                working_dir: opts.workingDir,
                project_type: projectType,
                checks: opts.checks,
                failures: withIndices,
            };
            fs.mkdirSync(path.dirname(opts.baselinePath), { recursive: true });
            fs.writeFileSync(opts.baselinePath, JSON.stringify(baseline, null, 2));
            return {
                status: 'green',
                failures: [],
                baseline_used: false,
                allowed_paths_used: allowedPathsUsed,
                elapsed_ms: Date.now() - start,
                total_raw_failure_count: withIndices.length,
                new_failures_vs_baseline: 0,
            };
        }
        const baseline = loadBaselineFile(opts.baselinePath);
        const newFailures = subtractBaseline(withIndices, baseline);
        return {
            status: newFailures.length === 0 ? 'green' : 'red',
            failures: newFailures,
            baseline_used: true,
            allowed_paths_used: allowedPathsUsed,
            elapsed_ms: Date.now() - start,
            total_raw_failure_count: withIndices.length,
            new_failures_vs_baseline: newFailures.length,
        };
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
