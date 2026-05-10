// @tier: fast
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProjectShapes } from '../../services/citadel/project-shape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDirs = [];

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-shape-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJson(dir, file, obj) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('detectProjectShapes', () => {
  test('node-cli: package.json with bin field, no next/nestjs deps → [node-cli]', () => {
    const dir = makeTmp();
    writeJson(dir, 'package.json', {
      name: 'pickle-rick-claude',
      bin: { pickle: './bin/pickle.js' },
    });
    assert.deepStrictEqual(detectProjectShapes(dir), ['node-cli']);
  });

  test('react-frontend: next.config.js present → includes react-frontend', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'next.config.js'), 'module.exports = {};');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('react-frontend'), `expected react-frontend in ${JSON.stringify(shapes)}`);
  });

  test('react-frontend: next.config.ts present → includes react-frontend', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'next.config.ts'), 'export default {};');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('react-frontend'), `expected react-frontend in ${JSON.stringify(shapes)}`);
  });

  test('react-frontend: react dep in package.json → includes react-frontend', () => {
    const dir = makeTmp();
    writeJson(dir, 'package.json', { name: 'app', dependencies: { react: '18.0.0' } });
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('react-frontend'), `expected react-frontend in ${JSON.stringify(shapes)}`);
  });

  test('react-frontend: tsx file in src/ → includes react-frontend', () => {
    const dir = makeTmp();
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), '');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('react-frontend'), `expected react-frontend in ${JSON.stringify(shapes)}`);
  });

  test('nestjs-api: @nestjs/core dep → includes nestjs-api', () => {
    const dir = makeTmp();
    writeJson(dir, 'package.json', { name: 'api', dependencies: { '@nestjs/core': '10.0.0' } });
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('nestjs-api'), `expected nestjs-api in ${JSON.stringify(shapes)}`);
  });

  test('python: pyproject.toml → includes python', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.poetry]\nname = "app"\n');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('python'), `expected python in ${JSON.stringify(shapes)}`);
  });

  test('python: requirements.txt → includes python', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'flask==3.0.0\n');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('python'), `expected python in ${JSON.stringify(shapes)}`);
  });

  test('rust: Cargo.toml → includes rust', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "myapp"\n');
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('rust'), `expected rust in ${JSON.stringify(shapes)}`);
  });

  test('multi-shape: bin + react dep → [node-cli, react-frontend]', () => {
    const dir = makeTmp();
    writeJson(dir, 'package.json', {
      name: 'react-cli',
      bin: { 'my-cli': './bin/cli.js' },
      dependencies: { react: '18.0.0' },
    });
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.includes('node-cli'), `expected node-cli in ${JSON.stringify(shapes)}`);
    assert.ok(shapes.includes('react-frontend'), `expected react-frontend in ${JSON.stringify(shapes)}`);
  });

  test('unknown: empty directory → [unknown]', () => {
    const dir = makeTmp();
    assert.deepStrictEqual(detectProjectShapes(dir), ['unknown']);
  });

  test('result is always non-empty', () => {
    const dir = makeTmp();
    const shapes = detectProjectShapes(dir);
    assert.ok(shapes.length > 0, 'shapes array must not be empty');
  });

  test('detection is deterministic (same result on repeat calls)', () => {
    const dir = makeTmp();
    writeJson(dir, 'package.json', { name: 'app', bin: { x: './x.js' } });
    const first = detectProjectShapes(dir);
    const second = detectProjectShapes(dir);
    assert.deepStrictEqual(first, second);
  });
});
