// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildRefinementWorkerInvocation } = await import('../bin/spawn-refinement-team.js');

test('buildRefinementWorkerInvocation: includes --mcp-config when settingsBag.worker_mcp_config_path resolves', () => {
    const configPath = '/tmp/test-mcp-config.json';
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 10,
        settingsBag: { worker_mcp_config_path: configPath },
    });
    const mcpIdx = inv.args.indexOf('--mcp-config');
    assert.ok(mcpIdx !== -1, '--mcp-config flag must be present when settingsBag provides a path');
    assert.equal(inv.args[mcpIdx + 1], configPath, '--mcp-config value must match the resolved path');
});

test('buildRefinementWorkerInvocation: omits --mcp-config cleanly when worker_mcp_config_path is null (INV-MCP-OPT-IN)', () => {
    const inv = buildRefinementWorkerInvocation({
        prompt: 'analyze the PRD',
        addDirs: [],
        maxTurns: 10,
        settingsBag: { worker_mcp_config_path: null },
    });
    // --mcp-config may still appear if ~/.claude.json exists, but must NEVER be the string 'undefined'
    const mcpIdx = inv.args.indexOf('--mcp-config');
    if (mcpIdx !== -1) {
        const val = inv.args[mcpIdx + 1];
        assert.notEqual(val, 'undefined', '--mcp-config value must never be the string "undefined"');
        assert.ok(typeof val === 'string' && val.length > 0, '--mcp-config value must be a non-empty string if present');
    }
    // If mcpIdx === -1, the flag was cleanly omitted — also valid per INV-MCP-OPT-IN
});
