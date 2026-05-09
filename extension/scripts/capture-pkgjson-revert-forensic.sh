#!/usr/bin/env bash
# Capture a forensic snapshot whenever extension/package.json:version appears to have reverted.
# Run this script immediately when a version revert is observed or suspected.
# Output: extension/audit/pkgjson-revert-<iso>.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
EXTENSION_DIR="$REPO_ROOT/extension"
DEPLOY_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"
DEPLOY_EXT="$DEPLOY_ROOT/extension"
AUDIT_DIR="$EXTENSION_DIR/audit"

ISO="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUTPUT="$AUDIT_DIR/pkgjson-revert-${ISO}.json"

mkdir -p "$AUDIT_DIR"

# Helper: md5 a file portably
md5_file() {
  local f="$1"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$f" 2>/dev/null | awk '{print $1}' || echo "error"
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$f" 2>/dev/null || echo "error"
  else
    echo "unavailable"
  fi
}

# Helper: read version from package.json
read_version() {
  local f="$1"
  if [ -f "$f" ]; then
    jq -r '.version // "missing"' "$f" 2>/dev/null || echo "parse-error"
  else
    echo "not-found"
  fi
}

SRC_VERSION="$(read_version "$EXTENSION_DIR/package.json")"
DEP_VERSION="$(read_version "$DEPLOY_EXT/package.json")"

# 5 most-trafficked compiled JS files
PARITY_FILES=(
  "types/index.js"
  "services/state-manager.js"
  "bin/spawn-morty.js"
  "bin/mux-runner.js"
  "services/pickle-utils.js"
)

hashes_json="{}"
for rel in "${PARITY_FILES[@]}"; do
  src_hash="$(md5_file "$EXTENSION_DIR/$rel")"
  dep_hash="$(md5_file "$DEPLOY_EXT/$rel")"
  hashes_json="$(echo "$hashes_json" | jq --arg k "$rel" --arg sh "$src_hash" --arg dh "$dep_hash" '. + {($k): {src: $sh, deployed: $dh}}')"
done

# Install audit log tail (last 20 lines)
AUDIT_LOG="$DEPLOY_ROOT/deploy-audit.log"
if [ -f "$AUDIT_LOG" ]; then
  audit_tail="$(tail -20 "$AUDIT_LOG" 2>/dev/null || echo "")"
else
  audit_tail="not-found"
fi

# Git log for extension/package.json in the last hour
git_log="$(git -C "$REPO_ROOT" log --oneline --since='1 hour ago' -- extension/package.json 2>/dev/null || echo "git-unavailable")"

# Write JSON snapshot
jq -n \
  --arg captured_at "$ISO" \
  --arg src_version "$SRC_VERSION" \
  --arg deployed_version "$DEP_VERSION" \
  --arg src_pkgjson "$EXTENSION_DIR/package.json" \
  --arg dep_pkgjson "$DEPLOY_EXT/package.json" \
  --argjson file_hashes "$hashes_json" \
  --arg install_audit_tail "$audit_tail" \
  --arg git_log_1h "$git_log" \
  '{
    captured_at: $captured_at,
    src_version: $src_version,
    deployed_version: $deployed_version,
    src_pkgjson_path: $src_pkgjson,
    dep_pkgjson_path: $dep_pkgjson,
    file_hashes: $file_hashes,
    install_audit_tail_20: $install_audit_tail,
    git_log_1h: $git_log_1h
  }' > "$OUTPUT"

echo "✅ Forensic snapshot written: $OUTPUT"
echo "   src_version=$SRC_VERSION  deployed_version=$DEP_VERSION"

# Log activity event if log-activity.js is available
LOG_ACTIVITY="$DEPLOY_ROOT/extension/bin/log-activity.js"
if [ -f "$LOG_ACTIVITY" ]; then
  node "$LOG_ACTIVITY" pkgjson_revert_forensic_captured \
    "forensic_artifact_path=$OUTPUT suspected_hypothesis=h-c src_version=$SRC_VERSION deployed_version=$DEP_VERSION" \
    2>/dev/null || true
fi
