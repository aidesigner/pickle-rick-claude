import type { Graph, ContextKeyRow } from '../types/plumbus-frame-analyzer.js';
import type { EngineKeysRegistry } from '../types/engine-keys-registry.js';
import { isEngineWritten } from './engine-keys-registry.js';

const CONDITION_RE = /context\.(\w+)/;
const TOOL_CMD_WRITE_RE = /ATTRACTOR_CTX:\s*(\w+)\s*=/g;
const ATTRACTOR_CTX_READ_RE = /\$\{ATTRACTOR_CTX_(\w+)\}/g;

function parseKeys(raw: string): string[] {
  return raw
    .split(',')
    .map(kv => kv.trim().split('=')[0].trim())
    .filter(Boolean);
}

type KeyMap = Map<string, Set<string>>;

function addKeyRef(map: KeyMap, key: string, nodeId: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(nodeId);
}

function collectNodeContextAttrs(node: Record<string, unknown>, id: string, writers: KeyMap): void {
  for (const attr of ['context_on_success', 'context_on_failure'] as const) {
    const raw = node[attr];
    if (typeof raw !== 'string') continue;
    for (const key of parseKeys(raw)) addKeyRef(writers, key, id);
  }
}

function collectNodeContextKeys(node: Record<string, unknown>, id: string, readers: KeyMap): void {
  const ctxKeys = node['context_keys'];
  if (typeof ctxKeys !== 'string') return;
  for (const key of ctxKeys.split(',').map(k => k.trim()).filter(Boolean)) {
    addKeyRef(readers, key, id);
  }
}

function collectNodeTextRefs(node: Record<string, unknown>, id: string, writers: KeyMap, readers: KeyMap): void {
  for (const field of ['tool_command', 'prompt'] as const) {
    const val = node[field];
    if (typeof val !== 'string') continue;
    for (const m of val.matchAll(TOOL_CMD_WRITE_RE)) addKeyRef(writers, m[1], id);
    for (const m of val.matchAll(ATTRACTOR_CTX_READ_RE)) addKeyRef(readers, m[1], id);
  }
}

function collectNodeRefs(graph: Graph, writers: KeyMap, readers: KeyMap): void {
  for (const node of graph.nodes) {
    const id = typeof node['id'] === 'string' ? node['id'] : null;
    if (!id) continue;

    collectNodeContextAttrs(node, id, writers);
    collectNodeContextKeys(node, id, readers);
    collectNodeTextRefs(node, id, writers, readers);
  }
}

function edgeCondition(edge: Record<string, unknown>): string | null {
  const attrsObj = typeof edge['attrs'] === 'object' && edge['attrs'] !== null
    ? (edge['attrs'] as Record<string, unknown>)
    : null;
  const condition = attrsObj?.['condition'] ?? edge['condition'];
  return typeof condition === 'string' ? condition : null;
}

function edgeTargetId(edge: Record<string, unknown>): string | null {
  return (typeof edge['target'] === 'string' ? edge['target'] : null) ??
    (typeof edge['to'] === 'string' ? edge['to'] : null);
}

function collectEdgeRefs(graph: Graph, readers: KeyMap): void {
  for (const edge of graph.edges) {
    const condition = edgeCondition(edge);
    if (!condition) continue;

    const match = CONDITION_RE.exec(condition);
    if (!match) continue;
    const key = match[1];

    const targetId = edgeTargetId(edge);
    if (!targetId) continue;
    addKeyRef(readers, key, targetId);
  }
}

export function buildContextKeyMatrix(graph: Graph, registry: EngineKeysRegistry): ContextKeyRow[] {
  const writers = new Map<string, Set<string>>();
  const readers = new Map<string, Set<string>>();

  collectNodeRefs(graph, writers, readers);
  collectEdgeRefs(graph, readers);

  const allKeys = new Set([...writers.keys(), ...readers.keys()]);
  const rows: ContextKeyRow[] = [];

  for (const key of allKeys) {
    if (isEngineWritten(key, registry)) continue;
    rows.push({
      key,
      writers: [...(writers.get(key) ?? new Set())].sort(),
      readers: [...(readers.get(key) ?? new Set())].sort(),
    });
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
