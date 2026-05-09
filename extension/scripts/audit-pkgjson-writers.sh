#!/usr/bin/env bash
# Audit files/scripts that write to package.json:version without touching content fields.
# Greps extension/, ~/.claude/pickle-rick/, ~/.claude/, and npm/yarn cache dirs.
# Output: structured list of suspected writers ranked by recency.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DEPLOY_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"

echo "# pkgjson Writer Audit"
echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Pattern: files that mention package.json AND version write semantics
VERSION_WRITE_PATTERNS='(jq.*\.version|\.version\s*=|"version"\s*:|\bversion\b.*package\.json|package\.json.*version)'

echo "## 1. Source repo (extension/)"
echo ""
# Only look for files that could modify package.json (shell scripts, JS, TS)
{
  grep -rl --include="*.sh" --include="*.js" --include="*.ts" \
    '"version"' "$REPO_ROOT/extension/src/" 2>/dev/null || true
  grep -rl --include="*.sh" \
    '\.version\|package\.json' "$REPO_ROOT/extension/scripts/" 2>/dev/null || true
  grep -rl --include="*.sh" \
    'package\.json' "$REPO_ROOT/" --max-depth=1 2>/dev/null || true
} | sort -u | while read -r f; do
  mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -c1-19 || echo "unknown")"
  echo "  - $f  (mtime: $mtime)"
done | sort -t'(' -k2 -r || true
echo ""

echo "## 2. Deployed extension (~/.claude/pickle-rick/extension/)"
echo ""
{
  grep -rl --include="*.js" --include="*.sh" \
    '"version"' "$DEPLOY_ROOT/extension/bin/" 2>/dev/null || true
  grep -rl --include="*.js" \
    'package\.json' "$DEPLOY_ROOT/extension/bin/" 2>/dev/null || true
} | sort -u | while read -r f; do
  mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -c1-19 || echo "unknown")"
  echo "  - $f  (mtime: $mtime)"
done || true
echo ""

echo "## 3. ~/.claude/ commands and settings"
echo ""
{
  grep -rl --include="*.md" --include="*.sh" --include="*.js" \
    'package\.json' "$HOME/.claude/" --max-depth=2 2>/dev/null || true
} | sort -u | while read -r f; do
  mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -c1-19 || echo "unknown")"
  echo "  - $f  (mtime: $mtime)"
done || true
echo ""

echo "## 4. npm/yarn cache (stale package.json with version field)"
echo ""
NPM_CACHE="$(npm config get cache 2>/dev/null || echo "$HOME/.npm")"
YARN_CACHE="${HOME}/.yarn/cache"
for cache_dir in "$NPM_CACHE" "$YARN_CACHE"; do
  if [ -d "$cache_dir" ]; then
    echo "  Cache dir: $cache_dir"
    # Look for pickle-rick-scripts package.json entries in cache
    find "$cache_dir" -name "package.json" -newer "$REPO_ROOT/extension/package.json" \
      2>/dev/null | xargs grep -l '"name".*"pickle-rick' 2>/dev/null | head -5 | while read -r f; do
      v="$(jq -r '.version // "?"' "$f" 2>/dev/null || echo "?")"
      mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$f" 2>/dev/null || stat -c '%y' "$f" 2>/dev/null | cut -c1-19 || echo "unknown")"
      echo "    - $f  version=$v  mtime=$mtime"
    done || true
  fi
done
echo ""

echo "## 5. Ranked suspected writers (by recency)"
echo ""
echo "  1. check-update.ts:performUpgrade (H-C) — runs install.sh from tarball extractDir,"
echo "     which overwrites deployed extension/package.json with tarball version"
echo "  2. install.sh (manual run) — rsync src→deployed, may read/deploy lower version"
echo "     if src version was uncommitted"
echo "  3. VS Code/Cursor (H-E) — format-on-save or git-revert-on-branch-switch"
echo "  4. npm install (H-A) — if operator runs npm install directly in extension/"
echo ""
echo "# End of audit"
