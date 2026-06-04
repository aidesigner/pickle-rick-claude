import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DiffSummary, ChangedFileSummary } from './diff-walker.js';
import { slugify } from './reporter.js';

export type DiffHygieneSeverity = 'Critical' | 'High' | 'Medium';
export type SzechuanDiffHygienePriority = 'P0' | 'P1' | 'P2';
export type DiffHygieneRule =
  | 'root-markdown-orphan'
  | 'root-scratch-artifact'
  | 'env-file'
  | 'large-unignored-file'
  | 'pii-in-fixture';

export const ROOT_MARKDOWN_ALLOWLIST = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'LICENSE.md',
  'README.md',
]);

export const LARGE_FILE_BYTES = 1024 * 1024;
export const ENV_FILE_ALLOWLIST = new Set(['.env.example']);
const GIT_CHECK_IGNORE_TIMEOUT_MS = 5_000;

/**
 * Enumerated identity/financial PII keys. Intentionally tight (no email/phone/name) so the rule
 * stays high-signal and silent on ordinary test fixtures. A fixture-file key from this set whose
 * value is non-placeholder is a committed-PII leak.
 */
export const PII_KEY_ALLOWLIST = new Set([
  'ssn',
  'social_security_number',
  'tax_id',
  'taxid',
  'ein',
  'credit_card',
  'card_number',
  'cvv',
  'account_number',
  'routing_number',
  'passport_number',
  'drivers_license',
  'driver_license',
  'date_of_birth',
  'dob',
]);

const PII_KEY_VALUE_RE = /['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*[:=]\s*['"]([^'"]+)['"]/g;
const PLACEHOLDER_WORD_RE = /placeholder|example|redact|sample|dummy|fake|test|xxxx|n\/?a|todo|change[_-]?me/i;
const PLACEHOLDER_FILLER_RE = /^[\sx0\-_.*]+$/i;
const PLACEHOLDER_FAKE_SSN = new Set(['000-00-0000', '123-45-6789', '111-11-1111']);

export interface DiffHygieneFinding {
  id: string;
  severity: DiffHygieneSeverity;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
}

export interface DiffHygieneReport {
  findings: DiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
    suppressed_by_szechuan: number;
  };
}

export interface SzechuanDiffHygieneFinding {
  id: string;
  priority: SzechuanDiffHygienePriority;
  severity: SzechuanDiffHygienePriority;
  message: string;
  rule: DiffHygieneRule;
  file: string;
  size_bytes?: number;
  category: 'hygiene';
  principle: 'Diff Hygiene';
}

export interface SzechuanDiffHygieneReport {
  findings: SzechuanDiffHygieneFinding[];
  summary: {
    added_files_scanned: number;
    findings: number;
  };
}

export interface SzechuanFindingLike {
  id?: unknown;
  category?: unknown;
  file?: unknown;
  path?: unknown;
  target?: unknown;
  evidence?: unknown;
  rule?: unknown;
}

export interface AuditDiffHygieneOptions {
  szechuanFindings?: SzechuanFindingLike[];
}

interface SuppressionIndex {
  ids: Set<string>;
  paths: Set<string>;
  pathRules: Set<string>;
}

export function auditDiffHygiene(
  diff: DiffSummary,
  options: AuditDiffHygieneOptions = {},
): DiffHygieneReport {
  const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
  const suppression = buildSuppressionIndex(options.szechuanFindings ?? []);
  const findings: DiffHygieneFinding[] = [];
  let suppressed = 0;

  for (const file of addedFiles) {
    for (const finding of findingsForAddedFile(diff.repoRoot, file)) {
      if (isSuppressed(finding, suppression)) {
        suppressed += 1;
      } else {
        findings.push(finding);
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return {
    findings,
    summary: {
      added_files_scanned: addedFiles.length,
      findings: findings.length,
      suppressed_by_szechuan: suppressed,
    },
  };
}

export function auditSzechuanDiffHygiene(diff: DiffSummary): SzechuanDiffHygieneReport {
  const addedFiles = diff.changedFiles.filter((file) => file.status === 'A');
  const findings = addedFiles.flatMap((file) => szechuanFindingsForAddedFile(diff.repoRoot, file));

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return {
    findings,
    summary: {
      added_files_scanned: addedFiles.length,
      findings: findings.length,
    },
  };
}

interface RuleMatch {
  file: string;
  rule: DiffHygieneRule;
  sizeBytes?: number;
}

function findingsForAddedFile(repoRoot: string, file: ChangedFileSummary): DiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file)
    .map((match) => makeFinding(match.file, match.rule, citadelSeverityForRule(match.rule), match.sizeBytes));
}

function szechuanFindingsForAddedFile(repoRoot: string, file: ChangedFileSummary): SzechuanDiffHygieneFinding[] {
  return ruleMatchesForAddedFile(repoRoot, file)
    .map((match) => makeSzechuanFinding(
      match.file,
      match.rule,
      szechuanPriorityForRule(match.rule),
      match.sizeBytes,
    ));
}

function ruleMatchesForAddedFile(repoRoot: string, file: ChangedFileSummary): RuleMatch[] {
  const normalized = toPosixPath(file.path);
  const basename = path.posix.basename(normalized);
  const matches: RuleMatch[] = [];

  if (isEnvFile(basename)) {
    matches.push({ file: file.path, rule: 'env-file' });
  }

  if (isTopLevel(normalized)) {
    if (isDisallowedRootMarkdown(basename)) {
      matches.push({ file: file.path, rule: 'root-markdown-orphan' });
    }
    if (isRootScratchArtifact(basename)) {
      matches.push({ file: file.path, rule: 'root-scratch-artifact' });
    }
  }

  const size = fileSize(repoRoot, file.path);
  if (size > LARGE_FILE_BYTES && !isGitIgnored(repoRoot, file.path)) {
    matches.push({ file: file.path, rule: 'large-unignored-file', sizeBytes: size });
  }

  if (isFixtureFile(normalized) && containsNonPlaceholderPii(repoRoot, file.path)) {
    matches.push({ file: file.path, rule: 'pii-in-fixture' });
  }

  return matches;
}

function isFixtureFile(filePath: string): boolean {
  return /(?:^|\/)(?:fixtures|__fixtures__)\//.test(filePath)
    || /\.fixture\.[cm]?[jt]sx?$/i.test(filePath);
}

function containsNonPlaceholderPii(repoRoot: string, filePath: string): boolean {
  // Isolated, intentionally UNGUARDED read: auditDiffHygiene runs UNWRAPPED by safeRunAnalyzer, and
  // the fail-open try/catch for this read lands in R-HRP-4 (50f75afa). Kept minimal so it can be
  // wrapped cleanly there.
  const content = readAddedFileText(repoRoot, filePath);
  for (const match of content.matchAll(new RegExp(PII_KEY_VALUE_RE.source, PII_KEY_VALUE_RE.flags))) {
    const key = match[1].toLowerCase();
    if (!PII_KEY_ALLOWLIST.has(key)) continue;
    if (!isPlaceholderValue(match[2])) return true;
  }
  return false;
}

function readAddedFileText(repoRoot: string, filePath: string): string {
  return readFileSync(path.join(repoRoot, filePath), 'utf-8');
}

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_FILLER_RE.test(trimmed)) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (trimmed.startsWith('{{') || trimmed.startsWith('${')) return true;
  if (PLACEHOLDER_WORD_RE.test(trimmed)) return true;
  if (PLACEHOLDER_FAKE_SSN.has(trimmed)) return true;
  return false;
}

function makeFinding(
  file: string,
  rule: DiffHygieneRule,
  severity: DiffHygieneSeverity,
  sizeBytes?: number,
): DiffHygieneFinding {
  return {
    id: `citadel-diff-hygiene-${slug(rule)}-${slug(file)}`,
    severity,
    message: messageForRule(rule, file, sizeBytes),
    rule,
    file,
    size_bytes: sizeBytes,
    category: 'hygiene',
  };
}

function makeSzechuanFinding(
  file: string,
  rule: DiffHygieneRule,
  priority: SzechuanDiffHygienePriority,
  sizeBytes?: number,
): SzechuanDiffHygieneFinding {
  return {
    id: `szechuan-diff-hygiene-${slug(rule)}-${slug(file)}`,
    priority,
    severity: priority,
    message: szechuanMessageForRule(rule, file, sizeBytes),
    rule,
    file,
    size_bytes: sizeBytes,
    category: 'hygiene',
    principle: 'Diff Hygiene',
  };
}

function messageForRule(rule: DiffHygieneRule, file: string, sizeBytes: number | undefined): string {
  switch (rule) {
    case 'root-markdown-orphan':
      return `Top-level markdown file ${file} is not in the documented root allowlist.`;
    case 'root-scratch-artifact':
      return `Top-level scratch artifact ${file} is not part of the documented change shape.`;
    case 'env-file':
      return `Environment file ${file} must not be committed unless it is .env.example.`;
    case 'large-unignored-file':
      return `Large added file ${file} is ${sizeBytes ?? 0} bytes and is not gitignored.`;
    case 'pii-in-fixture':
      return `Fixture ${file} contains a non-placeholder value for an enumerated PII key; replace it with a placeholder.`;
  }
}

function szechuanMessageForRule(rule: DiffHygieneRule, file: string, sizeBytes: number | undefined): string {
  switch (rule) {
    case 'root-markdown-orphan':
      return `orphan planning doc ${file} was added at repo root; move it to docs/ or prds/ or delete it.`;
    case 'root-scratch-artifact':
      return `Top-level scratch artifact ${file} was added; move it under an owned docs/prds path or delete it.`;
    case 'env-file':
      return `Secret leak risk: ${file} must not be committed unless it is .env.example.`;
    case 'large-unignored-file':
      return `Binary leak risk: ${file} is ${sizeBytes ?? 0} bytes and is not gitignored.`;
    case 'pii-in-fixture':
      return `PII leak risk: ${file} commits a non-placeholder value for an enumerated PII key.`;
  }
}

function citadelSeverityForRule(rule: DiffHygieneRule): DiffHygieneSeverity {
  switch (rule) {
    case 'env-file':
    case 'pii-in-fixture':
      return 'Critical';
    case 'large-unignored-file':
      return 'High';
    case 'root-markdown-orphan':
    case 'root-scratch-artifact':
      return 'Medium';
  }
}

function szechuanPriorityForRule(rule: DiffHygieneRule): SzechuanDiffHygienePriority {
  switch (rule) {
    case 'env-file':
    case 'pii-in-fixture':
      return 'P0';
    case 'root-markdown-orphan':
    case 'root-scratch-artifact':
      return 'P1';
    case 'large-unignored-file':
      return 'P2';
  }
}

function isTopLevel(filePath: string): boolean {
  return !filePath.includes('/');
}

function isDisallowedRootMarkdown(basename: string): boolean {
  return basename.endsWith('.md') && !ROOT_MARKDOWN_ALLOWLIST.has(basename);
}

function isRootScratchArtifact(basename: string): boolean {
  return /\.(?:txt|log|tmp)$/i.test(basename)
    || basename.startsWith('scratch')
    || basename.startsWith('notes')
    || basename.startsWith('WIP')
    || basename.startsWith('tmp');
}

function isEnvFile(basename: string): boolean {
  return basename.startsWith('.env') && !ENV_FILE_ALLOWLIST.has(basename);
}

function fileSize(repoRoot: string, filePath: string): number {
  const fullPath = path.join(repoRoot, filePath);
  try {
    return statSync(fullPath).size;
  } catch {
    return 0;
  }
}

function isGitIgnored(repoRoot: string, filePath: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', filePath], {
    cwd: repoRoot,
    stdio: 'ignore',
    timeout: GIT_CHECK_IGNORE_TIMEOUT_MS,
  });
  return result.status === 0;
}

function buildSuppressionIndex(findings: SzechuanFindingLike[]): SuppressionIndex {
  const index: SuppressionIndex = {
    ids: new Set(),
    paths: new Set(),
    pathRules: new Set(),
  };

  for (const finding of findings) {
    const id = typeof finding.id === 'string' ? finding.id : undefined;
    if (id) index.ids.add(id);

    if (finding.category !== 'hygiene') continue;
    const filePath = extractFindingPath(finding);
    if (!filePath) continue;
    index.paths.add(filePath);

    if (typeof finding.rule === 'string') {
      index.pathRules.add(`${filePath}:${finding.rule}`);
    }
  }

  return index;
}

function isSuppressed(finding: DiffHygieneFinding, suppression: SuppressionIndex): boolean {
  return suppression.ids.has(finding.id)
    || suppression.pathRules.has(`${toPosixPath(finding.file)}:${finding.rule}`)
    || suppression.paths.has(toPosixPath(finding.file));
}

function extractFindingPath(finding: SzechuanFindingLike): string | undefined {
  for (const value of [finding.file, finding.path, finding.target]) {
    if (typeof value === 'string' && value.trim()) return toPosixPath(value.trim());
  }
  if (typeof finding.evidence === 'string') {
    const match = finding.evidence.match(/^([^:\n]+):\d+(?::\d+)?$/);
    if (match) return toPosixPath(match[1]);
  }
  return undefined;
}

function slug(value: string): string {
  return slugify(value, 'root');
}

function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
