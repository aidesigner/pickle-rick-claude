## Trap Doors

- `purge-update-cache.js` — INVARIANT: purge root is `PICKLE_DATA_ROOT` or `~/.codex/pickle-rick`. BREAKS: poisoned updater cache survives release cleanup. ENFORCE: extension/tests/purge-update-cache.test.js. PATTERN_SHAPE: `path.join(os.homedir(), '.claude', 'pickle-rick')`.
