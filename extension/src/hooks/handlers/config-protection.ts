import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { State, ActivityEventType } from '../../types/index.js';
import { resolveStateFile, loadActiveState, approve } from '../resolve-state.js';
import { getExtensionRoot, getDataRoot } from '../../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../../services/microverse-state.js';
import { logActivity } from '../../services/activity-logger.js';

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
] as const;

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
] as const;

const PROTECTED_STATE_BASENAMES = [
  'state.json',
  'circuit_breaker.json',
  'pipeline-status.json',
  'pickle_settings.json',
] as const;

// Surfaces PROTECTED_WRITE_GLOBS at the module level for downstream tools that
// import the handler for auditing (e.g. an analyst grepping compiled mirrors).
export { PROTECTED_WRITE_GLOBS };

const SETTINGS_BASENAMES = new Set(['pickle_settings.json']);

const TMP_SUFFIX_RE = /\.tmp(?:\.\d+)?(?:\..*)?$/;

function getProtectedRuntimeRoot(): string {
  return path.resolve(os.homedir(), '.claude/pickle-rick');
}

function stripTmpSuffix(basename: string): string {
  return basename.replace(TMP_SUFFIX_RE, '');
}

/**
 * Returns the matching protected basename ('state.json' etc.) for the given
 * absolute or relative file path, including `.tmp.<pid>` variants. Returns
 * null when the path does not target a protected runtime state file.
 */
function matchProtectedStateBasename(filePath: string): string | null {
  if (!filePath) return null;
  const base = path.basename(filePath);
  const stripped = stripTmpSuffix(base);
  for (const candidate of PROTECTED_STATE_BASENAMES) {
    if (base === candidate || stripped === candidate) return candidate;
  }
  return null;
}

/**
 * Returns true if `filePath` resolves inside the deployed runtime tree
 * (`~/.claude/pickle-rick/**`). Uses path.resolve (no realpath) because the
 * worker may not have the target on disk yet; symlink resolution is not
 * the threat model here.
 */
function isInsideRuntimeRoot(filePath: string): boolean {
  if (!filePath) return false;
  const runtimeRoot = getProtectedRuntimeRoot();
  const resolved = path.resolve(filePath);
  if (resolved === runtimeRoot) return true;
  return resolved.startsWith(runtimeRoot + path.sep);
}

/** Tool-input file_path match → returns reason string or null. */
function detectProtectedWriteTarget(filePath: string): { matched: string; isSettings: boolean } | null {
  if (!filePath) return null;
  const stateMatch = matchProtectedStateBasename(filePath);
  if (stateMatch) {
    return { matched: filePath, isSettings: SETTINGS_BASENAMES.has(stateMatch) };
  }
  if (isInsideRuntimeRoot(filePath)) {
    return { matched: filePath, isSettings: false };
  }
  return null;
}

function isProtectedFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return PROTECTED_PATTERNS.some(p => p.test(base));
}

function shellPatternToRegex(pattern: string): RegExp {
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

function isProtectedShellPattern(token: string): boolean {
  const base = path.basename(token);
  if (!SHELL_PATTERN_CHARS.test(base)) {
    return false;
  }
  const candidatePattern = shellPatternToRegex(base);
  return PROTECTED_BASH_CANDIDATES.some((candidate) => candidatePattern.test(candidate));
}

function isBashTargetingConfig(command: string): boolean {
  // Extract space/quote-separated tokens and test each as a potential filename
  const tokens = command.split(/[\s'"]+/).filter(t => t.length > 0);
  return tokens.some(token => isProtectedFile(token) || isProtectedShellPattern(token));
}

/**
 * Tokenize a bash command, splitting on whitespace and quotes. Preserves
 * shell redirect operators (`>`, `>>`) as their own tokens so the scanner
 * can locate destination paths.
 */
function tokenizeBashCommand(command: string): string[] {
  const out: string[] = [];
  // First, isolate redirect operators so they don't glue to filenames.
  const spaced = command
    .replace(/>>/g, ' >> ')
    .replace(/(^|[^>])>/g, '$1 > ');
  for (const raw of spaced.split(/[\s'"]+/)) {
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

/**
 * Detects whether `command` writes to a protected state file via output
 * redirection (`>`, `>>`, `tee`, `cp <src> <dest>`, `mv <src> <dest>`, or
 * `rsync ... <dest>`). Returns the matched path (or `null` if none).
 */
function detectBashStateWriteTarget(command: string): { matched: string; isSettings: boolean } | null {
  if (!command) return null;
  const tokens = tokenizeBashCommand(command);

  // Pass 1: `>` and `>>` redirects — the immediate next token is the destination.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === '>' || tokens[i] === '>>') {
      const dest = tokens[i + 1];
      const hit = detectProtectedWriteTarget(dest);
      if (hit) return hit;
    }
  }

  // Pass 2: scan tee / cp / mv / rsync. Subsequent tokens after the command
  // are potential destinations; we test every non-flag token for safety.
  const REDIRECT_COMMANDS = new Set(['tee', 'cp', 'mv', 'rsync']);
  for (let i = 0; i < tokens.length; i++) {
    const cmdToken = path.basename(tokens[i]);
    if (!REDIRECT_COMMANDS.has(cmdToken)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = tokens[j];
      if (arg.startsWith('-')) continue;
      const hit = detectProtectedWriteTarget(arg);
      if (hit) return hit;
    }
  }

  return null;
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

function loadResolvedState(): State | null {
  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile) return null;
  return loadActiveState(stateFile);
}

function trimmedFlag(flags: Record<string, unknown> | undefined, key: string): string | null {
  if (!flags) return null;
  const v = flags[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emitStateWriteOverride(blockedPath: string, overrideReason: string, toolName: string): void {
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
  } catch {
    /* activity-logger is already best-effort; never break the hook */
  }
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

/**
 * Detect protected-state-file targets in the tool input. Returns the matched
 * path and whether it is a `pickle_settings.json` write (which uses the
 * `allow_settings_writes_reason` override exclusively).
 */
function detectTargetedStateFile(input: PreToolUseInput): { matched: string; isSettings: boolean } | null {
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
 *
 * Only matches when `install.sh` is the EXECUTABLE token (basename of the
 * binary being invoked), not when it appears as an argument to a read-only
 * tool (`cat install.sh`, `vim install.sh`, `git log install.sh`) and not
 * when it is a suffix of a different filename (`pre-install.sh`,
 * `my-install.sh`).
 */
function isBashInvokingInstallSh(command: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Tokenize on whitespace; locate the executable token (first non-empty token,
  // skipping a leading `bash` or `sh` wrapper).
  const tokens = trimmed.split(/\s+/);
  let execIdx = 0;
  if (tokens[execIdx] === 'bash' || tokens[execIdx] === 'sh') execIdx = 1;
  const exec = tokens[execIdx];
  if (!exec) return false;
  const cleanExec = exec.replace(/;+$/, '');
  const base = cleanExec.includes('/')
    ? cleanExec.substring(cleanExec.lastIndexOf('/') + 1)
    : cleanExec;
  return base === 'install.sh';
}

/**
 * Extracts the EXECUTABLE token from a shell command, handling common shell
 * prefixes: `bash`/`sh` wrappers, and KEY=value env-var assignments.
 * Returns the basename of the first actual executable, or null if empty.
 */
function parseFirstShellWord(command: string): string | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  let idx = 0;
  if (tokens[idx] === 'bash' || tokens[idx] === 'sh') idx++;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  const exec = tokens[idx];
  if (!exec) return null;
  const clean = exec.replace(/;+$/, '');
  return clean.includes('/') ? clean.substring(clean.lastIndexOf('/') + 1) : clean;
}

const PROHIBITED_GIT_VERBS_SIMPLE = new Set(['reset', 'switch', 'stash', 'rebase', 'pull', 'push']);

/**
 * Returns true when `git checkout <args>` is targeting a ref (blocked).
 * Allowed: `git checkout -- <path>`, `git checkout .`, `git checkout` with no positional.
 */
function isCheckoutRefOperation(afterVerb: string[]): boolean {
  for (const t of afterVerb) {
    if (t === '--') return false; // path-mode
    if (t.startsWith('-')) continue; // flag
    if (t === '.') return false; // whole-tree restore
    return true; // first non-flag, non-'.', non-'--' token → ref
  }
  return false; // no positional args
}

/**
 * R-WSRC-GR: Detects prohibited git verbs per the Git Boundary Rules.
 * Returns {verb} when the command is a prohibited git operation, null otherwise.
 *
 * Allowed exceptions (return null):
 *   git checkout -- <path>       (path-mode via --)
 *   git checkout .               (whole-tree restore)
 *   git commit (without --amend) (plain commit is allowed)
 *   git fetch (without --prune)  (plain fetch is allowed)
 */
function findGitVerb(command: string): { verb: string; afterVerb: string[] } | null {
  const tokens = command.trim().split(/\s+/);
  let idx = 0;
  if (tokens[idx] === 'bash' || tokens[idx] === 'sh') idx++;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  idx++; // skip 'git' itself
  const rest = tokens.slice(idx).filter(t => t.length > 0);
  let verbIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('-')) { verbIdx = i; break; }
  }
  if (verbIdx === -1) return null;
  return { verb: rest[verbIdx].toLowerCase(), afterVerb: rest.slice(verbIdx + 1) };
}

export function detectProhibitedGitVerb(command: string): { verb: string } | null {
  if (!command) return null;
  if (parseFirstShellWord(command) !== 'git') return null;
  const parsed = findGitVerb(command);
  if (!parsed) return null;
  const { verb, afterVerb } = parsed;
  if (PROHIBITED_GIT_VERBS_SIMPLE.has(verb)) return { verb };
  if (verb === 'checkout' && isCheckoutRefOperation(afterVerb)) return { verb: 'checkout' };
  if (verb === 'commit' && afterVerb.some(t => t === '--amend')) return { verb: 'commit --amend' };
  if (verb === 'fetch' && afterVerb.some(t => t === '--prune')) return { verb: 'fetch --prune' };
  return null;
}

/**
 * R-PIPE-3 extracted helper — keeps main() complexity <= 15.
 * Returns true if we handled (blocked or approved via override); caller should return.
 */
function isBashInstallBlockedByRWSRC(input: PreToolUseInput, state: State): boolean {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return false;
  if (!isBashInvokingInstallSh(input.tool_input.command)) return false;

  const flags = (state.flags as Record<string, unknown> | undefined) || {};
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

/** R-WSRC-GR: Per-verb operator override flags. Narrowly scoped — one flag per verb. */
const ALLOW_GIT_VERB_REASON_FIELDS: Record<string, string> = {
  'reset': 'allow_git_reset_reason',
  'checkout': 'allow_git_checkout_reason',
  'switch': 'allow_git_switch_reason',
  'stash': 'allow_git_stash_reason',
  'rebase': 'allow_git_rebase_reason',
  'commit --amend': 'allow_git_commit_amend_reason',
  'pull': 'allow_git_pull_reason',
  'push': 'allow_git_push_reason',
  'fetch --prune': 'allow_git_fetch_prune_reason',
};

function gitVerbEventName(verb: string, suffix: string): ActivityEventType {
  const base = verb.replace(/\s/g, '_').replace(/-+/g, '_');
  return `worker_git_${base}_${suffix}` as unknown as ActivityEventType;
}

/**
 * R-WSRC-GR: Blocks the 9 prohibited git verbs from worker subprocess contexts.
 * Manager / operator invocations (PICKLE_ROLE not set OR matches an allowed role) pass through.
 * R-WSRC-GR-LEAK fix (#76): widen to ALL worker-variant roles, not just 'worker' — the
 * refinement-team workers set PICKLE_ROLE='refinement-worker' and were leaking git resets
 * (B-PNTR 2026-05-25: 2x dropped commits on R-PNTR-1 ticket 373c9deb despite the hook
 * being live).
 */
function isGitVerbBlockedByRWSRCGR(input: PreToolUseInput, state: State): boolean {
  if (input.tool_name !== 'Bash' || !input.tool_input?.command) return false;
  const role = process.env.PICKLE_ROLE;
  if (!role) return false;
  // Worker-class roles that MUST honor Git Boundary Rules.
  const WORKER_ROLES = new Set(['worker', 'refinement-worker']);
  if (!WORKER_ROLES.has(role)) return false;
  const detected = detectProhibitedGitVerb(input.tool_input.command);
  if (!detected) return false;

  const { verb } = detected;
  const flagField = ALLOW_GIT_VERB_REASON_FIELDS[verb];
  const flags = (state.flags as Record<string, unknown> | undefined) || {};
  const override = flagField ? trimmedFlag(flags, flagField) : null;
  const ticketId = (state as unknown as Record<string, unknown>).current_ticket as string | null | undefined;

  if (override) {
    try {
      logActivity({
        event: gitVerbEventName(verb, 'bypass'),
        source: 'hook',
        gate_payload: { command: input.tool_input.command, reason: override, ticket_id: ticketId ?? null },
      });
    } catch { /* activity logging is best-effort */ }
    approve();
    return true;
  }

  try {
    logActivity({
      event: gitVerbEventName(verb, 'blocked'),
      source: 'hook',
      gate_payload: { command: input.tool_input.command, ticket_id: ticketId ?? null },
    });
  } catch { /* best-effort */ }

  block(`R-WSRC-GR: \`git ${verb}\` is FORBIDDEN inside worker subprocesses (path-scope your edits with \`git restore <paths>\` instead). Operator override: set state.flags.${flagField ?? `allow_git_${verb.replace(/\s/g, '_')}_reason`}="<reason>" to bypass.`);
  return true;
}

function evaluateStateWriteGate(
  input: PreToolUseInput,
  state: State,
): { decision: 'block' | 'approve'; reason?: string } | null {
  const hit = detectTargetedStateFile(input);
  if (!hit) return null;

  const flags = state.flags as Record<string, unknown> | undefined;
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

function main(): void {
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

  // R-WSRC-GR: Block prohibited git verbs (reset, checkout w/ ref, switch, stash, rebase,
  // commit --amend, pull, push, fetch --prune) from worker subprocess contexts.
  if (isGitVerbBlockedByRWSRCGR(input, state)) {
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
