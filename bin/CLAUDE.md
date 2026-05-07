## Trap Doors

- `purge-update-cache.js` — INVARIANT: purge root MUST equal `getExtensionRoot()` (`EXTENSION_DIR` env override, default `~/.claude/pickle-rick`); `update-check.json` and `deploy-audit.log` are written by `extension/src/bin/check-update.ts` and `install.sh` to that path. BREAKS: purge no-ops in production (commit 5fc4ecee shipped `.codex/pickle-rick` default which never matches the real cache location); stale auto-updater cache poisons the next update check. ENFORCE: extension/tests/purge-update-cache.test.js. PATTERN_SHAPE: `path.join(os.homedir(), '.codex', 'pickle-rick')`.
