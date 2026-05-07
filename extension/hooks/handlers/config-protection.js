import * as fs from 'fs';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
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
function hasActiveAutomationSession() {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile) {
        return false;
    }
    return loadActiveState(stateFile) !== null;
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
function main() {
    const inputData = readHookInputData();
    const input = inputData ? parseHookInput(inputData) : null;
    if (!input) {
        approve();
        return;
    }
    if (!isConfigProtectionEnabled(getExtensionRoot()) || !hasActiveAutomationSession()) {
        approve();
        return;
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
