import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../git-utils.js';
import { slugify, uniqueSortedStrings } from './reporter.js';
const BACKTICK_SPAN_RE = /`([^`]+)`/g;
const CODE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
export function isCommentLine(line) {
    const trimmed = line.trim();
    return (trimmed.startsWith('//')
        || trimmed.startsWith('/*')
        || trimmed.startsWith('*')
        || trimmed.startsWith('*/'));
}
function looksLikeCode(identifier) {
    if (identifier.length < 4)
        return false;
    if (!CODE_IDENTIFIER_RE.test(identifier))
        return false;
    // Filter plain English words: require a code shape signal.
    return /[A-Z]/.test(identifier.slice(1)) || identifier.includes('_') || identifier.includes('.') || identifier.endsWith('()');
}
export function extractBacktickedIdentifiers(line) {
    const out = [];
    for (const match of line.matchAll(new RegExp(BACKTICK_SPAN_RE.source, BACKTICK_SPAN_RE.flags))) {
        const candidate = match[1].trim();
        if (looksLikeCode(candidate))
            out.push(candidate);
    }
    return out;
}
function commentIdentifiersInRanges(content, ranges) {
    const lines = content.split(/\r?\n/);
    const identifiers = [];
    for (const range of ranges) {
        for (let lineNo = range.start; lineNo <= range.end; lineNo++) {
            const line = lines[lineNo - 1];
            if (line === undefined || !isCommentLine(line))
                continue;
            identifiers.push(...extractBacktickedIdentifiers(line));
        }
    }
    return uniqueSortedStrings(identifiers);
}
export function findStaleReferences(items, isPresentAtHead) {
    const findings = [];
    for (const item of items) {
        for (const identifier of item.identifiers) {
            if (isPresentAtHead(identifier))
                continue;
            findings.push({
                id: `stale-reference:${slugify(item.file)}:${slugify(identifier)}`,
                severity: 'Low',
                file: item.file,
                message: `Backticked reference \`${identifier}\` in a changed comment is absent from HEAD (renamed or stale).`,
            });
        }
    }
    return findings;
}
export function auditStaleReferences(diff) {
    const items = [];
    for (const changed of diff.changedFiles) {
        if (changed.status === 'D' || changed.kind !== 'production')
            continue;
        let content;
        try {
            content = readFileSync(path.resolve(diff.repoRoot, changed.path), 'utf-8');
        }
        catch {
            continue;
        }
        const identifiers = commentIdentifiersInRanges(content, changed.changedLines);
        if (identifiers.length > 0)
            items.push({ file: changed.path, identifiers });
    }
    const presenceCache = new Map();
    const isPresentAtHead = (identifier) => {
        const cached = presenceCache.get(identifier);
        if (cached !== undefined)
            return cached;
        // Fail safe: never flag when the HEAD probe fails (default present=true).
        let present = true;
        try {
            const out = runGit(['grep', '-l', '-F', '--', identifier, diff.head], diff.repoRoot, false);
            present = out.trim().length > 0;
        }
        catch {
            // HEAD grep unavailable — leave present=true so we never emit a false stale finding.
        }
        presenceCache.set(identifier, present);
        return present;
    };
    return { findings: findStaleReferences(items, isPresentAtHead) };
}
