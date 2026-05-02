#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const runnerArgs = [];
const testFiles = [];
let grepPattern = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--grep') {
    const pattern = args[index + 1];
    if (!pattern) {
      process.stderr.write('Missing value for --grep\n');
      process.exit(1);
    }
    grepPattern = pattern;
    runnerArgs.push('--test-name-pattern', pattern);
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) runnerArgs.push(arg);
  else testFiles.push(arg);
}

const selectedFiles = grepPattern
  ? testFiles.filter((file) => readFileSync(file, 'utf8').includes(grepPattern))
  : testFiles;

if (grepPattern && selectedFiles.length === 0) {
  process.stderr.write(`No tests matched --grep ${grepPattern}\n`);
  process.exit(1);
}

const nodeArgs = ['--test', ...runnerArgs, ...selectedFiles];
const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
