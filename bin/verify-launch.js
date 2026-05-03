#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ONE_HOUR_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    samples: path.join(os.homedir(), '.claude', 'pickle-rick', 'deploy-parity-samples.jsonl'),
    out: path.join('bundle', 'ac-dr-07.json'),
    status: path.join('bundle', 'status.json'),
    now: new Date(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--samples' || arg === '--out' || arg === '--status' || arg === '--now') {
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      if (arg === '--samples') options.samples = next;
      if (arg === '--out') options.out = next;
      if (arg === '--status') options.status = next;
      if (arg === '--now') options.now = new Date(next);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (Number.isNaN(options.now.getTime())) throw new Error('--now must be an ISO timestamp');
  return options;
}

function readSamples(samplesPath) {
  const raw = fs.readFileSync(samplesPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSONL at line ${index + 1}`);
      }
    });
}

function sampleTimestamp(sample, index) {
  if (typeof sample.ts !== 'string') throw new Error(`sample ${index + 1} missing ts`);
  const ts = new Date(sample.ts);
  if (Number.isNaN(ts.getTime())) throw new Error(`sample ${index + 1} has invalid ts`);
  return ts;
}

function buildArtifact({ samples, now }) {
  const firstSampleAt = samples.length > 0 ? sampleTimestamp(samples[0], 0) : null;
  const mismatches = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => sample.hashes_match !== true);
  const elapsedMs = firstSampleAt ? now.getTime() - firstSampleAt.getTime() : 0;
  const failures = [];

  if (samples.length < 10) failures.push(`expected at least 10 samples, found ${samples.length}`);
  if (mismatches.length > 0) failures.push(`expected 100% matching samples, found ${mismatches.length} mismatch(es)`);
  if (!firstSampleAt || elapsedMs < ONE_HOUR_MS) failures.push('expected at least one hour since first sample');

  const pass = failures.length === 0;
  return {
    ac_id: 'AC-DR-07',
    pass,
    checked_at: now.toISOString(),
    checker: 'bin/verify-launch.js',
    checker_version: 'local',
    evidence: {
      sample_count: samples.length,
      first_sample_at: firstSampleAt ? firstSampleAt.toISOString() : null,
      elapsed_ms: elapsedMs,
      match_count: samples.length - mismatches.length,
      mismatch_count: mismatches.length,
      status: pass ? 'launch-validated' : 'failed',
      terminal_state: pass ? 'success-pending-soak' : null,
    },
    failure_reason: failures.length > 0 ? failures.join('; ') : null,
    remediation_hint: failures.length > 0 ? 'Wait for deploy parity cron to collect one hour of matching samples, then rerun.' : null,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function verifyLaunch(options) {
  const samples = readSamples(options.samples);
  const artifact = buildArtifact({ samples, now: options.now });
  writeJson(options.out, artifact);

  if (artifact.pass) {
    writeJson(options.status, {
      status: 'launch-validated',
      terminal_state: 'success-pending-soak',
      updated_at: artifact.checked_at,
      ac_id: artifact.ac_id,
      sample_count: artifact.evidence.sample_count,
    });
  }

  return artifact;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'verify-launch.js') {
  try {
    const artifact = verifyLaunch(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(artifact)}\n`);
    process.exit(artifact.pass ? 0 : 1);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
