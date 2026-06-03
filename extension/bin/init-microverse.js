import * as path from 'path';
import { createMicroverseState, readRecoverableJsonObject, resolveStallLimit, writeMicroverseState } from '../services/microverse-state.js';
import { getExtensionRoot, safeErrorMessage } from '../services/pickle-utils.js';
const DEFAULT_METRIC = {
    description: 'Number of coding principle violations (lower is better)',
    validation: 'Review the code at the target path for violations of established coding principles (KISS, YAGNI, DRY, SOLID, Small Functions, Guard Clauses, Cognitive Load, Self-Documenting Code, Encapsulation, Fail-Fast, etc). Count only REAL, actionable violations — not style nitpicks. A violation must be fixable and must clearly hurt readability, maintainability, or correctness. Score = number of violations found.',
    type: 'llm',
    timeout_seconds: 300,
    tolerance: 0,
    direction: 'lower',
};
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    const value = args[idx + 1];
    if (!value || value.startsWith('--')) {
        console.error(`${flag} requires a value`);
        process.exit(1);
    }
    return value;
}
function parseConvergenceMode(raw) {
    if (raw == null)
        return undefined;
    if (raw === 'metric' || raw === 'worker')
        return raw;
    console.error(`convergence_mode must be 'metric' or 'worker', got ${raw}`);
    process.exit(1);
}
// Read + validate the --allowed-paths-file scope JSON. Fail-fast: silently
// dropping scope filtering would defeat the purpose of the flag. Uses
// readRecoverableJsonObject so a newer dead-writer scope.json.tmp.<pid> is
// promoted before reading (init-microverse allowed-path trap door).
function readAllowedPathsFile(allowedPathsFile) {
    const fail = (detail) => {
        console.error(`--allowed-paths-file ${allowedPathsFile}: ${detail}`);
        process.exit(1);
    };
    let raw;
    try {
        raw = readRecoverableJsonObject(allowedPathsFile);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to read --allowed-paths-file ${allowedPathsFile}: ${msg}`);
        process.exit(1);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        fail("expected a JSON object with an 'allowed_paths' array");
    }
    const field = raw.allowed_paths;
    if (!Array.isArray(field)) {
        fail("'allowed_paths' is missing or not an array");
    }
    if (!field.every((p) => typeof p === 'string')) {
        fail("'allowed_paths' must contain only strings");
    }
    return field;
}
// Positional args are non-flag tokens that are not the value of a preceding flag.
// Every flag here takes a value (see parseFlag), so the token after a `--flag` is its value.
function extractPositionalArgs(args) {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--'))
            continue;
        if (i > 0 && args[i - 1]?.startsWith('--'))
            continue;
        positional.push(arg);
    }
    return positional;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'init-microverse.js') {
    const args = process.argv.slice(2);
    const positional = extractPositionalArgs(args);
    const sessionDir = positional[0];
    const targetPath = positional[1];
    if (!sessionDir || !targetPath) {
        console.error('Usage: init-microverse <session-dir> <target-path> [--stall-limit N] [--convergence-target N] [--convergence-mode metric|worker] [--convergence-file <filename>] [--metric-json \'...\'] [--allowed-paths-file <path>]');
        process.exit(1);
    }
    const explicitStallLimitRaw = parseFlag(args, '--stall-limit');
    const rawConvergence = parseFlag(args, '--convergence-target');
    const rawMetricJson = parseFlag(args, '--metric-json');
    const judgeContextPath = parseFlag(args, '--judge-context');
    const rawConvergenceMode = parseFlag(args, '--convergence-mode');
    const convergenceFile = parseFlag(args, '--convergence-file');
    const allowedPathsFile = parseFlag(args, '--allowed-paths-file');
    if (convergenceFile && (/[/\\]/.test(convergenceFile) || convergenceFile.includes('..'))) {
        console.error('convergence_file must be a bare filename');
        process.exit(1);
    }
    if (rawConvergenceMode === 'worker' && !convergenceFile) {
        console.error('worker mode requires --convergence-file');
        process.exit(1);
    }
    const convergenceMode = parseConvergenceMode(rawConvergenceMode);
    let metric;
    if (rawMetricJson) {
        try {
            metric = JSON.parse(rawMetricJson);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Invalid --metric-json: ${msg}`);
            process.exit(1);
        }
    }
    else {
        metric = DEFAULT_METRIC;
    }
    if (metric.type === 'none' && convergenceMode !== 'worker') {
        console.error('type: none requires convergence_mode: worker');
        process.exit(1);
    }
    let stallLimit;
    if (explicitStallLimitRaw !== undefined) {
        stallLimit = Number(explicitStallLimitRaw);
    }
    else {
        let settingsRaw = null;
        try {
            settingsRaw = readRecoverableJsonObject(path.join(getExtensionRoot(), 'pickle_settings.json'));
        }
        catch {
            // defensive: if settings can't be read, resolveStallLimit handles null
        }
        stallLimit = resolveStallLimit(metric.type, settingsRaw);
    }
    const allowedPaths = allowedPathsFile
        ? readAllowedPathsFile(allowedPathsFile)
        : undefined;
    try {
        const convergenceTarget = rawConvergence != null ? Number(rawConvergence) : undefined;
        const state = createMicroverseState({ prdPath: targetPath, metric, stallLimit, convergenceTarget, convergenceMode, convergenceFile, allowedPaths });
        state.gap_analysis_path = path.join(sessionDir, 'gap_analysis.md');
        if (judgeContextPath)
            state.judge_context_path = judgeContextPath;
        writeMicroverseState(sessionDir, state);
        console.log('microverse.json created');
    }
    catch (err) {
        console.error(`Failed to init microverse: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
}
