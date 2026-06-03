function nodeId(node) {
    return typeof node['id'] === 'string' ? node['id'] : null;
}
function buildAdjacency(graph) {
    const adj = new Map();
    for (const node of graph.nodes) {
        const id = nodeId(node);
        if (id !== null && !adj.has(id))
            adj.set(id, []);
    }
    for (const edge of graph.edges) {
        const src = edgeEndpoint(edge, 'source', 'from');
        const tgt = edgeEndpoint(edge, 'target', 'to');
        if (!src || !tgt)
            continue;
        if (!adj.has(src))
            adj.set(src, []);
        adj.get(src).push(tgt);
    }
    for (const [, neighbors] of adj)
        neighbors.sort();
    return adj;
}
function tarjanSCC(adj) {
    const index = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const sccStack = [];
    const sccs = [];
    let counter = 0;
    for (const startNode of [...adj.keys()].sort()) {
        if (index.has(startNode))
            continue;
        const workStack = [{ node: startNode, neighborIdx: 0 }];
        while (workStack.length > 0) {
            const frame = workStack[workStack.length - 1];
            const { node } = frame;
            if (frame.neighborIdx === 0) {
                index.set(node, counter);
                lowlink.set(node, counter);
                counter++;
                onStack.add(node);
                sccStack.push(node);
            }
            const neighbors = adj.get(node) ?? [];
            if (frame.neighborIdx < neighbors.length) {
                const neighbor = neighbors[frame.neighborIdx];
                frame.neighborIdx++;
                if (!index.has(neighbor)) {
                    workStack.push({ node: neighbor, neighborIdx: 0 });
                }
                else if (onStack.has(neighbor)) {
                    lowlink.set(node, Math.min(lowlink.get(node), index.get(neighbor)));
                }
            }
            else {
                workStack.pop();
                if (workStack.length > 0) {
                    const parent = workStack[workStack.length - 1].node;
                    lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
                }
                if (lowlink.get(node) === index.get(node)) {
                    const scc = [];
                    let popped;
                    do {
                        popped = sccStack.pop();
                        onStack.delete(popped);
                        scc.push(popped);
                    } while (popped !== node);
                    sccs.push(scc);
                }
            }
        }
    }
    return sccs;
}
function hasIterateSignal(node) {
    const epsilon = node['convergence_epsilon'];
    const until = node['until'];
    return node['class'] === 'iterate' &&
        typeof epsilon !== 'undefined' &&
        epsilon !== null &&
        Number(epsilon) > 0 &&
        until !== undefined &&
        until !== null &&
        until !== '';
}
function hasModelLadderSignal(node) {
    return node['model_ladder'] !== undefined &&
        node['model_ladder'] !== null &&
        node['ladder_advance_on'] === 'rollback';
}
function hasFixAttemptHistorySignal(node) {
    const ctxKeys = node['context_keys'];
    if (typeof ctxKeys !== 'string')
        return false;
    const keys = ctxKeys.split(',').map(k => k.trim());
    return keys.includes('__pool_findings__') ||
        keys.includes('__fix_attempt_history') ||
        keys.includes('__last_failure_output');
}
function findSignalNode(sccNodes, nodeMap, predicate) {
    for (const id of sccNodes) {
        const node = nodeMap.get(id);
        if (node && predicate(node))
            return true;
    }
    return false;
}
function detectConvergenceSignal(sccNodes, nodeMap) {
    if (findSignalNode(sccNodes, nodeMap, hasIterateSignal))
        return 'iterate';
    if (findSignalNode(sccNodes, nodeMap, hasModelLadderSignal))
        return 'model_ladder';
    if (findSignalNode(sccNodes, nodeMap, hasFixAttemptHistorySignal))
        return 'fix_attempt_history';
    return null;
}
function buildNodeMap(graph) {
    const nodeMap = new Map();
    for (const node of graph.nodes) {
        const id = nodeId(node);
        if (id !== null)
            nodeMap.set(id, node);
    }
    return nodeMap;
}
function edgeEndpoint(edge, primary, fallback) {
    return (typeof edge[primary] === 'string' ? edge[primary] : null) ??
        (typeof edge[fallback] === 'string' ? edge[fallback] : null);
}
function collectSelfLoopNodes(graph) {
    const selfLoopNodes = new Set();
    for (const edge of graph.edges) {
        const src = edgeEndpoint(edge, 'source', 'from');
        const tgt = edgeEndpoint(edge, 'target', 'to');
        if (src && tgt && src === tgt)
            selfLoopNodes.add(src);
    }
    return selfLoopNodes;
}
export function buildCycles(graph) {
    const adj = buildAdjacency(graph);
    const rawSccs = tarjanSCC(adj);
    const nodeMap = buildNodeMap(graph);
    const selfLoopNodes = collectSelfLoopNodes(graph);
    const rows = [];
    for (const scc of rawSccs) {
        const isTrivial = scc.length === 1 && !selfLoopNodes.has(scc[0]);
        if (isTrivial)
            continue;
        const sccNodes = [...scc].sort();
        const convergenceSignal = detectConvergenceSignal(sccNodes, nodeMap);
        rows.push({ scc_nodes: sccNodes, convergence_signal: convergenceSignal });
    }
    return rows;
}
