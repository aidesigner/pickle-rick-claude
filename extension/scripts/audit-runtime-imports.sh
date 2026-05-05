#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"
OUT_FILE="$EXTENSION_DIR/audit-runtime-imports.json"

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

EXTENSION_DIR="$EXTENSION_DIR" \
DEPLOY_ROOT="$DEPLOY_ROOT" \
OUT_FILE="$OUT_FILE" \
node -e "
const fs = require('fs');
const path = require('path');
const { EXTENSION_DIR, DEPLOY_ROOT, OUT_FILE } = process.env;

const SCAN_DIRS = [
  path.join(EXTENSION_DIR, 'src', 'services'),
  path.join(EXTENSION_DIR, 'src', 'bin'),
];

const builtins = new Set(require('module').builtinModules);

function walkTs(dir, results) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, results);
    else if (entry.isFile() && entry.name.endsWith('.ts')) results.push(full);
  }
}

const tsFiles = [];
for (const d of SCAN_DIRS) walkTs(d, tsFiles);

const importRe = /^(import|export)\s[^;]+from\s+'([^']+)'/;
const pkgMap = new Map();

for (const tsFile of tsFiles) {
  const relFile = path.relative(EXTENSION_DIR, tsFile);
  const lines = fs.readFileSync(tsFile, 'utf8').split('\n');
  for (const line of lines) {
    const m = importRe.exec(line);
    if (!m) continue;
    const mod = m[2];
    if (mod.startsWith('.') || mod.startsWith('/')) continue;
    const bare = mod.startsWith('node:') ? mod.slice(5) : mod;
    if (builtins.has(bare)) continue;
    if (mod.startsWith('@types/')) continue;
    if (!pkgMap.has(mod)) pkgMap.set(mod, new Set());
    pkgMap.get(mod).add(relFile);
  }
}

const deployModulesDir = path.join(DEPLOY_ROOT, 'extension', 'node_modules');
const srcModulesDir = path.join(EXTENSION_DIR, 'node_modules');

const packages = [];
for (const [name, files] of [...pkgMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const deployPath = path.join(deployModulesDir, name);
  const srcPath = path.join(srcModulesDir, name);
  const resolvedPath = fs.existsSync(deployPath) ? deployPath
    : fs.existsSync(srcPath) ? srcPath
    : null;
  packages.push({ name, source_files: [...files].sort(), deploy_path: resolvedPath });
}

const auditedAt = new Date().toISOString();
fs.writeFileSync(OUT_FILE, JSON.stringify({ audited_at: auditedAt, packages }, null, 2) + '\n');
process.stdout.write('[audit-runtime-imports] ' + packages.length + ' package(s) -> ' + path.basename(OUT_FILE) + '\n');
"
