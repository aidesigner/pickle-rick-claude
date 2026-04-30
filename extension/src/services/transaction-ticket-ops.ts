import * as fs from 'node:fs';
import * as path from 'node:path';

export type TicketStatus = 'Todo' | 'In Progress' | 'Done' | 'Skipped' | string;

export interface TicketTransactionContext {
  now?: Date | string;
}

export interface PlannedFileWrite {
  path: string;
  content: string;
}

export type PlannedTicketWrite = PlannedFileWrite;

export interface MaterializeTicketFileSpec {
  path?: string;
  name?: string;
  content: string;
}

export interface MaterializeTicketSpec {
  ticketId: string;
  sessionDir?: string;
  sessionRoot?: string;
  dirPath?: string;
  ticketFileName?: string;
  content?: string;
  files?: MaterializeTicketFileSpec[];
  frontmatter?: Record<string, string | number | boolean | null>;
  body?: string;
}

export interface MaterializedTicketPlan {
  dirPath: string;
  files: PlannedFileWrite[];
}

export type ReverseLedgerEntry =
  | {
      action: 'create' | 'created';
      path: string;
    }
  | {
      action: 'write' | 'update' | 'delete' | 'deleted';
      path: string;
      beforeContent?: string | null;
      previousContent?: string | null;
      backupContent?: string | null;
    };

export interface ReverseLedger {
  entries?: ReverseLedgerEntry[];
  actions?: ReverseLedgerEntry[];
  steps?: ReverseLedgerEntry[];
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertWithinRoot(targetPath: string, rootPath: string): string {
  if (!isWithinRoot(targetPath, rootPath)) {
    throw new Error(`Path escapes ticket transaction root: ${targetPath}`);
  }
  return targetPath;
}

function resolveTicketDir(sessionDir: string, ticketId: string): string {
  return path.join(sessionDir, ticketId);
}

function findLinearTicketFile(ticketDir: string): string {
  const ticketFile = fs
    .readdirSync(ticketDir)
    .find(file => file.startsWith('linear_ticket_') && file.endsWith('.md'));
  if (!ticketFile) throw new Error(`No linear ticket file found in ${ticketDir}`);
  return path.join(ticketDir, ticketFile);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFrontmatter(content: string): { body: string; start: number; end: number } | null {
  const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
  if (openLen === 0) return null;
  const closeIdx = content.indexOf('\n---', openLen);
  if (closeIdx === -1) return null;
  const rawEnd = closeIdx + 4;
  const end = content[rawEnd] === '\n'
    ? rawEnd + 1
    : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n'
      ? rawEnd + 2
      : rawEnd;
  return { body: content.slice(openLen, closeIdx), start: 0, end };
}

function setFrontmatterField(content: string, field: string, value: string): string {
  const fm = extractFrontmatter(content);
  if (!fm) return content;

  const existingField = new RegExp(`^${escapeRegExp(field)}:\\s*.*$`, 'm');
  if (existingField.test(fm.body)) {
    return content.replace(existingField, `${field}: "${value}"`);
  }

  const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
  if (closingNewline === -1) return content;
  const insertPoint = closingNewline + 1;
  return content.slice(0, insertPoint) + `${field}: "${value}"\n` + content.slice(insertPoint);
}

function statusTimestampField(status: TicketStatus): 'completed_at' | 'skipped_at' | null {
  const normalized = String(status).toLowerCase();
  if (normalized === 'done') return 'completed_at';
  if (normalized === 'skipped') return 'skipped_at';
  return null;
}

function timestamp(ctx?: TicketTransactionContext): string {
  if (ctx?.now instanceof Date) return ctx.now.toISOString();
  if (typeof ctx?.now === 'string') return ctx.now;
  return new Date().toISOString();
}

function assertStatusWasUpdated(before: string, after: string, filePath: string): void {
  if (before === after) {
    throw new Error(`Ticket status could not be updated in ${filePath}`);
  }
}

export function updateTicketStatusInTransaction(
  ticketId: string,
  newStatus: TicketStatus,
  sessionDir: string,
  txCtx?: TicketTransactionContext,
): PlannedTicketWrite {
  const ticketDir = resolveTicketDir(sessionDir, ticketId);
  const filePath = findLinearTicketFile(ticketDir);
  const content = fs.readFileSync(filePath, 'utf-8');
  let updated = content.replace(/^(status:\s*).*$/m, `$1"${newStatus}"`);
  assertStatusWasUpdated(content, updated, filePath);

  const timestampField = statusTimestampField(newStatus);
  if (timestampField) {
    updated = setFrontmatterField(updated, timestampField, timestamp(txCtx));
  }

  return { path: filePath, content: updated };
}

function defaultTicketContent(spec: MaterializeTicketSpec): string {
  const frontmatter = {
    id: spec.ticketId,
    status: 'Todo',
    ...spec.frontmatter,
  };
  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${value}`;
    if (value === null) return `${key}: null`;
    return `${key}: "${value}"`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${spec.body ?? ''}`;
}

export function materializeNewTicket(spec: MaterializeTicketSpec): MaterializedTicketPlan {
  const root = spec.dirPath ?? path.join(spec.sessionDir ?? spec.sessionRoot ?? '', spec.ticketId);
  if (!root || root === spec.ticketId) {
    throw new Error('materializeNewTicket requires dirPath, sessionDir, or sessionRoot');
  }

  const files = spec.files && spec.files.length > 0
    ? spec.files
    : [{
        name: spec.ticketFileName ?? `linear_ticket_${spec.ticketId}.md`,
        content: spec.content ?? defaultTicketContent(spec),
      }];

  return {
    dirPath: root,
    files: files.map(file => ({
      path: assertWithinRoot(
        file.path ?? path.join(root, file.name ?? `linear_ticket_${spec.ticketId}.md`),
        root,
      ),
      content: file.content,
    })),
  };
}

function resolveLedgerEntries(parsed: ReverseLedger | ReverseLedgerEntry[]): ReverseLedgerEntry[] {
  if (Array.isArray(parsed)) return parsed;
  return parsed.entries ?? parsed.actions ?? parsed.steps ?? [];
}

function resolveLedgerPath(sessionRoot: string, entryPath: string): string {
  const targetPath = path.isAbsolute(entryPath) ? entryPath : path.join(sessionRoot, entryPath);
  return assertWithinRoot(targetPath, sessionRoot);
}

function restoreContent(entry: ReverseLedgerEntry): string | null | undefined {
  if ('beforeContent' in entry) return entry.beforeContent;
  if ('previousContent' in entry) return entry.previousContent;
  if ('backupContent' in entry) return entry.backupContent;
  return undefined;
}

function removeEmptyParents(startDir: string, stopDir: string): void {
  let current = startDir;
  while (isWithinRoot(current, stopDir) && path.resolve(current) !== path.resolve(stopDir)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function replayReverseLedger(ledgerPath: string, sessionRoot: string): PlannedFileWrite[] {
  const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as ReverseLedger | ReverseLedgerEntry[];
  const entries = resolveLedgerEntries(parsed);
  const restored: PlannedFileWrite[] = [];

  for (const entry of [...entries].reverse()) {
    const targetPath = resolveLedgerPath(sessionRoot, entry.path);
    const priorContent = restoreContent(entry);

    if (priorContent === undefined || priorContent === null) {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
      removeEmptyParents(path.dirname(targetPath), sessionRoot);
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, priorContent);
    restored.push({ path: targetPath, content: priorContent });
  }

  return restored;
}
