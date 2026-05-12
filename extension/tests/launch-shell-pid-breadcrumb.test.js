// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const CASES = [
  '.claude/commands/pickle-pipeline.md',
  '.claude/commands/pickle-microverse.md',
  '.claude/commands/anatomy-park.md',
  '.claude/commands/szechuan-sauce.md',
  '.claude/commands/plumbus.md',
];

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-launch-shell-pid-')));
}

function extractLaunchScript(markdownPath) {
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const match = markdown.match(/cat > "\$\{SESSION_ROOT\}\/launch\.sh" <<'LAUNCH_EOF'\n([\s\S]*?)\nLAUNCH_EOF/);
  assert.ok(match, `launch.sh heredoc missing from ${markdownPath}`);
  return match[1];
}

function writeNodeStub(binDir) {
  const stubPath = path.join(binDir, 'node');
  fs.writeFileSync(
    stubPath,
    [
      '#!/bin/bash',
      'if [ "$1" = "--input-type=module" ]; then',
      `  exec "${process.execPath}" "$@"`,
      'fi',
      'if [[ "$1" == *"read-microverse.js" ]]; then',
      '  echo 0',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(stubPath, 0o755);
}

describe('launch.sh breadcrumb templates', () => {
  for (const relPath of CASES) {
    test(`${relPath} writes launch_shell_pid to state.json`, () => {
      const tmpRoot = makeTmpDir();
      try {
        const sessionRoot = path.join(tmpRoot, 'session');
        const binDir = path.join(tmpRoot, 'bin');
        fs.mkdirSync(sessionRoot, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });
        writeNodeStub(binDir);

        const statePath = path.join(sessionRoot, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({ active: true, session_dir: sessionRoot }, null, 2));

        const launchScriptPath = path.join(sessionRoot, 'launch.sh');
        fs.writeFileSync(launchScriptPath, extractLaunchScript(path.join(repoRoot, relPath)));
        fs.chmodSync(launchScriptPath, 0o755);

        const result = spawnSync('bash', [launchScriptPath, sessionRoot], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
          encoding: 'utf8',
          input: '\n',
          timeout: 30_000,
        });

        assert.equal(result.status, 0, `launch.sh must exit cleanly for ${relPath}: ${result.stderr}`);

        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        assert.equal(typeof state.launch_shell_pid, 'number', `launch_shell_pid missing in ${relPath}`);
        assert.ok(state.launch_shell_pid > 0, `launch_shell_pid must be positive in ${relPath}`);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  }
});
