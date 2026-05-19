import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { logActivity } from '../../services/activity-logger.js';
const PROTECTED_PATTERNS = [
    /^\.eslintrc(\..*)?$/,
    /^eslint\.config\..+$/,
    /^\.prettierrc(\..*)?$/,
    /^biome\.json$/,
    /^tsconfig(\..*)?\.json$/,
    /^pyproject\.toml$/,
    /^\.ruff\.toml$/,
    /^jest\.config\./,
    /^vitest\.config\./,
];
const SHELL_PATTERN_CHARS = /[*?[\]{}]/;
const PROTECTED_BASH_CANDIDATES = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.mjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    'eslint.config.js',
    'eslint.config.cjs',
    'eslint.config.mjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.json',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    'biome.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.base.json',
    'tsconfig.build.json',
    'tsconfig.eslint.json',
    'pyproject.toml',
    '.ruff.toml',
    'jest.config.js',
    'jest.config.cjs',
    'jest.config.mjs',
    'jest.config.ts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vitest.config.ts',
];
/**
 * R-WSRC-3: Runtime state files that workers MUST NOT write directly.
 * Each entry is a basename or `.tmp.<pid>` suffixed variant; the matcher
 * applies them at any directory depth (`**` semantics) plus the deployed-runtime
 * tree under `~/.claude/pickle-rick/**`. The literal glob shapes are documented
 * here so subsystem audits and the R-WSRC-3 trap-door grep can locate them.
 */
const PROTECTED_WRITE_GLOBS = [
    '**/state.json',
    '**/state.json.tmp.*',
    '**/circuit_breaker.json',
    '**/circuit_breaker.json.tmp.*',
    '**/pipeline-status.json',
    '**/pipeline-status.json.tmp.*',
    '~/.claude/pickle-rick/**',
    'pickle_settings.json',
    'pickle_settings.json.tmp.*',
];
const PROTECTED_STATE_BASENAMES = [
    'state.json',
    'circuit_breaker.json',
    'pipeline-status.json',
    'pickle_settings.json',
];
// Surfaces PROTECTED_WRITE_GLOBS at the module level for downstream tools that
// import the handler for auditing (e.g. an analyst grepping compiled mirrors).
export { PROTECTED_WRITE_GLOBS };
const SETTINGS_BASENAMES = new Set(['pickle_settings.json']);
const TMP_SUFFIX_RE = /\.tmp(?:\.\d+)?(?:\..*)?$/;
function getProtectedRuntimeRoot() {
    return path.resolve(os.homedir(), '.claude/pickle-rick');
}
function stripTmpSuffix(basename) {
    return basename.replace(TMP_SUFFIX_RE, '');
}
/**
 * Returns the matching protected basename ('state.json' etc.) for the given
 * absolute or relative file path, including `.tmp.<pid>` variants. Returns
 * null when the path does not target a protected runtime state file.
 */
function matchProtectedStateBasename(filePath) {
    if (!filePath)
        return null;
    const base = path.basename(filePath);
    const stripped = stripTmpSuffix(base);
    for (const candidate of PROTECTED_STATE_BASENAMES) {
        if (base === candidate || stripped === candidate)
            return candidate;
    }
    return null;
}
/**
 * Returns true if `filePath` resolves inside the deployed runtime tree
 * (`~/.claude/pickle-rick/**`). Uses path.resolve (no realpath) because the
 * worker may not have the target on disk yet; symlink resolution is not
 * the threat model here.
 */
function isInsideRuntimeRoot(filePath) {
    if (!filePath)
        return false;
    const runtimeRoot = getProtectedRuntimeRoot();
    const resolved = path.resolve(filePath);
    if (resolved === runtimeRoot)
        return true;
    return resolved.startsWith(runtimeRoot + path.sep);
}
/** Tool-input file_path match → returns reason string or null. */
function detectProtectedWriteTarget(filePath) {
    if (!filePath)
        return null;
    const stateMatch = matchProtectedStateBasename(filePath);
    if (stateMatch) {
        return { matched: filePath, isSettings: SETTINGS_BASENAMES.has(stateMatch) };
    }
    if (isInsideRuntimeRoot(filePath)) {
        return { matched: filePath, isSettings: false };
    }
    return null;
}
function isProtectedFile(filePath) {
    const base = path.basename(filePath);
    return PROTECTED_PATTERNS.some(p => p.test(base));
}
function shellPatternToRegex(pattern) {
    let regex = '^';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '*') {
            regex += '.*';
            continue;
        }
        if (char === '?') {
            regex += '.';
            continue;
        }
        if (char === '{') {
            const end = pattern.indexOf('}', i + 1);
            if (end !== -1) {
                const variants = pattern
                    .slice(i + 1, end)
                    .split(',')
                    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                    .join('|');
                regex += `(?:${variants})`;
                i = end;
                continue;
            }
        }
        if (char === '[') {
            const end = pattern.indexOf(']', i + 1);
            if (end !== -1) {
                const rawClass = pattern.slice(i + 1, end);
                const isNegated = rawClass.startsWith('!') || rawClass.startsWith('^');
                const classBody = (isNegated ? rawClass.slice(1) : rawClass)
                    .replace(/\\/g, '\\\\')
                    .replace(/\]/g, '\\]');
                if (classBody.length > 0) {
                    regex += isNegated ? `[^${classBody}]` : `[${classBody}]`;
                    i = end;
                    continue;
                }
            }
        }
        regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    regex += '$';
    return new RegExp(regex);
}
function isProtectedShellPattern(token) {
    const base = path.basename(token);
    if (!SHELL_PATTERN_CHARS.test(base)) {
        return false;
    }
    const candidatePattern = shellPatternToRegex(base);
    return PROTECTED_BASH_CANDIDATES.some((candidate) => candidatePattern.test(candidate));
}
function isBashTargetingConfig(command) {
    // Extract space/quote-separated tokens and test each as a potential filename
    const tokens = command.split(/[\s'"]+/).filter(t => t.length > 0);
    return tokens.some(token => isProtectedFile(token) || isProtectedShellPattern(token));
}
/**
 * Tokenize a bash command, splitting on whitespace and quotes. Preserves
 * shell redirect operators (`>`, `>>`) as their own tokens so the scanner
 * can locate destination paths.
 */
function tokenizeBashCommand(command) {
    const out = [];
    // First, isolate redirect operators so they don't glue to filenames.
    const spaced = command
        .replace(/>>/g, ' >> ')
        .replace(/(^|[^>])>/g, '$1 > ');
    for (const raw of spaced.split(/[\s'"]+/)) {
        if (raw.length > 0)
            out.push(raw);
    }
    return out;
}
/**
 * Detects whether `command` writes to a protected state file via output
 * redirection (`>`, `>>`, `tee`, `cp <src> <dest>`, `mv <src> <dest>`, or
 * `rsync ... <dest>`). Returns the matched path (or `null` if none).
 */
function detectBashStateWriteTarget(command) {
    if (!command)
        return null;
    const tokens = tokenizeBashCommand(command);
    // Pass 1: `>` and `>>` redirects — the immediate next token is the destination.
    for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] === '>' || tokens[i] === '>>') {
            const dest = tokens[i + 1];
            const hit = detectProtectedWriteTarget(dest);
            if (hit)
                return hit;
        }
    }
    // Pass 2: scan tee / cp / mv / rsync. Subsequent tokens after the command
    // are potential destinations; we test every non-flag token for safety.
    const REDIRECT_COMMANDS = new Set(['tee', 'cp', 'mv', 'rsync']);
    for (let i = 0; i < tokens.length; i++) {
        const cmdToken = path.basename(tokens[i]);
        if (!REDIRECT_COMMANDS.has(cmdToken))
            continue;
        for (let j = i + 1; j < tokens.length; j++) {
            const arg = tokens[j];
            if (arg.startsWith('-'))
                continue;
            const hit = detectProtectedWriteTarget(arg);
            if (hit)
                return hit;
        }
    }
    return null;
}
const ALLOW_CONFIG_EDIT_FLAG = '--allow-config-edit';
function hasAllowConfigEditFlag(args) {
    return args.includes(ALLOW_CONFIG_EDIT_FLAG);
}
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
    if (!inputData.trim()) {
        return null;
    }
    try {
        return JSON.parse(inputData);
    }
    catch {
        return null;
    }
}
function isConfigProtectionEnabled(extensionDir) {
    try {
        const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json'));
        return flagSettings?.enable_config_protection !== false;
    }
    catch { /* default true — continue with protection enabled */ }
    return true;
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
    const v = flags[key];
    if (typeof v !== 'string')
        return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function emitStateWriteOverride(blockedPath, overrideReason, toolName) {
    try {
        logActivity({
            event: 'state_write_override_used',
            source: 'hook',
            gate_payload: {
                blocked_path: blockedPath,
                override_reason: overrideReason,
                tool_name: toolName,
                callsite_pid: process.pid,
            },
        });
    }
    catch {
        /* activity-logger is already best-effort; never break the hook */
    }
}
function detectTargetedConfigFile(input) {
    const toolName = input.tool_name || '';
    const filePath = input.tool_input?.file_path || '';
    const command = input.tool_input?.command || '';
    if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
        return isProtectedFile(filePath) ? path.basename(filePath) : null;
    }
    if (toolName === 'Bash' && command && isBashTargetingConfig(command)) {
        return '<config file>';
    }
    return null;
}
/**
 * Detect protected-state-file targets in the tool input. Returns the matched
 * path and whether it is a `pickle_settings.json` write (which uses the
 * `allow_settings_writes_reason` override exclusively).
 */
function detectTargetedStateFile(input) {
    const toolName = input.tool_name || '';
    const filePath = input.tool_input?.file_path || '';
    const command = input.tool_input?.command || '';
    if ((toolName === 'Write' || toolName === 'Edit') && filePath) {
        return detectProtectedWriteTarget(filePath);
    }
    if (toolName === 'Bash' && command) {
        return detectBashStateWriteTarget(command);
    }
    return null;
}
/**
 * R-PIPE-3 / R-WSRC: Explicit detection for `bash install.sh` (and variants)
 * from worker contexts. This is a hard forbidden (manager-only) per the
 * project CLAUDE.md worker rules. The hook must return "block" for workers.
 */
function isBashInvokingInstallSh(command) {
    if (!command)
        return false;
    const c = command.trim().toLowerCase();
    // Covers: bash install.sh, ./install.sh, /full/path/install.sh, bash ./install.sh --foo, etc.
    return c.includes('install.sh') || c.startsWith('bash install') || c.startsWith('./install.sh') || c.startsWith('sh install');
}
/**
 * R-PIPE-3 extracted helper — keeps main() complexity <= 15.
 * Returns true if we handled (blocked or approved via override); caller should return.
 */
function isBashInstallBlockedByRWSRC(input, state) {
    if (input.tool_name !== 'Bash' || !input.tool_input?.command)
        return false;
    if (!isBashInvokingInstallSh(input.tool_input.command))
        return false;
    const flags = state.flags || {};
    const override = trimmedFlag(flags, ALLOW_INSTALL_SH_REASON_FIELD);
    if (override) {
        logActivity({
            event: 'install_sh_override_used',
            source: 'hook',
            gate_payload: { override_reason: override, command: input.tool_input.command },
        });
        approve();
        return true;
    }
    block('R-WSRC: `bash install.sh` (and variants) is FORBIDDEN from worker subprocesses. This is manager-only. See CLAUDE.md "## ⛔ Worker Forbidden Ops". Set state.flags.allow_install_sh_reason only for explicit manager-owned closer steps.');
    return true;
}
const ALLOW_STATE_WRITE_REASON_FIELD = 'allow_state_writes_reason';
const ALLOW_SETTINGS_WRITE_REASON_FIELD = 'allow_settings_writes_reason';
const ALLOW_INSTALL_SH_REASON_FIELD = 'allow_install_sh_reason'; // rare manager override only (R-WSRC)
function evaluateStateWriteGate(input, state) {
    const hit = detectTargetedStateFile(input);
    if (!hit)
        return null;
    const flags = state.flags;
    const toolName = input.tool_name || '';
    if (hit.isSettings) {
        const settingsReason = trimmedFlag(flags, ALLOW_SETTINGS_WRITE_REASON_FIELD);
        if (settingsReason) {
            emitStateWriteOverride(hit.matched, settingsReason, toolName);
            return { decision: 'approve' };
        }
        // Settings-only files also accept the broader state-writes flag.
        const stateReason = trimmedFlag(flags, ALLOW_STATE_WRITE_REASON_FIELD);
        if (stateReason) {
            emitStateWriteOverride(hit.matched, stateReason, toolName);
            return { decision: 'approve' };
        }
        return {
            decision: 'block',
            reason: `Runtime settings file protected: ${hit.matched}. Set state.flags.${ALLOW_SETTINGS_WRITE_REASON_FIELD} or state.flags.${ALLOW_STATE_WRITE_REASON_FIELD} to a non-empty reason to override.`,
        };
    }
    const stateReason = trimmedFlag(flags, ALLOW_STATE_WRITE_REASON_FIELD);
    if (stateReason) {
        emitStateWriteOverride(hit.matched, stateReason, toolName);
        return { decision: 'approve' };
    }
    return {
        decision: 'block',
        reason: `Runtime state file protected: ${hit.matched}. Set state.flags.${ALLOW_STATE_WRITE_REASON_FIELD} to a non-empty reason to override.`,
    };
}
function main() {
    const inputData = readHookInputData();
    const input = inputData ? parseHookInput(inputData) : null;
    if (!input) {
        approve();
        return;
    }
    if (!isConfigProtectionEnabled(getExtensionRoot())) {
        approve();
        return;
    }
    const state = loadResolvedState();
    if (!state) {
        approve();
        return;
    }
    // R-WSRC-3: state-file write gate runs BEFORE the legacy config-file gate so
    // an `--allow-config-edit` flag cannot accidentally smuggle a state-file
    // write through; state writes require their own explicit override flags.
    const stateDecision = evaluateStateWriteGate(input, state);
    if (stateDecision) {
        if (stateDecision.decision === 'approve') {
            approve();
            return;
        }
        block(stateDecision.reason || 'Runtime state file protected.');
        return;
    }
    // R-PIPE-3 + R-WSRC: Hard block on `bash install.sh` (any variant) from worker context.
    // Extracted to keep main() cyclomatic complexity <= 15.
    if (isBashInstallBlockedByRWSRC(input, state)) {
        return; // block() or approve() already called inside
    }
    const targetedConfigFile = detectTargetedConfigFile(input);
    if (!targetedConfigFile || hasAllowConfigEditFlag(process.argv.slice(2))) {
        approve();
        return;
    }
    block(`Config file protected: ${targetedConfigFile}. Pass ${ALLOW_CONFIG_EDIT_FLAG} to override.`);
}
try {
    main();
}
catch (err) {
    try {
        const msg = err instanceof Error ? err.message : String(err);
        const extensionDir = getExtensionRoot();
        fs.appendFileSync(path.join(extensionDir, 'debug.log'), `[config-protection] FATAL: ${msg}\n`);
    }
    catch {
        /* ignore */
    }
    approve();
}
