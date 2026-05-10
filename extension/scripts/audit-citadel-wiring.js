#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXCLUDED_FILENAMES = new Set([
  'audit-runner.ts',
  'reporter.ts',
  'diff-walker.ts',
  'prd-parser.ts',
]);

function isExcluded(filename) {
  if (EXCLUDED_FILENAMES.has(filename)) return true;
  if (filename.endsWith('-helpers.ts')) return true;
  if (filename.endsWith('-types.ts')) return true;
  return false;
}

export function runAudit(citadelDir, runnerPath) {
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`audit-runner.ts not found: ${runnerPath}`);
  }

  let entries;
  try {
    entries = fs.readdirSync(citadelDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read citadel directory: ${citadelDir}: ${msg}`);
  }

  const runnerContent = fs.readFileSync(runnerPath, 'utf-8');

  const analyzers = entries
    .filter((f) => f.endsWith('.ts') && !isExcluded(f))
    .sort();

  return analyzers.map((filename) => {
    const name = filename.slice(0, -3);
    const wired = runnerContent.includes(`from './${name}.js'`) || runnerContent.includes(`from './${name}'`);
    const file_size_bytes = fs.statSync(path.join(citadelDir, filename)).size;
    return { analyzer: name, wired, file_size_bytes };
  });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'audit-citadel-wiring.js') {
  const args = process.argv.slice(2);
  let strict = false;
  let outPath = null;
  let citadelDirOverride = null;
  let runnerPathOverride = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strict') {
      strict = true;
    } else if (args[i] === '--out' && args[i + 1]) {
      outPath = args[i + 1];
      i++;
    } else if (args[i] === '--citadel-dir' && args[i + 1]) {
      citadelDirOverride = args[i + 1];
      i++;
    } else if (args[i] === '--runner-path' && args[i + 1]) {
      runnerPathOverride = args[i + 1];
      i++;
    }
  }

  const defaultCitadelDir = path.resolve(__dirname, '../src/services/citadel');
  const citadelDir = citadelDirOverride ?? defaultCitadelDir;
  const runnerPath = runnerPathOverride ?? path.join(defaultCitadelDir, 'audit-runner.ts');

  let results;
  try {
    results = runAudit(citadelDir, runnerPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`audit-citadel-wiring: ${msg}\n`);
    process.exit(1);
  }

  const output = JSON.stringify(results, null, 2);

  if (outPath) {
    fs.writeFileSync(outPath, `${output}\n`, 'utf-8');
  } else {
    process.stdout.write(`${output}\n`);
  }

  if (strict && results.some((r) => !r.wired)) {
    const unwired = results.filter((r) => !r.wired).map((r) => r.analyzer);
    process.stderr.write(`audit-citadel-wiring: unwired analyzers: ${unwired.join(', ')}\n`);
    process.exit(1);
  }
}
