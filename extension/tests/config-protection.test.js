import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../hooks/handlers/config-protection.js');

function baseState(overrides = {}) {
  return {
    active: true,
    working_dir: process.cwd(),
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/pickle-test',
    tmux_mode: false,
    ...overrides,
  };
}

/**
 * Run config-protection handler as subprocess.
 * Returns parsed decision object.
 */
function runHandler(opts = {}) {
  const {
    state = baseState(),
    toolName = 'Write',
    toolInput = {},
    withStateFile = true,
    withSessionsMap = withStateFile,
    setStateFileEnv = withStateFile,
    persistState = true,
    configChange = false,
  } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const sessionDir = path.join(tmpDir, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });

  const stateFile = path.join(sessionDir, 'state.json');

  // Set up session_dir and current_ticket in state
  const ticketId = state.current_ticket || 'test-ticket-01';
  const resolvedState = {
    ...state,
    session_dir: sessionDir,
    current_ticket: ticketId,
  };

  // Create ticket file if configChange requested
  if (configChange) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const frontmatter = configChange
      ? `---\nid: ${ticketId}\ntitle: "Test"\nconfig_change: true\n---\n# Ticket\n`
      : `---\nid: ${ticketId}\ntitle: "Test"\n---\n# Ticket\n`;
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), frontmatter);
  }

  if (persistState) {
    fs.writeFileSync(stateFile, JSON.stringify(resolvedState));
  }
  if (withSessionsMap) {
    fs.writeFileSync(
      path.join(tmpDir, 'current_sessions.json'),
      JSON.stringify({ [process.cwd()]: sessionDir })
    );
  }

  const env = { ...process.env, EXTENSION_DIR: tmpDir, FORCE_COLOR: '0' };
  delete env.PICKLE_STATE_FILE;
  if (setStateFileEnv) env.PICKLE_STATE_FILE = stateFile;

  const hookInput = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

  const stdout = execFileSync(process.execPath, [HANDLER], {
    input: hookInput,
    encoding: 'utf-8',
    env,
  });

  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// Block cases
// ---------------------------------------------------------------------------

test('blocks Write to .eslintrc.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.eslintrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .eslintrc (no extension)', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.eslintrc' } });
  assert.equal(result.decision, 'block');
});

test('blocks Edit to tsconfig.json', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Edit to tsconfig.build.json', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/tsconfig.build.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to biome.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/biome.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .prettierrc.json', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.prettierrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to jest.config.js', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/jest.config.js' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to vitest.config.ts', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/vitest.config.ts' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to pyproject.toml', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/pyproject.toml' } });
  assert.equal(result.decision, 'block');
});

test('blocks Write to .ruff.toml', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/.ruff.toml' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash sed targeting tsconfig.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'sed -i "s/foo/bar/" tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash awk targeting .eslintrc.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'awk \'{print}\' .eslintrc.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash echo redirect to tsconfig.json', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'echo "{}" > tsconfig.json' } });
  assert.equal(result.decision, 'block');
});

test('blocks Bash echo append to .prettierrc', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'echo "extra" >> .prettierrc' } });
  assert.equal(result.decision, 'block');
});

// ---------------------------------------------------------------------------
// Approve cases
// ---------------------------------------------------------------------------

test('approves Write to src/foo.ts', () => {
  const result = runHandler({ toolName: 'Write', toolInput: { file_path: '/project/src/foo.ts' } });
  assert.equal(result.decision, 'approve');
});

test('approves Edit to package.json (not in protected list)', () => {
  const result = runHandler({ toolName: 'Edit', toolInput: { file_path: '/project/package.json' } });
  assert.equal(result.decision, 'approve');
});

test('approves Bash npm test (no config target)', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'npm test' } });
  assert.equal(result.decision, 'approve');
});

test('approves Bash git commit', () => {
  const result = runHandler({ toolName: 'Bash', toolInput: { command: 'git commit -m "feat: add thing"' } });
  assert.equal(result.decision, 'approve');
});

test('approves Read tool (not Write/Edit/Bash)', () => {
  const result = runHandler({ toolName: 'Read', toolInput: { file_path: '/project/tsconfig.json' } });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Override case
// ---------------------------------------------------------------------------

test('approves Write to .eslintrc.json when ticket has config_change: true', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
    configChange: true,
  });
  assert.equal(result.decision, 'approve');
});

// ---------------------------------------------------------------------------
// Inactive session cases
// ---------------------------------------------------------------------------

test('approves any tool when no state file exists', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
    withSessionsMap: false,
    setStateFileEnv: false,
    persistState: false,
  });
  assert.equal(result.decision, 'approve');
});

test('approves any tool when session is inactive (active: false)', () => {
  const result = runHandler({
    state: baseState({ active: false }),
    toolName: 'Write',
    toolInput: { file_path: '/project/.eslintrc.json' },
  });
  assert.equal(result.decision, 'approve');
});

test('blocks protected config edits when the sessions map is missing but a live session state exists', () => {
  const result = runHandler({
    toolName: 'Write',
    toolInput: { file_path: '/project/tsconfig.json' },
    withSessionsMap: false,
    setStateFileEnv: false,
  });
  assert.equal(result.decision, 'block');
});
