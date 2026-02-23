import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPR } from '../services/pr-factory.js';

test('createPR throws when state.json does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        assert.throws(() => createPR(tmp), { message: 'state.json not found' });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR throws when state.json is corrupt JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(path.join(tmp, 'state.json'), '{not valid json!!!');
        assert.throws(() => createPR(tmp), { message: 'state.json is corrupt or unreadable' });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('createPR throws when state.json is missing working_dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-factory-'));
    try {
        fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ original_prompt: 'test' }));
        assert.throws(() => createPR(tmp), {
            message: 'state.json is missing working_dir — cannot determine target repository',
        });
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});
