import * as fs from 'fs';
import * as path from 'path';
import { runCmd, extractFrontmatter } from './pickle-utils.js';

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

export function updateTicketStatus(
  ticketId: string,
  newStatus: string,
  sessionDir: string
): void {
  if (/["\n\r]/.test(newStatus)) {
    throw new Error('Invalid status value: must not contain quotes or newlines');
  }
  // 1. Find the ticket file
  // Search recursively in the session directory
  const findTicket = (dir: string, depth: number = 0): string | null => {
    if (depth > 10) return null; // prevent runaway recursion from symlink cycles
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return null; }
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath); // lstat: don't follow symlinks into directories
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const res = findTicket(fullPath, depth + 1);
        if (res) return res;
      } else if (file === `linear_ticket_${ticketId}.md`) {
        return fullPath;
      }
    }
    return null;
  };

  const ticketPath = findTicket(sessionDir);
  if (!ticketPath) {
    throw new Error(`Ticket linear_ticket_${ticketId}.md not found in ${sessionDir}`);
  }

  // 2. Read and update the frontmatter
  let content = fs.readFileSync(ticketPath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];

  // Track whether the status: line was actually found and replaced
  let statusReplaced = false;

  // Replace only within the YAML frontmatter block (between the first pair of --- delimiters).
  // Using a global replace here would corrupt any "status:" lines in the ticket body.
  const fm = extractFrontmatter(content);
  if (fm) {
    let fmSection = content.slice(0, fm.end);
    if (/^status:.*$/m.test(fmSection)) {
      fmSection = fmSection.replace(/^status:.*$/m, `status: "${newStatus}"`);
      statusReplaced = true;
    }
    if (/^updated:.*$/m.test(fmSection)) {
      fmSection = fmSection.replace(/^updated:.*$/m, `updated: "${today}"`);
    } else {
      // Insert updated field before closing --- if missing
      fmSection = fmSection.replace(/\n---(\r?\n?)$/, `\nupdated: "${today}"\n---$1`);
    }
    content = fmSection + content.slice(fm.end);
  } else {
    // No frontmatter delimiters found — warn and fall back to full-file replace
    console.warn(`Warning: ticket ${ticketId} has no valid YAML frontmatter — status replacement may be imprecise`);
    if (/^status:.*$/m.test(content)) {
      content = content.replace(/^status:.*$/m, `status: "${newStatus}"`);
      statusReplaced = true;
    }
    content = content.replace(/^updated:.*$/m, `updated: "${today}"`);
  }

  if (!statusReplaced) {
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
    console.log(`Successfully updated ticket ${ticketId} to status "${newStatus}"`);
  }
}

export function getHeadSha(cwd: string): string {
  return runGit(['rev-parse', 'HEAD'], cwd).trim();
}

export function resetToSha(sha: string, cwd: string): void {
  runGit(['reset', '--hard', sha], cwd);
  runGit(['clean', '-fd'], cwd);
}

export function isWorkingTreeDirty(cwd: string): boolean {
  return runGit(['status', '--porcelain'], cwd).trim().length > 0;
}
