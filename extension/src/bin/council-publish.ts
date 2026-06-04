import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { safeErrorMessage } from '../services/pickle-utils.js';
import { validateDirective, CouncilSchemaError } from '../services/council-schema.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import type { Directive, Finding, TrapDoor } from '../services/council-schema.js';

export class CouncilPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilPublishError';
  }
}

export interface PublishOptions {
  ghCommand?: string;
  dryRun?: boolean;
  /**
   * Override timeout (ms) applied to every `gh` subprocess call. Production
   * should leave this unset — per-call defaults are 15s (auth status) and 30s
   * (pr list / pr comment). Tests inject small values to assert the hang-guard
   * without a multi-second wall-clock wait.
   */
  ghTimeoutMs?: number;
}

export interface PublishResult {
  branch: string;
  outcome: 'posted' | 'skipped_already_published' | 'skipped_no_pr' | 'skipped_no_gh' | 'failed';
  pr_number?: number;
  error?: string;
  body_path?: string;
}

export interface PublishReport {
  session_root: string;
  results: PublishResult[];
  posted: number;
  skipped: number;
  failed: number;
  warnings?: string[];
}

interface CouncilStack {
  branches: string[];
  trunk: string;
  repo_path: string;
  codex_enabled: boolean;
}

interface PublishContext {
  ghCommand: string;
  dryRun: boolean;
  prListTimeoutMs: number;
  prCommentTimeoutMs: number;
  ghAvailable: boolean;
  commentsDir: string;
  publishedDir: string;
  repoPath: string;
  directive: Directive;
  roundOutcomes: string[];
  finalRound: number;
}

function slugify(branch: string): string {
  return branch.replace(/\//g, '__');
}

/**
 * Escape a value for safe interpolation into a GitHub-flavored markdown table
 * cell. A raw `|` opens a spurious column and a raw newline terminates the row,
 * shifting every subsequent finding's cells out of alignment — council findings
 * are LLM-authored free text and routinely contain both. `|` → `\|`, CR/LF → `<br>`.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');
}

interface PrListRow {
  number: number;
  state?: string;
  updatedAt?: string;
}

export type PrListParse =
  | { ok: true; rows: PrListRow[] }
  | { ok: false; reason: string };

/**
 * Parse `gh pr list --json number,state,updatedAt` output tolerantly.
 * Accepts a JSON array (current shape) OR a bare integer on the first line
 * (legacy `--jq .[0].number` shape). Returns a discriminated result so the
 * caller can distinguish "well-formed but empty" from "unparseable" — the
 * latter must NOT masquerade as `skipped_no_pr`.
 */
export function parsePrList(stdout: string): PrListParse {
  const trimmed = stdout.trim();
  if (!trimmed) return { ok: true, rows: [] };
  const tryParseArray = (text: string): PrListRow[] | null => {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map(p => ({
            number: Number(p.number),
            state: typeof p.state === 'string' ? p.state : undefined,
            updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
          }))
          .filter(r => Number.isFinite(r.number) && r.number > 0);
      }
    } catch {
      // not JSON
    }
    return null;
  };
  const direct = tryParseArray(trimmed);
  if (direct !== null) return { ok: true, rows: direct };
  // Some `gh` invocations emit a warning line (or several) before the JSON.
  // Walk from the top, skip lines until one begins with `[` or `{`, rejoin
  // and retry. If that fails, fall through to the bare-integer path.
  const lines = trimmed.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trimStart();
    if (head.startsWith('[') || head.startsWith('{')) {
      const rest = lines.slice(i).join('\n').trim();
      if (rest && rest !== trimmed) {
        const retried = tryParseArray(rest);
        if (retried !== null) return { ok: true, rows: retried };
      }
      break;
    }
  }
  // Bare-integer legacy fallback: first non-empty line.
  const firstLine = (lines.find(l => l.trim().length > 0) || '').trim();
  const n = Number(firstLine);
  if (Number.isFinite(n) && n > 0) {
    return { ok: true, rows: [{ number: n, state: 'OPEN' }] };
  }
  const preview = trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed;
  return { ok: false, reason: `unparseable gh pr list output: ${preview}` };
}

/**
 * Scans the council-of-ricks-summary.md for `## Round N:` headers and returns
 * a clean bullet list reflecting every round outcome this session — so reviewers
 * see the full rotation (clean / partial / issues), not just the final state.
 *
 * Ignores `## Round N:` lines that appear inside fenced code blocks or
 * block-quotes — the summary template itself shows literal `## Round ...`
 * examples, so a line-oriented scan without fence tracking would double-count.
 */
function extractRoundOutcomes(summaryPath: string): string[] {
  if (!fs.existsSync(summaryPath)) return [];
  try {
    const content = fs.readFileSync(summaryPath, 'utf-8');
    const lines = content.split('\n');
    const rounds: string[] = [];
    let inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (trimmed.startsWith('>')) continue;
      const m = line.match(/^##\s+Round\s+(\d+)\s*:\s*(.+?)\s*$/i);
      if (m) {
        rounds.push(`- Round ${m[1]}: ${m[2].trim()}`);
      }
    }
    return rounds;
  } catch {
    return [];
  }
}

// council-directive.json is the machine-written directive consumed by this publisher (humans: see council-directive.md for the human-readable equivalent)
function readDirectiveJson(sessionRoot: string): Directive {
  const jsonPath = path.join(sessionRoot, 'council-directive.json');
  let parsed: unknown;
  try {
    parsed = readRecoverableJsonObject(jsonPath);
    if (!parsed) {
      if (!fs.existsSync(jsonPath)) {
        throw new CouncilPublishError('council-directive.json missing');
      }
      throw new CouncilPublishError('council-directive.json invalid JSON');
    }
  } catch (err) {
    if (err instanceof CouncilPublishError) throw err;
    throw new CouncilPublishError(`council-directive.json invalid JSON: ${safeErrorMessage(err)}`);
  }
  try {
    return validateDirective(parsed);
  } catch (err) {
    const jsonPath = err instanceof CouncilSchemaError ? err.jsonPath : '$';
    throw new CouncilPublishError(`council-directive.json failed validation: ${jsonPath}: ${safeErrorMessage(err)}`);
  }
}

export function composeBody(params: {
  sessionRoot: string;
  branch: string;
  finalRound: number;
  codexEnabled: boolean;
  findings: Finding[];
  trapDoors: TrapDoor[];
  roundOutcomes: string[];
}): string {
  const { sessionRoot, branch: _branch, finalRound, codexEnabled, findings, trapDoors, roundOutcomes } = params;
  const sessionName = path.basename(sessionRoot);
  const codexLine = codexEnabled ? 'enabled: ran on this branch' : 'disabled: not available';

  let findingsBlock: string;
  if (findings.length === 0) {
    findingsBlock = '_No findings for this branch at session close._';
  } else {
    const header = '| Severity | Conf | Source | File | Issue | Rule | Recommendation |';
    const sep = '| --- | --- | --- | --- | --- | --- | --- |';
    const rows = findings.map(f => {
      const file = f.line_range != null
        ? `${f.file}:${f.line_range.replace(/-/g, '–')}`
        : `${f.file}:${f.line}`;
      return `| ${f.severity} | ${f.confidence} | [${f.source}] | ${escapeTableCell(file)} | ${escapeTableCell(f.description)} | ${escapeTableCell(f.rule)} | ${escapeTableCell(f.recommendation)} |`;
    });
    findingsBlock = [header, sep, ...rows].join('\n');
  }

  const trapBlock = trapDoors.length === 0
    ? '_None catalogued._'
    : trapDoors.map(td => `- \`${td.path}\` — ${td.constraint}; ${td.why_it_breaks}; ${td.what_must_hold}`).join('\n');

  const roundBlock = roundOutcomes.length > 0 ? roundOutcomes.join('\n') : '- (no rounds recorded)';

  return [
    '## Council of Ricks — Stack Review',
    '',
    '_Posted at session end. See the [Council skill](https://github.com/gregorydickson/pickle-rick-claude) for the parallel-round review protocol._',
    '',
    `**Session:** \`${sessionName}\``,
    `**Final round:** ${finalRound}`,
    `**Codex adversarial:** ${codexLine}`,
    '',
    '### Findings for this branch',
    '',
    findingsBlock,
    '',
    '### Trap Doors',
    '',
    trapBlock,
    '',
    '### Round outcomes (this session)',
    '',
    roundBlock,
    '',
  ].join('\n');
}

function appendPublishLog(fd: number, result: PublishResult): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...result }) + '\n';
  fs.writeSync(fd, Buffer.from(line));
}

function appendPublishLogRaw(fd: number, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.writeSync(fd, Buffer.from(line));
}

/**
 * A marker is only "published" if it exists AND has non-zero size. A prior
 * run can leave a zero-byte file behind (interrupted write, tmpfs eviction,
 * bad umask) — treating those as "already published" silently swallows the
 * outstanding comment for that branch forever. Size > 0 means a real ISO
 * timestamp was written.
 */
function isMarkerPublished(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function loadCouncilStack(sessionRoot: string): CouncilStack {
  const stackPath = path.join(sessionRoot, 'council-stack.json');
  try {
    const parsedStack = readRecoverableJsonObject(stackPath);
    if (!parsedStack) {
      if (!fs.existsSync(stackPath)) {
        throw new CouncilPublishError(`not a council session: council-stack.json missing at ${stackPath}`);
      }
      throw new CouncilPublishError('failed to parse council-stack.json: invalid JSON');
    }
    const stack = parsedStack as unknown as CouncilStack;
    validateCouncilStack(stack);
    return stack;
  } catch (err) {
    if (err instanceof CouncilPublishError) throw err;
    throw new CouncilPublishError(`failed to parse council-stack.json: ${safeErrorMessage(err)}`);
  }
}

function validateCouncilStack(stack: CouncilStack): void {
  const { branches, trunk, repo_path } = stack;
  if (!Array.isArray(branches) || typeof trunk !== 'string' || typeof repo_path !== 'string') {
    throw new CouncilPublishError('council-stack.json missing required fields (branches, trunk, repo_path)');
  }
  if (!branches.includes(trunk)) {
    throw new CouncilPublishError(`council-stack.json: trunk "${trunk}" not in branches list`);
  }
  let repoStat: fs.Stats;
  try {
    repoStat = fs.statSync(repo_path);
  } catch {
    throw new CouncilPublishError(`council-stack.json: repo_path does not exist: ${repo_path}`);
  }
  if (!repoStat.isDirectory()) {
    throw new CouncilPublishError(`council-stack.json: repo_path is not a directory: ${repo_path}`);
  }
}

function ensurePublishDirs(sessionRoot: string): { commentsDir: string; publishedDir: string; logPath: string } {
  const commentsDir = path.join(sessionRoot, 'council-comments');
  fs.mkdirSync(commentsDir, { recursive: true });
  const publishedDir = path.join(sessionRoot, '.published');
  fs.mkdirSync(publishedDir, { recursive: true });
  const logPath = path.join(sessionRoot, 'publish.log');
  return { commentsDir, publishedDir, logPath };
}

function checkGhAvailable(ghCommand: string, authTimeoutMs: number): boolean {
  // gh availability check. `timeout` guards against a hang on a machine where
  // `gh` is installed but wedged (stuck keyring prompt, dead network on first
  // auth-refresh attempt) — without it, the entire publisher blocks at session
  // end with no log output. Treated the same as any other auth failure.
  try {
    execFileSync(ghCommand, ['auth', 'status'], { stdio: 'pipe', timeout: authTimeoutMs });
    return true;
  } catch {
    return false;
  }
}

function recordPublishResult(results: PublishResult[], logFd: number, result: PublishResult): void {
  results.push(result);
  appendPublishLog(logFd, result);
}

function countPublishResult(report: PublishReport, result: PublishResult): void {
  if (result.outcome === 'posted') report.posted++;
  else if (result.outcome === 'failed') report.failed++;
  else report.skipped++;
}

function writeBranchBody(sessionRoot: string, branch: string, bodyPath: string, ctx: PublishContext): PublishResult | null {
  const branchEntry = ctx.directive.branches.find(b => b.name === branch);
  if (!branchEntry) {
    return {
      branch,
      outcome: 'failed',
      error: 'council-directive.json has no entry for this branch — directive/stack mismatch',
    };
  }
  const body = composeBody({
    sessionRoot,
    branch,
    finalRound: ctx.finalRound,
    codexEnabled: ctx.directive.codex_enabled,
    findings: branchEntry.findings,
    trapDoors: ctx.directive.trap_doors,
    roundOutcomes: ctx.roundOutcomes,
  });
  fs.writeFileSync(bodyPath, body);
  return null;
}

function pickPrNumber(rows: PrListRow[]): number | undefined {
  rows.sort((a, b) => {
    if (a.state === 'OPEN' && b.state !== 'OPEN') return -1;
    if (b.state === 'OPEN' && a.state !== 'OPEN') return 1;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  const picked = rows[0]?.number;
  return Number.isFinite(picked) && picked > 0 ? picked : undefined;
}

function resolvePrNumber(branch: string, bodyPath: string, ctx: PublishContext): PublishResult | number {
  try {
    const out = execFileSync(
      ctx.ghCommand,
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,updatedAt'],
      { cwd: ctx.repoPath, stdio: 'pipe', encoding: 'utf8', timeout: ctx.prListTimeoutMs },
    ).trim();
    const parsed = parsePrList(out);
    if (!parsed.ok) {
      return { branch, outcome: 'failed', error: `pr list parse: ${parsed.reason}`, body_path: bodyPath };
    }
    const prNumber = pickPrNumber(parsed.rows);
    return prNumber ?? { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
  } catch (err) {
    return { branch, outcome: 'failed', error: `pr list: ${safeErrorMessage(err)}`, body_path: bodyPath };
  }
}

function publishBranch(sessionRoot: string, branch: string, ctx: PublishContext): PublishResult {
  const slug = slugify(branch);
  const bodyPath = path.join(ctx.commentsDir, `${slug}.md`);
  const markerPath = path.join(ctx.publishedDir, slug);
  const bodyFailure = writeBranchBody(sessionRoot, branch, bodyPath, ctx);
  if (bodyFailure) return bodyFailure;
  if (!ctx.ghAvailable) return { branch, outcome: 'skipped_no_gh', body_path: bodyPath };
  if (isMarkerPublished(markerPath)) return { branch, outcome: 'skipped_already_published', body_path: bodyPath };
  const resolved = resolvePrNumber(branch, bodyPath, ctx);
  if (typeof resolved !== 'number') return resolved;
  if (ctx.dryRun) return { branch, outcome: 'posted', pr_number: resolved, body_path: bodyPath };
  try {
    execFileSync(
      ctx.ghCommand,
      ['pr', 'comment', String(resolved), '--body-file', bodyPath],
      { cwd: ctx.repoPath, stdio: 'pipe', timeout: ctx.prCommentTimeoutMs },
    );
    fs.writeFileSync(markerPath, new Date().toISOString());
    return { branch, outcome: 'posted', pr_number: resolved, body_path: bodyPath };
  } catch (err) {
    return { branch, outcome: 'failed', pr_number: resolved, error: `pr comment: ${safeErrorMessage(err)}`, body_path: bodyPath };
  }
}

export default function publishCouncilStack(
  sessionRoot: string,
  opts: PublishOptions = {},
): PublishReport {
  const ghCommand = opts.ghCommand || 'gh';
  const ghTimeoutOverride = opts.ghTimeoutMs;
  const authTimeoutMs = ghTimeoutOverride ?? 15_000;
  if (!fs.existsSync(sessionRoot)) {
    throw new CouncilPublishError(`session_root does not exist: ${sessionRoot}`);
  }
  const stack = loadCouncilStack(sessionRoot);
  const { commentsDir, publishedDir, logPath } = ensurePublishDirs(sessionRoot);
  const roundOutcomes = extractRoundOutcomes(path.join(sessionRoot, 'council-of-ricks-summary.md'));
  const ctx: PublishContext = {
    ghCommand,
    dryRun: !!opts.dryRun,
    prListTimeoutMs: ghTimeoutOverride ?? 30_000,
    prCommentTimeoutMs: ghTimeoutOverride ?? 30_000,
    ghAvailable: checkGhAvailable(ghCommand, authTimeoutMs),
    commentsDir,
    publishedDir,
    repoPath: stack.repo_path,
    directive: readDirectiveJson(sessionRoot),
    roundOutcomes,
    finalRound: roundOutcomes.length,
  };
  const report: PublishReport = { session_root: sessionRoot, results: [], posted: 0, skipped: 0, failed: 0 };
  const logFd = fs.openSync(logPath, 'a');
  try {
    for (const branch of stack.branches) {
      if (branch === stack.trunk) continue;
      const result = publishBranch(sessionRoot, branch, ctx);
      recordPublishResult(report.results, logFd, result);
      countPublishResult(report, result);
    }
    if (report.results.length === 0) {
      const msg = 'council-stack.json has no non-trunk branches; nothing to publish';
      report.warnings = [msg];
      appendPublishLogRaw(logFd, { level: 'warn', message: msg });
    }
    return report;
  } finally {
    fs.closeSync(logFd);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'council-publish.js') {
  const sessionRoot = process.argv[2];
  if (!sessionRoot) {
    console.error('Usage: council-publish <SESSION_ROOT> [--dry-run]');
    process.exit(1);
  }
  let dryRun = false;
  for (const arg of process.argv.slice(3)) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else {
      console.error(`council-publish: unknown argument: ${arg}`);
      console.error('Usage: council-publish <SESSION_ROOT> [--dry-run]');
      process.exit(2);
    }
  }
  try {
    const report = publishCouncilStack(sessionRoot, { dryRun });
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(`council-publish: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
