// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyProjectType,
  getProjectTypesCsvPath,
  loadProjectTypeDefinitions,
  PROJECT_TYPE_CATEGORIES,
} from '../services/project-type-classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '..');
const fixturesRoot = path.join(__dirname, '__fixtures__', 'archaeology');

function listFiles(dir) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const relativeDir = stack.pop() ?? '';
    for (const entry of fs.readdirSync(path.join(dir, relativeDir), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
      if (entry.isDirectory()) {
        stack.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files;
}

test('project-types.csv has exactly the required 10 categories', () => {
  const definitions = loadProjectTypeDefinitions(repoRoot);
  assert.deepEqual(
    definitions.map((definition) => definition.category),
    [...PROJECT_TYPE_CATEGORIES]
  );
});

test('project type registry path is resolved from injected extensionRoot', () => {
  assert.equal(
    getProjectTypesCsvPath('/tmp/pickle-root'),
    path.join('/tmp/pickle-root', 'extension', 'data', 'project-types.csv')
  );
});

test('archaeology fixtures classify with at least 90 percent accuracy', () => {
  const expectedCategories = [...PROJECT_TYPE_CATEGORIES];
  let correct = 0;
  for (const category of expectedCategories) {
    const fixtureDir = path.join(fixturesRoot, category);
    const files = listFiles(fixtureDir);
    assert.ok(files.length >= 5, `${category} fixture must contain at least 5 files`);

    const result = classifyProjectType(fixtureDir, { extensionRoot: repoRoot });
    if (result.category === category) correct += 1;
    assert.equal(result.category, category, `${category} classified as ${result.category}: ${result.reason}`);
  }

  assert.ok(correct / expectedCategories.length >= 0.9, `accuracy ${correct}/${expectedCategories.length}`);
});

test('classifyProjectType does not treat substring hits as file-pattern matches', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-type-classifier-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Fixture\n');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'fixture-library',
      private: true,
      devDependencies: {
        tsup: '^8.0.0',
      },
    }, null, 2));
    fs.writeFileSync(path.join(projectRoot, 'src', 'commander-helper.ts'), 'export const helper = true;\n');

    const result = classifyProjectType(projectRoot, { extensionRoot: repoRoot });
    const cliScore = result.scores.find((score) => score.category === 'cli');

    assert.equal(result.category, 'library');
    assert.ok(cliScore);
    assert.deepEqual(cliScore.matchedFiles, ['package.json']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
