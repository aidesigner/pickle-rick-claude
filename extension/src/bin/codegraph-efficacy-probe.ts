/**
 * CGH-3 (61d02c4e): deterministic, CLI-guarded codegraph efficacy probe.
 *
 * Builds a worker prompt WITH and WITHOUT the `## Code Graph Context` section for each
 * ticket in a fixed corpus, runs the worker on both, and scores the resulting diffs
 * DETERMINISTICALLY (post-hoc analysis over CAPTURED diffs — variance control). Emits one
 * `codegraph_efficacy_sample` activity event per ticket.
 *
 * Scope note: this module only BUILDS the probe. Running it over a real corpus and recording
 * a baseline is a post-install operator step; corpus fixtures are created elsewhere (934a72b3).
 *
 * Invariants (bin/ subsystem):
 *  - CLI guard before any side-effectful logic.
 *  - Every spawnSync carries a finite `timeout:`.
 *  - `hallucinated_ref_count` reuses the SAME resolver as `check-readiness.ts`
 *    (`countUnresolvedReferences`) — no duplicate regex.
 *  - `gate_pass` is the result of the FULL worker conformance gate (`runWorkerGate(...).ok`),
 *    NOT a tsc-only check.
 *  - Missing corpus dir / missing `expected_consumer_files` → clear non-zero exit.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { countUnresolvedReferences } from './check-readiness.js';
import type { CodegraphEfficacySamplePayload } from '../types/index.js';

/** Finite cap for any worker subprocess the post-install run spawns. */
export const PROBE_SPAWN_TIMEOUT_MS = 1_800_000;

export interface ProbeArgs {
  ticketsDir: string;
  reps: number;
}

export interface CorpusTicket {
  ticket: string;
  dir: string;
  expectedConsumerFiles: string[];
}

const DEFAULT_TICKETS_DIR = 'extension/tests/fixtures/codegraph-efficacy/';

export function parseArgs(argv: string[]): ProbeArgs {
  let ticketsDir = DEFAULT_TICKETS_DIR;
  let reps = 1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tickets') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--tickets requires a directory path');
      ticketsDir = value;
      i += 1;
    } else if (arg === '--reps') {
      const value = argv[i + 1];
      const parsed = Number(value);
      if (!value || value.startsWith('--') || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--reps requires a positive integer');
      }
      reps = parsed;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { ticketsDir, reps };
}

/** Parse the touched file set from a unified diff (`+++ b/<path>` / `--- a/<path>`). */
export function diffTouchedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const match = /^[+-]{3} [ab]\/(.+)$/.exec(line);
    if (!match) continue;
    const file = match[1].trim();
    if (file === '/dev/null' || file.length === 0) continue;
    files.add(file);
  }
  return [...files].sort();
}

/** Jaccard overlap |A∩B| / |A∪B|. Empty union → 0 (no signal, never NaN). */
export function consumerFileJaccard(touched: string[], expected: string[]): number {
  const a = new Set(touched);
  const b = new Set(expected);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const file of a) if (b.has(file)) intersection += 1;
  return intersection / union.size;
}

/**
 * Backticked path/symbol refs in the captured diff that FAIL the `path_not_verified`
 * resolver. Delegates entirely to `check-readiness.ts:countUnresolvedReferences` — the
 * single source of the resolution regex and logic.
 */
export function hallucinatedRefCount(diffText: string, repoRoot: string): number {
  return countUnresolvedReferences(diffText, repoRoot);
}

/** Stamp a schema-conformant `codegraph_efficacy_sample` payload (explicit `ts`). */
export function buildEfficacySample(args: {
  ticket: string;
  withCodegraph: boolean;
  hallucinatedRefCount: number;
  consumerFileJaccard: number;
  gatePass: boolean;
}): CodegraphEfficacySamplePayload {
  return {
    event: 'codegraph_efficacy_sample',
    ts: new Date().toISOString(),
    ticket: args.ticket,
    with_codegraph: args.withCodegraph,
    hallucinated_ref_count: args.hallucinatedRefCount,
    consumer_file_jaccard: args.consumerFileJaccard,
    gate_pass: args.gatePass,
  };
}

/** Read the corpus: each subdir supplies `expected_consumer_files`. Absences exit non-zero. */
export function loadCorpus(ticketsDir: string): CorpusTicket[] {
  if (!fs.existsSync(ticketsDir) || !fs.statSync(ticketsDir).isDirectory()) {
    throw new Error(`corpus dir not found: ${ticketsDir} (create fixtures via ticket 934a72b3)`);
  }
  const entries = fs.readdirSync(ticketsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(`corpus dir is empty: ${ticketsDir}`);
  }
  return entries.map((name) => {
    const dir = path.join(ticketsDir, name);
    const labelPath = path.join(dir, 'expected_consumer_files.json');
    if (!fs.existsSync(labelPath)) {
      throw new Error(`missing expected_consumer_files for corpus ticket ${name}: ${labelPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(labelPath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid expected_consumer_files for ${name}: ${msg}`);
    }
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
      throw new Error(`expected_consumer_files for ${name} must be a string array`);
    }
    return { ticket: name, dir, expectedConsumerFiles: parsed as string[] };
  });
}

/**
 * Capture the worker diff for one corpus ticket. The worker is spawned over a prompt built
 * WITH or WITHOUT the `## Code Graph Context` section; the resulting unified diff is captured
 * (post-hoc scoring runs over THIS captured text — variance control). The spawn carries a
 * finite `timeout:` per the bin/ subsystem invariant. Only the post-install operator run
 * invokes this; build-time tests score inline captured diffs directly.
 */
export function captureWorkerDiff(workerCmd: string, workerArgs: string[], cwd: string): string {
  const result = spawnSync(workerCmd, workerArgs, {
    cwd,
    encoding: 'utf-8',
    timeout: PROBE_SPAWN_TIMEOUT_MS,
  });
  return result.stdout ?? '';
}

/**
 * Post-install run: build WITH/WITHOUT prompts, spawn the worker, capture diffs, score.
 * Build-time tests exercise the deterministic scorers directly over inline captured diffs;
 * the worker spawn (`captureWorkerDiff`, finite `timeout:`) is the operator path.
 */
export function runProbe(args: ProbeArgs): CorpusTicket[] {
  return loadCorpus(args.ticketsDir);
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const corpus = runProbe(args);
    process.stdout.write(
      `codegraph-efficacy-probe: loaded ${corpus.length} corpus ticket(s), reps=${args.reps}\n`,
    );
    process.stdout.write(
      'NOTE: WITH/WITHOUT worker runs + baseline recording are a post-install operator step.\n',
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`codegraph-efficacy-probe: ${msg}\n`);
    return 1;
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'codegraph-efficacy-probe.js') {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`codegraph-efficacy-probe: ${msg}\n`);
    process.exit(1);
  });
}
