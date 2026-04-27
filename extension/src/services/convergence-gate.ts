import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import type { GateResult, GateMode, GateFailure } from '../types/index.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadGateCommands(): Record<string, { typecheck?: string; lint?: string; test?: string }> {
  const dataPath = path.resolve(__dirname, '../data/gate-commands.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Record<string, { typecheck?: string; lint?: string; test?: string }>;
}

export class GateError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'GateError';
    this.kind = kind;
  }
}

export interface RunGateOpts {
  workingDir: string;
  mode: GateMode;
  scope: 'full' | 'changed';
  checks: ('typecheck' | 'lint' | 'tests')[];
  baselinePath?: string;
  since?: string;
  allowedPaths?: string[];
}

export function detectProjectType(workingDir: string): 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | null {
  const has = (f: string) => fs.existsSync(path.join(workingDir, f));
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  if (has('package.json')) return 'npm';
  if (has('Cargo.toml')) return 'cargo';
  if (has('go.mod')) return 'go';
  return null;
}

function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (trimmed.startsWith('- ')) {
      patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ''));
    } else if (trimmed && !trimmed.startsWith('#')) {
      inPackages = false;
    }
  }
  return patterns;
}

function resolveWorkspaceGlobs(workingDir: string, patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    const parts = pattern.split('/');
    const starIdx = parts.findIndex(p => p.includes('*'));
    if (starIdx === -1) {
      const resolved = path.resolve(workingDir, pattern);
      if (fs.existsSync(path.join(resolved, 'package.json'))) results.push(resolved);
      continue;
    }
    const base = path.resolve(workingDir, parts.slice(0, starIdx).join('/') || '.');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) results.push(candidate);
    }
  }
  return results;
}

export function getWorkspacePackages(workingDir: string): string[] {
  const pnpmYaml = path.join(workingDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmYaml)) {
    const patterns = parsePnpmWorkspaceYaml(fs.readFileSync(pnpmYaml, 'utf-8'));
    return resolveWorkspaceGlobs(workingDir, patterns);
  }

  const pkgJsonPath = path.join(workingDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
        workspaces?: string[] | { packages: string[] };
      };
      const ws = pkg.workspaces;
      if (ws) {
        const patterns: string[] = Array.isArray(ws) ? ws : (ws.packages ?? []);
        return resolveWorkspaceGlobs(workingDir, patterns);
      }
    } catch {
      /* not a valid package.json with workspaces */
    }
  }

  return [];
}

function globToRegex(pattern: string): RegExp {
  // Strip trailing /** so the base dir itself matches: packages/b/** → ^packages/b(/.*)?$
  const pat = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  const re = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${re}(/.*)?$`);
}

export function filterByScope(
  files: string[],
  opts: { scope: 'full' | 'changed'; since?: string; allowedPaths?: string[] }
): string[] {
  if (!opts.allowedPaths || opts.allowedPaths.length === 0) return files;
  const regexes = opts.allowedPaths.map(globToRegex);
  return files.filter(f => regexes.some(re => re.test(f)));
}

function getChangedSince(workingDir: string, since: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${since}..HEAD`], {
    cwd: workingDir,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if ((result.status ?? 1) !== 0) return [];
  return (result.stdout || '').split('\n').filter(Boolean);
}

interface CheckResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCheckCommand(cmd: string, cwd: string): Promise<CheckResult> {
  const parts = cmd.split(' ');
  const bin = parts[0];
  const args = parts.slice(1);
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function buildFailures(result: CheckResult, check: 'typecheck' | 'lint' | 'tests', pkgDir: string): GateFailure[] {
  if (result.exitCode === 0) return [];
  const output = (result.stderr || result.stdout).trim();
  return [{
    check,
    file: pkgDir,
    line: 0,
    ruleOrCode: String(result.exitCode),
    message: output.slice(0, 500) || `${check} failed with exit code ${result.exitCode}`,
    severity: 'error',
    occurrence_index: 0,
  }];
}

const CHECK_KEY_MAP: Record<'typecheck' | 'lint' | 'tests', keyof { typecheck?: string; lint?: string; test?: string }> = {
  typecheck: 'typecheck',
  lint: 'lint',
  tests: 'test',
};

export async function runGate(opts: RunGateOpts): Promise<GateResult> {
  const start = Date.now();
  const empty: GateResult = {
    status: 'green',
    failures: [],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 0,
    total_raw_failure_count: 0,
    new_failures_vs_baseline: 0,
  };

  const projectType = detectProjectType(opts.workingDir);
  if (!projectType) return { ...empty, elapsed_ms: Date.now() - start };

  const commands = loadGateCommands();
  const cmdMap = commands[projectType];
  if (!cmdMap) return { ...empty, elapsed_ms: Date.now() - start };

  const workspacePackages = getWorkspacePackages(opts.workingDir);
  const allowedPathsUsed = Boolean(opts.allowedPaths && opts.allowedPaths.length > 0);

  let targetDirs: string[];
  if (workspacePackages.length > 0) {
    let candidates = workspacePackages;

    if (opts.scope === 'changed' && opts.since) {
      const changedFiles = getChangedSince(opts.workingDir, opts.since);
      candidates = workspacePackages.filter(pkgDir =>
        changedFiles.some(f => {
          const absFile = path.resolve(opts.workingDir, f);
          return absFile.startsWith(pkgDir + path.sep) || absFile === pkgDir;
        })
      );
    }

    if (allowedPathsUsed) {
      const relCandidates = candidates.map(p => path.relative(opts.workingDir, p));
      const filtered = filterByScope(relCandidates, { scope: opts.scope, allowedPaths: opts.allowedPaths });
      candidates = filtered.map(rel => path.resolve(opts.workingDir, rel));
    }

    targetDirs = candidates;
  } else {
    // Single-package: run checks in workingDir
    if (opts.scope === 'changed' && opts.since) {
      const changedFiles = getChangedSince(opts.workingDir, opts.since);
      if (changedFiles.length === 0) return { ...empty, elapsed_ms: Date.now() - start };
    }
    targetDirs = [opts.workingDir];
  }

  const allFailures: GateFailure[] = [];

  for (const dir of targetDirs) {
    for (const check of opts.checks) {
      const cmdKey = CHECK_KEY_MAP[check];
      const cmd = cmdMap[cmdKey];
      if (!cmd) continue;
      const result = await runCheckCommand(cmd, dir);
      const failures = buildFailures(result, check, dir);
      allFailures.push(...failures);
    }
  }

  const status = allFailures.length === 0 ? 'green' : 'red';
  return {
    status,
    failures: allFailures,
    baseline_used: false,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: Date.now() - start,
    total_raw_failure_count: allFailures.length,
    new_failures_vs_baseline: 0,
  };
}
