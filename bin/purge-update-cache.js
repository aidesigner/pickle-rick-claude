#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const unexpected = args.filter((arg) => arg !== '--dry-run');

if (unexpected.length > 0) {
  process.stderr.write(`Usage: purge-update-cache.js [--dry-run]\n`);
  process.exit(2);
}

const runtimeRoot = path.join(os.homedir(), '.claude', 'pickle-rick');
const cachePath = path.join(runtimeRoot, 'update-check.json');
const auditPath = path.join(runtimeRoot, 'deploy-audit.log');
const removedPaths = [];

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function removePath(targetPath) {
  if (!pathExists(targetPath)) return;
  removedPaths.push(targetPath);
  if (!dryRun) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
  process.stderr.write(`[purge-update-cache] ${dryRun ? 'Would remove' : 'Removed'} ${targetPath}\n`);
}

function collectPrefixMatches(dir, prefix) {
  try {
    return fs.readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

function collectVarFolderMatches(rootDir) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.name.startsWith('pickle-update-')) {
        matches.push(fullPath);
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return matches;
}

function appendAudit() {
  if (removedPaths.length === 0) return;
  const event = {
    event: 'CACHE_PURGE',
    removed_paths: removedPaths,
    ts: new Date().toISOString(),
  };
  if (!dryRun) {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(event)}\n`);
  }
}

removePath(cachePath);

const tmpRoot = process.env.TMPDIR || os.tmpdir();
for (const targetPath of collectPrefixMatches(tmpRoot, 'pickle-update-')) {
  removePath(targetPath);
}

const varFoldersRoot = process.env.PICKLE_PURGE_VAR_FOLDERS_ROOT || '/var/folders';
if (process.platform === 'darwin') {
  for (const targetPath of collectVarFolderMatches(varFoldersRoot)) {
    removePath(targetPath);
  }
}

appendAudit();
