import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../git-utils.js';
import { CitadelFinding, slugify, uniqueSortedStrings } from './reporter.js';
import { ChangedLineRange, DiffSummary } from './diff-walker.js';

export interface StaleReferenceResult {
  findings: CitadelFinding[];
}

export interface ChangedComments {
  file: string;
  identifiers: string[];
}

const BACKTICK_SPAN_RE = /`([^`]+)`/g;
const CODE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

export function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('*/')
  );
}

function looksLikeCode(identifier: string): boolean {
  if (identifier.length < 4) return false;
  if (!CODE_IDENTIFIER_RE.test(identifier)) return false;
  // Filter plain English words: require a code shape signal.
  return /[A-Z]/.test(identifier.slice(1)) || identifier.includes('_') || identifier.includes('.') || identifier.endsWith('()');
}

export function extractBacktickedIdentifiers(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(new RegExp(BACKTICK_SPAN_RE.source, BACKTICK_SPAN_RE.flags))) {
    const candidate = match[1].trim();
    if (looksLikeCode(candidate)) out.push(candidate);
  }
  return out;
}

function commentIdentifiersInRanges(content: string, ranges: ChangedLineRange[]): string[] {
  const lines = content.split(/\r?\n/);
  const identifiers: string[] = [];
  for (const range of ranges) {
    for (let lineNo = range.start; lineNo <= range.end; lineNo++) {
      const line = lines[lineNo - 1];
      if (line === undefined || !isCommentLine(line)) continue;
      identifiers.push(...extractBacktickedIdentifiers(line));
    }
  }
  return uniqueSortedStrings(identifiers);
}

export function findStaleReferences(
  items: ChangedComments[],
  isPresentAtHead: (identifier: string) => boolean,
): CitadelFinding[] {
  const findings: CitadelFinding[] = [];
  for (const item of items) {
    for (const identifier of item.identifiers) {
      if (isPresentAtHead(identifier)) continue;
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

export function auditStaleReferences(diff: DiffSummary): StaleReferenceResult {
  const items: ChangedComments[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === 'D' || changed.kind !== 'production') continue;
    let content: string;
    try {
      content = readFileSync(path.resolve(diff.repoRoot, changed.path), 'utf-8');
    } catch {
      continue;
    }
    const identifiers = commentIdentifiersInRanges(content, changed.changedLines);
    if (identifiers.length > 0) items.push({ file: changed.path, identifiers });
  }

  const presenceCache = new Map<string, boolean>();
  const isPresentAtHead = (identifier: string): boolean => {
    const cached = presenceCache.get(identifier);
    if (cached !== undefined) return cached;
    // Fail safe: never flag when the HEAD probe fails (default present=true).
    let present = true;
    try {
      const out = runGit(['grep', '-l', '-F', '--', identifier, diff.head], diff.repoRoot, false);
      present = out.trim().length > 0;
    } catch {
      // HEAD grep unavailable — leave present=true so we never emit a false stale finding.
    }
    presenceCache.set(identifier, present);
    return present;
  };

  return { findings: findStaleReferences(items, isPresentAtHead) };
}
