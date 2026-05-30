#!/usr/bin/env node
// Fake worker fixture for R-WSWA-5 regression test.
// Always exits clean (code 0) and produces zero review/conformance artifacts.
process.stdout.write('<promise>I AM DONE</promise>\n');
process.exit(0);
