#!/bin/bash
set -e

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "🥒 Uninstalling Pickle Rick for Claude Code..."

# Remove extension scripts (guard: ensure $HOME is set to prevent catastrophic rm -rf)
if [ -z "$HOME" ]; then echo "❌ \$HOME is not set — aborting to prevent data loss."; exit 1; fi
rm -rf "$HOME/.claude/pickle-rick/"

# Remove commands (by exact name — does NOT touch user's other commands)
rm -f "$HOME/.claude/commands/pickle.md"
rm -f "$HOME/.claude/commands/pickle-prd.md"
rm -f "$HOME/.claude/commands/eat-pickle.md"
rm -f "$HOME/.claude/commands/help-pickle.md"
rm -f "$HOME/.claude/commands/send-to-morty.md"
rm -f "$HOME/.claude/commands/add-to-pickle-jar.md"
rm -f "$HOME/.claude/commands/pickle-jar-open.md"
rm -f "$HOME/.claude/commands/disable-pickle.md"
rm -f "$HOME/.claude/commands/enable-pickle.md"
rm -f "$HOME/.claude/commands/pickle-status.md"
rm -f "$HOME/.claude/commands/pickle-retry.md"
rm -f "$HOME/.claude/commands/pickle-tmux.md"
rm -f "$HOME/.claude/commands/pickle-refine-prd.md"
rm -f "$HOME/.claude/commands/meeseeks.md"

# Remove Stop hook from settings.json (clean up empty Stop/hooks keys)
if [ -f "$SETTINGS_FILE" ]; then
  TMPFILE="$(mktemp)"
  jq '
    "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook" as $cmd |
    if .hooks.Stop then
      .hooks.Stop = [.hooks.Stop[] | select(.hooks | map(.command) | any(. == $cmd) | not)] |
      if (.hooks.Stop | length) == 0 then del(.hooks.Stop) else . end |
      if (.hooks | keys | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Removed Stop hook from settings.json"
fi

echo ""
echo "✅ Pickle Rick uninstalled."
echo "📝 Project-local CLAUDE.md files were NOT removed — delete them manually if desired."
echo "📝 Backup: ~/.claude/backups/ (if you ran install.sh) — safe to delete manually."
