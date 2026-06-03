#!/usr/bin/env node
// Minimal MCP echo server for integration testing (R-MFW-7).
// Registers one tool: echo(message) -> returns the message unchanged.
// Communicates via line-delimited JSON-RPC 2.0 over stdio (MCP protocol 2024-11-05).

import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echoes back the given message unchanged',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo' },
    },
    required: ['message'],
  },
};

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Notifications have no id — skip silently
  if (req.id === undefined || req.id === null) return;

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp', version: '0.1.0' },
      },
    });
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: [ECHO_TOOL] },
    });
  } else if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params ?? {};
    if (name === 'echo') {
      const message = typeof args?.message === 'string' ? args.message : '';
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{ type: 'text', text: message }],
          isError: false,
        },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }
  } else {
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    });
  }
});
