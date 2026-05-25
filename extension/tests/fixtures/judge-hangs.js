#!/usr/bin/env node
// Judge fixture: hangs indefinitely, ignoring SIGTERM so SIGKILL is required.
// Used by integration tests to exercise the SIGTERM→SIGKILL timeout path in spawnWithClosedStdin.
process.on('SIGTERM', () => {});
setInterval(() => {}, 86_400_000);
