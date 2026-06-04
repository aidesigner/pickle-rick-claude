import { slugify } from './reporter.js';
import { collectChangedCodeLines, isCommentLine, stripStringLiterals, } from './banned-constructs-audit.js';
const AS_ERROR_ACCESS_RE = /\(\s*[\w$.[\]]+\s+as\s+Error\s*\)\s*\./;
const AS_ANY_RE = /\bas\s+any\b/;
export function hasAsErrorCast(line) {
    return AS_ERROR_ACCESS_RE.test(stripStringLiterals(line));
}
export function hasAsAnyCast(line) {
    return AS_ANY_RE.test(stripStringLiterals(line));
}
export function findBannedCasts(sources) {
    const findings = [];
    for (const source of sources) {
        for (const { no, text } of source.lines) {
            if (isCommentLine(text))
                continue;
            if (hasAsErrorCast(text)) {
                findings.push({
                    id: `banned-cast:as-error:${slugify(source.file)}:${no}`,
                    severity: 'Medium',
                    file: source.file,
                    line: no,
                    message: `Unsafe \`(x as Error).\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
                        + 'use `const msg = err instanceof Error ? err.message : String(err);`.',
                });
            }
            if (hasAsAnyCast(text)) {
                findings.push({
                    id: `banned-cast:as-any:${slugify(source.file)}:${no}`,
                    severity: 'Medium',
                    file: source.file,
                    line: no,
                    message: `\`as any\` cast at ${source.file}:${no} is banned by CLAUDE.md; `
                        + 'replace it with the project type or `unknown` plus a narrowing guard.',
                });
            }
        }
    }
    return findings;
}
export function auditBannedCasts(diff) {
    return { findings: findBannedCasts(collectChangedCodeLines(diff)) };
}
