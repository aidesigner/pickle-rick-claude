import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { slugify, uniqueSortedStrings } from './reporter.js';
const PG_ENUM_RE = /pgEnum\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\[([^\]]*)\]/g;
const CHECK_IN_RE = /check\(\s*['"]([A-Za-z0-9_]+)['"][\s\S]*?\bin\s*\(([^)]*)\)/g;
const MIRROR_ANNOTATION_RE = /registry-mirror:\s*([A-Za-z0-9_]+)/;
const STRING_LITERAL_RE = /['"]([^'"]+)['"]/g;
function stringLiterals(blob) {
    const out = [];
    for (const match of blob.matchAll(STRING_LITERAL_RE)) {
        if (match[1].length > 0)
            out.push(match[1]);
    }
    return uniqueSortedStrings(out);
}
function extractEnumDeclarations(content) {
    const declarations = [];
    for (const match of content.matchAll(new RegExp(PG_ENUM_RE.source, PG_ENUM_RE.flags))) {
        declarations.push({ name: match[1], members: stringLiterals(match[2]) });
    }
    for (const match of content.matchAll(new RegExp(CHECK_IN_RE.source, CHECK_IN_RE.flags))) {
        declarations.push({ name: match[1], members: stringLiterals(match[2]) });
    }
    return declarations;
}
function extractRegistryMirrors(content) {
    const lines = content.split(/\r?\n/);
    const mirrors = [];
    for (let i = 0; i < lines.length; i++) {
        const annotation = MIRROR_ANNOTATION_RE.exec(lines[i]);
        if (!annotation)
            continue;
        // The annotation sits on the same line as the const, or the line directly above it.
        const declarationLine = /=\s*\[/.test(lines[i]) ? i : i + 1;
        const blob = collectArrayLiteral(lines, declarationLine);
        if (blob === null)
            continue;
        mirrors.push({ enumName: annotation[1], members: stringLiterals(blob) });
    }
    return mirrors;
}
function collectArrayLiteral(lines, start) {
    if (start >= lines.length || !/=\s*\[/.test(lines[start]))
        return null;
    let blob = '';
    for (let i = start; i < lines.length && i < start + 200; i++) {
        blob += `${lines[i]}\n`;
        if (lines[i].includes(']'))
            return blob;
    }
    return blob;
}
function symmetricDifference(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    return {
        missing: a.filter((m) => !setB.has(m)),
        extra: b.filter((m) => !setA.has(m)),
    };
}
export function findSchemaRegistryDrift(files) {
    const findings = [];
    for (const file of files) {
        const enums = extractEnumDeclarations(file.content);
        if (enums.length === 0)
            continue;
        const mirrorsByName = new Map();
        for (const mirror of extractRegistryMirrors(file.content)) {
            mirrorsByName.set(mirror.enumName, mirror);
        }
        for (const decl of enums) {
            const mirror = mirrorsByName.get(decl.name);
            if (!mirror)
                continue;
            const { missing, extra } = symmetricDifference(decl.members, mirror.members);
            if (missing.length === 0 && extra.length === 0)
                continue;
            findings.push({
                id: `schema-registry-drift:${slugify(file.path)}:${slugify(decl.name)}`,
                severity: 'Medium',
                file: file.path,
                message: `Schema/registry drift for '${decl.name}': mirror missing [${missing.join(', ')}], `
                    + `mirror has extra [${extra.join(', ')}].`,
            });
        }
    }
    return findings;
}
export function auditSchemaRegistryDrift(diff) {
    const files = [];
    for (const changed of diff.changedFiles) {
        if (changed.status === 'D' || !changed.path.endsWith('.ts'))
            continue;
        try {
            files.push({
                path: changed.path,
                content: readFileSync(path.resolve(diff.repoRoot, changed.path), 'utf-8'),
            });
        }
        catch {
            // unreadable working-tree file: skip defensively
        }
    }
    return { findings: findSchemaRegistryDrift(files) };
}
