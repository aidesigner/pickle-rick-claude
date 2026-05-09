#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface CheckScopeDiffOpts {
  scopeJsonPath?: string;
  headRef?: string;
}

export interface ScopeDiffResult {
  status: 'ok' | 'outside_scope' | 'no_scope' | 'malformed_scope';
  staged_count?: number;
  staged_paths_outside_scope?: string[];
  scope_json_path?: string;
  head_ref?: string;
  suggested_remediation?: string;
  error?: string;
}

function normalizePath(p: string): string {
  return p.replace(/\/$/, '');
}

function isPathInScope(stagedPath: string, allowedPaths: string[]): boolean {
  const normalized = normalizePath(stagedPath);
  return allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizePath(allowed);
    return normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/');
  });
}

function getStagedPaths(): string[] {
  const result = spawnSync('git', ['diff', '--staged', '--name-only', '--no-renames'], {
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if ((result.status ?? 1) !== 0) return [];
  return (result.stdout || '').split('\n').filter(Boolean);
}

export function checkScopeDiff(opts: CheckScopeDiffOpts = {}): ScopeDiffResult {
  const scopeJsonPath = opts.scopeJsonPath;
  const headRef = opts.headRef ?? 'HEAD';

  if (!scopeJsonPath || !fs.existsSync(scopeJsonPath)) {
    return { status: 'no_scope' };
  }

  let scopeData: { allowed_paths?: unknown };
  try {
    scopeData = JSON.parse(fs.readFileSync(scopeJsonPath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'malformed_scope', error: `Failed to parse scope.json: ${msg}` };
  }

  if (
    !scopeData ||
    typeof scopeData !== 'object' ||
    !Array.isArray(scopeData.allowed_paths) ||
    !scopeData.allowed_paths.every((p: unknown) => typeof p === 'string')
  ) {
    return { status: 'malformed_scope', error: 'scope.json missing or invalid allowed_paths array' };
  }

  const allowedPaths: string[] = scopeData.allowed_paths;
  const staged = getStagedPaths();
  const outside = staged.filter((p) => !isPathInScope(p, allowedPaths));

  if (outside.length === 0) {
    return { status: 'ok', staged_count: staged.length };
  }

  return {
    status: 'outside_scope',
    staged_paths_outside_scope: outside,
    scope_json_path: scopeJsonPath,
    head_ref: headRef,
    suggested_remediation:
      'Unstage outside-scope paths or expand scope.json:allowed_paths before committing.',
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-scope-diff.js') {
  const args = process.argv.slice(2);

  function parseArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  let scopeJsonPath = parseArg('--scope-json');
  let headRef = parseArg('--head-ref');

  // Optionally read from stdin JSON
  if (!scopeJsonPath && !process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync('/dev/stdin', 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.scope_json_path) scopeJsonPath = parsed.scope_json_path;
        if (parsed.head_ref) headRef = parsed.head_ref;
      }
    } catch {
      // stdin parse failure is non-fatal — fall through to CLI args / defaults
    }
  }

  const result = checkScopeDiff({ scopeJsonPath, headRef });

  if (result.status === 'no_scope' || result.status === 'ok') {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  if (result.status === 'malformed_scope') {
    process.stderr.write(JSON.stringify({ error: result.error, status: result.status }) + '\n');
    process.exit(2);
  }

  // outside_scope → exit 1
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(1);
}
