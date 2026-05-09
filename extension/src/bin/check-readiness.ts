#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { logActivity } from '../services/activity-logger.js';
import { listLinearTicketFiles } from '../services/artifact-validation.js';
import { computeOneHop } from '../services/scope-resolver.js';
import { isRecord } from '../lib/is-record.js';
import { formatLocalDateKey, safeErrorMessage, writeStateFile } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
import { readRecoverableJsonObject } from '../services/recoverable-json.js';
import type { ReadinessCycleHistoryEntry } from '../types/index.js';

export interface ReadinessArgs {
  sessionDir: string;
  repoRoot: string;
  manifest?: string;
  machinabilityOnly: boolean;
  contractOnly: boolean;
  history: boolean;
  last: number;
  maxWallMs: number;
  /**
   * BMAD residual P0.6: when set, the gate is bypassed entirely; the reason is
   * recorded as a `readiness_skipped` activity event for audit. The flag is
   * only forwarded by `mux-runner` when `state.flags.skip_readiness_reason` is
   * configured for the session — there is no implicit default.
   */
  skipReadiness?: string;
}

export interface ReadinessFinding {
  ticket: string;
  kind: 'prd_map' | 'machinability' | 'file_path' | 'contract' | 'dependency' | 'performance' | 'annotation_format';
  message: string;
  analyst: 'gaps' | 'codebase' | 'risk';
  detail: string;
}

interface TicketInfo {
  file: string;
  id: string;
  key?: string;
  workingDir?: string;
  sourcePrd?: string;
  sourceSection?: string;
  mappedRequirements: string[];
  acIds: string[];
  dependencies: Array<{ ref: string; external: boolean }>;
}

interface ManifestTicket {
  id?: unknown;
  key?: unknown;
  ac_ids?: unknown;
  requirements?: unknown;
  source_prd?: unknown;
  source_section?: unknown;
  mapped_requirements?: unknown;
}

interface SourceRequirement {
  sourcePrd: string;
  sourceSection: string;
  requirementId: string;
}

interface TicketSnapshot {
  ticketsVersion?: number;
  hashes: Record<string, string>;
}

interface ReadinessStateShape {
  readiness?: {
    cycle_history?: unknown[];
  };
  tickets_version?: unknown;
  activity?: Array<{ event?: unknown }>;
}

const SNAPSHOT_FILE = 'readiness_snapshot.json';
const READINESS_MAX_RECYCLE_CYCLES = 3;
const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_MAX_WALL_MS = 60_000;
const FIND_IMPORTERS_TIMEOUT_MS = 3_000;
const MACHINE_HINT_RE = /\b(\d+(?:\.\d+)?%?|exit\s+\d+|<\s*\d+|>\s*\d+|<=\s*\d+|>=\s*\d+|under\s+\d+|within\s+\d+|exact(?:ly)?|regex|matches?|JSON|field|file exists|writes?|emits?|test|describe\.each|node --test|npm test|tsc|eslint|table|input\/output)\b/i;
const PURE_PROSE_RE = /\b(must|should)\s+(?:be|feel)\s+(?:intuitive|performant|fast|easy|simple|clear|usable|nice|good|robust|reliable)\b/i;
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sh|py|css|scss|html)\b/g;
const SYMBOL_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z_$][\w$]*\(\)/g;
// R-RTRC-7 forward-reference annotation: backticked token followed by exactly
// one ASCII space and a `(created|introduced) by ticket <hash>` parenthetical.
// Hash format = 8-char short SHA OR ticket-dir basename — both 8-char alphanumeric.
// Resolver matches 6-12 alphanumeric to give some flexibility while remaining strict.
const FORWARD_REF_ANNOTATION_HASH_RE = /^[A-Za-z0-9]{6,12}$/;
const FORWARD_REF_ANNOTATION_RE = /`([^`]+)`(\s*)\((created|introduced) by ticket ([^)]+)\)/g;
const ALLOWLIST_FILE_REL = 'extension/.readiness-allowlist.json';
const GIT_LS_FILES_TIMEOUT_MS = 30_000;
const DOC_EXTENSION_ALLOWLIST = new Set([
  'md',
  'sh',
  'yml',
  'yaml',
  'json',
  'toml',
  'txt',
  'csv',
  'tsv',
  'conf',
  'cfg',
  'ini',
  'env',
  'lock',
  'gitignore',
  'dockerignore',
  'markdown',
]);

function usage(): never {
  console.error('Usage: node check-readiness.js --session-dir <dir> [--repo-root <dir>] [--manifest <file>] [--machinability-only] [--contract-only] [--history [--last N]] [--skip-readiness <reason>] [--max-wall-ms N]');
  process.exit(1);
}

const SKIP_USAGE_MSG = '--skip-readiness requires a reason argument (e.g. --skip-readiness "bundle pre-validated by refinement team")';
const SKIP_USAGE_EXIT_CODE = 64;

function parseSkipReadiness(argv: string[]): string | undefined {
  const skipIndex = argv.indexOf('--skip-readiness');
  if (skipIndex < 0) return undefined;
  const raw = argv[skipIndex + 1];
  if (raw === undefined || raw.startsWith('--') || raw.trim() === '') {
    process.stderr.write(`${SKIP_USAGE_MSG}\n`);
    process.exit(SKIP_USAGE_EXIT_CODE);
  }
  return raw;
}

function parseLast(argv: string[]): number {
  const lastIndex = argv.indexOf('--last');
  if (lastIndex < 0) return DEFAULT_HISTORY_LIMIT;
  const rawLast = argv[lastIndex + 1];
  if (!rawLast || rawLast.startsWith('--')) usage();
  const last = Number.parseInt(rawLast, 10);
  if (!Number.isInteger(last) || last < 1) usage();
  return last;
}

function parseMaxWallMs(argv: string[]): number {
  const idx = argv.indexOf('--max-wall-ms');
  if (idx < 0) return DEFAULT_MAX_WALL_MS;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith('--')) usage();
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) usage();
  return value;
}

function parseValueFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function parseArgs(argv: string[]): ReadinessArgs {
  const sessionDir = parseValueFlag(argv, '--session-dir');
  if (!sessionDir) usage();
  const repoRoot = parseValueFlag(argv, '--repo-root') ?? process.cwd();
  return {
    sessionDir: path.resolve(sessionDir),
    repoRoot: path.resolve(repoRoot),
    manifest: parseValueFlag(argv, '--manifest'),
    machinabilityOnly: argv.includes('--machinability-only'),
    contractOnly: argv.includes('--contract-only'),
    history: argv.includes('--history'),
    last: parseLast(argv),
    maxWallMs: parseMaxWallMs(argv),
    skipReadiness: parseSkipReadiness(argv),
  };
}

export function extractAcceptanceCriteria(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const acs: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##+\s+Acceptance Criteria\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##+\s+/.test(line)) break;
    if (!inSection) continue;
    const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (match) acs.push(match[1]);
  }
  return acs;
}

type VerifyPhase = 'pre' | 'post';

function acceptanceCriterionVerifyPhase(ac: string): VerifyPhase {
  return /\bverify_pre\b/i.test(ac) ? 'pre' : 'post';
}

export function isMachineCheckable(ac: string): boolean {
  if (PURE_PROSE_RE.test(ac) && !MACHINE_HINT_RE.test(ac)) return false;
  return MACHINE_HINT_RE.test(ac) || /\|.+\|/.test(ac) || /`[^`]+`/.test(ac);
}

function isDocExtensionBasename(ref: string): boolean {
  if (ref.includes('/')) return false;
  const lastDot = ref.lastIndexOf('.');
  if (lastDot < 0) return false;
  const ext = ref.slice(lastDot + 1).toLowerCase();
  return DOC_EXTENSION_ALLOWLIST.has(ext);
}

export interface ForwardRefAnnotation {
  token: string;
  separator: string;
  verb: 'created' | 'introduced';
  hash: string;
  raw: string;
}

/**
 * R-RTRC-2 / R-RTRC-7: Extract `\`token\` (created|introduced) by ticket <hash>`
 * annotations from PRD/ticket content.
 *
 * Annotation schema (R-RTRC-7):
 *   - position OUTSIDE backticks
 *   - separated by EXACTLY one ASCII space (no-space, two-space, tab → malformed)
 *   - hash = 8-char short SHA OR ticket-dir basename (resolver normalizes by length)
 *
 * Returns:
 *   - `valid`: tokens whose annotation parses cleanly. Resolver MUST skip these
 *              (forward-created artifacts that do not yet exist at HEAD).
 *   - `malformed`: annotations whose separator/hash format is wrong; resolver
 *                  emits an `annotation_format` finding for each.
 */
export function extractForwardRefAnnotations(content: string): { valid: Set<string>; malformed: ForwardRefAnnotation[] } {
  const valid = new Set<string>();
  const malformed: ForwardRefAnnotation[] = [];
  const re = new RegExp(FORWARD_REF_ANNOTATION_RE.source, FORWARD_REF_ANNOTATION_RE.flags);
  for (const match of content.matchAll(re)) {
    const [raw, token, separator, verb, hashRaw] = match;
    const hash = hashRaw.trim();
    const verbTyped = verb === 'created' || verb === 'introduced' ? verb : 'created';
    const annotation: ForwardRefAnnotation = { token: token.trim(), separator, verb: verbTyped, hash, raw };
    if (separator !== ' ' || !FORWARD_REF_ANNOTATION_HASH_RE.test(hash)) {
      malformed.push(annotation);
      continue;
    }
    valid.add(annotation.token);
  }
  return { valid, malformed };
}

export function extractContractReferences(content: string): string[] {
  const annotations = extractForwardRefAnnotations(content);
  const refs = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) refs.add(match[0]);
  for (const match of content.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (PATH_RE.test(value)) refs.add(value);
    PATH_RE.lastIndex = 0;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/.test(value) || /^[A-Za-z_$][\w$]*\(\)$/.test(value)) refs.add(value);
  }
  for (const match of content.matchAll(SYMBOL_RE)) refs.add(match[0]);
  return [...refs]
    .filter((ref) => !ref.startsWith('AC-'))
    .filter((ref) => !refs.has(`${ref}()`))
    .filter((ref) => !isDocExtensionBasename(ref))
    .filter((ref) => !annotations.valid.has(ref))
    .sort();
}

function resolvePathRef(ref: string, repoRoot: string, ticket: TicketInfo, sessionDir: string, cache?: ResolverCache): boolean {
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return true;
  let workingDir: string | undefined;
  if (ticket.workingDir) {
    workingDir = path.isAbsolute(ticket.workingDir)
      ? ticket.workingDir
      : path.resolve(repoRoot, ticket.workingDir);
  }
  const bases = [
    workingDir,
    repoRoot,
    path.join(repoRoot, 'extension'),
    path.dirname(ticket.file),
    sessionDir,
  ].filter((base): base is string => typeof base === 'string');
  if (bases.some((base) => fs.existsSync(path.resolve(base, ref)))) return true;
  // R-RTRC-4: git ls-files suffix-match fallback. Equivalent to
  //   git ls-files | grep -E '/<ref>$|^<ref>$'
  // Catches deep repo paths whose containing dir none of the bases above resolve.
  const tracked = cache?.trackedAllFiles ?? gitTrackedFiles(repoRoot);
  if (cache && cache.trackedAllFiles === undefined) cache.trackedAllFiles = tracked;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixRe = new RegExp(`(?:^|/)${escaped}$`);
  return tracked.some((file) => suffixRe.test(file));
}

function gitTrackedFiles(repoRoot: string): string[] {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: GIT_LS_FILES_TIMEOUT_MS,
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

interface ResolverCache {
  trackedSourceFiles: string[];
  trackedAllFiles?: string[];
  fileContents: Map<string, string>;
  deadline: number;
  truncated: boolean;
  allowlist: Set<string>;
}

function createResolverCache(repoRoot: string, maxWallMs: number, allowlist: Set<string> = new Set()): ResolverCache {
  // R-RTRC-3: lift the tests/ exclusion ONLY. Symbols defined in test files
  // (helpers, test fixtures) are valid resolution targets — the prior filter
  // produced false positives whenever a ticket cited a test-defined helper.
  // Extension allowlist (ts|tsx|js|jsx|mjs|cjs) is unchanged.
  const tracked = gitTrackedFiles(repoRoot)
    .filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file));
  return {
    trackedSourceFiles: tracked,
    fileContents: new Map<string, string>(),
    deadline: Date.now() + maxWallMs,
    truncated: false,
    allowlist,
  };
}

function readCachedFile(absPath: string, cache: ResolverCache): string | undefined {
  const cached = cache.fileContents.get(absPath);
  if (cached !== undefined) return cached;
  try {
    const content = fs.readFileSync(absPath, 'utf-8');
    cache.fileContents.set(absPath, content);
    return content;
  } catch {
    return undefined;
  }
}

function resolveSymbolRef(ref: string, repoRoot: string, cache: ResolverCache): boolean {
  const normalized = ref.replace(/\(\)$/, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 0) return false;
  const partPatterns = parts.map((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  const candidates = cache.trackedSourceFiles.filter((file) => {
    const content = readCachedFile(path.join(repoRoot, file), cache);
    if (content === undefined) return false;
    return partPatterns.every((pattern) => pattern.test(content));
  });
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return true;
  try {
    computeOneHop(candidates.slice(0, 1), repoRoot, { findImportersTimeoutMs: FIND_IMPORTERS_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function findMachinabilityFindings(ticketFile: string, content: string): ReadinessFinding[] {
  const findings: ReadinessFinding[] = [];
  for (const ac of extractAcceptanceCriteria(content)) {
    if (acceptanceCriterionVerifyPhase(ac) === 'post') continue;
    if (!isMachineCheckable(ac)) {
      findings.push({
        ticket: ticketFile,
        kind: 'machinability',
        analyst: 'gaps',
        message: 'Acceptance criterion is not machine-checkable',
        detail: ac,
      });
    }
  }
  return findings;
}

function findAnnotationFormatFindings(ticketFile: string, content: string): ReadinessFinding[] {
  // R-RTRC-7: emit annotation_format findings for malformed forward-reference annotations.
  return extractForwardRefAnnotations(content).malformed.map((malformed) => ({
    ticket: ticketFile,
    kind: 'annotation_format' as const,
    analyst: 'gaps' as const,
    message: 'annotation-format-error: forward-reference annotation must be `<token>` (created|introduced) by ticket <8-12-char-hash>) — exactly one ASCII space separator',
    detail: malformed.raw,
  }));
}

export function findReadinessFindings(
  ticketFile: string,
  repoRoot: string,
  opts: { checkMachinability: boolean; checkContracts: boolean; cache?: ResolverCache; maxWallMs?: number; allowlist?: Set<string> },
): ReadinessFinding[] {
  const content = fs.readFileSync(ticketFile, 'utf-8');
  const findings: ReadinessFinding[] = [];
  if (opts.checkMachinability) findings.push(...findMachinabilityFindings(ticketFile, content));
  if (opts.checkContracts) {
    findings.push(...findAnnotationFormatFindings(ticketFile, content));
    const allowlist = opts.allowlist ?? opts.cache?.allowlist ?? new Set<string>();
    const cache = opts.cache ?? createResolverCache(repoRoot, opts.maxWallMs ?? DEFAULT_MAX_WALL_MS, allowlist);
    for (const ref of extractContractReferences(content)) {
      if (ref.includes('/')) continue;
      if (allowlist.has(ref)) continue;
      if (Date.now() > cache.deadline) {
        cache.truncated = true;
        findings.push({
          ticket: ticketFile,
          kind: 'performance',
          analyst: 'codebase',
          message: 'Contract resolution wall budget exceeded; remaining refs were not checked',
          detail: ref,
        });
        break;
      }
      const resolved = resolveSymbolRef(ref, repoRoot, cache);
      if (!resolved) {
        findings.push({
          ticket: ticketFile,
          kind: 'contract',
          analyst: 'codebase',
          message: 'Referenced contract does not resolve',
          detail: ref,
        });
      }
    }
  }
  return findings;
}

function parseFrontmatter(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return match ? match[1] : '';
}

function readScalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
  if (!match) return undefined;
  const value = match[1].trim();
  if (value === '[]') return undefined;
  return value.replace(/^['"]|['"]$/g, '');
}

function readStringArray(frontmatter: string, key: string): string[] {
  const inline = new RegExp(`^${key}:\\s*\\[(.*?)\\]\\s*$`, 'm').exec(frontmatter);
  if (inline) {
    return inline[1].split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (index < 0) return [];
  const values: string[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const match = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    values.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return values;
}

function unquoteYamlish(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function readNestedStringArray(frontmatter: string, parentKey: string, childKey: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const parentIndex = lines.findIndex((line) => new RegExp(`^${parentKey}:\\s*$`).test(line));
  if (parentIndex < 0) return [];
  const values: string[] = [];
  for (let i = parentIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (!new RegExp(`^\\s+${childKey}:\\s*$`).test(line)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = lines[j];
      if (/^\s{2}\S/.test(item) && !/^\s{4,}-\s+/.test(item)) break;
      const match = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(item);
      if (match) values.push(unquoteYamlish(match[1]));
    }
    break;
  }
  return values;
}

function dependencyRefs(content: string, frontmatter: string): Array<{ ref: string; external: boolean }> {
  const refs = new Map<string, boolean>();
  for (const dep of [...readStringArray(frontmatter, 'depends_on'), ...readStringArray(frontmatter, 'dependencies')]) {
    const external = /\bexternal\b/i.test(dep) || dep.startsWith('external:');
    refs.set(dep.replace(/^external:/, '').trim(), external);
  }
  for (const match of content.matchAll(/title:\s*["']?Depends on:\s*([^"'\n]+)["']?/gi)) {
    const raw = match[1].trim();
    const ref = raw.split(/\s+[—-]\s+|\s+\(/)[0]?.trim();
    if (!ref) continue;
    refs.set(ref, /\bexternal\b/i.test(raw));
  }
  return [...refs].map(([ref, external]) => ({ ref, external }));
}

function ticketInfo(ticketFile: string): TicketInfo {
  const content = fs.readFileSync(ticketFile, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const id = readScalar(frontmatter, 'id') ?? path.basename(path.dirname(ticketFile));
  const acIds = [
    ...readStringArray(frontmatter, 'ac_ids'),
    ...extractAcceptanceCriteria(content)
      .flatMap((ac) => [...ac.matchAll(/\b(?:AC-[A-Za-z0-9-]+|P\d+\.\d+|R\d+|T\d+)\b/g)].map((match) => match[0])),
  ];
  return {
    file: ticketFile,
    id,
    key: readScalar(frontmatter, 'key'),
    workingDir: readScalar(frontmatter, 'working_dir'),
    sourcePrd: readScalar(frontmatter, 'source_prd'),
    sourceSection: readScalar(frontmatter, 'source_section'),
    mappedRequirements: readStringArray(frontmatter, 'mapped_requirements'),
    acIds: [...new Set(acIds)].sort(),
    dependencies: dependencyRefs(content, frontmatter),
  };
}

function readJsonFile(file: string | undefined): unknown {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * R-RTRC-5: Load `extension/.readiness-allowlist.json` from repoRoot. Each
 * entry is `{ ref: string, source: string, kind?: 'path'|'symbol'|'both' }`.
 * Entries lacking a non-empty `source` field are dropped at load time and
 * blocked by `extension/scripts/audit-readiness-allowlist.sh` (lint).
 */
export function loadReadinessAllowlist(repoRoot: string): Set<string> {
  const candidates = [
    path.join(repoRoot, ALLOWLIST_FILE_REL),
    path.join(repoRoot, 'extension', '.readiness-allowlist.json'),
    path.join(repoRoot, '.readiness-allowlist.json'),
  ];
  const allowlistPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!allowlistPath) return new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
  } catch {
    return new Set<string>();
  }
  if (!Array.isArray(parsed)) return new Set<string>();
  const refs = new Set<string>();
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const ref = typeof entry.ref === 'string' ? entry.ref.trim() : '';
    const source = typeof entry.source === 'string' ? entry.source.trim() : '';
    if (!ref || !source) continue; // R-RTRC-5: source field is mandatory.
    refs.add(ref);
  }
  return refs;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function resolvePeerPrdPath(parentPrdPath: string, peerPath: string, repoRoot: string): string | undefined {
  if (path.isAbsolute(peerPath) && fs.existsSync(peerPath)) return peerPath;
  const candidates = [
    path.resolve(path.dirname(parentPrdPath), peerPath),
    path.resolve(repoRoot, peerPath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function requirementsFromPrd(filePath: string, sourcePrd: string, idPattern = /\bAC-[A-Za-z0-9-]+\b/g): SourceRequirement[] {
  const requirements: SourceRequirement[] = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  let section = '';
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) section = heading[1].trim();
    for (const match of line.matchAll(idPattern)) {
      requirements.push({ sourcePrd, sourceSection: section, requirementId: match[0] });
    }
  }
  return requirements;
}

function sourceRequirementsFromParentPrd(parentPrdPath: string | undefined, repoRoot: string): SourceRequirement[] {
  if (!parentPrdPath || !fs.existsSync(parentPrdPath)) return [];
  const parentContent = fs.readFileSync(parentPrdPath, 'utf-8');
  const peerPaths = readNestedStringArray(parseFrontmatter(parentContent), 'peer_prds', 'deferred');
  const requirements = requirementsFromPrd(parentPrdPath, path.relative(repoRoot, parentPrdPath) || path.basename(parentPrdPath), /\bAC-DR-[A-Za-z0-9-]+\b/g);
  for (const peerPath of peerPaths) {
    const resolved = resolvePeerPrdPath(parentPrdPath, peerPath, repoRoot);
    if (!resolved) continue;
    requirements.push(...requirementsFromPrd(resolved, peerPath));
  }
  return requirements;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))].sort();
}

function resolveManifestPrdPath(manifest: unknown, sessionDir: string, repoRoot: string): string | undefined {
  if (!isRecord(manifest) || typeof manifest.prd_path !== 'string' || manifest.prd_path.trim() === '') return undefined;
  const prdPath = manifest.prd_path;
  if (path.isAbsolute(prdPath)) return prdPath;
  const candidates = [
    path.resolve(repoRoot, prdPath),
    path.resolve(sessionDir, prdPath),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function manifestTickets(manifest: unknown): ManifestTicket[] {
  if (!isRecord(manifest) || !Array.isArray(manifest.tickets)) return [];
  return manifest.tickets.filter(isRecord);
}

function manifestTicketFor(ticket: TicketInfo, manifest: unknown): ManifestTicket | undefined {
  return manifestTickets(manifest).find((entry) => entry.id === ticket.id || entry.key === ticket.key);
}

function sourceRequirementIndex(requirements: SourceRequirement[]): Map<string, SourceRequirement[]> {
  const index = new Map<string, SourceRequirement[]>();
  for (const requirement of requirements) {
    const existing = index.get(requirement.requirementId) ?? [];
    existing.push(requirement);
    index.set(requirement.requirementId, existing);
  }
  return index;
}

function enrichTickets(tickets: TicketInfo[], manifest: unknown, sourceRequirements: SourceRequirement[]): TicketInfo[] {
  const byRequirement = sourceRequirementIndex(sourceRequirements);
  return tickets.map((ticket) => {
    const manifestTicket = manifestTicketFor(ticket, manifest);
    const mappedRequirements = uniqueStrings([
      ...ticket.mappedRequirements,
      ...stringArray(manifestTicket?.mapped_requirements),
      ...stringArray(manifestTicket?.requirements),
      ...stringArray(manifestTicket?.ac_ids),
    ]);
    const acIds = uniqueStrings([...ticket.acIds, ...mappedRequirements]);
    const matches = acIds.flatMap((id) => byRequirement.get(id) ?? []);
    const sourcePrds = uniqueStrings(matches.map((match) => match.sourcePrd));
    const sourceSections = uniqueStrings(matches.map((match) => match.sourceSection));
    const inferredSourcePrd = sourcePrds.join(', ') || undefined;
    const inferredSourceSection = sourceSections.join(', ') || undefined;
    return {
      ...ticket,
      sourcePrd: ticket.sourcePrd ?? (typeof manifestTicket?.source_prd === 'string' ? manifestTicket.source_prd : undefined) ?? inferredSourcePrd,
      sourceSection: ticket.sourceSection ?? (typeof manifestTicket?.source_section === 'string' ? manifestTicket.source_section : undefined) ?? inferredSourceSection,
      mappedRequirements,
      acIds,
    };
  });
}

function manifestRequirementIds(manifest: unknown, sourceRequirements: SourceRequirement[] = []): string[] {
  const ids = new Set<string>();
  for (const req of sourceRequirements) ids.add(req.requirementId);
  if (!isRecord(manifest)) return [...ids].sort();
  for (const req of stringArray(manifest.requirements)) ids.add(req);
  if (isRecord(manifest.prd_requirements)) {
    for (const value of Object.values(manifest.prd_requirements)) {
      for (const req of stringArray(value)) ids.add(req);
    }
  }
  for (const ticket of manifestTickets(manifest)) {
    for (const req of stringArray(ticket.requirements)) ids.add(req);
  }
  return [...ids].sort();
}

function manifestRefs(manifest: unknown, tickets: TicketInfo[]): Set<string> {
  const refs = new Set<string>(tickets.flatMap((ticket) => [ticket.id, ticket.key].filter((value): value is string => Boolean(value))));
  for (const ticket of manifestTickets(manifest)) {
    if (typeof ticket.id === 'string') refs.add(ticket.id);
    if (typeof ticket.key === 'string') refs.add(ticket.key);
  }
  return refs;
}

function ticketRequirementIds(manifest: unknown, tickets: TicketInfo[]): Set<string> {
  const ids = new Set<string>(tickets.flatMap((ticket) => [...ticket.acIds, ...ticket.mappedRequirements]));
  for (const ticket of manifestTickets(manifest)) {
    for (const ac of stringArray(ticket.ac_ids)) ids.add(ac);
    for (const req of stringArray(ticket.requirements)) ids.add(req);
  }
  return ids;
}

function findPrdMapFindings(tickets: TicketInfo[], manifest: unknown, sourceRequirements: SourceRequirement[]): ReadinessFinding[] {
  const mapped = ticketRequirementIds(manifest, tickets);
  return manifestRequirementIds(manifest, sourceRequirements)
    .filter((requirement) => !mapped.has(requirement))
    .map((requirement) => ({
      ticket: 'manifest',
      kind: 'prd_map' as const,
      analyst: 'gaps' as const,
      message: 'PRD requirement is not mapped to any ticket',
      detail: requirement,
    }));
}

function findPathFindings(ticket: TicketInfo, repoRoot: string, sessionDir: string, cache?: ResolverCache): ReadinessFinding[] {
  const content = fs.readFileSync(ticket.file, 'utf-8');
  // R-RTRC-2: skip annotated forward-references — they're documented as
  // forward-created so the resolver MUST not flag them as unresolved paths.
  const annotatedTokens = extractForwardRefAnnotations(content).valid;
  const allowlist = cache?.allowlist ?? new Set<string>();
  const refs = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) refs.add(match[0]);
  return [...refs].sort()
    .filter((ref) => !annotatedTokens.has(ref))
    .filter((ref) => !allowlist.has(ref))
    .filter((ref) => !resolvePathRef(ref, repoRoot, ticket, sessionDir, cache))
    .map((ref) => ({
      ticket: ticket.file,
      kind: 'file_path' as const,
      analyst: 'codebase' as const,
      message: 'Referenced ticket file path does not resolve',
      detail: ref,
    }));
}

function findDependencyFindings(ticket: TicketInfo, refs: Set<string>): ReadinessFinding[] {
  return ticket.dependencies
    .filter((dep) => !dep.external && !refs.has(dep.ref))
    .map((dep) => ({
      ticket: ticket.file,
      kind: 'dependency' as const,
      analyst: 'risk' as const,
      message: 'Ticket dependency is not in the manifest and is not marked external',
      detail: dep.ref,
    }));
}

function displayTicketRef(sessionDir: string, ticket: string): string {
  return path.isAbsolute(ticket) ? path.relative(sessionDir, ticket) : ticket;
}

function readState(sessionDir: string): ReadinessStateShape {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return {};
  try {
    return new StateManager().read(statePath) as ReadinessStateShape;
  } catch {
    return {};
  }
}

function writeState(sessionDir: string, state: ReadinessStateShape): void {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return;
  const sm = new StateManager();
  sm.update(statePath, (current) => {
    Object.assign(current, state);
  });
}

function readinessCycleHistory(state: ReadinessStateShape): ReadinessCycleHistoryEntry[] {
  const history = state.readiness?.cycle_history;
  if (!Array.isArray(history)) return [];
  return history.filter(isRecord).map((entry, index) => ({
    cycle: typeof entry.cycle === 'number' && Number.isFinite(entry.cycle) ? entry.cycle : index + 1,
    status: typeof entry.status === 'string' ? entry.status : '',
    suggested_analyst: typeof entry.suggested_analyst === 'string' ? entry.suggested_analyst : null,
    user_action: typeof entry.user_action === 'string' ? entry.user_action : null,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
  }));
}

function readinessCycleCount(sessionDir: string, state: ReadinessStateShape): number {
  if (Array.isArray(state.readiness?.cycle_history)) return state.readiness.cycle_history.length;
  return fs.readdirSync(sessionDir).filter((file) => /^readiness_\d{4}-\d{2}-\d{2}/.test(file)).length;
}

function appendReadinessCycle(sessionDir: string, state: ReadinessStateShape, findings: ReadinessFinding[], escalated: boolean): void {
  if (escalated) return;
  const existing = readinessCycleHistory(state);
  if (existing.length >= READINESS_MAX_RECYCLE_CYCLES) return;
  const next: ReadinessCycleHistoryEntry = {
    cycle: existing.length + 1,
    status: 'failed',
    suggested_analyst: findings[0]?.analyst ?? null,
    user_action: null,
    timestamp: new Date().toISOString(),
  };
  state.readiness = {
    ...(isRecord(state.readiness) ? state.readiness : {}),
    cycle_history: [...existing, next].slice(0, READINESS_MAX_RECYCLE_CYCLES),
  };
  writeState(sessionDir, state);
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readSnapshot(sessionDir: string): TicketSnapshot | undefined {
  const file = path.join(sessionDir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = readRecoverableJsonObject(file) as TicketSnapshot | null;
    return parsed && typeof parsed.hashes === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSnapshot(sessionDir: string, ticketFiles: string[], ticketsVersion: number | undefined): void {
  const snapshot: TicketSnapshot = {
    ticketsVersion,
    hashes: Object.fromEntries(ticketFiles.map((file) => [path.relative(sessionDir, file), hashFile(file)])),
  };
  writeStateFile(path.join(sessionDir, SNAPSHOT_FILE), snapshot);
}

function getTicketsVersion(state: ReadinessStateShape): number | undefined {
  return typeof state.tickets_version === 'number' ? state.tickets_version : undefined;
}

function selectTicketFiles(sessionDir: string, state: ReadinessStateShape): { files: string[]; delta: boolean } {
  const allFiles = listLinearTicketFiles(sessionDir);
  const snapshot = readSnapshot(sessionDir);
  const ticketsVersion = getTicketsVersion(state);
  const hasCorrection = Array.isArray(state.activity) && state.activity.some((entry) => entry.event === 'course_corrected');
  const delta = Boolean(snapshot && ticketsVersion !== undefined && snapshot.ticketsVersion !== ticketsVersion && hasCorrection);
  if (!delta || !snapshot) return { files: allFiles, delta: false };
  return {
    files: allFiles.filter((file) => snapshot.hashes[path.relative(sessionDir, file)] !== hashFile(file)),
    delta: true,
  };
}

function writeReport(sessionDir: string, tickets: TicketInfo[], findings: ReadinessFinding[], escalation: boolean): string {
  const date = formatLocalDateKey(new Date());
  const filename = escalation ? `readiness_escalation_${date}.md` : `readiness_${date}.md`;
  const reportPath = path.join(sessionDir, filename);
  const prdMapRows = tickets.map((ticket) => `| ${ticket.id} | ${ticket.key ?? ''} | ${ticket.sourcePrd ?? ''} | ${ticket.sourceSection ?? ''} | ${uniqueStrings([...ticket.acIds, ...ticket.mappedRequirements]).join(', ')} |`);
  const acRows = tickets.flatMap((ticket) => extractAcceptanceCriteria(fs.readFileSync(ticket.file, 'utf-8')).map((ac) => {
    const status = acceptanceCriterionVerifyPhase(ac) === 'post' ? 'SKIP_POST' : isMachineCheckable(ac) ? 'PASS' : 'FAIL';
    return `| ${path.relative(sessionDir, ticket.file)} | ${status} | ${ac.replace(/\|/g, '\\|')} |`;
  }));
  const contractRows = findings
    .filter((finding) => finding.kind === 'contract')
    .map((finding) => `| ${displayTicketRef(sessionDir, finding.ticket)} | FAIL | ${finding.detail} | ${finding.analyst} |`);
  const lines = [
    `# ${escalation ? 'Readiness Escalation' : 'Readiness Failure'}`,
    '',
    `Date: ${date}`,
    '',
    '## PRD-ticket map',
    '',
    '| Ticket | Key | Source PRD | Source section | Mapped requirements |',
    '|---|---|---|---|---|',
    ...prdMapRows,
    ...findings.filter((finding) => finding.kind === 'prd_map').map((finding) => `| manifest |  |  |  | MISSING: ${finding.detail} |`),
    '',
    '## AC verifiability matrix',
    '',
    '| Ticket | Status | Criterion |',
    '|---|---|---|',
    ...acRows,
    '',
    '## Contract resolution table',
    '',
    '| Ticket | Status | Reference | Suggested analyst |',
    '|---|---|---|---|',
    ...(contractRows.length > 0 ? contractRows : ['| all | PASS |  |  |']),
    '',
    '## Findings',
    ...findings.map((finding) => [
      `- **${finding.kind}** in \`${displayTicketRef(sessionDir, finding.ticket)}\``,
      `  - suggested_analyst: ${finding.analyst}`,
      `  - ${finding.message}: \`${finding.detail}\``,
    ].join('\n')),
    '',
  ];
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

export function runReadiness(args: ReadinessArgs): { exitCode: number; findings: ReadinessFinding[]; reportPath?: string; delta: boolean; elapsed_ms: number } {
  const started = Date.now();
  const state = readState(args.sessionDir);
  const selected = selectTicketFiles(args.sessionDir, state);
  const checkMachinability = args.machinabilityOnly || !args.contractOnly;
  const checkContracts = args.contractOnly || !args.machinabilityOnly;
  const manifestPath = args.manifest ? path.resolve(args.sessionDir, args.manifest) : path.join(args.sessionDir, 'decomposition_manifest.json');
  const manifest = readJsonFile(fs.existsSync(manifestPath) ? manifestPath : args.manifest);
  const sourceRequirements = sourceRequirementsFromParentPrd(resolveManifestPrdPath(manifest, args.sessionDir, args.repoRoot), args.repoRoot);
  const tickets = enrichTickets(selected.files.map(ticketInfo), manifest, sourceRequirements);
  const refs = manifestRefs(manifest, tickets);
  // R-RTRC-5: extension/.readiness-allowlist.json — long-tail false positives
  // (stdlib, external APIs) listed with `source:` justification short-circuit
  // both path and symbol resolution.
  const allowlist = loadReadinessAllowlist(args.repoRoot);
  const resolverCache = checkContracts || !args.machinabilityOnly
    ? createResolverCache(args.repoRoot, args.maxWallMs, allowlist)
    : undefined;
  const pathCache: ResolverCache = resolverCache ?? createResolverCache(args.repoRoot, args.maxWallMs, allowlist);
  const findings = [
    ...findPrdMapFindings(tickets, manifest, sourceRequirements),
    ...tickets.flatMap((ticket) => findPathFindings(ticket, args.repoRoot, args.sessionDir, pathCache)),
    ...tickets.flatMap((ticket) => findDependencyFindings(ticket, refs)),
    ...selected.files.flatMap((file) => findReadinessFindings(file, args.repoRoot, { checkMachinability, checkContracts, cache: resolverCache, maxWallMs: args.maxWallMs, allowlist })),
  ];
  const ticketsVersion = getTicketsVersion(state);

  if (findings.length === 0) {
    writeSnapshot(args.sessionDir, listLinearTicketFiles(args.sessionDir), ticketsVersion);
    return { exitCode: 0, findings, delta: selected.delta, elapsed_ms: Date.now() - started };
  }

  const escalation = readinessCycleCount(args.sessionDir, state) >= READINESS_MAX_RECYCLE_CYCLES;
  const reportPath = writeReport(args.sessionDir, tickets, findings, escalation);
  appendReadinessCycle(args.sessionDir, state, findings, escalation);
  if (selected.delta) {
    logActivity({
      event: 'readiness_failed_post_correction',
      source: 'pickle',
      session: path.basename(args.sessionDir),
      gate_payload: { findings: findings.length, report: reportPath },
    });
  }
  return { exitCode: 2, findings, reportPath, delta: selected.delta, elapsed_ms: Date.now() - started };
}

export function runHistory(args: ReadinessArgs): string {
  const history = readinessCycleHistory(readState(args.sessionDir)).slice(-args.last);
  const rows = history.map((entry) => [
    entry.cycle,
    entry.status || '',
    entry.suggested_analyst ?? '',
    entry.user_action ?? '',
    entry.timestamp || '',
  ]);
  return [
    '| Cycle | Status | Suggested analyst | User action | Timestamp |',
    '|---:|---|---|---|---|',
    ...(rows.length > 0 ? rows.map((row) => `| ${row.join(' | ')} |`) : ['|  |  |  |  |  |']),
    '',
  ].join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.history) {
      process.stdout.write(runHistory(args));
      process.exit(0);
    }
    if (args.skipReadiness !== undefined) {
      const reason = args.skipReadiness;
      const timestamp = new Date().toISOString();
      logActivity({
        event: 'readiness_skipped',
        source: 'pickle',
        session: path.basename(args.sessionDir),
        gate_payload: { reason, timestamp },
      });
      if (/manifest-bundle/i.test(reason)) {
        logActivity({
          event: 'readiness_skipped_for_manifest',
          source: 'pickle',
          session: path.basename(args.sessionDir),
          gate_payload: { reason, timestamp },
        });
      }
      process.stdout.write(`${JSON.stringify({ status: 'skipped', reason, elapsed_ms: 0 })}\n`);
      process.exit(0);
    }
    const result = runReadiness(args);
    process.stdout.write(`${JSON.stringify({
      status: result.exitCode === 0 ? 'pass' : 'fail',
      findings: result.findings,
      elapsed_ms: result.elapsed_ms,
      report: result.reportPath,
      delta: result.delta,
    })}\n`);
    if (result.reportPath) process.stderr.write(`readiness failed: ${result.reportPath}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      status: 'error',
      findings: [],
      elapsed_ms: 0,
      error: safeErrorMessage(err),
    })}\n`);
    process.stderr.write(`check-readiness failed: ${safeErrorMessage(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-readiness.js') {
  main();
}
