import * as fs from 'fs';
import * as path from 'path';

export const NON_GUARANTEED_TOOLS: ReadonlySet<string> = new Set([
  'rg', 'fd', 'fdfind', 'bat', 'jq', 'delta', 'exa', 'eza',
  'ag', 'sd', 'dust', 'duf', 'hyperfine', 'http', 'xh',
]);

function resolvesOnPath(bin: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return true;
    } catch {
      // intentional no-op: ENOENT / permission error means binary absent in this dir
    }
  }
  return false;
}

function extractLeadingCommands(command: string): string[] {
  const tokens: string[] = [];
  // Split on shell separators: |, &&, ;
  const segments = command.split(/\|{1,2}|&&|;/);
  for (const seg of segments) {
    const first = seg.trimStart().split(/\s+/)[0];
    if (first) tokens.push(first);
  }
  return tokens;
}

export function detectMissingTools(
  command: string | string[],
  opts?: { which?: (bin: string) => boolean },
): string[] {
  const resolver = opts?.which ?? resolvesOnPath;

  const candidates: string[] = Array.isArray(command)
    ? [command[0]].filter(Boolean)
    : extractLeadingCommands(command);

  return candidates
    .filter((c) => NON_GUARANTEED_TOOLS.has(c))
    .filter((c) => !resolver(c));
}

export function containsUnquotedGlobHazard(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < command.length) { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { i++; continue; }
    if (ch === '*' || ch === '?' || ch === '[' || ch === '{') return true;
  }
  return false;
}
