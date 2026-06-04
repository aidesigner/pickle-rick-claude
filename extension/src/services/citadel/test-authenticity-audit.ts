import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CitadelFinding, slugify } from './reporter.js';
import { DiffSummary } from './diff-walker.js';

export interface TestAuthenticityResult {
  findings: CitadelFinding[];
}

const VACUOUS_TYPE_PRESENCE_RE =
  /Object\.keys\([^()]*\)\s*\.\s*toContain\(\s*['"]([A-Z][A-Za-z0-9_]*)['"]\s*\)/g;
const LOCAL_FN_CLASS_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm;
const NAMED_IMPORT_RE = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

export function findVacuousTypePresence(content: string, file: string): CitadelFinding[] {
  const findings: CitadelFinding[] = [];
  for (const match of content.matchAll(new RegExp(VACUOUS_TYPE_PRESENCE_RE.source, VACUOUS_TYPE_PRESENCE_RE.flags))) {
    const typeName = match[1];
    findings.push({
      id: `test-vacuous-type-presence:${slugify(file)}:${slugify(typeName)}`,
      severity: 'Low',
      file,
      message: `Vacuous assertion Object.keys(...).toContain('${typeName}') asserts a type name, not behavior.`,
    });
  }
  return findings;
}

export function collectLocalDeclarations(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(new RegExp(LOCAL_FN_CLASS_RE.source, LOCAL_FN_CLASS_RE.flags))) {
    names.add(match[1]);
  }
  return names;
}

export interface ParsedImports {
  names: Set<string>;
  modules: string[];
}

export function collectImports(content: string): ParsedImports {
  const names = new Set<string>();
  const modules: string[] = [];
  for (const match of content.matchAll(new RegExp(NAMED_IMPORT_RE.source, NAMED_IMPORT_RE.flags))) {
    modules.push(match[2]);
    for (const raw of match[1].split(',')) {
      const ident = raw.trim().split(/\s+as\s+/)[0].trim();
      if (ident) names.add(ident);
    }
  }
  return { names, modules };
}

export function findInlineCopies(
  specContent: string,
  specFile: string,
  siblingExports: Map<string, Set<string>>,
): CitadelFinding[] {
  const findings: CitadelFinding[] = [];
  const declared = collectLocalDeclarations(specContent);
  const { names: imported } = collectImports(specContent);
  const seen = new Set<string>();
  for (const [, exports] of siblingExports) {
    for (const name of declared) {
      if (seen.has(name) || imported.has(name) || !exports.has(name)) continue;
      seen.add(name);
      findings.push({
        id: `test-inline-copy:${slugify(specFile)}:${slugify(name)}`,
        severity: 'Medium',
        file: specFile,
        message:
          `Test declares '${name}', a sibling export it imports the module for but never imports — `
          + 'likely an inline copy instead of testing the real symbol.',
      });
    }
  }
  return findings;
}

const EXPORT_NAME_RE =
  /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function readSiblingExports(specAbsPath: string, moduleSpecifier: string): Set<string> | null {
  if (!moduleSpecifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(specAbsPath), moduleSpecifier);
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (!candidate.endsWith('.ts') || !existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, 'utf-8');
      const names = new Set<string>();
      for (const match of content.matchAll(new RegExp(EXPORT_NAME_RE.source, EXPORT_NAME_RE.flags))) {
        names.add(match[1]);
      }
      return names;
    } catch {
      return null;
    }
  }
  return null;
}

export function auditTestAuthenticity(diff: DiffSummary): TestAuthenticityResult {
  const findings: CitadelFinding[] = [];
  for (const changed of diff.changedFiles) {
    if (changed.status === 'D' || changed.kind !== 'test') continue;
    const specAbsPath = path.resolve(diff.repoRoot, changed.path);
    let content: string;
    try {
      content = readFileSync(specAbsPath, 'utf-8');
    } catch {
      continue;
    }
    findings.push(...findVacuousTypePresence(content, changed.path));
    const siblingExports = new Map<string, Set<string>>();
    for (const moduleSpecifier of collectImports(content).modules) {
      const exports = readSiblingExports(specAbsPath, moduleSpecifier);
      if (exports && exports.size > 0) siblingExports.set(moduleSpecifier, exports);
    }
    findings.push(...findInlineCopies(content, changed.path, siblingExports));
  }
  return { findings };
}
