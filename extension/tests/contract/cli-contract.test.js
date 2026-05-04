// @tier: contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PINS_PATH = path.resolve(__dirname, '..', '..', '.cli-pins.json');
const PINS = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));

const ROWS = [
  ['gh',     ['--version'], /^gh version /,  false],
  ['codex',  ['--help'],    /Usage:/,         false],
  ['claude', ['--version'], /Claude Code/,    true],
];

for (const [bin, argv, surfaceRegex, isRecursive] of ROWS) {
  test(`contract: ${bin} ${argv.join(' ')}`, (t) => {
    const found = spawnSync('which', [bin]);
    if (found.status !== 0) {
      t.skip(JSON.stringify({ reason: 'binary-absent', condition: bin }));
      return;
    }
    const pinned = PINS[bin];
    const versionOut = spawnSync(bin, argv, { encoding: 'utf8' });
    if (pinned && !versionOut.stdout.includes(pinned)) {
      t.skip(JSON.stringify({ reason: 'version-pin-mismatch', condition: `${bin} expected ${pinned}` }));
      return;
    }
    if (isRecursive && process.env.CLAUDE_INSIDE_HARNESS === '1') {
      t.skip(JSON.stringify({ reason: 'recursive-harness-detected', condition: bin }));
      return;
    }
    assert.match(versionOut.stdout, surfaceRegex);
  });
}
