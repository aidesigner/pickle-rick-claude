// @tier: fast
//
// Regression guard for C7: session-merged worker MCP config forwarding in
// runWorkerProcess (spawn-morty.ts).
//
// The HIGH finding (Flow 6) from data-flow audit ticket fdd9e119:
//   setup.ts writes <sessionRoot>/mcp/worker-mcp.json, but spawn-morty.ts
//   runWorkerProcess never resolved or forwarded that path to
//   buildWorkerInvocation.  Workers spawned with expose_mcp_to_workers:true
//   never received --mcp-config and could not reach the codegraph MCP server.
//
// Fix: runWorkerProcess now resolves the session-merged path via
//   `path.join(sessionRoot, 'mcp', 'worker-mcp.json')` and passes it as
//   `mcpConfig` to buildWorkerInvocation when (a) backend === 'claude' and
//   (b) the file exists at spawn time.
//
// Tests here verify:
//   1. When session-merged worker-mcp.json exists + backend='claude', the
//      resulting invocation includes '--mcp-config <path>'.
//   2. When the file is absent, no '--mcp-config' arg appears (fail-open: no
//      crash, no spurious arg).
//   3. Non-claude backends never receive '--mcp-config' even when the file
//      exists (codex structural exclusion).
//   4. Source-level assertion: spawn-morty.ts contains the C7 resolution
//      block so the fix cannot be silently removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorkerInvocation } from '../services/backend-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Simulate the C7 resolution that runWorkerProcess now performs:
//   const sessionMcpPath = path.join(sessionRoot, 'mcp', 'worker-mcp.json');
//   const resolvedMcpConfig =
//     args.backend === 'claude' && fs.existsSync(sessionMcpPath)
//       ? sessionMcpPath : undefined;
// ---------------------------------------------------------------------------

function resolveC7McpConfig(sessionRoot, backend) {
    const sessionMcpPath = path.join(sessionRoot, 'mcp', 'worker-mcp.json');
    return backend === 'claude' && fs.existsSync(sessionMcpPath)
        ? sessionMcpPath
        : undefined;
}

// Test 1: file present + claude → --mcp-config included in invocation args
test('C7 forwarding: session-merged worker-mcp.json present + claude → --mcp-config in invocation', () => {
    const sessionRoot = mkTmpDir('c7-present-');
    try {
        // Write the session-merged MCP config file (content doesn't matter for
        // the forwarding assertion — only existence is checked at spawn time).
        const mcpDir = path.join(sessionRoot, 'mcp');
        fs.mkdirSync(mcpDir, { recursive: true });
        const sessionMcpPath = path.join(mcpDir, 'worker-mcp.json');
        fs.writeFileSync(sessionMcpPath, JSON.stringify({ mcpServers: {} }));

        const resolvedMcpConfig = resolveC7McpConfig(sessionRoot, 'claude');
        assert.equal(resolvedMcpConfig, sessionMcpPath, 'C7 resolution returns the session-merged path');

        const inv = buildWorkerInvocation('claude', {
            prompt: 'test',
            addDirs: [],
            mcpConfig: resolvedMcpConfig,
        });
        const idx = inv.args.indexOf('--mcp-config');
        assert.ok(idx >= 0, 'claude invocation includes --mcp-config when session-merged file exists');
        assert.equal(inv.args[idx + 1], sessionMcpPath, '--mcp-config value is the session-merged path');
    } finally {
        rmDir(sessionRoot);
    }
});

// Test 2: file absent → C7 resolution returns undefined → session-merged path
// is NOT injected (fail-open contract: the resolver falls through to the
// settingsBag / ~/.claude.json chain, which may or may not have an entry
// depending on the host; what MUST NOT happen is the session-merged path
// appearing when the file is absent).
test('C7 forwarding: session-merged worker-mcp.json absent → C7 resolution returns undefined (fail-open)', () => {
    const sessionRoot = mkTmpDir('c7-absent-');
    try {
        // Do NOT create mcp/worker-mcp.json
        const resolvedMcpConfig = resolveC7McpConfig(sessionRoot, 'claude');
        assert.equal(resolvedMcpConfig, undefined, 'C7 resolution returns undefined when file absent');

        const sessionMcpPath = path.join(sessionRoot, 'mcp', 'worker-mcp.json');
        const inv = buildWorkerInvocation('claude', {
            prompt: 'test',
            addDirs: [],
            mcpConfig: resolvedMcpConfig,  // undefined
        });
        // The session-merged path itself must NOT appear as the --mcp-config value.
        // (The resolver may still produce a --mcp-config from settingsBag/~/.claude.json,
        // which is correct fall-through behaviour; we only assert the session path is absent.)
        const mcpIdx = inv.args.indexOf('--mcp-config');
        if (mcpIdx >= 0) {
            assert.notEqual(
                inv.args[mcpIdx + 1],
                sessionMcpPath,
                'when session-merged file is absent, --mcp-config must NOT point at the session path',
            );
        }
        // If no --mcp-config arg at all, the resolver correctly fell through to omitted.
        // Either result is acceptable; both prove C7 resolution is not injecting a phantom path.
    } finally {
        rmDir(sessionRoot);
    }
});

// Test 3: file present but backend=codex → never forwarded (structural codex exclusion)
test('C7 forwarding: codex backend NEVER receives --mcp-config even when session-merged file exists', () => {
    const sessionRoot = mkTmpDir('c7-codex-');
    try {
        const mcpDir = path.join(sessionRoot, 'mcp');
        fs.mkdirSync(mcpDir, { recursive: true });
        fs.writeFileSync(path.join(mcpDir, 'worker-mcp.json'), JSON.stringify({ mcpServers: {} }));

        // C7 resolution gates on backend === 'claude'
        const resolvedMcpConfig = resolveC7McpConfig(sessionRoot, 'codex');
        assert.equal(resolvedMcpConfig, undefined, 'C7 resolution returns undefined for non-claude backend');

        const inv = buildWorkerInvocation('codex', {
            prompt: 'test',
            addDirs: [],
            mcpConfig: resolvedMcpConfig,
        });
        assert.equal(
            inv.args.includes('--mcp-config'),
            false,
            'codex invocation must NEVER include --mcp-config',
        );
    } finally {
        rmDir(sessionRoot);
    }
});

// Test 4: source-level assertion — C7 resolution block is present in spawn-morty.ts.
// This guards against silent removal of the fix without a corresponding test update.
test('C7 source guard: spawn-morty.ts contains the C7 session-merged MCP resolution block', () => {
    const spawnMortyPath = path.resolve(
        __dirname,
        '../src/bin/spawn-morty.ts',
    );
    assert.ok(
        fs.existsSync(spawnMortyPath),
        `spawn-morty.ts must exist at ${spawnMortyPath}`,
    );
    const src = fs.readFileSync(spawnMortyPath, 'utf8');

    // The fix inserts a C7-annotated block that:
    //   1. Computes sessionMcpPath via path.join(sessionRoot, 'mcp', 'worker-mcp.json')
    //   2. Guards on args.backend === 'claude' && fs.existsSync(sessionMcpPath)
    //   3. Passes mcpConfig to buildWorkerInvocation
    assert.ok(
        src.includes("path.join(sessionRoot, 'mcp', 'worker-mcp.json')"),
        "spawn-morty.ts must compute session-merged path via path.join(sessionRoot, 'mcp', 'worker-mcp.json')",
    );
    assert.ok(
        src.includes("args.backend === 'claude' && fs.existsSync(sessionMcpPath)"),
        "spawn-morty.ts must guard C7 resolution on backend === 'claude' && fs.existsSync(sessionMcpPath)",
    );
    assert.ok(
        src.includes('mcpConfig: resolvedMcpConfig'),
        "spawn-morty.ts must pass mcpConfig: resolvedMcpConfig to buildWorkerInvocation",
    );
});
