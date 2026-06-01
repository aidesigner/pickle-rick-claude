// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMissingTools, containsUnquotedGlobHazard } from '../../services/verify-command-safety.js';

// --- detectMissingTools ---

test('detectMissingTools: argv-form flags NON_GUARANTEED_TOOLS tool when which returns false', () => {
  const missing = detectMissingTools(['jq', '.x', 'f.json'], { which: () => false });
  assert.deepEqual(missing, ['jq']);
});

test('detectMissingTools: argv-form returns empty when which reports tool present', () => {
  const missing = detectMissingTools(['jq', '.x', 'f.json'], { which: () => true });
  assert.deepEqual(missing, []);
});

test('detectMissingTools: argv-form only checks first element', () => {
  // rg is in NON_GUARANTEED_TOOLS; 'grep' is not — but argv-form only checks argv[0]
  const missing = detectMissingTools(['rg', 'foo', '|', 'grep', 'bar'], { which: () => false });
  assert.deepEqual(missing, ['rg']);
});

test('detectMissingTools: shell-form with pipe separates leading commands', () => {
  // rg is in NON_GUARANTEED_TOOLS; grep is NOT
  const missing = detectMissingTools('rg foo | grep bar', { which: () => false });
  assert.deepEqual(missing, ['rg']);
});

test('detectMissingTools: shell-form with && separates leading commands', () => {
  const missing = detectMissingTools('jq --version && bat file.txt', { which: () => false });
  assert.deepEqual(missing, ['jq', 'bat']);
});

test('detectMissingTools: shell-form with ; separates leading commands', () => {
  const missing = detectMissingTools('fd . ; rg foo', { which: () => false });
  assert.deepEqual(missing, ['fd', 'rg']);
});

test('detectMissingTools: POSIX tool grep never flagged even when which returns false', () => {
  const missing = detectMissingTools(['grep', 'foo', 'bar'], { which: () => false });
  assert.deepEqual(missing, []);
});

test('detectMissingTools: POSIX tool test never flagged even when which returns false', () => {
  const missing = detectMissingTools(['test', '-f', 'foo'], { which: () => false });
  assert.deepEqual(missing, []);
});

test('detectMissingTools: POSIX tool git never flagged even when which returns false', () => {
  const missing = detectMissingTools(['git', 'status'], { which: () => false });
  assert.deepEqual(missing, []);
});

test('detectMissingTools: shell-form POSIX tools not flagged', () => {
  const missing = detectMissingTools('grep foo | git status', { which: () => false });
  assert.deepEqual(missing, []);
});

test('detectMissingTools: selective which — only absent tools returned', () => {
  // jq absent, bat present
  const missing = detectMissingTools('jq --version && bat file.txt', {
    which: (bin) => bin === 'bat',
  });
  assert.deepEqual(missing, ['jq']);
});

test('detectMissingTools: shell-form with pipe — tool present, returns empty', () => {
  const missing = detectMissingTools('rg foo | grep bar', { which: () => true });
  assert.deepEqual(missing, []);
});

// --- containsUnquotedGlobHazard ---

test('containsUnquotedGlobHazard: unquoted * returns true', () => {
  assert.equal(containsUnquotedGlobHazard('ls *'), true);
});

test('containsUnquotedGlobHazard: unquoted ? returns true', () => {
  assert.equal(containsUnquotedGlobHazard('ls foo?'), true);
});

test('containsUnquotedGlobHazard: unquoted [ returns true', () => {
  assert.equal(containsUnquotedGlobHazard('ls [abc]'), true);
});

test('containsUnquotedGlobHazard: unquoted { returns true', () => {
  assert.equal(containsUnquotedGlobHazard('cp {a,b}.txt dest/'), true);
});

test('containsUnquotedGlobHazard: * inside single quotes returns false', () => {
  assert.equal(containsUnquotedGlobHazard("echo '*'"), false);
});

test('containsUnquotedGlobHazard: ? inside double quotes returns false', () => {
  assert.equal(containsUnquotedGlobHazard('echo "foo?"'), false);
});

test('containsUnquotedGlobHazard: [ inside single quotes returns false', () => {
  assert.equal(containsUnquotedGlobHazard("grep '[abc]' file"), false);
});

test('containsUnquotedGlobHazard: { inside double quotes returns false', () => {
  assert.equal(containsUnquotedGlobHazard('echo "{a,b}"'), false);
});

test('containsUnquotedGlobHazard: plain command with no glob chars returns false', () => {
  assert.equal(containsUnquotedGlobHazard('jq .x f.json'), false);
});

test('containsUnquotedGlobHazard: backslash-escaped * returns false', () => {
  assert.equal(containsUnquotedGlobHazard('echo \\*'), false);
});
