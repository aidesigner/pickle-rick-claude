import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCmd, extractFrontmatter, formatLocalDateKey } from './pickle-utils.js';
import { syncLinearTicketStatus } from './linear-integration.js';

export function runGit(cmd: string[], cwd?: string, check: boolean = true): string {
  return runCmd(['git', ...cmd], { cwd, check });
}

export function getGithubUser(): string {
  try {
    return runCmd(['gh', 'api', 'user', '-q', '.login']);
  } catch {
    try {
      return runCmd(['git', 'config', 'user.name']).replace(/\s+/g, '');
    } catch {
      return 'pickle-rick';
    }
  }
}

export function getBranchName(taskId: string): string {
  const user = getGithubUser();
  const lowerId = taskId.toLowerCase();
  const type = ['fix', 'bug', 'patch', 'issue'].some((x) => lowerId.includes(x)) ? 'fix' : 'feat';
  return `${user}/${type}/${taskId}`;
}

const MAX_TICKET_SEARCH_DEPTH = 10;

function findTicketFile(sessionDir: string, ticketId: string): string | null {
  const fileName = `linear_ticket_${ticketId}.md`;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_TICKET_SEARCH_DEPTH) return null; // symlink-cycle guard
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(fullPath); } catch { continue; } // lstat: don't follow symlinks
      if (stat.isDirectory()) {
        const hit = walk(fullPath, depth + 1);
        if (hit) return hit;
      } else if (entry === fileName) {
        return fullPath;
      }
    }
    return null;
  };
  return walk(sessionDir, 0);
}

function setFrontmatterField(frontmatterSection: string, key: string, value: string | null): string {
  const lineRe = new RegExp(`^${key}:.*$(\\r?\\n)?`, 'm');
  if (value === null) {
    return frontmatterSection.replace(lineRe, '');
  }
  if (lineRe.test(frontmatterSection)) {
    return frontmatterSection.replace(lineRe, `${key}: "${value}"$1`);
  }
  return frontmatterSection.replace(/\n---(\r?\n?)$/, `\n${key}: "${value}"\n---$1`);
}

export interface TicketFrontmatterPatch {
  status?: string;
  completion_commit?: string | null;
}

function validateTicketFrontmatterPatch(patch: TicketFrontmatterPatch): void {
  if (patch.status !== undefined && /["\n\r]/.test(patch.status)) {
    throw new Error('Invalid status value: must not contain quotes or newlines');
  }
  if (patch.completion_commit !== undefined && patch.completion_commit !== null && /["\n\r]/.test(patch.completion_commit)) {
    throw new Error('Invalid completion_commit value: must not contain quotes or newlines');
  }
}

function applyStatusAndUpdatedFields(
  content: string,
  ticketId: string,
  nextStatus: string | null,
  today: string
): { content: string; statusReplaced: boolean } {
  let statusReplaced = false;
  let nextContent = content;

  const hasFrontmatter = extractFrontmatter(nextContent) !== null;
  if (!hasFrontmatter) {
    console.warn(`Warning: ticket ${ticketId} has no valid YAML frontmatter — status replacement may be imprecise`);
  }

  if (nextStatus !== null && /^status:.*$/m.test(nextContent)) {
    nextContent = nextContent.replace(/^status:.*$/m, `status: "${nextStatus}"`);
    statusReplaced = true;
  }

  if (/^updated:.*$/m.test(nextContent)) {
    nextContent = nextContent.replace(/^updated:.*$/m, `updated: "${today}"`);
  } else if (hasFrontmatter) {
    nextContent = nextContent.replace(/\n---(\r?\n?)$/, `\nupdated: "${today}"\n---$1`);
  }

  return { content: nextContent, statusReplaced };
}

function applyCompletionCommitField(content: string, patch: TicketFrontmatterPatch): string {
  if (patch.completion_commit === undefined) return content;
  const updated = setFrontmatterField(content, 'completion_commit', patch.completion_commit);
  if (patch.completion_commit !== null) return updated;
  return setFrontmatterField(updated, 'completion_commit_inferred', null);
}

export function updateTicketFrontmatter(
  ticketId: string,
  sessionDir: string,
  patch: TicketFrontmatterPatch
): void {
  validateTicketFrontmatterPatch(patch);

  const ticketPath = findTicketFile(sessionDir, ticketId);
  if (!ticketPath) {
    throw new Error(`Ticket linear_ticket_${ticketId}.md not found in ${sessionDir}`);
  }

  const original = fs.readFileSync(ticketPath, 'utf-8');
  const today = formatLocalDateKey(new Date());
  const nextStatus = patch.status ?? null;
  const fm = extractFrontmatter(original);
  const baseContent = fm ? original.slice(0, fm.end) : original;
  const { content: updatedBase, statusReplaced } = applyStatusAndUpdatedFields(baseContent, ticketId, nextStatus, today);
  const content = applyCompletionCommitField(
    fm ? updatedBase + original.slice(fm.end) : updatedBase,
    patch
  );

  if (nextStatus !== null && !statusReplaced) {
    console.warn(`Warning: no "status:" field found in ticket ${ticketId} — status not updated`);
  }

  const tmp = `${ticketPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, ticketPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  if (statusReplaced) {
    console.log(`Successfully updated ticket ${ticketId} to status "${nextStatus}"`);
  }
  if (nextStatus !== null) {
    syncLinearTicketStatus(sessionDir, ticketId, nextStatus);
  }
}

export function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  sessionDir: string
): void {
  updateTicketFrontmatter(ticketId, sessionDir, { status: newStatus });
}

export function getHeadSha(cwd: string): string {
  return runGit(['rev-parse', 'HEAD'], cwd).trim();
}

export function getHeadBranch(cwd: string): string | null {
  const result = runGit(['symbolic-ref', '--short', 'HEAD'], cwd, false).trim();
  return result || null;
}

function buildCleanArgs(preservePrefixes?: string[]): string[] {
  const args = ['clean', '-fd'];
  const cleanedPrefixes = normalizeExcludePrefixes(preservePrefixes);
  if (cleanedPrefixes.length === 0) return args;
  args.push('--', '.');
  for (const cleaned of cleanedPrefixes) {
    args.push(`:!${cleaned}`, `:!${cleaned}/**`);
  }
  return args;
}

export function resetToSha(sha: string, cwd: string, preservePrefixes?: string[]): void {
  runGit(['reset', '--hard', sha], cwd);
  runGit(buildCleanArgs(preservePrefixes), cwd);
}

function normalizeExcludePrefixes(excludePrefixes?: string[]): string[] {
  if (!excludePrefixes || excludePrefixes.length === 0) return [];
  return excludePrefixes
    .map((prefix) => prefix.replace(/^\.?\/+/, '').replace(/\/+$/, ''))
    .filter((prefix) => prefix.length > 0);
}

function statusArgs(excludePrefixes?: string[]): string[] {
  const args = ['status', '--porcelain', '-z'];
  const cleanedPrefixes = normalizeExcludePrefixes(excludePrefixes);
  if (cleanedPrefixes.length > 0) {
    args.push('--', '.');
    for (const cleaned of cleanedPrefixes) {
      args.push(`:!${cleaned}`, `:!${cleaned}/**`);
    }
  }
  return args;
}

export function listWorkingTreeDirtyPaths(cwd: string, excludePrefixes?: string[]): string[] {
  const result = spawnSync('git', statusArgs(excludePrefixes), {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Command failed: git ${statusArgs(excludePrefixes).join(' ')}\nError: ${result.stderr || ''}`);
  }
  const output = result.stdout || '';
  if (!output) return [];

  const tokens = output.split('\0').filter((token) => token.length > 0);
  const paths: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    paths.push(token.slice(3));
    const status = token.slice(0, 2);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      index += 1;
    }
  }

  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function isGitIgnoredPath(cwd: string, filePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', filePath], {
    cwd,
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function isWorkingTreeDirty(cwd: string, excludePrefixes?: string[]): boolean {
  return listWorkingTreeDirtyPaths(cwd, excludePrefixes).length > 0;
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | 'B';
export interface DiffEntry {
  path: string;
  status: DiffStatus;
}

/**
 * Returns file-level diff between `base` and `head` for `repoRoot`.
 *
 * Uses `git diff <base>...<head> --name-status -M100 -z` so renames are
 * detected only when similarity is exactly 100% (no heuristic flake), and
 * paths containing whitespace/unicode/newlines survive the NUL-delimited
 * parse intact. Deleted files (`D`) are included — the caller decides
 * whether to exclude them from any "allowed paths" set.
 *
 * Rename entries report the **new** path with status `'R'`; the old path
 * is discarded (scope-resolver does not need it).
 */
export function getDiffFiles(base: string, head: string, repoRoot: string): DiffEntry[] {
  const out = runGit(
    ['diff', `${base}...${head}`, '--name-status', '-M100', '-z'],
    repoRoot,
  );
  if (!out) return [];
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const entries: DiffEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code.startsWith('R') || code.startsWith('C')) {
      const newPath = tokens[i + 2];
      if (newPath) entries.push({ path: newPath, status: 'R' });
      i += 2;
    } else if (code === 'A' || code === 'M' || code === 'D') {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: code });
      i += 1;
    } else {
      const p = tokens[i + 1];
      if (p) entries.push({ path: p, status: 'B' });
      i += 1;
    }
  }
  return entries;
}

/**
 * Returns the merge-base SHA between `ref1` and `ref2` for `repoRoot`.
 * Throws via `runGit` if either ref is unknown to the repository.
 */
export function getMergeBase(ref1: string, ref2: string, repoRoot: string): string {
  return runGit(['merge-base', ref1, ref2], repoRoot).trim();
}
