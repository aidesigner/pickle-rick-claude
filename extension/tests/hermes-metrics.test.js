// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    buildReport,
    parseSessionLine,
    scanSessionFiles,
} from '../services/metrics-utils.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';

function assistantLine(timestamp, input, output, backend) {
    const line = {
        type: 'assistant',
        timestamp,
        message: {
            usage: {
                input_tokens: input,
                output_tokens: output,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
        },
    };
    if (backend !== undefined) line.backend = backend;
    return JSON.stringify(line);
}

function writeSessionLine(root, slug, filename, line) {
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, filename), `${line}\n`);
}

test('hermes-metrics: parseSessionLine preserves hermes backend', () => {
    const parsed = parseSessionLine(assistantLine('2026-05-03T12:00:00Z', 10, 20, 'hermes'));

    assert.ok(parsed);
    assert.equal(parsed.backend, 'hermes');
    assert.equal(parsed.usage.input, 10);
    assert.equal(parsed.usage.output, 20);
});

test('hermes-metrics: invalid backend falls back to claude', () => {
    const parsed = parseSessionLine(assistantLine('2026-05-03T12:00:00Z', 10, 20, 'bogus'));

    assert.ok(parsed);
    assert.equal(parsed.backend, 'claude');
});

test('hermes-metrics: scanSessionFiles attributes usage to hermes bucket', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-metrics-'));
    const cacheFile = path.join(root, 'metrics-cache.json');
    const date = formatLocalDateKey(new Date('2026-05-03T12:00:00Z'));
    try {
        writeSessionLine(root, 'hermes-project', 'session.jsonl', assistantLine('2026-05-03T12:00:00Z', 12, 34, 'hermes'));

        const scanned = scanSessionFiles(root, date, date, cacheFile);
        const tokens = scanned.get('hermes-project').get(date);

        assert.equal(tokens.turns, 1);
        assert.equal(tokens.tokens_per_backend.hermes.turns, 1);
        assert.equal(tokens.tokens_per_backend.hermes.output, 34);
        assert.equal(tokens.tokens_per_backend.codex.output, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('hermes-metrics: buildReport aggregates hermes backend totals', () => {
    const tokens = new Map([
        ['hermes-project', new Map([
            ['2026-05-03', {
                turns: 1,
                input: 12,
                output: 34,
                cache_read: 0,
                cache_create: 0,
                tokens_per_backend: {
                    claude: { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 },
                    codex: { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 },
                    hermes: { turns: 1, input: 12, output: 34, cache_read: 0, cache_create: 0 },
                },
            }],
        ])],
    ]);

    const report = buildReport(tokens, new Map(), '2026-05-03', '2026-05-03', 'daily');

    assert.equal(report.tokens_per_backend.hermes.turns, 1);
    assert.equal(report.tokens_per_backend.hermes.input, 12);
    assert.equal(report.tokens_per_backend.hermes.output, 34);
    assert.equal(report.tokens_per_backend.claude.output, 0);
});
