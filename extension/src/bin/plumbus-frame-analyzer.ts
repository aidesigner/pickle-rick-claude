#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import type { AnalyzerOutput, Graph } from '../types/plumbus-frame-analyzer.js';
import { loadEngineKeysRegistry } from '../lib/engine-keys-registry.js';
import { buildContextKeyMatrix } from '../lib/context-key-matrix.js';
import { buildDiamondRouting } from '../lib/diamond-routing.js';

const PROBE = 'packages/attractor/src/cli.ts';
const DIAG_PREFIX = 'plumbus-frame-analyzer:';

function discoverAttractor(): string | null {
  const envRoot = process.env.ATTRACTOR_ROOT;
  if (envRoot && fs.existsSync(path.join(envRoot, PROBE))) {
    return envRoot;
  }

  const relRoot = path.resolve(process.cwd(), '..', 'attractor');
  if (fs.existsSync(path.join(relRoot, PROBE))) {
    return relRoot;
  }

  const result = spawnSync(
    'find',
    [path.join(os.homedir(), 'loanlight'), '-maxdepth', '2', '-type', 'f', '-name', 'cli.ts', '-path', `*/${PROBE}`],
    { encoding: 'utf8', timeout: 5000 },
  );
  const found = result.status === 0 ? result.stdout.split('\n').find(l => l.trim()) : undefined;
  if (found) {
    return path.dirname(path.dirname(path.dirname(path.dirname(found.trim()))));
  }

  return null;
}

function parseDotViaBun(targetDotAbsPath: string, attractorRoot: string): Graph {
  const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  if (bunCheck.error || bunCheck.status !== 0) {
    process.stderr.write(`${DIAG_PREFIX} bun not on PATH\n`);
    process.exit(2);
  }

  const dumpGraphPath = path.join(attractorRoot, 'packages', 'attractor', 'scripts', 'dump-graph.ts');
  if (!fs.existsSync(dumpGraphPath)) {
    process.stderr.write(`${DIAG_PREFIX} dump-graph.ts not found at ${dumpGraphPath}\n`);
    process.exit(2);
  }

  const result = spawnSync('bun', [dumpGraphPath, targetDotAbsPath], { encoding: 'utf-8' });
  if (result.status !== 0) {
    const firstLine = (result.stderr ?? '').split('\n')[0] ?? '';
    process.stderr.write(`${DIAG_PREFIX} dump-graph.ts exited non-zero: ${firstLine}\n`);
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(`${DIAG_PREFIX} dump-graph.ts stdout is not valid JSON\n`);
    process.exit(2);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('nodes' in parsed) ||
    !('edges' in parsed)
  ) {
    process.stderr.write(`${DIAG_PREFIX} dump-graph.ts output missing required top-level keys (nodes, edges)\n`);
    process.exit(2);
  }

  return parsed as Graph;
}

function main(): void {
  const dotPath = process.argv[2];
  if (!dotPath) {
    process.stderr.write(`${DIAG_PREFIX} missing required argument <target.dot>\n`);
    process.exit(2);
  }

  const attractor = discoverAttractor();
  if (!attractor) {
    process.stderr.write(
      `${DIAG_PREFIX} attractor repo not found — set $ATTRACTOR_ROOT or re-run with --no-validator\n`,
    );
    process.exit(2);
  }

  const graph = parseDotViaBun(dotPath, attractor);
  const registry = loadEngineKeysRegistry();

  const output: AnalyzerOutput = {
    context_keys: buildContextKeyMatrix(graph, registry),
    diamond_routing: buildDiamondRouting(graph),
    cycles: [],
  };

  try {
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${DIAG_PREFIX} failed to write output: ${msg}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'plumbus-frame-analyzer.js') {
  main();
}
