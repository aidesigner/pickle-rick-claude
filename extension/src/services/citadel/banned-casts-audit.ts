import { CitadelFinding, CitadelSeverity, slugify } from './reporter.js';
import { DiffSummary } from './diff-walker.js';
import {
  ChangedSource,
  collectChangedCodeLines,
  isCommentLine,
  stripStringLiterals,
} from './banned-constructs-audit.js';

export interface BannedCastsResult {
  findings: CitadelFinding[];
}

const AS_ERROR_ACCESS_RE = /\(\s*[\w$.[\]]+\s+as\s+Error\s*\)\s*\./;
const AS_ANY_RE = /\bas\s+any\b/;
const AS_NEVER_RE = /\bas\s+never\b/;

const CAST_SEVERITY: CitadelSeverity = 'Medium';

export function hasAsErrorCast(line: string): boolean {
  return AS_ERROR_ACCESS_RE.test(stripStringLiterals(line));
}

export function hasAsAnyCast(line: string): boolean {
  return AS_ANY_RE.test(stripStringLiterals(line));
}

export function hasAsNeverCast(line: string): boolean {
  return AS_NEVER_RE.test(stripStringLiterals(line));
}

export function findBannedCasts(sources: ChangedSource[]): CitadelFinding[] {
  const findings: CitadelFinding[] = [];
  for (const source of sources) {
    for (const { no, text } of source.lines) {
      if (isCommentLine(text)) continue;
      if (hasAsErrorCast(text)) {
        findings.push({
          id: `banned-cast:as-error:${slugify(source.file)}:${no}`,
          severity: CAST_SEVERITY,
          file: source.file,
          line: no,
          message:
            `Unsafe \`(x as Error).\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
            + 'use `const msg = err instanceof Error ? err.message : String(err);`.',
        });
      }
      if (hasAsAnyCast(text)) {
        findings.push({
          id: `banned-cast:as-any:${slugify(source.file)}:${no}`,
          severity: CAST_SEVERITY,
          file: source.file,
          line: no,
          message:
            `\`as any\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
            + 'replace it with the project type or `unknown` plus a narrowing guard.',
        });
      }
      if (hasAsNeverCast(text)) {
        findings.push({
          id: `banned-cast:as-never:${slugify(source.file)}:${no}`,
          severity: CAST_SEVERITY,
          file: source.file,
          line: no,
          message:
            `\`as never\` cast at ${source.file}:${no} is banned; `
            + 'use a proper type guard or narrow the union explicitly instead of casting through `never`.',
        });
      }
    }
  }
  return findings;
}

export function auditBannedCasts(diff: DiffSummary): BannedCastsResult {
  return { findings: findBannedCasts(collectChangedCodeLines(diff)) };
}
