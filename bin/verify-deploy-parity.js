#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SOURCE_REPO = '/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude';
const HASH_FILES = [
  ['check-update.js', 'extension/bin/check-update.js'],
  ['state-manager.js', 'extension/services/state-manager.js'],
  ['types/index.js', 'extension/types/index.js'],
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPackageVersion(filePath) {
  const pkg = readJson(filePath);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`package missing version: ${filePath}`);
  }
  return pkg.version;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function deployedHashes(runtimeRoot) {
  return Object.fromEntries(
    HASH_FILES.map(([key, relPath]) => [key, sha256(path.join(runtimeRoot, relPath))]),
  );
}

function compareHashes(actual, baseline) {
  const drift = {};
  for (const [name] of HASH_FILES) {
    if (actual[name] !== baseline[name]) {
      drift[name] = { baseline: baseline[name] ?? null, actual: actual[name] ?? null };
    }
  }
  return drift;
}

export function sampleDeployParity(options = {}) {
  const sourceRepo = options.sourceRepo ?? process.env.SOURCE_REPO ?? DEFAULT_SOURCE_REPO;
  const runtimeRoot = options.runtimeRoot
    ?? process.env.PICKLE_DEPLOY_ROOT
    ?? path.join(os.homedir(), '.claude', 'pickle-rick');
  const baselinePath = path.join(runtimeRoot, 'deploy-baseline.json');

  if (!fs.existsSync(baselinePath)) {
    return { exitCode: 2, stderr: 'baseline missing — run install.sh\n' };
  }

  const baseline = readJson(baselinePath);
  const srcVersion = readPackageVersion(path.join(sourceRepo, 'extension/package.json'));
  const depVersion = readPackageVersion(path.join(runtimeRoot, 'extension/package.json'));
  const actualHashes = deployedHashes(runtimeRoot);
  const drift = compareHashes(actualHashes, baseline.content_hashes ?? {});

  if (baseline.src_version !== srcVersion) {
    drift.src_version = { baseline: baseline.src_version ?? null, actual: srcVersion };
  }
  if (baseline.dep_version !== depVersion) {
    drift.dep_version = { baseline: baseline.dep_version ?? null, actual: depVersion };
  }

  const hashesMatch = Object.keys(drift).length === 0;
  const line = {
    ts: new Date().toISOString(),
    src_version: srcVersion,
    dep_version: depVersion,
    hashes_match: hashesMatch,
  };
  if (!hashesMatch) line.drift = drift;
  return { exitCode: 0, stdout: `${JSON.stringify(line)}\n` };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-deploy-parity.js') {
  try {
    const result = sampleDeployParity();
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
