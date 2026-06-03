// @tier: fast
// R-PGI-6: tests that spawn-morty passes --mcp-config to claude workers when
// a gitnexus index is present, and that codex workers are excluded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkerInvocation } from '../services/backend-spawn.js';
import { buildGitNexusMcpConfig } from '../bin/spawn-morty.js';

const GITNEXUS_MCP_JSON = buildGitNexusMcpConfig();

test('buildGitNexusMcpConfig: returns valid JSON with gitnexus server key', () => {
    const parsed = JSON.parse(GITNEXUS_MCP_JSON);
    assert.ok(parsed.mcpServers, 'mcpServers key present');
    assert.ok(parsed.mcpServers.gitnexus, '"gitnexus" server key present');
    const gn = parsed.mcpServers.gitnexus;
    assert.equal(typeof gn.command, 'string', 'command is a string');
    assert.ok(Array.isArray(gn.args), 'args is an array');
    assert.ok(gn.args.includes('gitnexus'), 'args includes "gitnexus"');
    assert.ok(gn.args.includes('mcp'), 'args includes "mcp"');
});

test('buildWorkerInvocation(claude): includes --mcp-config when mcpConfig provided', () => {
    const inv = buildWorkerInvocation('claude', {
        prompt: 'do work',
        addDirs: [],
        mcpConfig: GITNEXUS_MCP_JSON,
    });
    assert.equal(inv.cmd, 'claude');
    const mcpIdx = inv.args.indexOf('--mcp-config');
    assert.ok(mcpIdx >= 0, '--mcp-config flag present');
    assert.equal(inv.args[mcpIdx + 1], GITNEXUS_MCP_JSON, '--mcp-config value is the JSON string');
    // --mcp-config must appear before -p (prompt)
    const pIdx = inv.args.indexOf('-p');
    assert.ok(mcpIdx < pIdx, '--mcp-config appears before -p');
});

test('buildWorkerInvocation(claude): omits --mcp-config when mcpConfig not provided', () => {
    // R-MFW-2 added a ~/.claude.json fallback to resolveMcpConfigPath. To assert
    // the clean-omission path deterministically (independent of the dev machine's
    // real ~/.claude.json), point HOME at a fresh temp dir with no .claude.json.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgi6-nohome-'));
    const priorHome = process.env.HOME;
    try {
        process.env.HOME = tmpHome;
        const inv = buildWorkerInvocation('claude', {
            prompt: 'do work',
            addDirs: [],
        });
        assert.equal(inv.cmd, 'claude');
        assert.ok(!inv.args.includes('--mcp-config'), '--mcp-config absent when nothing resolves');
    } finally {
        if (priorHome === undefined) delete process.env.HOME;
        else process.env.HOME = priorHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    }
});

test('buildWorkerInvocation(codex): does not pass --mcp-config even when mcpConfig provided', () => {
    const inv = buildWorkerInvocation('codex', {
        prompt: 'do work',
        addDirs: [],
        mcpConfig: GITNEXUS_MCP_JSON,
    });
    assert.equal(inv.cmd, 'codex');
    assert.ok(!inv.args.includes('--mcp-config'), 'codex invocation never gets --mcp-config');
});
