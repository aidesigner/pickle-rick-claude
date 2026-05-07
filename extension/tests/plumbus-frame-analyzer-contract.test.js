// @tier: contract
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'plumbus-frame-analyzer.js');
const FIXTURE_DOT = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'frame1-asymmetric-writer.dot');
const PINNED_JSON = path.resolve(__dirname, '__fixtures__', 'plumbus-frames', 'dump-graph-output.pinned.json');

let tmpRoot;
let attractorRoot;

function makeAttractorRoot() {
  const tmp = mkdtempSync(path.join(tmpRoot, 'attractor-'));
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'src'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'src', 'cli.ts'), '// stub\n');
  mkdirSync(path.join(tmp, 'packages', 'attractor', 'scripts'), { recursive: true });
  writeFileSync(path.join(tmp, 'packages', 'attractor', 'scripts', 'dump-graph.ts'), '// stub\n');
  return tmp;
}

function makeFakeBun(jsonPath) {
  const dir = mkdtempSync(path.join(tmpRoot, 'fake-bun-'));
  const bunPath = path.join(dir, 'bun');
  writeFileSync(bunPath, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bun 1.0.0"; exit 0; fi\ncat "${jsonPath}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

function runAnalyzer(extraEnv) {
  return spawnSync(
    process.execPath,
    [BIN_PATH, FIXTURE_DOT],
    { encoding: 'utf8', env: { ...process.env, ATTRACTOR_ROOT: attractorRoot, ...extraEnv } },
  );
}

describe('plumbus-frame-analyzer — output contract', () => {
  before(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plumbus-contract-'));
    attractorRoot = makeAttractorRoot();
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('contract pass with pinned JSON — exits 0, output has exactly three top-level keys', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(
      Object.keys(output).sort(),
      ['context_keys', 'cycles', 'diamond_routing'],
    );
  });

  test('context_keys shape — each row has key:string, writers:array, readers:array', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { context_keys } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(context_keys), 'context_keys must be an array');
    assert.ok(context_keys.length > 0, 'context_keys must be non-empty with pinned fixture');
    assert.ok(
      context_keys.every(r => typeof r.key === 'string' && Array.isArray(r.writers) && Array.isArray(r.readers)),
      `context_keys row shape violation: ${JSON.stringify(context_keys)}`,
    );
  });

  test('diamond_routing shape — each row has diamond:string, covered_states:array, stuck_states:array', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { diamond_routing } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(diamond_routing), 'diamond_routing must be an array');
    assert.ok(diamond_routing.length > 0, 'diamond_routing must be non-empty with pinned fixture');
    assert.ok(
      diamond_routing.every(
        r => typeof r.diamond === 'string' && Array.isArray(r.covered_states) && Array.isArray(r.stuck_states),
      ),
      `diamond_routing row shape violation: ${JSON.stringify(diamond_routing)}`,
    );
  });

  test('cycles shape — each row has scc_nodes:array, convergence_signal:null|string', () => {
    const fakeBunDir = makeFakeBun(PINNED_JSON);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0: ${result.stderr}`);
    const { cycles } = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(cycles), 'cycles must be an array');
    assert.ok(cycles.length > 0, 'cycles must be non-empty with pinned fixture');
    assert.ok(
      cycles.every(r => Array.isArray(r.scc_nodes) && (r.convergence_signal === null || typeof r.convergence_signal === 'string')),
      `cycles row shape violation: ${JSON.stringify(cycles)}`,
    );
  });

  test('contract drift detection — missing nodes key → exit 2, stderr contains "nodes"', () => {
    const brokenJson = path.join(tmpRoot, 'broken.json');
    writeFileSync(brokenJson, JSON.stringify({ edges: [] }));
    const fakeBunDir = makeFakeBun(brokenJson);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.notStrictEqual(result.status, 0, 'expected non-zero exit when nodes key is missing');
    assert.ok(result.stderr.includes('nodes'), `expected stderr to contain "nodes", got: ${result.stderr}`);
  });

  test('dotted ATTRACTOR_CTX keys survive tool_command and prompt supplemental parsing', () => {
    const graphPath = path.join(tmpRoot, 'dotted-attr-ctx.json');
    writeFileSync(
      graphPath,
      JSON.stringify({
        nodes: [
          {
            id: 'tool_writer',
            tool_command: 'echo ATTRACTOR_CTX:stack.child.status=ready',
          },
          {
            id: 'prompt_reader',
            prompt: 'Inspect ${ATTRACTOR_CTX_stack.child.status} before continuing',
          },
        ],
        edges: [
          {
            target: 'edge_reader',
            condition: 'context.stack.child.status=ready',
          },
        ],
      }),
    );
    const fakeBunDir = makeFakeBun(graphPath);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    const row = output.context_keys.find((entry) => entry.key === 'stack.child.status');
    assert.deepStrictEqual(row, {
      key: 'stack.child.status',
      writers: ['tool_writer'],
      readers: ['edge_reader', 'prompt_reader'],
    });
  });

  test('multi-clause context conditions preserve all reader keys and routed diamond states', () => {
    const graphPath = path.join(tmpRoot, 'multi-clause-context-conditions.json');
    writeFileSync(
      graphPath,
      JSON.stringify({
        nodes: [
          {
            id: 'verify_contract',
            context_on_success: 'contract_violation_category=cast_any,contract_violation_package=api,contract_violation_detail=clean',
            context_on_failure: 'contract_violation_category=none,contract_violation_package=ui,contract_violation_detail=violation',
          },
          {
            id: 'route_contract_violation',
            class: 'diamond',
          },
        ],
        edges: [
          {
            source: 'route_contract_violation',
            target: 'fix_backend',
            condition: 'context.contract_violation_category=cast_any && context.contract_violation_package=api',
          },
          {
            source: 'route_contract_violation',
            target: 'review_entity',
            condition: 'context.contract_violation_category=none && context.contract_violation_detail!=violation',
          },
        ],
      }),
    );
    const fakeBunDir = makeFakeBun(graphPath);
    const result = runAnalyzer({ PATH: `${fakeBunDir}:${process.env.PATH ?? ''}` });

    assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());

    assert.deepStrictEqual(
      output.context_keys.find((entry) => entry.key === 'contract_violation_package'),
      {
        key: 'contract_violation_package',
        writers: ['verify_contract'],
        readers: ['fix_backend'],
      },
    );
    assert.deepStrictEqual(
      output.context_keys.find((entry) => entry.key === 'contract_violation_detail'),
      {
        key: 'contract_violation_detail',
        writers: ['verify_contract'],
        readers: ['review_entity'],
      },
    );

    const route = output.diamond_routing.find((entry) => entry.diamond === 'route_contract_violation');
    assert.ok(route, 'expected routed diamond output for multi-clause context conditions');
    assert.ok(
      route.covered_states.some((state) =>
        state.cell.contract_violation_category === 'cast_any' &&
        state.cell.contract_violation_package === 'api' &&
        state.matchingEdges.includes('route_contract_violation->fix_backend'),
      ),
      'expected equality multi-clause edge to produce a covered state',
    );
    assert.ok(
      route.covered_states.some((state) =>
        state.cell.contract_violation_category === 'none' &&
        state.cell.contract_violation_detail === 'clean' &&
        state.matchingEdges.includes('route_contract_violation->review_entity'),
      ),
      'expected inequality multi-clause edge to produce a covered state',
    );
    assert.ok(
      route.stuck_states.some((state) =>
        state.cell.contract_violation_category === 'none' &&
        state.cell.contract_violation_detail === 'violation',
      ),
      'expected forbidden inequality value to remain a stuck state',
    );
  });
});
