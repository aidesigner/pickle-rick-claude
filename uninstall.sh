#!/bin/bash
set -e

# uninstall.sh — Full Pickle Rick removal.
#
# Removes:
#   1. All hooks from ~/.claude/settings.json (via uninstall-hooks.sh)
#   2. Extension scripts at ~/.claude/pickle-rick/
#   3. Slash commands at ~/.claude/commands/pickle*.md and related
#
# Preserves:
#   - Session history at ~/.claude/pickle-rick/sessions/  (delete manually if desired)
#   - Activity logs at ~/.claude/pickle-rick/activity/
#   - Settings backups at ~/.claude/backups/
#   - Project-local CLAUDE.md files
#
# If you only want to disable automatic behavior (hooks) while keeping
# slash commands available for manual use, run uninstall-hooks.sh instead.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
COMMANDS_DIR="$HOME/.claude/commands"

echo "🥒 Uninstalling Pickle Rick for Claude Code..."

# --- VALIDATION ---
if [ -z "$HOME" ]; then echo "❌ \$HOME is not set — aborting to prevent data loss."; exit 1; fi

# --- REMOVE HOOKS (delegate to uninstall-hooks.sh) ---
if [ -f "$SCRIPT_DIR/uninstall-hooks.sh" ]; then
  bash "$SCRIPT_DIR/uninstall-hooks.sh"
else
  echo "⚠️  uninstall-hooks.sh not found alongside uninstall.sh — skipping hook removal"
  echo "    Remove hooks manually from ~/.claude/settings.json"
fi

# --- REMOVE EXTENSION SCRIPTS ---
# Guard: $HOME is validated above. rm -rf only inside ~/.claude/pickle-rick.
if [ -d "$EXTENSION_ROOT" ]; then
  rm -rf "$EXTENSION_ROOT"
  echo "✅ Removed extension scripts at $EXTENSION_ROOT"
else
  echo "ℹ️  No extension scripts at $EXTENSION_ROOT — skipping"
fi

# --- REMOVE SLASH COMMANDS ---
# Derived from .claude/commands/ in the source repo. Explicit list so the
# script works from a tarball (no repo) and never touches user commands
# that happen to start with "pickle" but aren't ours.
PICKLE_COMMANDS=(
  add-to-pickle-jar
  anatomy-park
  attract
  council-of-ricks
  disable-pickle
  eat-pickle
  enable-pickle
  help-pickle
  meeseeks
  meeseeks-zellij
  pickle
  pickle-dot
  pickle-dot-patterns
  pickle-jar-open
  pickle-metrics
  pickle-microverse
  pickle-prd
  pickle-refine-prd
  pickle-retry
  pickle-standup
  pickle-status
  pickle-tmux
  pickle-zellij
  portal-gun
  project-mayhem
  send-to-morty
  send-to-morty-review
  szechuan-sauce
)

# Legacy commands from older versions — clean up if present
LEGACY_COMMANDS=(
  microverse
  pickle-microverse-tmux
  pickle-portal
)

REMOVED_COUNT=0
for cmd in "${PICKLE_COMMANDS[@]}" "${LEGACY_COMMANDS[@]}"; do
  if [ -f "$COMMANDS_DIR/$cmd.md" ]; then
    rm -f "$COMMANDS_DIR/$cmd.md"
    REMOVED_COUNT=$((REMOVED_COUNT + 1))
  fi
done
echo "✅ Removed $REMOVED_COUNT slash command file(s) from $COMMANDS_DIR"

# --- REMOVE REPO-LOCAL tsc SYMLINK (created by install.sh in git mode) ---
if [ -L "$SCRIPT_DIR/node_modules/.bin/tsc" ]; then
  rm -f "$SCRIPT_DIR/node_modules/.bin/tsc"
  echo "✅ Removed repo-local tsc symlink"
fi

echo ""
echo "✅ Pickle Rick uninstalled."
echo "📝 Project-local CLAUDE.md files were NOT removed — delete them manually if desired."
echo "📝 Settings backups at ~/.claude/backups/ — safe to delete manually."
echo "📝 Session history (if any) was removed with $EXTENSION_ROOT/sessions/"
