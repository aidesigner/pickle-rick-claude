import { isEngineWritten } from './engine-keys-registry.js';
const CONDITION_RE = /context\.([\w.]+)=/;
const TOOL_CMD_WRITE_RE = /ATTRACTOR_CTX:\s*([\w.]+)\s*=/g;
const ATTRACTOR_CTX_READ_RE = /\$\{ATTRACTOR_CTX_([\w.]+)\}/g;
function parseKeys(raw) {
    return raw
        .split(',')
        .map(kv => kv.trim().split('=')[0].trim())
        .filter(Boolean);
}
function addKeyRef(map, key, nodeId) {
    if (!map.has(key))
        map.set(key, new Set());
    map.get(key).add(nodeId);
}
function collectNodeContextAttrs(node, id, writers) {
    for (const attr of ['context_on_success', 'context_on_failure']) {
        const raw = node[attr];
        if (typeof raw !== 'string')
            continue;
        for (const key of parseKeys(raw))
            addKeyRef(writers, key, id);
    }
}
function collectNodeContextKeys(node, id, readers) {
    const ctxKeys = node['context_keys'];
    if (typeof ctxKeys !== 'string')
        return;
    for (const key of ctxKeys.split(',').map(k => k.trim()).filter(Boolean)) {
        addKeyRef(readers, key, id);
    }
}
function collectNodeTextRefs(node, id, writers, readers) {
    for (const field of ['tool_command', 'prompt']) {
        const val = node[field];
        if (typeof val !== 'string')
            continue;
        for (const m of val.matchAll(TOOL_CMD_WRITE_RE))
            addKeyRef(writers, m[1], id);
        for (const m of val.matchAll(ATTRACTOR_CTX_READ_RE))
            addKeyRef(readers, m[1], id);
    }
}
function collectNodeRefs(graph, writers, readers) {
    for (const node of graph.nodes) {
        const id = typeof node['id'] === 'string' ? node['id'] : null;
        if (!id)
            continue;
        collectNodeContextAttrs(node, id, writers);
        collectNodeContextKeys(node, id, readers);
        collectNodeTextRefs(node, id, writers, readers);
    }
}
function edgeCondition(edge) {
    const attrsObj = typeof edge['attrs'] === 'object' && edge['attrs'] !== null
        ? edge['attrs']
        : null;
    const condition = attrsObj?.['condition'] ?? edge['condition'];
    return typeof condition === 'string' ? condition : null;
}
function edgeTargetId(edge) {
    return (typeof edge['target'] === 'string' ? edge['target'] : null) ??
        (typeof edge['to'] === 'string' ? edge['to'] : null);
}
function collectEdgeRefs(graph, readers) {
    for (const edge of graph.edges) {
        const condition = edgeCondition(edge);
        if (!condition)
            continue;
        const match = CONDITION_RE.exec(condition);
        if (!match)
            continue;
        const key = match[1];
        const targetId = edgeTargetId(edge);
        if (!targetId)
            continue;
        addKeyRef(readers, key, targetId);
    }
}
export function buildContextKeyMatrix(graph, registry) {
    const writers = new Map();
    const readers = new Map();
    collectNodeRefs(graph, writers, readers);
    collectEdgeRefs(graph, readers);
    const allKeys = new Set([...writers.keys(), ...readers.keys()]);
    const rows = [];
    for (const key of allKeys) {
        if (isEngineWritten(key, registry))
            continue;
        rows.push({
            key,
            writers: [...(writers.get(key) ?? new Set())].sort(),
            readers: [...(readers.get(key) ?? new Set())].sort(),
        });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
}
