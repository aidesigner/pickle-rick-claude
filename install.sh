#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
COMMANDS_DIR="$HOME/.claude/commands"
SETTINGS_FILE="$HOME/.claude/settings.json"
# IMPORTANT: $HOME is intentionally a literal here — it gets expanded at runtime
# by the shell when Claude Code executes the hook command. Do NOT expand it at install time.
HOOK_CMD_LITERAL='node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook'

echo "🥒 Installing Pickle Rick for Claude Code..."

# --- VALIDATION ---
node --version >/dev/null 2>&1    || { echo "❌ node not found on PATH"; exit 1; }
jq --version >/dev/null 2>&1     || { echo "❌ jq not found on PATH"; exit 1; }
rsync --version >/dev/null 2>&1  || { echo "❌ rsync not found on PATH"; exit 1; }
claude --version >/dev/null 2>&1 || echo "⚠️  claude CLI not on PATH (needed at runtime for worker spawning)"
[ -f "$SETTINGS_FILE" ]          || { echo "❌ ~/.claude/settings.json not found. Run 'claude' at least once first."; exit 1; }
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json is not valid JSON"; exit 1; }
[ -d "$SCRIPT_DIR/extension" ]   || { echo "❌ extension/ not found. Are you running from the repo root?"; exit 1; }
[ -d "$SCRIPT_DIR/.claude/commands" ] || { echo "❌ .claude/commands/ not found. Are you running from the repo root?"; exit 1; }

# --- MODE DETECTION ---
if [ -d "$SCRIPT_DIR/.git" ]; then
  INSTALL_MODE="git"
else
  INSTALL_MODE="tarball"
fi
echo "[install.sh] Mode: $INSTALL_MODE" >&2

# --- COMPILE (git mode only) ---
if [ "$INSTALL_MODE" = "git" ]; then
  echo "📦 Installing dependencies..."
  (cd "$SCRIPT_DIR/extension" && npm install --no-fund --no-audit)
  echo "🔨 Compiling TypeScript..."
  (cd "$SCRIPT_DIR/extension" && npx tsc)
else
  echo "[install.sh] Skipping compilation (pre-built tarball)" >&2
fi

# --- BACKUP ---
mkdir -p "$HOME/.claude/backups"
cp "$SETTINGS_FILE" "$HOME/.claude/backups/settings.json.pickle-backup.$(date +%s)"
echo "✅ Backed up settings.json to ~/.claude/backups/"

# --- DIRECTORIES ---
mkdir -p "$EXTENSION_ROOT" "$COMMANDS_DIR" "$EXTENSION_ROOT/activity" "$EXTENSION_ROOT/templates"
chmod 700 "$EXTENSION_ROOT/activity"

# --- EXTENSION SCRIPTS ---
# rsync compiled JS runtime files; exclude TS sources, tests, and dev-only files.
# --delete removes stale files from the destination (e.g. deleted scripts).
# package.json is included — required for ESM "type":"module".
rsync -a --delete --delete-excluded \
  --exclude='node_modules' \
  --exclude='src' \
  --exclude='tests' \
  --exclude='tsconfig.json' \
  --exclude='package-lock.json' \
  "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"
# Merge pickle_settings: repo defaults as base, user values overlaid (preserves customizations)
if [ -f "$EXTENSION_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \
    && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"
else
  cp "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/"
fi
# Store persona snippet — append this to your project's CLAUDE.md
cp "$SCRIPT_DIR/persona.md" "$EXTENSION_ROOT/persona.md"

# --- PERMISSIONS (files with shebangs that may be invoked directly) ---
chmod +x "$EXTENSION_ROOT/extension/hooks/dispatch.js"
chmod +x "$EXTENSION_ROOT/extension/bin/setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/cancel.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-morty.js"
chmod +x "$EXTENSION_ROOT/extension/bin/worker-setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/jar-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/status.js"
chmod +x "$EXTENSION_ROOT/extension/bin/retry-ticket.js"
chmod +x "$EXTENSION_ROOT/extension/bin/mux-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/microverse-runner.js"
ln -sf "$EXTENSION_ROOT/extension/bin/mux-runner.js" "$EXTENSION_ROOT/extension/bin/tmux-runner.js"
chmod +x "$EXTENSION_ROOT/extension/bin/monitor.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-watcher.js"
chmod +x "$EXTENSION_ROOT/extension/bin/morty-watcher.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-refinement-team.js"
chmod +x "$EXTENSION_ROOT/extension/bin/get-session.js"
chmod +x "$EXTENSION_ROOT/extension/bin/update-state.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-activity.js"
chmod +x "$EXTENSION_ROOT/extension/bin/log-commit.js"
chmod +x "$EXTENSION_ROOT/extension/bin/prune-activity.js"
chmod +x "$EXTENSION_ROOT/extension/bin/standup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/metrics.js"
chmod +x "$EXTENSION_ROOT/extension/bin/circuit-reset.js"
chmod +x "$EXTENSION_ROOT/extension/scripts/tmux-monitor.sh"

# --- INTERNAL TEMPLATES (hidden from slash command list) ---
if [ -d "$SCRIPT_DIR/templates" ]; then
  rsync -a "$SCRIPT_DIR/templates/" "$EXTENSION_ROOT/templates/"
fi

# --- COMMANDS ---
# rsync all commands from .claude/commands/; no --delete to preserve user commands.
rsync -a "$SCRIPT_DIR/.claude/commands/" "$COMMANDS_DIR/"

# Clean up legacy commands AFTER rsync (so they're removed even if source still had them)
rm -f "$COMMANDS_DIR/microverse.md"
rm -f "$COMMANDS_DIR/pickle-microverse-tmux.md"

# --- STOP HOOK (idempotent jq merge, $HOME stays LITERAL in JSON) ---
if jq -e '.hooks.Stop // [] | map(.hooks // [] | map(.command)) | flatten | any(. == "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook")' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  Stop hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq '
    "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook" as $cmd |
    {"type": "command", "command": $cmd} as $entry |
    if .hooks == null then
      .hooks = {"Stop": [{"hooks": [$entry]}]}
    elif .hooks.Stop == null then
      .hooks.Stop = [{"hooks": [$entry]}]
    else
      .hooks.Stop += [{"hooks": [$entry]}]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered Stop hook in $SETTINGS_FILE"
fi

# --- POST-TOOL-USE HOOK (git commit activity logger, idempotent) ---
COMMIT_HOOK_CMD='node $HOME/.claude/pickle-rick/extension/bin/log-commit.js'
if jq -e --arg cmd "$COMMIT_HOOK_CMD" \
    '.hooks.PostToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  PostToolUse hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq --arg cmd "$COMMIT_HOOK_CMD" '
    {"type": "command", "command": $cmd, "async": true, "timeout": 5} as $entry |
    {"matcher": "Bash", "hooks": [$entry]} as $group |
    if .hooks == null then
      .hooks = {"PostToolUse": [$group]}
    elif .hooks.PostToolUse == null then
      .hooks.PostToolUse = [$group]
    else
      .hooks.PostToolUse += [$group]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered PostToolUse hook in $SETTINGS_FILE"
fi

# --- VALIDATE result ---
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json corrupted after merge — restore from backup"; exit 1; }

echo ""
echo "✅ Pickle Rick for Claude Code installed!"
echo ""
echo "📝 Persona setup — add the Pickle Rick persona to your project's CLAUDE.md:"
echo ""
echo "   # If your project already has a CLAUDE.md:"
echo "   cat $EXTENSION_ROOT/persona.md >> /path/to/project/.claude/CLAUDE.md"
echo ""
echo "   # If starting fresh:"
echo "   mkdir -p /path/to/project/.claude"
echo "   cp $EXTENSION_ROOT/persona.md /path/to/project/.claude/CLAUDE.md"
echo ""
echo "Get started in any project: /pickle \"your task here\""
echo "Queue tasks for later:      /add-to-pickle-jar  then  /pickle-jar-open"
