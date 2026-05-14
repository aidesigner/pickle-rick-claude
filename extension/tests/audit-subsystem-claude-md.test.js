// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(EXTENSION_ROOT, 'scripts', 'audit-subsystem-claude-md.sh');
const JSON_PATH = path.join(EXTENSION_ROOT, 'audit', 'subsystem-claude-md-2026-05-08.json');
const CLAUDE_MD_PATH = path.join(EXTENSION_ROOT, 'CLAUDE.md');
const VALID_DRIFT_CLASSES = new Set(['MISSING', 'STALE', 'INCOMPLETE', 'OK']);
const EXPECTED_SUBSYSTEMS = ['bin', 'hooks', 'lib', 'services', 'types'];

test('audit-subsystem-claude-md: script exists and is executable', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `Script not found: ${SCRIPT_PATH}`);
  const stat = fs.statSync(SCRIPT_PATH);
  const isExecutable = (stat.mode & 0o111) !== 0;
  assert.ok(isExecutable, `Script is not executable: ${SCRIPT_PATH}`);
});

test('audit-subsystem-claude-md: script runs cleanly (exit 0)', () => {
  const committedBefore = fs.readFileSync(JSON_PATH, 'utf8');
  const result = spawnSync('bash', [SCRIPT_PATH], { encoding: 'utf8', timeout: 30000 });
  try {
    assert.equal(
      result.status,
      0,
      `Script exited with code ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );

    const match = result.stdout.match(/\[audit-subsystem-claude-md\] wrote (.+)\n/);
    assert.ok(match, `expected output path in stdout, got:\n${result.stdout}`);
    const outputPath = match[1].trim();
    assert.ok(fs.existsSync(outputPath), `script output not found: ${outputPath}`);
    assert.notEqual(outputPath, JSON_PATH, 'default audit run must not overwrite the tracked report');
    assert.equal(
      fs.readFileSync(JSON_PATH, 'utf8'),
      committedBefore,
      'default audit run must leave the tracked report unchanged',
    );
  } finally {
    const match = result.stdout.match(/\[audit-subsystem-claude-md\] wrote (.+)\n/);
    const outputPath = match?.[1]?.trim();
    if (outputPath && outputPath !== JSON_PATH && fs.existsSync(outputPath)) {
      fs.rmSync(outputPath, { force: true });
    }
  }
});

test('audit-subsystem-claude-md: OUTPUT_FILE_OVERRIDE writes the requested report path', () => {
  const overridePath = path.join(EXTENSION_ROOT, 'audit', `subsystem-claude-md.override.${process.pid}.json`);
  try {
    const result = spawnSync('bash', [SCRIPT_PATH], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, OUTPUT_FILE_OVERRIDE: overridePath },
    });
    assert.equal(
      result.status,
      0,
      `Script exited with code ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.ok(fs.existsSync(overridePath), `override output not found: ${overridePath}`);
    const data = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
    assert.ok(Array.isArray(data), 'override JSON root must be an array');
  } finally {
    fs.rmSync(overridePath, { force: true });
  }
});

test('audit-subsystem-claude-md: JSON report exists at committed path', () => {
  assert.ok(fs.existsSync(JSON_PATH), `JSON report not found: ${JSON_PATH}`);
});

test('audit-subsystem-claude-md: JSON report has exactly 5 subsystem entries', () => {
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const data = JSON.parse(raw);
  assert.ok(Array.isArray(data), 'JSON root must be an array');
  assert.equal(data.length, 5, `Expected 5 entries, got ${data.length}`);
});

test('audit-subsystem-claude-md: each entry has required fields with valid types', () => {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  for (const entry of data) {
    assert.equal(typeof entry.subsystem, 'string', `subsystem must be string in: ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.has_claude_md, 'boolean', `has_claude_md must be boolean in: ${JSON.stringify(entry)}`);
    assert.ok(
      entry.last_modified_iso === null || typeof entry.last_modified_iso === 'string',
      `last_modified_iso must be string or null in: ${JSON.stringify(entry)}`,
    );
    assert.equal(typeof entry.file_count, 'number', `file_count must be number in: ${JSON.stringify(entry)}`);
    assert.ok(
      VALID_DRIFT_CLASSES.has(entry.drift_class),
      `drift_class '${entry.drift_class}' not in [${[...VALID_DRIFT_CLASSES].join(', ')}]`,
    );
  }
});

test('audit-subsystem-claude-md: entries cover all expected subsystems', () => {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const subsystems = data.map((e) => e.subsystem).sort();
  assert.deepEqual(subsystems, [...EXPECTED_SUBSYSTEMS].sort());
});

test('audit-subsystem-claude-md: trap-door entry exists in extension/CLAUDE.md', () => {
  assert.ok(fs.existsSync(CLAUDE_MD_PATH), `extension/CLAUDE.md not found at: ${CLAUDE_MD_PATH}`);
  const content = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  assert.ok(
    content.includes('audit-subsystem-claude-md'),
    'extension/CLAUDE.md must contain a trap-door entry referencing audit-subsystem-claude-md',
  );
  assert.ok(
    content.includes('R-CMD-4'),
    'extension/CLAUDE.md trap-door entry must reference R-CMD-4',
  );
});
