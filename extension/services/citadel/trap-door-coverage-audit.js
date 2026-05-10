import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
export const ENFORCE_REF_RE = /(?<=ENFORCE:\s*)((?:[`]?[\w./*-]+\.(?:test\.js|sh)[`]?(?:#[\w_-]+)?(?:,\s*)?)+)/g;
export function auditTrapDoorCoverage(diff) {
    return runT6TrapDoorCoverage({ projectRoot: diff.repoRoot });
}
export function runT6TrapDoorCoverage(context) {
    const { projectRoot } = context;
    const findings = [];
    const claudeFiles = collectClaudeMdFiles(projectRoot);
    const referencedFiles = new Set();
    for (const claudeFile of claudeFiles) {
        let content;
        try {
            content = readFileSync(claudeFile, 'utf-8');
        }
        catch {
            continue;
        }
        const section = extractTrapDoorsSection(content);
        if (!section)
            continue;
        const relClaude = path.relative(projectRoot, claudeFile);
        let barePathWarned = false;
        for (const match of section.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
            const refs = parseEnforceRefs(match[1]);
            for (const { filePath, anchor } of refs) {
                referencedFiles.add(filePath);
                if (!anchor && !barePathWarned) {
                    findings.push({
                        id: `trap-door-bare-path:${relClaude}`,
                        severity: 'Low',
                        message: `ENFORCE ref without #anchor in ${relClaude}; adding #test-case-name improves precision.`,
                        file: relClaude,
                    });
                    barePathWarned = true;
                }
                const absPath = path.resolve(projectRoot, filePath);
                if (!existsSync(absPath)) {
                    findings.push({
                        id: `orphan-enforce:${filePath}`,
                        severity: 'High',
                        message: `ENFORCE ref points to nonexistent file: ${filePath} (in ${relClaude})`,
                        file: relClaude,
                    });
                    continue;
                }
                if (anchor) {
                    const testContent = readFileSync(absPath, 'utf-8');
                    if (!hasTestCase(testContent, anchor)) {
                        findings.push({
                            id: `orphan-test-case:${filePath}#${anchor}`,
                            severity: 'High',
                            message: `ENFORCE anchor #${anchor} not found in ${filePath}`,
                            file: filePath,
                        });
                    }
                }
            }
        }
    }
    for (const absTestFile of collectTestFiles(projectRoot)) {
        const relPath = path.relative(projectRoot, absTestFile);
        if (!referencedFiles.has(relPath)) {
            findings.push({
                id: `orphan-test-file:${relPath}`,
                severity: 'Medium',
                message: `Test file has no inbound ENFORCE ref: ${relPath}`,
                file: relPath,
            });
        }
    }
    return { findings };
}
function collectClaudeMdFiles(projectRoot) {
    const files = [];
    const primary = path.join(projectRoot, 'extension', 'CLAUDE.md');
    if (existsSync(primary))
        files.push(primary);
    const srcDir = path.join(projectRoot, 'extension', 'src');
    if (existsSync(srcDir))
        files.push(...walkForClaudeMd(srcDir));
    return files;
}
function walkForClaudeMd(dir) {
    const results = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkForClaudeMd(fullPath));
            }
            else if (entry.name === 'CLAUDE.md') {
                results.push(fullPath);
            }
        }
    }
    catch {
        // non-fatal: subsystem CLAUDE.md may be missing (Open Finding #5)
    }
    return results;
}
function extractTrapDoorsSection(content) {
    const start = content.search(/^##\s+Trap Doors\s*$/m);
    if (start === -1)
        return '';
    const afterHeading = content.indexOf('\n', start) + 1;
    const rest = content.slice(afterHeading);
    const nextHeading = rest.search(/^##\s+/m);
    return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}
function parseEnforceRefs(raw) {
    return raw.split(/,\s*/).flatMap((part) => {
        const cleaned = part.trim().replace(/^`|`$/g, '');
        if (!cleaned)
            return [];
        const hashIdx = cleaned.indexOf('#');
        if (hashIdx === -1)
            return [{ filePath: cleaned }];
        return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
    });
}
function hasTestCase(content, anchor) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:it|test)\\s*\\(\\s*['"\`]${escaped}['"\`]`).test(content);
}
function collectTestFiles(projectRoot) {
    const testsDir = path.join(projectRoot, 'extension', 'tests');
    return existsSync(testsDir) ? walkForTestFiles(testsDir) : [];
}
function walkForTestFiles(dir) {
    const results = [];
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...walkForTestFiles(fullPath));
            }
            else if (entry.name.endsWith('.test.js')) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // non-fatal
    }
    return results;
}
