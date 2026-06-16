// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const CLAUDE_MD = path.join(repoRoot, 'CLAUDE.md');
const README_MD = path.join(repoRoot, 'README.md');
const SETTINGS = path.join(repoRoot, 'pickle_settings.json');

const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
const readme = fs.readFileSync(README_MD, 'utf8');
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

test('AC-GA-CG-2: CLAUDE.md no longer claims codegraph is Default-ON', () => {
  assert.equal(claudeMd.includes('Default-ON since B-CGH'), false);
});

test('AC-GA-CG-2: CLAUDE.md codegraph row describes opt-in / disabled-by-default', () => {
  const row = claudeMd.split('\n').find((l) => l.startsWith('| `codegraph`'));
  assert.ok(row, 'codegraph settings row present in CLAUDE.md');
  assert.match(row, /Opt-in \/ disabled by default/);
  assert.match(row, /`enabled` \(`false`\)/);
  assert.match(row, /`index_at_setup` \(`false`\)/);
});

test('AC-GA-CG-2: README describes codegraph as opt-in / disabled by default', () => {
  assert.match(readme, /Code Graph is opt-in and ships disabled by default/);
});

test('AC-GA-CG-2: README has no unconditional serve --mcp-by-default claim; lane split documented', () => {
  assert.equal(
    /Claude-family workers get a `codegraph serve --mcp` MCP server/.test(readme),
    false,
  );
  assert.match(readme, /injected-context lane/);
  assert.match(readme, /dormant by default/);
  assert.match(readme, /gated OFF unless `expose_mcp_to_workers === true`/);
});

test('AC-GA-CG-2: source pickle_settings.json codegraph booleans match the opt-in docs', () => {
  assert.equal(settings.codegraph.enabled, false);
  assert.equal(settings.codegraph.index_at_setup, false);
});
