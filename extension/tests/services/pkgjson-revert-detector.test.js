// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectPkgJsonVersionDrift } from '../../bin/mux-runner.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pkgjson-revert-'));
}

const BASE_PKG = {
  name: 'pickle-rick-scripts',
  version: '1.69.0',
  private: true,
  type: 'module',
};

function writeState(dir) {
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ schema_version: 3, active: false, activity: [] }));
  return statePath;
}

function writePkg(dir, name, pkg) {
  const pkgDir = path.join(dir, name);
  fs.mkdirSync(pkgDir, { recursive: true });
  const pkgPath = path.join(pkgDir, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return pkgPath;
}

function readActivity(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8')).activity ?? [];
}

test('version-only diff emits pkgjson_only_revert_detected', () => {
  const dir = makeTempDir();
  try {
    const srcPkg = { ...BASE_PKG, version: '1.69.0' };
    const depPkg = { ...BASE_PKG, version: '1.68.0' };
    const srcPath = writePkg(dir, 'src', srcPkg);
    const depPath = writePkg(dir, 'dep', depPkg);
    const statePath = writeState(dir);

    detectPkgJsonVersionDrift(srcPath, depPath, statePath);

    const activity = readActivity(statePath);
    assert.equal(activity.length, 1, 'expected exactly one activity event');
    assert.equal(activity[0].event, 'pkgjson_only_revert_detected');
    assert.equal(activity[0].src_version, '1.69.0');
    assert.equal(activity[0].dep_version, '1.68.0');
    assert.equal(activity[0].src_path, srcPath);
    assert.equal(activity[0].dep_path, depPath);
    assert.ok(typeof activity[0].ts === 'string' && activity[0].ts.length > 0, 'ts should be ISO string');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('equal versions emit no event', () => {
  const dir = makeTempDir();
  try {
    const srcPath = writePkg(dir, 'src', { ...BASE_PKG, version: '1.69.0' });
    const depPath = writePkg(dir, 'dep', { ...BASE_PKG, version: '1.69.0' });
    const statePath = writeState(dir);

    detectPkgJsonVersionDrift(srcPath, depPath, statePath);

    const activity = readActivity(statePath);
    assert.equal(activity.length, 0, 'expected no activity events when versions are equal');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('other-field diff emits pkgjson_full_drift_detected', () => {
  const dir = makeTempDir();
  try {
    const srcPath = writePkg(dir, 'src', { ...BASE_PKG, version: '1.69.0', name: 'pickle-rick-scripts' });
    const depPath = writePkg(dir, 'dep', { ...BASE_PKG, version: '1.68.0', name: 'stale-name' });
    const statePath = writeState(dir);

    detectPkgJsonVersionDrift(srcPath, depPath, statePath);

    const activity = readActivity(statePath);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].event, 'pkgjson_full_drift_detected');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('missing src file emits pkgjson_dep_or_src_missing', () => {
  const dir = makeTempDir();
  try {
    const depPath = writePkg(dir, 'dep', BASE_PKG);
    const statePath = writeState(dir);
    const missingPath = path.join(dir, 'nonexistent', 'package.json');

    detectPkgJsonVersionDrift(missingPath, depPath, statePath);

    const activity = readActivity(statePath);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].event, 'pkgjson_dep_or_src_missing');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
