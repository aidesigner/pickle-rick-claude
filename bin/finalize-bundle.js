#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateBundleArtifact } from './verify-bundle.js';

const CHECKER = 'bin/finalize-bundle.js';
const CHECKER_VERSION = 'local';
const RELEASE_TAG = 'v1.66.0';
const SOAK_MS = 24 * 60 * 60 * 1000;
const MIN_SAMPLES = Math.floor((24 * 60 * 60 / 300) * 0.9);

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    baseline: process.env.PICKLE_BASELINE_PATH ?? homePath('.claude', 'pickle-rick', 'deploy-baseline.json'),
    samples: homePath('.claude', 'pickle-rick', 'deploy-parity-samples.jsonl'),
    bundleDir: path.join(process.cwd(), 'bundle'),
    status: null,
    now: new Date(),
    gh: 'gh',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (['--baseline', '--samples', '--bundle-dir', '--status', '--now', '--gh'].includes(arg)) {
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === '--baseline') options.baseline = next;
      if (arg === '--samples') options.samples = next;
      if (arg === '--bundle-dir') options.bundleDir = next;
      if (arg === '--status') options.status = next;
      if (arg === '--now') options.now = new Date(next);
      if (arg === '--gh') options.gh = next;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (Number.isNaN(options.now.getTime())) throw new Error('--now must be an ISO timestamp');
  options.baseline = expandHome(options.baseline);
  options.samples = expandHome(options.samples);
  options.bundleDir = expandHome(options.bundleDir);
  options.status = expandHome(options.status ?? path.join(options.bundleDir, 'status.json'));
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSamples(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`invalid JSONL at line ${index + 1}`);
    }
  });
}

function sampleTs(sample, index) {
  if (typeof sample.ts !== 'string') throw new Error(`sample ${index + 1} missing ts`);
  const ts = new Date(sample.ts);
  if (Number.isNaN(ts.getTime())) throw new Error(`sample ${index + 1} has invalid ts`);
  return ts;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function artifact(acId, pass, checkedAt, evidence, failureReason = null, remediationHint = null) {
  const value = {
    ac_id: acId,
    pass,
    checked_at: checkedAt,
    checker: CHECKER,
    checker_version: CHECKER_VERSION,
    evidence,
    failure_reason: failureReason,
    remediation_hint: remediationHint,
  };
  const errors = validateBundleArtifact(value);
  if (errors.length > 0) throw new Error(`${acId} artifact invalid: ${errors.join('; ')}`);
  return value;
}

function windowSamples(samples, installedAt) {
  const end = new Date(installedAt.getTime() + SOAK_MS);
  return samples.filter((sample, index) => {
    const ts = sampleTs(sample, index);
    return ts >= installedAt && ts <= end;
  });
}

function mismatches(samples) {
  return samples.flatMap((sample, index) => {
    const failures = [];
    if (sample.hashes_match !== true) failures.push('hashes_match');
    if (sample.src_version !== sample.dep_version) failures.push('version_mismatch');
    return failures.length === 0 ? [] : [{ index, ts: sample.ts ?? null, failures, sample }];
  });
}

function archivePath(bundleDir) {
  const dispositionPath = path.join(bundleDir, 'v1.66.0-disposition.json');
  if (fs.existsSync(dispositionPath)) {
    const disposition = readJson(dispositionPath);
    if (typeof disposition.tarball_path === 'string') {
      const candidate = path.isAbsolute(disposition.tarball_path)
        ? disposition.tarball_path
        : path.resolve(path.dirname(bundleDir), disposition.tarball_path);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const archiveDir = path.join(bundleDir, 'pre-deletion-archive');
  if (!fs.existsSync(archiveDir)) return null;
  const archivedTarball = fs.readdirSync(archiveDir)
    .find((name) => name.includes('1.66.0') && name.endsWith('.tar.gz'));
  return archivedTarball ? path.join(archiveDir, archivedTarball) : null;
}

function updateDisposition(bundleDir, checkedAt, deleted) {
  const filePath = path.join(bundleDir, 'v1.66.0-disposition.json');
  const current = fs.existsSync(filePath) ? readJson(filePath) : { tag: RELEASE_TAG };
  writeJson(filePath, {
    ...current,
    decision_pending: false,
    decision: deleted ? 'deleted_post_soak' : 'dry_run_delete_post_soak',
    decided_at: checkedAt,
  });
}

function writeStatus(filePath, status, checkedAt, acId, sampleCount) {
  writeJson(filePath, {
    status,
    terminal_state: status,
    updated_at: checkedAt,
    ac_id: acId,
    sample_count: sampleCount,
  });
}

function deleteRelease(gh) {
  const result = spawnSync(gh, ['release', 'delete', RELEASE_TAG, '--yes'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`gh release delete ${RELEASE_TAG} failed: ${result.stderr || result.stdout || result.status}`);
  }
}

export function finalizeBundle(options) {
  const checkedAt = options.now.toISOString();
  const baseline = readJson(options.baseline);
  const installedAt = new Date(baseline.installed_at);
  if (Number.isNaN(installedAt.getTime())) throw new Error('baseline missing valid installed_at');
  const samples = windowSamples(readSamples(options.samples), installedAt);
  const drift = mismatches(samples);
  const baseEvidence = {
    installed_at: installedAt.toISOString(),
    window_end: new Date(installedAt.getTime() + SOAK_MS).toISOString(),
    sample_count: samples.length,
    required_samples: MIN_SAMPLES,
    match_count: samples.length - drift.length,
    mismatch_count: drift.length,
    dry_run: options.dryRun,
  };

  if (samples.length < MIN_SAMPLES) {
    const ac03 = artifact('AC-DR-03', false, checkedAt, baseEvidence, 'insufficient-samples', 'Wait for 24h deploy parity sampling, then rerun.');
    writeJson(path.join(options.bundleDir, 'ac-dr-03.json'), ac03);
    writeStatus(options.status, 'regression-detected', checkedAt, 'AC-DR-03', samples.length);
    return { exitCode: 2, ac03 };
  }
  if (drift.length > 0) {
    const ac03 = artifact('AC-DR-03', false, checkedAt, { ...baseEvidence, drift }, 'deploy-drift', 'Investigate sample drift before deleting v1.66.0.');
    writeJson(path.join(options.bundleDir, 'ac-dr-03.failed.json'), ac03);
    writeStatus(options.status, 'regression-detected', checkedAt, 'AC-DR-03', samples.length);
    return { exitCode: 1, ac03 };
  }

  const archive = archivePath(options.bundleDir);
  const ac03 = artifact('AC-DR-03', true, checkedAt, { ...baseEvidence, archive_path: archive }, null, null);
  writeJson(path.join(options.bundleDir, 'ac-dr-03.json'), ac03);
  if (!archive) {
    const ac12 = artifact('AC-DR-12', false, checkedAt, { release_tag: RELEASE_TAG, archive_exists: false, dry_run: options.dryRun }, 'missing-pre-deletion-archive', 'Create bundle/pre-deletion-archive tarball before cleanup.');
    writeJson(path.join(options.bundleDir, 'ac-dr-12.json'), ac12);
    return { exitCode: 2, ac03, ac12 };
  }

  if (!options.dryRun) deleteRelease(options.gh);
  updateDisposition(options.bundleDir, checkedAt, !options.dryRun);
  const ac12 = artifact('AC-DR-12', true, checkedAt, {
    release_tag: RELEASE_TAG,
    archive_path: archive,
    delete_invoked: !options.dryRun,
    dry_run: options.dryRun,
  }, null, null);
  writeJson(path.join(options.bundleDir, 'ac-dr-12.json'), ac12);
  writeStatus(options.status, 'pass', checkedAt, 'AC-DR-12', samples.length);
  return { exitCode: 0, ac03, ac12 };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'finalize-bundle.js') {
  try {
    const result = finalizeBundle(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, ac03: result.ac03.pass, ac12: result.ac12?.pass ?? null })}\n`);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
