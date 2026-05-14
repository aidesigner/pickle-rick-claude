import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding } from './reporter.js';
import { DiffSummary } from './diff-walker.js';
import { extractTrapDoorsSection } from './trap-doors-section.js';

export interface CitadelContext {
  projectRoot: string;
  claudeFiles?: string[];
  testFiles?: string[];
}

export interface AnalyzerResult {
  findings: CitadelFinding[];
}

export interface TrapDoorCoverageResult {
  findings: CitadelFinding[];
}

export const ENFORCE_REF_RE =
  /(?<=ENFORCE:\s*)((?:[`]?[\w./*-]+\.(?:test\.js|sh)[`]?(?:#[\w_-]+)?(?:,\s*)?)+)/g;

export function auditTrapDoorCoverage(diff: DiffSummary): TrapDoorCoverageResult {
  return runT6TrapDoorCoverage({
    projectRoot: diff.repoRoot,
    claudeFiles: diff.claudeFiles,
    testFiles: diff.changedFiles
      .filter((file) => file.kind === 'test')
      .map((file) => file.path),
  });
}

export function runT6TrapDoorCoverage(context: CitadelContext): AnalyzerResult {
  const { projectRoot } = context;
  const findings: CitadelFinding[] = [];
  const allClaudeFiles = collectClaudeMdFiles(projectRoot);
  const scopedClaudeFiles = new Set((context.claudeFiles ?? []).map(normalizeRelativePath));
  const scopedTestFiles = new Set((context.testFiles ?? []).map(normalizeRelativePath));
  const hasScope = scopedClaudeFiles.size > 0 || scopedTestFiles.size > 0;
  const referencedFiles = new Set<string>();

  for (const claudeFile of allClaudeFiles) {
    let content: string;
    try {
      content = readFileSync(claudeFile, 'utf-8');
    } catch {
      continue;
    }

    const section = extractTrapDoorsSection(content);
    if (!section) continue;

    const relClaude = normalizeRelativePath(path.relative(projectRoot, claudeFile));
    const claudeInScope = !hasScope || scopedClaudeFiles.has(relClaude);
    let barePathWarned = false;

    for (const match of section.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
      const refs = parseEnforceRefs(match[1]);

      for (const { filePath, anchor } of refs) {
        const normalizedFilePath = normalizeRelativePath(filePath);
        referencedFiles.add(normalizedFilePath);
        const refInScope = !hasScope || claudeInScope || scopedTestFiles.has(normalizedFilePath);

        if (!anchor && !barePathWarned && claudeInScope) {
          findings.push({
            id: `trap-door-bare-path:${relClaude}`,
            severity: 'Low',
            message: `ENFORCE ref without #anchor in ${relClaude}; adding #test-case-name improves precision.`,
            file: relClaude,
          });
          barePathWarned = true;
        }

        const absPath = path.resolve(projectRoot, normalizedFilePath);
        if (!existsSync(absPath)) {
          if (refInScope) {
            findings.push({
              id: `orphan-enforce:${normalizedFilePath}`,
              severity: 'High',
              message: `ENFORCE ref points to nonexistent file: ${normalizedFilePath} (in ${relClaude})`,
              file: relClaude,
            });
          }
          continue;
        }

        if (anchor) {
          const testContent = readFileSync(absPath, 'utf-8');
          if (refInScope && !hasTestCase(testContent, anchor)) {
            findings.push({
              id: `orphan-test-case:${normalizedFilePath}#${anchor}`,
              severity: 'High',
              message: `ENFORCE anchor #${anchor} not found in ${normalizedFilePath}`,
              file: normalizedFilePath,
            });
          }
        }
      }
    }
  }

  const scopedTestCandidates = hasScope
    ? [...scopedTestFiles].map((filePath) => path.resolve(projectRoot, filePath))
    : collectTestFiles(projectRoot);

  for (const absTestFile of scopedTestCandidates) {
    const relPath = normalizeRelativePath(path.relative(projectRoot, absTestFile));
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

function collectClaudeMdFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const primary = path.join(projectRoot, 'extension', 'CLAUDE.md');
  if (existsSync(primary)) files.push(primary);
  const srcDir = path.join(projectRoot, 'extension', 'src');
  if (existsSync(srcDir)) files.push(...walkForClaudeMd(srcDir));
  return files;
}

function walkForClaudeMd(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkForClaudeMd(fullPath));
      } else if (entry.name === 'CLAUDE.md') {
        results.push(fullPath);
      }
    }
  } catch {
    // non-fatal: subsystem CLAUDE.md may be missing (Open Finding #5)
  }
  return results;
}

function parseEnforceRefs(raw: string): Array<{ filePath: string; anchor?: string }> {
  return raw.split(/,\s*/).flatMap((part) => {
    const cleaned = part.trim().replace(/^`|`$/g, '');
    if (!cleaned) return [];
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx === -1) return [{ filePath: cleaned }];
    return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
  });
}

function hasTestCase(content: string, anchor: string): boolean {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:it|test)\\s*\\(\\s*['"\`]${escaped}['"\`]`).test(content);
}

function collectTestFiles(projectRoot: string): string[] {
  const testsDir = path.join(projectRoot, 'extension', 'tests');
  return existsSync(testsDir) ? walkForTestFiles(testsDir) : [];
}

function walkForTestFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkForTestFiles(fullPath));
      } else if (entry.name.endsWith('.test.js')) {
        results.push(fullPath);
      }
    }
  } catch {
    // non-fatal
  }
  return results;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
