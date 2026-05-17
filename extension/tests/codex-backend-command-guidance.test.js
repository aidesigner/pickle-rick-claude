// @tier: fast
/**
 * R-CCPM-1b-3 / AC-R-CCPM-1b-3 — codex backend guidance must keep the
 * tmux-direct workaround explicit across operator-facing command surfaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKLE = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'pickle.md');
const PICKLE_TMUX = path.resolve(__dirname, '..', '..', '.claude', 'commands', 'pickle-tmux.md');
const README = path.resolve(__dirname, '..', '..', 'README.md');

function read(p) {
  return fs.readFileSync(p, 'utf-8');
}

test('R-CCPM-1b-3: /pickle codex guidance recommends /pickle-tmux for longer codex sessions', () => {
  const content = read(PICKLE);
  assert.match(content, /prefer `\/pickle-tmux` for anything likely to run longer than about 30 minutes/i);
  assert.match(content, /safe codex workflow is tmux-direct/i);
  assert.match(content, /Do NOT run a long codex-backed pipeline in the risky "codex is the parent of mux-runner" arrangement\./);
});

test('R-CCPM-1b-3: /pickle-tmux codex guidance pins the safe process tree', () => {
  const content = read(PICKLE_TMUX);
  assert.match(content, /tmux pane runs `mux-runner` directly under the shell/i);
  assert.match(content, /Target process tree: `zsh -> tmux pane -> node \.\.\.\/mux-runner\.js -> codex exec`\./);
  assert.match(content, /codex is the worker child, not the parent of mux-runner\./i);
});

test('R-CCPM-1b-3: README backend guidance stays aligned with tmux-direct workaround', () => {
  const content = read(README);
  assert.match(content, /keep `\/pickle` for short interactive work and prefer `\/pickle-tmux` for longer sessions/i);
  assert.match(content, /safe workaround is tmux-direct/i);
  assert.match(content, /Avoid the risky arrangement where a long-lived codex session becomes the parent of mux-runner/i);
});
