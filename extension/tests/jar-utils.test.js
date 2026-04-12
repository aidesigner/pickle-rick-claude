import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addToJar } from '../services/jar-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAR_UTILS_BIN = path.resolve(__dirname, '../services/jar-utils.js');

// --- Error paths ---

test('addToJar: throws when state.json does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));
    try {
        assert.throws(() => addToJar(dir), /state\.json not found/);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('addToJar: throws when working_dir missing from state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true }));
        assert.throws(() => addToJar(dir), /working_dir not found/);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('addToJar: throws when prd.md does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: true,
            working_dir: dir,
        }));
        // No prd.md written
        assert.throws(() => addToJar(dir), /prd\.md not found/);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- Happy path ---

test('addToJar: creates jar entry, writes meta.json, deactivates session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));
    const jarRoot = path.join(os.homedir(), '.claude/pickle-rick/jar');

    try {
        // Setup minimal valid session
        const state = {
            active: true,
            working_dir: dir,
            original_prompt: 'test jar task',
        };
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
        fs.writeFileSync(path.join(dir, 'prd.md'), '# Test PRD\nHello world');

        const resultPath = addToJar(dir);

        // Result path should exist
        assert.ok(fs.existsSync(resultPath), 'jar task dir should be created');

        // prd.md should be copied
        const prdDest = path.join(resultPath, 'prd.md');
        assert.ok(fs.existsSync(prdDest), 'prd.md should be in jar dir');
        const prdContent = fs.readFileSync(prdDest, 'utf-8');
        assert.equal(prdContent, '# Test PRD\nHello world');

        // meta.json should be written with correct fields
        const meta = JSON.parse(fs.readFileSync(path.join(resultPath, 'meta.json'), 'utf-8'));
        assert.equal(meta.repo_path, dir);
        assert.equal(meta.prd_path, 'prd.md');
        assert.equal(meta.status, 'marinating');
        assert.equal(meta.task_id, path.basename(dir));
        assert.ok(meta.created_at, 'created_at should be set');

        // state.json should be deactivated
        const updatedState = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(updatedState.active, false);
        assert.equal(updatedState.completion_promise, 'JARRED');

        // Clean up jar entry
        fs.rmSync(resultPath, { recursive: true });
        // Clean up empty parent dirs if present
        const parentDir = path.dirname(resultPath);
        if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
            const grandParent = path.dirname(parentDir);
            if (fs.existsSync(grandParent) && fs.readdirSync(grandParent).length === 0) {
                fs.rmdirSync(grandParent);
            }
        }
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('addToJar: prd.md and meta.json are written atomically (no leftover .tmp files)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));

    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: true,
            working_dir: dir,
        }));
        fs.writeFileSync(path.join(dir, 'prd.md'), '# Atomic Test PRD');

        const resultPath = addToJar(dir);

        // Verify the files exist
        assert.ok(fs.existsSync(path.join(resultPath, 'prd.md')), 'prd.md should exist');
        assert.ok(fs.existsSync(path.join(resultPath, 'meta.json')), 'meta.json should exist');

        // Verify no leftover .tmp files (atomic write cleans up)
        const files = fs.readdirSync(resultPath);
        const tmpFiles = files.filter(f => f.endsWith('.tmp'));
        assert.equal(tmpFiles.length, 0, `No .tmp files should remain, found: ${tmpFiles.join(', ')}`);

        // Cleanup
        fs.rmSync(resultPath, { recursive: true });
        const parentDir = path.dirname(resultPath);
        if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
        }
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// CLI --session validation (deep review pass 5)
// ---------------------------------------------------------------------------

test('jar-utils CLI: --session as last arg (no value) exits 1 with error', () => {
    const result = spawnSync(process.execPath, [JAR_UTILS_BIN, 'add', '--session'], {
        encoding: 'utf-8',
        timeout: 10000,
    });
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(
        result.stderr.includes('non-empty path') || result.stderr.includes('requires'),
        `stderr should mention empty path error, got: ${result.stderr}`
    );
});

test('jar-utils CLI: --session with value starting with -- exits 1 with error', () => {
    const result = spawnSync(process.execPath, [JAR_UTILS_BIN, 'add', '--session', '--bogus'], {
        encoding: 'utf-8',
        timeout: 10000,
    });
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(
        result.stderr.includes('non-empty path') || result.stderr.includes('requires'),
        `stderr should mention path error, got: ${result.stderr}`
    );
});

test('addToJar: result path is nested under jar/<date>/<sessionId>', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));

    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: true,
            working_dir: dir,
        }));
        fs.writeFileSync(path.join(dir, 'prd.md'), '# PRD');

        const resultPath = addToJar(dir);
        const today = new Date().toISOString().split('T')[0];
        const sessionId = path.basename(dir);
        const jarRoot = path.join(os.homedir(), '.local/share/pickle-rick/jar');

        assert.equal(resultPath, path.join(jarRoot, today, sessionId));

        // Cleanup
        fs.rmSync(resultPath, { recursive: true });
        const parentDir = path.dirname(resultPath);
        if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
        }
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
