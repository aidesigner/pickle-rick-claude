import * as fs from 'node:fs';
import * as path from 'node:path';
function isWithinRoot(targetPath, rootPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function assertWithinRoot(targetPath, rootPath) {
    if (!isWithinRoot(targetPath, rootPath)) {
        throw new Error(`Path escapes ticket transaction root: ${targetPath}`);
    }
    return targetPath;
}
function resolveTicketDir(sessionDir, ticketId) {
    return path.join(sessionDir, ticketId);
}
function findLinearTicketFile(ticketDir) {
    const ticketFile = fs
        .readdirSync(ticketDir)
        .find(file => file.startsWith('linear_ticket_') && file.endsWith('.md'));
    if (!ticketFile)
        throw new Error(`No linear ticket file found in ${ticketDir}`);
    return path.join(ticketDir, ticketFile);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractFrontmatter(content) {
    const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
    if (openLen === 0)
        return null;
    const closeIdx = content.indexOf('\n---', openLen);
    if (closeIdx === -1)
        return null;
    const rawEnd = closeIdx + 4;
    const end = content[rawEnd] === '\n'
        ? rawEnd + 1
        : content[rawEnd] === '\r' && content[rawEnd + 1] === '\n'
            ? rawEnd + 2
            : rawEnd;
    return { body: content.slice(openLen, closeIdx), start: 0, end };
}
function setFrontmatterField(content, field, value) {
    const fm = extractFrontmatter(content);
    if (!fm)
        return content;
    const existingField = new RegExp(`^${escapeRegExp(field)}:\\s*.*$`, 'm');
    if (existingField.test(fm.body)) {
        return content.replace(existingField, `${field}: "${value}"`);
    }
    const closingNewline = content.lastIndexOf('\n---', fm.end - 1);
    if (closingNewline === -1)
        return content;
    const insertPoint = closingNewline + 1;
    return content.slice(0, insertPoint) + `${field}: "${value}"\n` + content.slice(insertPoint);
}
function statusTimestampField(status) {
    const normalized = String(status).toLowerCase();
    if (normalized === 'done')
        return 'completed_at';
    if (normalized === 'skipped')
        return 'skipped_at';
    return null;
}
function timestamp(ctx) {
    if (ctx?.now instanceof Date)
        return ctx.now.toISOString();
    if (typeof ctx?.now === 'string')
        return ctx.now;
    return new Date().toISOString();
}
function assertStatusWasUpdated(before, after, filePath) {
    if (before === after) {
        throw new Error(`Ticket status could not be updated in ${filePath}`);
    }
}
export function updateTicketStatusInTransaction(ticketId, newStatus, sessionDir, txCtx) {
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
function defaultTicketContent(spec) {
    const frontmatter = {
        id: spec.ticketId,
        status: 'Todo',
        ...spec.frontmatter,
    };
    const lines = Object.entries(frontmatter).map(([key, value]) => {
        if (typeof value === 'number' || typeof value === 'boolean')
            return `${key}: ${value}`;
        if (value === null)
            return `${key}: null`;
        return `${key}: "${value}"`;
    });
    return `---\n${lines.join('\n')}\n---\n\n${spec.body ?? ''}`;
}
export function materializeNewTicket(spec) {
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
            path: assertWithinRoot(file.path ?? path.join(root, file.name ?? `linear_ticket_${spec.ticketId}.md`), root),
            content: file.content,
        })),
    };
}
function resolveLedgerEntries(parsed) {
    if (Array.isArray(parsed))
        return parsed;
    return parsed.entries ?? parsed.actions ?? parsed.steps ?? [];
}
function resolveLedgerPath(sessionRoot, entryPath) {
    const targetPath = path.isAbsolute(entryPath) ? entryPath : path.join(sessionRoot, entryPath);
    return assertWithinRoot(targetPath, sessionRoot);
}
function restoreContent(entry) {
    if ('beforeContent' in entry)
        return entry.beforeContent;
    if ('previousContent' in entry)
        return entry.previousContent;
    if ('backupContent' in entry)
        return entry.backupContent;
    return undefined;
}
function removeEmptyParents(startDir, stopDir) {
    let current = startDir;
    while (isWithinRoot(current, stopDir) && path.resolve(current) !== path.resolve(stopDir)) {
        try {
            fs.rmdirSync(current);
        }
        catch {
            return;
        }
        current = path.dirname(current);
    }
}
export function replayReverseLedger(ledgerPath, sessionRoot) {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    const entries = resolveLedgerEntries(parsed);
    const restored = [];
    for (const entry of [...entries].reverse()) {
        const targetPath = resolveLedgerPath(sessionRoot, entry.path);
        const priorContent = restoreContent(entry);
        if (priorContent === undefined || priorContent === null) {
            if (fs.existsSync(targetPath))
                fs.rmSync(targetPath, { force: true });
            removeEmptyParents(path.dirname(targetPath), sessionRoot);
            continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, priorContent);
        restored.push({ path: targetPath, content: priorContent });
    }
    return restored;
}
