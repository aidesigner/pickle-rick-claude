import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { approve, loadActiveState, resolveStateFile } from '../resolve-state.js';
import { logActivity } from '../../services/activity-logger.js';
import { getDataRoot, safeErrorMessage } from '../../services/pickle-utils.js';
const TSC_TRIGGER_RE = /\.(?:[cm]?ts|tsx)$/i;
const TSC_CONFIG_RE = /^tsconfig(?:\..+)?\.json$/i;
const PACKAGE_JSON_RE = /^package.*\.json$/i;
const NEGATIVE_GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'rev-parse']);
const CD_PREFIX_RE = /^cd\s+(?:"[^"]*"|'[^']*'|[^;&]+?)\s*(?:&&|;)\s*/;
const COMMAND_TIMEOUT_MS = 5_000;
const ALLOW_TSC_FAILED_REASON_FIELD = 'allow_tsc_failed_reason';
function block(reason) {
    console.log(JSON.stringify({ decision: 'block', reason }));
}
function readHookInputData() {
    try {
        return fs.readFileSync(0, 'utf8');
    }
    catch {
        return null;
    }
}
function parseHookInput(inputData) {
    if (!inputData.trim())
        return null;
    try {
        return JSON.parse(inputData);
    }
    catch {
        return null;
    }
}
function loadResolvedState() {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile)
        return null;
    return loadActiveState(stateFile);
}
function trimmedFlag(flags, key) {
    if (!flags)
        return null;
    const raw = flags[key];
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function stripMatchingQuotes(token) {
    if (token.length >= 2) {
        const first = token[0];
        const last = token[token.length - 1];
        if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
            return token.slice(1, -1);
        }
    }
    return token;
}
function tokenizeCommand(command) {
    const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    return tokens.map((token) => stripMatchingQuotes(token));
}
function stripCdPrefix(command) {
    let stripped = command.trim();
    while (CD_PREFIX_RE.test(stripped)) {
        stripped = stripped.replace(CD_PREFIX_RE, '').trimStart();
    }
    return stripped;
}
export function isGitCommitCommand(command) {
    const stripped = stripCdPrefix(command);
    const tokens = tokenizeCommand(stripped);
    if (tokens.length === 0)
        return false;
    if (tokens[0] === 'gh')
        return false;
    if (tokens[0] !== 'git')
        return false;
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (NEGATIVE_GIT_SUBCOMMANDS.has(token))
            return false;
        if (token === '-c' || token === '-C' || token === '--git-dir' || token === '--work-tree') {
            index += 2;
            continue;
        }
        if (token.startsWith('-c') ||
            token.startsWith('--git-dir=') ||
            token.startsWith('--work-tree=')) {
            index += 1;
            continue;
        }
        return token === 'commit';
    }
    return false;
}
function runTextCommand(cmd, args, cwd, timeoutMs) {
    const result = spawnSync(cmd, args, {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        error: result.error,
        timedOut: hasTimedOut(result),
    };
}
function hasTimedOut(result) {
    if (!result.error)
        return false;
    const errno = result.error;
    return errno.code === 'ETIMEDOUT';
}
function parseLineList(output) {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
function listStagedPaths(repoRoot) {
    const result = runTextCommand('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], repoRoot, COMMAND_TIMEOUT_MS);
    return { ...result, paths: parseLineList(result.stdout) };
}
function listAddedPaths(repoRoot) {
    const result = runTextCommand('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], repoRoot, COMMAND_TIMEOUT_MS);
    return { ...result, paths: parseLineList(result.stdout) };
}
function shouldRunTsc(paths) {
    return paths.some((filePath) => {
        const base = path.basename(filePath);
        return TSC_TRIGGER_RE.test(filePath) || TSC_CONFIG_RE.test(base) || PACKAGE_JSON_RE.test(base);
    });
}
function materializeStagedTree(repoRoot, destinationRoot, addedPaths) {
    const checkoutPrefix = destinationRoot.endsWith(path.sep) ? destinationRoot : `${destinationRoot}${path.sep}`;
    // Stage isolation uses `git checkout-index --prefix` against the staged tree.
    const checkoutResult = runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '--stage=0', '-a'], repoRoot, COMMAND_TIMEOUT_MS);
    if (checkoutResult.status !== 0 || checkoutResult.timedOut || checkoutResult.error) {
        return checkoutResult;
    }
    for (const relativePath of addedPaths) {
        const showResult = spawnSync('git', ['show', `:${relativePath}`], {
            cwd: repoRoot,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        });
        if (hasTimedOut(showResult)) {
            return { status: showResult.status, stdout: '', stderr: String(showResult.stderr ?? ''), error: showResult.error, timedOut: true };
        }
        if (showResult.error || showResult.status !== 0) {
            return {
                status: showResult.status,
                stdout: '',
                stderr: String(showResult.stderr ?? ''),
                error: showResult.error,
                timedOut: false,
            };
        }
        const outputPath = path.join(destinationRoot, relativePath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, showResult.stdout);
    }
    return null;
}
function getTscTimeoutMs() {
    const dispatchTimeout = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
    return Math.min(8_000, Math.max(1_000, dispatchTimeout - 1_000));
}
function classifyTscFailure(result) {
    if (result.timedOut) {
        return (result.stdout + result.stderr).trim().length === 0 ? 'cold_cache_timeout' : 'timeout';
    }
    return 'compile_error';
}
function formatBlockReason(kind, details) {
    const suffix = details.trim().length > 0 ? `: ${details.trim()}` : '.';
    return `R-WACT: tsc --noEmit failed with ${kind}${suffix}`;
}
function runTscGate(repoRoot, stagedPaths) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rick-tsc-gate-'));
    try {
        const added = listAddedPaths(repoRoot);
        if (added.status !== 0 || added.timedOut || added.error) {
            return {
                decision: 'block',
                reason: formatBlockReason('setup_error', safeErrorMessage(added.error) || added.stderr || 'failed to enumerate added staged files'),
            };
        }
        const materializeResult = materializeStagedTree(repoRoot, tempDir, added.paths);
        if (materializeResult) {
            return {
                decision: 'block',
                reason: formatBlockReason('setup_error', safeErrorMessage(materializeResult.error) || materializeResult.stderr || 'failed to materialize staged tree'),
            };
        }
        const tscResult = runTextCommand('npx', ['tsc', '--noEmit'], tempDir, getTscTimeoutMs());
        if (tscResult.status === 0 && !tscResult.error) {
            return { decision: 'approve' };
        }
        const failureKind = classifyTscFailure(tscResult);
        const detailSource = tscResult.stderr || tscResult.stdout || `staged changes: ${stagedPaths.join(', ')}`;
        return { decision: 'block', reason: formatBlockReason(failureKind, detailSource.split('\n')[0] || failureKind) };
    }
    finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
function evaluateCommitCommand(command, state) {
    // TODO(R-WACT-1b): 1b removes the cast after StateFlags adds allow_tsc_failed_reason.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allowReason = trimmedFlag(state?.flags, ALLOW_TSC_FAILED_REASON_FIELD);
    if (allowReason) {
        return { decision: 'approve' };
    }
    const repoRootResult = runTextCommand('git', ['rev-parse', '--show-toplevel'], process.cwd(), COMMAND_TIMEOUT_MS);
    if (repoRootResult.status !== 0 || repoRootResult.timedOut || repoRootResult.error) {
        return {
            decision: 'block',
            reason: formatBlockReason('setup_error', safeErrorMessage(repoRootResult.error) || repoRootResult.stderr || 'failed to resolve repository root'),
        };
    }
    const repoRoot = repoRootResult.stdout.trim();
    const staged = listStagedPaths(repoRoot);
    if (staged.status !== 0 || staged.timedOut || staged.error) {
        return {
            decision: 'block',
            reason: formatBlockReason('setup_error', safeErrorMessage(staged.error) || staged.stderr || 'failed to enumerate staged files'),
        };
    }
    if (!shouldRunTsc(staged.paths)) {
        return { decision: 'approve' };
    }
    return runTscGate(repoRoot, staged.paths);
}
function emitCrashEvent(error, command) {
    try {
        logActivity({
            event: 'tsc_gate_crashed',
            source: 'hook',
            gate_payload: {
                error: safeErrorMessage(error),
                command,
                failure_kind: 'crashed',
            },
        });
    }
    catch {
        /* activity logging is best effort */
    }
}
function main() {
    const inputData = readHookInputData();
    const input = inputData ? parseHookInput(inputData) : null;
    if (!input) {
        approve();
        return;
    }
    if (input.tool_name !== 'Bash') {
        approve();
        return;
    }
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || !isGitCommitCommand(command)) {
        approve();
        return;
    }
    const state = loadResolvedState();
    const decision = evaluateCommitCommand(command, state);
    if (decision.decision === 'approve') {
        approve();
        return;
    }
    block(decision.reason || formatBlockReason('compile_error', 'unknown tsc failure'));
}
try {
    main();
}
catch (error) {
    const inputData = readHookInputData();
    const input = inputData ? parseHookInput(inputData) : null;
    emitCrashEvent(error, input?.tool_input?.command ?? '');
    approve();
}
