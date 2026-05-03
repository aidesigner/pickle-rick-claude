import * as fs from 'fs';
import * as path from 'path';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    [key: string]: unknown;
  };
}

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

function isProtectedFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return PROTECTED_PATTERNS.some(p => p.test(base));
}

function isBashTargetingConfig(command: string): boolean {
  // Extract space/quote-separated tokens and test each as a potential filename
  const tokens = command.split(/[\s'"]+/).filter(t => t.length > 0);
  return tokens.some(token => isProtectedFile(token));
}

const ALLOW_CONFIG_EDIT_FLAG = '--allow-config-edit';

function hasAllowConfigEditFlag(args: string[]): boolean {
  return args.includes(ALLOW_CONFIG_EDIT_FLAG);
}

function block(reason: string): void {
  console.log(JSON.stringify({ decision: 'block', reason }));
}

function readHookInputData(): string | null {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function parseHookInput(inputData: string): PreToolUseInput | null {
  if (!inputData.trim()) {
    return null;
  }

  try {
    return JSON.parse(inputData) as PreToolUseInput;
  } catch {
    return null;
  }
}

function isConfigProtectionEnabled(extensionDir: string): boolean {
  try {
    const flagSettings = readRecoverableJsonObject(path.join(extensionDir, 'pickle_settings.json')) as Record<string, unknown> | null;
    return flagSettings?.enable_config_protection !== false;
  } catch { /* default true — continue with protection enabled */ }
  return true;
}

function hasActiveAutomationSession(): boolean {
  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile) {
    return false;
  }

  return loadActiveState(stateFile) !== null;
}

function detectTargetedConfigFile(input: PreToolUseInput): string | null {
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

function main(): void {
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
} catch (err) {
  try {
    const msg = err instanceof Error ? err.message : String(err);
    const extensionDir = getExtensionRoot();
    fs.appendFileSync(
      path.join(extensionDir, 'debug.log'),
      `[config-protection] FATAL: ${msg}\n`
    );
  } catch {
    /* ignore */
  }
  approve();
}
