import { spawnSync } from 'child_process';
import * as path from 'path';
import { logActivity } from './activity-logger.js';
import { safeErrorMessage } from './pickle-utils.js';

export const PINNED_GITNEXUS_VERSION = '1.6.5';

const DETECT_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 120_000;
const ANALYZE_TIMEOUT_MS = 120_000;

export interface GraphPreflightResult {
  available: boolean;
  indexPath?: string;
  symbolCount?: number;
  staleness?: number;
  degraded: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface EnsureGraphOpts {
  detectFn?: () => { found: boolean };
  installFn?: (version: string) => { success: boolean; reason?: string };
  analyzeFn?: (repoRoot: string) => { success: boolean; indexPath?: string; symbolCount?: number; reason?: string };
}

function defaultDetect(): { found: boolean } {
  const r = spawnSync('which', ['gitnexus'], { encoding: 'utf-8', timeout: DETECT_TIMEOUT_MS });
  return { found: r.status === 0 && !r.error };
}

function defaultInstall(version: string): { success: boolean; reason?: string } {
  const r = spawnSync('npm', ['install', '-g', `gitnexus@${version}`], {
    encoding: 'utf-8',
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (r.status === 0 && !r.error) return { success: true };
  const stderr = (r.stderr as string || '').trim();
  const reason = r.error ? safeErrorMessage(r.error) : (stderr || `npm install exited ${r.status}`);
  return { success: false, reason };
}

function defaultAnalyze(repoRoot: string): { success: boolean; indexPath?: string; symbolCount?: number; reason?: string } {
  const r = spawnSync('gitnexus', ['analyze', repoRoot], {
    encoding: 'utf-8',
    timeout: ANALYZE_TIMEOUT_MS,
    cwd: repoRoot,
  });
  if (r.status !== 0 || r.error) {
    const stderr = (r.stderr as string || '').trim();
    const reason = r.error ? safeErrorMessage(r.error) : (stderr || `gitnexus analyze exited ${r.status}`);
    return { success: false, reason };
  }
  const indexPath = path.join(repoRoot, '.gitnexus');
  const stdout = (r.stdout as string || '');
  const match = stdout.match(/(\d+)\s+symbols?/i);
  const symbolCount = match ? parseInt(match[1], 10) : undefined;
  return { success: true, indexPath, symbolCount };
}

function degraded(reason: string): GraphPreflightResult {
  process.stderr.write(`[graph-preflight] ${reason}\n`);
  return { available: false, degraded: true, reason };
}

function ensureBinary(
  detect: () => { found: boolean },
  install: (v: string) => { success: boolean; reason?: string },
): { ok: boolean; reason?: string } {
  if (detect().found) return { ok: true };
  const res = install(PINNED_GITNEXUS_VERSION);
  if (!res.success) return { ok: false, reason: `gitnexus install failed: ${res.reason ?? 'unknown'}` };
  if (!detect().found) return { ok: false, reason: 'gitnexus binary not found after successful install' };
  return { ok: true };
}

export async function ensureGraph(repoRoot: string, opts?: EnsureGraphOpts): Promise<GraphPreflightResult> {
  const detect = opts?.detectFn ?? defaultDetect;
  const install = opts?.installFn ?? defaultInstall;
  const analyze = opts?.analyzeFn ?? defaultAnalyze;

  try {
    const binary = ensureBinary(detect, install);
    if (!binary.ok) {
      const reason = binary.reason ?? 'gitnexus binary unavailable';
      logActivity({ event: 'graph_preflight_degraded', source: 'pickle', gate_payload: { reason, phase: 'install' } });
      return degraded(reason);
    }

    const ar = analyze(repoRoot);
    if (!ar.success) {
      const reason = `gitnexus analyze failed: ${ar.reason ?? 'unknown'}`;
      logActivity({ event: 'graph_preflight_degraded', source: 'pickle', gate_payload: { reason, phase: 'analyze' } });
      return degraded(reason);
    }

    const result: GraphPreflightResult = { available: true, degraded: false };
    if (ar.indexPath !== undefined) result.indexPath = ar.indexPath;
    if (ar.symbolCount !== undefined) result.symbolCount = ar.symbolCount;
    logActivity({ event: 'graph_preflight_completed', source: 'pickle', gate_payload: result });
    return result;
  } catch (err) {
    const reason = `graph-preflight unexpected error: ${safeErrorMessage(err)}`;
    logActivity({ event: 'graph_preflight_degraded', source: 'pickle', gate_payload: { reason, phase: 'unexpected' } });
    return degraded(reason);
  }
}
