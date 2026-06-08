import { readFileSync } from 'node:fs';
import * as path from 'node:path';
// Identity comparison with object/array literal: e.g. `x === {}` always false
const SEMANTIC_IDENTITY_RE = /===\s*[[{]|[[{]\s*===/;
// Optional chain without null coalescing fallback on the same line
const OPTIONAL_CHAIN_RE = /\?\.\w/;
const NULL_COALESCE_RE = /\?\?/;
// Resource construction without visible lifecycle close/destroy
const RESOURCE_CTOR_RE = /\bnew\s+\w*(?:ReadStream|WriteStream|Client|Connection|Socket|Handle)\b/;
// Dead guard: if (false) / if (true)
const DEAD_GUARD_RE = /\bif\s*\(\s*(?:false|true)\s*\)/;
// No-op assignment: x = x;
const NOOP_ASSIGN_RE = /\b(\w+)\s*=\s*\1\s*[;,]/;
// Function declaration for cross-file repetition check (name must be 5+ chars to avoid noise)
const FN_DECL_RE = /\bfunction\s+(\w{5,})\s*\(/;
// Table-driven per-line detectors: collapses the 4 sequential defect checks into one loop.
const LINE_DETECTORS = [
    {
        defect: 'semantic-identity',
        why: 'Identity comparison with object/array literal always evaluates to false',
        match: (line) => SEMANTIC_IDENTITY_RE.test(line),
    },
    {
        defect: 'fallback-null-flow',
        why: 'Optional chaining result consumed without null coalescing fallback',
        match: (line) => OPTIONAL_CHAIN_RE.test(line) && !NULL_COALESCE_RE.test(line),
    },
    {
        defect: 'resource-lifecycle',
        why: 'Resource construction without visible close/destroy in changed context',
        match: (line) => RESOURCE_CTOR_RE.test(line),
    },
    {
        defect: 'dead-guard-no-op-flag-behavior-parity',
        why: 'Dead guard condition or no-op assignment detected',
        match: (line) => DEAD_GUARD_RE.test(line) || NOOP_ASSIGN_RE.test(line),
    },
];
function detectLineDefects(line, file, ln) {
    const out = [];
    for (const detector of LINE_DETECTORS) {
        if (detector.match(line)) {
            out.push({ defect: detector.defect, file, line: ln, why: detector.why, shape: line.trim() });
        }
    }
    return out;
}
function readLines(repoRoot, filePath) {
    try {
        return readFileSync(path.join(repoRoot, filePath), 'utf-8').split('\n');
    }
    catch {
        return null;
    }
}
export function runSkepticLens(changedFiles, repoRoot) {
    const findings = [];
    const fnsByName = new Map();
    for (const file of changedFiles) {
        const lines = readLines(repoRoot, file.path);
        if (!lines)
            continue;
        for (const range of file.changedLines) {
            for (let ln = range.start; ln <= range.end; ln++) {
                const line = lines[ln - 1] ?? '';
                findings.push(...detectLineDefects(line, file.path, ln));
                const fnMatch = FN_DECL_RE.exec(line);
                if (fnMatch) {
                    const name = fnMatch[1];
                    const files = fnsByName.get(name) ?? [];
                    if (!files.includes(file.path)) {
                        files.push(file.path);
                        fnsByName.set(name, files);
                    }
                }
            }
        }
    }
    for (const [name, files] of fnsByName) {
        if (files.length >= 2) {
            findings.push({
                defect: 'cross-file-repetition-exhaustiveness',
                file: files[0],
                why: `Function '${name}' defined in ${files.length} changed files — potential duplication or missing exhaustiveness`,
                shape: `function ${name}(`,
            });
        }
    }
    return { findings };
}
