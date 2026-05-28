// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// Test A: closer runbook references npm run test:expensive and prohibits standalone node --test
test('closer runbook references npm run test:expensive and prohibits node --test <soak>', () => {
    const runbookPath = path.join(REPO_ROOT, 'docs/closer-ticket-manager-handoff.md');
    const content = fs.readFileSync(runbookPath, 'utf8');
    assert.ok(
        content.includes('npm run test:expensive'),
        'docs/closer-ticket-manager-handoff.md must reference npm run test:expensive',
    );
    assert.ok(
        !content.includes('node --test tests/integration/deploy-lifecycle-soak'),
        'docs/closer-ticket-manager-handoff.md must NOT contain bare node --test <soak> invocation',
    );
});

// Test B: trap door source contains the required identifiers
test('config-protection.ts trap door contains closer_expensive_node_test_blocked event', () => {
    const guardPath = path.join(REPO_ROOT, 'extension/src/hooks/handlers/config-protection.ts');
    const content = fs.readFileSync(guardPath, 'utf8');
    assert.ok(
        content.includes('closer_expensive_node_test_blocked'),
        'config-protection.ts must emit closer_expensive_node_test_blocked event',
    );
    assert.ok(
        content.includes('isExpensiveNodeTestBlockedByRCSIS'),
        'config-protection.ts must define isExpensiveNodeTestBlockedByRCSIS',
    );
    assert.ok(
        content.includes('extractNodeTestPath'),
        'config-protection.ts must define extractNodeTestPath',
    );
    assert.ok(
        content.includes('@tier: expensive'),
        'config-protection.ts must detect the @tier: expensive marker',
    );
});
