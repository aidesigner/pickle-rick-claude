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

// Static parity guard: the codex version recorded in package.json:engines.codex
// must agree with .cli-pins.json:codex (and the test consumer above). engines.codex
// is a `>=X.Y.Z` floor (c24b3c6b: codex is a daily-bumping 0.x CLI, so an exact pin
// hard-killed setup on every operator auto-update); an exact `X.Y.Z` shape is also
// accepted for back-compat. Either way the version COMPONENT must equal the
// .cli-pins.json pin — a future bump to one without the other silently desyncs, and
// caret/tilde/star/x ranges remain rejected. This test fails closed before drift ships.
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
  // Accept an exact `X.Y.Z` pin OR a `>=X.Y.Z` floor (the sanctioned shape for the
  // daily-bumping codex 0.x CLI). Caret (^), tilde (~), wildcard (*/x) remain rejected.
  const shape = /^(>=)?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$/;
  assert.match(
    enginesPin,
    shape,
    `package.json:engines.codex must be an exact version or a ">=" floor, got "${enginesPin}"`,
  );
  // Parity is on the version component (strip an optional ">=" floor prefix).
  const enginesVersion = enginesPin.replace(/^>=/, '');
  assert.equal(
    enginesVersion,
    cliPin,
    `pin drift: package.json:engines.codex="${enginesPin}" (version "${enginesVersion}") vs .cli-pins.json:codex="${cliPin}"`,
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
