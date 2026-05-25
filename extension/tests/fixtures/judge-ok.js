#!/usr/bin/env node
// Judge fixture: outputs a valid score JSON and exits 0.
// Used by integration tests as a real-spawn stand-in for the claude judge binary.
process.stdout.write('{"score":85}\n');
process.exit(0);
