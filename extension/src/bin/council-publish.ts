import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { safeErrorMessage } from '../services/pickle-utils.js';

export class CouncilPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouncilPublishError';
  }
}

export interface PublishOptions {
  ghCommand?: string;
  dryRun?: boolean;
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
}

interface CouncilStack {
  branches: string[];
  trunk: string;
  repo_path: string;
  codex_enabled: boolean;
}

function slugify(branch: string): string {
  return branch.replace(/\//g, '__');
}

interface PrListRow {
  number: number;
  state?: string;
  updatedAt?: string;
}

/**
 * Parse `gh pr list --json number,state,updatedAt` output tolerantly.
 * Accepts a JSON array (current shape) OR a bare integer on the first line
 * (legacy `--jq .[0].number` shape) — the fallback keeps older mocks and
 * possible `gh` variants working without a code change.
 */
function parsePrList(stdout: string): PrListRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
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
    // JSON.parse succeeds on bare integers / "null" too — fall through to the
    // legacy-shape handler below so a `--jq .[0].number` stdout still parses.
  } catch {
    // Not JSON at all — also fall through.
  }
  const n = Number(trimmed.split('\n')[0]);
  return Number.isFinite(n) && n > 0 ? [{ number: n, state: 'OPEN' }] : [];
}

/**
 * Scans the council-of-ricks-summary.md for `## Round N:` headers and returns
 * a clean bullet list reflecting every round outcome this session — so reviewers
 * see the full rotation (clean / partial / issues), not just the final state.
 */
function extractRoundOutcomes(summaryPath: string): string[] {
  if (!fs.existsSync(summaryPath)) return [];
  try {
    const content = fs.readFileSync(summaryPath, 'utf-8');
    const lines = content.split('\n');
    const rounds: string[] = [];
    for (const line of lines) {
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

/**
 * Reads council-directive.md if present and returns the full text of the
 * LATEST directive. Directives are typically overwritten each round, but we
 * support append-mode too — the H1 `# Council Directive` (optionally followed
 * by `— Round N`) anchors the split. Word boundary prevents false positives
 * inside fenced code blocks or quoted examples.
 */
function readLatestDirective(directivePath: string): string {
  if (!fs.existsSync(directivePath)) return '';
  try {
    const content = fs.readFileSync(directivePath, 'utf-8');
    const markers: number[] = [];
    const rx = /^# Council Directive(?:\s|$)/gm;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(content)) !== null) markers.push(m.index);
    if (markers.length === 0) return content;
    return content.slice(markers[markers.length - 1]);
  } catch {
    return '';
  }
}

/**
 * Extracts per-branch findings rows from the latest directive. Findings tables
 * follow `### Findings` (or `## Findings`) and have a `Branch` column. We scan
 * every markdown-table-looking line and keep rows whose `Branch` cell matches.
 */
function findingsForBranch(directive: string, branch: string): string[] {
  if (!directive) return [];
  const lines = directive.split('\n');
  // Find any table with a Branch column. A table ends at a non-pipe line; when
  // a new table starts we reset the header but keep the last one we used to
  // emit rows, so we can reconstruct output even if row collection spans blocks.
  const rows: string[] = [];
  let header: string[] | null = null;
  let usedHeader: string[] | null = null;
  let branchCol = -1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      header = null;
      branchCol = -1;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (!header) {
      const idx = cells.findIndex(c => c.toLowerCase() === 'branch');
      if (idx >= 0) {
        header = cells;
        usedHeader = cells;
        branchCol = idx;
      }
      continue;
    }
    // Skip separator row like |---|---|
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    if (branchCol >= 0 && branchCol < cells.length && cells[branchCol] === branch) {
      rows.push(line);
    }
  }
  if (rows.length === 0 || !usedHeader) return [];
  const sep = '| ' + usedHeader.map(() => '---').join(' | ') + ' |';
  return ['| ' + usedHeader.join(' | ') + ' |', sep, ...rows];
}

/**
 * Extracts the `## Trap Doors` section; trap doors are structural and shared
 * across the stack by design, so the full section body is returned for every
 * branch.
 */
function trapDoorsForBranch(directive: string, _branch: string): string {
  if (!directive) return '';
  const lines = directive.split('\n');
  let inSection = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^##\s+Trap Doors/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (inSection) collected.push(line);
  }
  return collected.join('\n').trim();
}

function composeBody(params: {
  sessionRoot: string;
  branch: string;
  finalRound: number;
  codexEnabled: boolean;
  findings: string[];
  trapDoors: string;
  roundOutcomes: string[];
}): string {
  const { sessionRoot, branch: _branch, finalRound, codexEnabled, findings, trapDoors, roundOutcomes } = params;
  const sessionName = path.basename(sessionRoot);
  const codexLine = codexEnabled ? 'enabled: ran on this branch' : 'disabled: not available';
  const findingsBlock = findings.length > 0
    ? findings.join('\n')
    : 'No findings for this branch at session close.';
  const trapBlock = trapDoors.length > 0 ? trapDoors : 'None catalogued.';
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

export default function publishCouncilStack(
  sessionRoot: string,
  opts: PublishOptions = {},
): PublishReport {
  const ghCommand = opts.ghCommand || 'gh';
  const dryRun = !!opts.dryRun;

  if (!fs.existsSync(sessionRoot)) {
    throw new CouncilPublishError(`session_root does not exist: ${sessionRoot}`);
  }
  const stackPath = path.join(sessionRoot, 'council-stack.json');
  if (!fs.existsSync(stackPath)) {
    throw new CouncilPublishError(`not a council session: council-stack.json missing at ${stackPath}`);
  }

  let stack: CouncilStack;
  try {
    stack = JSON.parse(fs.readFileSync(stackPath, 'utf-8')) as CouncilStack;
  } catch (err) {
    throw new CouncilPublishError(`failed to parse council-stack.json: ${safeErrorMessage(err)}`);
  }
  const { branches, trunk, repo_path, codex_enabled } = stack;
  if (!Array.isArray(branches) || typeof trunk !== 'string' || typeof repo_path !== 'string') {
    throw new CouncilPublishError('council-stack.json missing required fields (branches, trunk, repo_path)');
  }

  const commentsDir = path.join(sessionRoot, 'council-comments');
  fs.mkdirSync(commentsDir, { recursive: true });
  const publishedDir = path.join(sessionRoot, '.published');
  fs.mkdirSync(publishedDir, { recursive: true });
  const logPath = path.join(sessionRoot, 'publish.log');

  // gh availability check
  let ghAvailable = true;
  try {
    execFileSync(ghCommand, ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    ghAvailable = false;
  }

  const roundOutcomes = extractRoundOutcomes(path.join(sessionRoot, 'council-of-ricks-summary.md'));
  const finalRound = roundOutcomes.length;
  const directive = readLatestDirective(path.join(sessionRoot, 'council-directive.md'));

  const results: PublishResult[] = [];
  let posted = 0;
  let skipped = 0;
  let failed = 0;

  const logFd = fs.openSync(logPath, 'a');
  try {
    for (const branch of branches) {
      if (branch === trunk) continue;
      const slug = slugify(branch);
      const bodyPath = path.join(commentsDir, `${slug}.md`);
      const markerPath = path.join(publishedDir, slug);

      const body = composeBody({
        sessionRoot,
        branch,
        finalRound,
        codexEnabled: !!codex_enabled,
        findings: findingsForBranch(directive, branch),
        trapDoors: trapDoorsForBranch(directive, branch),
        roundOutcomes,
      });
      fs.writeFileSync(bodyPath, body);

      if (!ghAvailable) {
        const r: PublishResult = { branch, outcome: 'skipped_no_gh', body_path: bodyPath };
        results.push(r);
        skipped++;
        appendPublishLog(logFd, r);
        continue;
      }

      if (fs.existsSync(markerPath)) {
        const r: PublishResult = { branch, outcome: 'skipped_already_published', body_path: bodyPath };
        results.push(r);
        skipped++;
        appendPublishLog(logFd, r);
        continue;
      }

      // Resolve PR number. Query all states (OPEN + MERGED + CLOSED) so re-runs
      // on a merged stack still post. When multiple PRs share a head branch,
      // prefer OPEN, then most-recently-updated — deterministic tie-break.
      let prNumber: number | undefined;
      try {
        const out = execFileSync(
          ghCommand,
          ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,updatedAt'],
          { cwd: repo_path, stdio: 'pipe', encoding: 'utf8' },
        ).trim();
        const prs = parsePrList(out);
        if (prs.length === 0) {
          const r: PublishResult = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
          results.push(r);
          skipped++;
          appendPublishLog(logFd, r);
          continue;
        }
        prs.sort((a, b) => {
          if (a.state === 'OPEN' && b.state !== 'OPEN') return -1;
          if (b.state === 'OPEN' && a.state !== 'OPEN') return 1;
          return (b.updatedAt || '').localeCompare(a.updatedAt || '');
        });
        const picked = prs[0].number;
        if (!Number.isFinite(picked) || picked <= 0) {
          const r: PublishResult = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
          results.push(r);
          skipped++;
          appendPublishLog(logFd, r);
          continue;
        }
        prNumber = picked;
      } catch (err) {
        const r: PublishResult = {
          branch,
          outcome: 'failed',
          error: `pr list: ${safeErrorMessage(err)}`,
          body_path: bodyPath,
        };
        results.push(r);
        failed++;
        appendPublishLog(logFd, r);
        continue;
      }

      if (dryRun) {
        const r: PublishResult = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
        results.push(r);
        posted++;
        appendPublishLog(logFd, r);
        continue;
      }

      // Post the comment
      try {
        execFileSync(
          ghCommand,
          ['pr', 'comment', String(prNumber), '--body-file', bodyPath],
          { cwd: repo_path, stdio: 'pipe' },
        );
        fs.writeFileSync(markerPath, new Date().toISOString());
        const r: PublishResult = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
        results.push(r);
        posted++;
        appendPublishLog(logFd, r);
      } catch (err) {
        const r: PublishResult = {
          branch,
          outcome: 'failed',
          pr_number: prNumber,
          error: `pr comment: ${safeErrorMessage(err)}`,
          body_path: bodyPath,
        };
        results.push(r);
        failed++;
        appendPublishLog(logFd, r);
      }
    }
  } finally {
    fs.closeSync(logFd);
  }

  return { session_root: sessionRoot, results, posted, skipped, failed };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'council-publish.js') {
  const sessionRoot = process.argv[2];
  if (!sessionRoot) {
    console.error('Usage: council-publish <SESSION_ROOT>');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  try {
    const report = publishCouncilStack(sessionRoot, { dryRun });
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(`council-publish: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
