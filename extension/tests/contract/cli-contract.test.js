// @tier: contract
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PINS_PATH = path.resolve(__dirname, '..', '..', '.cli-pins.json');
const PKG_PATH = path.resolve(__dirname, '..', '..', 'package.json');
const PINS = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));
const PKG = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

const ROWS = [
  ['gh',     ['--version'], /^gh version /,  false],
  ['codex',  ['--help'],    /Usage:/,         false],
  ['claude', ['--version'], /Claude Code/,    true],
];

// Static parity guard: codex pin must agree byte-exact across the three
// surfaces that record it (package.json:engines.codex, .cli-pins.json:codex,
// the test consumer above). A future bump to one without the others would
// silently desync; this test fails closed before that can ship.
test('contract: codex pin is identical across package.json:engines and .cli-pins.json', () => {
  const enginesPin = PKG.engines?.codex;
  const cliPin = PINS.codex;
  assert.equal(
    typeof enginesPin === 'string' && enginesPin.length > 0,
    true,
    'package.json:engines.codex must be a non-empty string',
  );
  assert.equal(
    typeof cliPin === 'string' && cliPin.length > 0,
    true,
    '.cli-pins.json:codex must be a non-empty string',
  );
  // Reject range-prefix syntax (^, ~, >=, *, x). The pin must be exact.
  assert.match(
    enginesPin,
    /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/,
    `package.json:engines.codex must be exact-version, got "${enginesPin}"`,
  );
  assert.equal(
    enginesPin,
    cliPin,
    `pin drift: package.json:engines.codex="${enginesPin}" vs .cli-pins.json:codex="${cliPin}"`,
  );
});

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
