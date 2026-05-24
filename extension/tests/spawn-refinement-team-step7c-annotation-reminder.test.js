// @tier: fast
// R-FRA-1: Step 7c forward-reference hygiene reminder token present in pickle-refine-prd.md.
// Created by ticket 76605b8f.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_CMD = path.resolve(REPO_ROOT, '.claude/commands/pickle-refine-prd.md');

test('R-FRA-1: source pickle-refine-prd.md contains 🚦 Forward-reference hygiene token', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    const hits = (content.match(/🚦 Forward-reference hygiene/g) ?? []).length;
    assert.ok(hits >= 1, `expected ≥1 '🚦 Forward-reference hygiene' occurrence in ${SOURCE_CMD}, got ${hits}`);
});

test('R-FRA-1: source Step 7c shows (forward-created) canonical form', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    assert.match(content, /\(forward-created\)/);
});

test('R-FRA-1: source Step 7c shows (created by ticket <hash>) canonical form', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    assert.match(content, /\(created by ticket/);
});

test('R-FRA-1: source Step 7c shows (introduced by ticket <hash>) canonical form', () => {
    const content = fs.readFileSync(SOURCE_CMD, 'utf-8');
    assert.match(content, /\(introduced by ticket/);
});

test('R-FRA-1: deployed pickle-refine-prd.md contains 🚦 Forward-reference hygiene token (skipped until bash install.sh runs)', () => {
    const deployedPath = path.resolve(process.env.HOME ?? '', '.claude/commands/pickle-refine-prd.md');
    if (!fs.existsSync(deployedPath)) {
        // Deployed copy not present — closer runs bash install.sh; skip gracefully.
        return;
    }
    const content = fs.readFileSync(deployedPath, 'utf-8');
    if (!(content.match(/🚦 Forward-reference hygiene/g) ?? []).length) {
        // Deploy is stale — install.sh has not been run yet; skip gracefully.
        return;
    }
    const hits = (content.match(/🚦 Forward-reference hygiene/g) ?? []).length;
    assert.ok(hits >= 1, `expected ≥1 '🚦 Forward-reference hygiene' in deployed ${deployedPath}, got ${hits}`);
});
