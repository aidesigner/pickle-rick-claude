// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(EXTENSION_ROOT, 'scripts', 'audit-closer-template-compliance.sh');

function makeTmpDir(prefix = 'pickle-closer-audit-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test('audit-closer-template-compliance: script exists and passes on the repo sweep set', () => {
  const stat = fs.statSync(SCRIPT_PATH);
  assert.ok((stat.mode & 0o111) !== 0, `script must be executable: ${SCRIPT_PATH}`);

  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(
    result.status,
    0,
    `expected audit to pass\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /\[audit-closer-template-compliance\] scope: 3 file\(s\)/);
  assert.match(result.stdout, /\[audit-closer-template-compliance\] OK/);
});

test('audit-closer-template-compliance: script fails on a non-compliant closer artifact', () => {
  const root = makeTmpDir();
  try {
    const prdDir = path.join(root, 'prds');
    fs.mkdirSync(prdDir, { recursive: true });
    const badPrdPath = path.join(prdDir, 'bad-closer.md');
    fs.writeFileSync(
      badPrdPath,
      [
        '<!-- R-CTSF compliant -->',
        '# Bad closer fixture',
        '',
        '## Closer',
        '- [worker] run verification',
        '- Deploy via `bash install.sh --closer-context --no-confirm`',
        '',
      ].join('\n'),
    );

    const result = spawnSync('bash', [SCRIPT_PATH, 'prds/bad-closer.md'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PRD_ROOT_OVERRIDE: root,
      },
    });

    assert.notEqual(result.status, 0, 'expected audit failure for malformed closer fixture');
    assert.match(result.stdout, /missing \[manager\] ownership tag|must be tagged \[manager\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
