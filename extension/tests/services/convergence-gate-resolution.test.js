import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProjectType } from '../../services/convergence-gate.js';

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-res-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('detectProjectType: pnpm-lock.yaml → pnpm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    assert.equal(detectProjectType(dir), 'pnpm');
  });
});

test('detectProjectType: yarn.lock → yarn', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    assert.equal(detectProjectType(dir), 'yarn');
  });
});

test('detectProjectType: package-lock.json → npm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '');
    assert.equal(detectProjectType(dir), 'npm');
  });
});

test('detectProjectType: package.json only → npm', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.equal(detectProjectType(dir), 'npm');
  });
});

test('detectProjectType: Cargo.toml → cargo', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
    assert.equal(detectProjectType(dir), 'cargo');
  });
});

test('detectProjectType: go.mod → go', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'go.mod'), '');
    assert.equal(detectProjectType(dir), 'go');
  });
});

test('detectProjectType: pnpm-lock.yaml wins over yarn.lock', () => {
  withTmpDir(dir => {
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
    assert.equal(detectProjectType(dir), 'pnpm');
  });
});

test('detectProjectType: empty dir → null', () => {
  withTmpDir(dir => {
    assert.equal(detectProjectType(dir), null);
  });
});
