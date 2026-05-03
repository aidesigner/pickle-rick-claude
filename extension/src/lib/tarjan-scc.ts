import type { Graph, CycleRow } from '../types/plumbus-frame-analyzer.js';

function nodeId(node: Record<string, unknown>): string | null {
  return typeof node['id'] === 'string' ? node['id'] : null;
}

function buildAdjacency(graph: Graph): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  for (const node of graph.nodes) {
    const id = nodeId(node);
    if (id !== null && !adj.has(id)) adj.set(id, []);
  }

  for (const edge of graph.edges) {
    const src =
      (typeof edge['source'] === 'string' ? edge['source'] : null) ??
      (typeof edge['from'] === 'string' ? edge['from'] : null);
    const tgt =
      (typeof edge['target'] === 'string' ? edge['target'] : null) ??
      (typeof edge['to'] === 'string' ? edge['to'] : null);
    if (!src || !tgt) continue;
    if (!adj.has(src)) adj.set(src, []);
    adj.get(src)!.push(tgt);
  }

  for (const [, neighbors] of adj) neighbors.sort();

  return adj;
}

function tarjanSCC(adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const sccStack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  interface WorkItem {
    node: string;
    neighborIdx: number;
  }

  for (const startNode of [...adj.keys()].sort()) {
    if (index.has(startNode)) continue;

    const workStack: WorkItem[] = [{ node: startNode, neighborIdx: 0 }];

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
        } else if (onStack.has(neighbor)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(neighbor)!));
        }
      } else {
        workStack.pop();

        if (workStack.length > 0) {
          const parent = workStack[workStack.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
        }

        if (lowlink.get(node) === index.get(node)) {
          const scc: string[] = [];
          let popped: string;
          do {
            popped = sccStack.pop()!;
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

function hasIterateSignal(node: Record<string, unknown>): boolean {
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

function hasModelLadderSignal(node: Record<string, unknown>): boolean {
  return node['model_ladder'] !== undefined &&
    node['model_ladder'] !== null &&
    node['ladder_advance_on'] === 'rollback';
}

function hasFixAttemptHistorySignal(node: Record<string, unknown>): boolean {
  const ctxKeys = node['context_keys'];
  if (typeof ctxKeys !== 'string') return false;
  const keys = ctxKeys.split(',').map(k => k.trim());
  return keys.includes('__pool_findings__') ||
    keys.includes('__fix_attempt_history') ||
    keys.includes('__last_failure_output');
}

function findSignalNode(
  sccNodes: string[],
  nodeMap: Map<string, Record<string, unknown>>,
  predicate: (node: Record<string, unknown>) => boolean,
): boolean {
  for (const id of sccNodes) {
    const node = nodeMap.get(id);
    if (node && predicate(node)) return true;
  }
  return false;
}

function detectConvergenceSignal(
  sccNodes: string[],
  nodeMap: Map<string, Record<string, unknown>>,
): CycleRow['convergence_signal'] {
  if (findSignalNode(sccNodes, nodeMap, hasIterateSignal)) return 'iterate';
  if (findSignalNode(sccNodes, nodeMap, hasModelLadderSignal)) return 'model_ladder';
  if (findSignalNode(sccNodes, nodeMap, hasFixAttemptHistorySignal)) return 'fix_attempt_history';
  return null;
}

function buildNodeMap(graph: Graph): Map<string, Record<string, unknown>> {
  const nodeMap = new Map<string, Record<string, unknown>>();
  for (const node of graph.nodes) {
    const id = nodeId(node);
    if (id !== null) nodeMap.set(id, node);
  }
  return nodeMap;
}

function edgeEndpoint(edge: Record<string, unknown>, primary: 'source' | 'target', fallback: 'from' | 'to'): string | null {
  return (typeof edge[primary] === 'string' ? edge[primary] : null) ??
    (typeof edge[fallback] === 'string' ? edge[fallback] : null);
}

function collectSelfLoopNodes(graph: Graph): Set<string> {
  const selfLoopNodes = new Set<string>();
  for (const edge of graph.edges) {
    const src = edgeEndpoint(edge, 'source', 'from');
    const tgt = edgeEndpoint(edge, 'target', 'to');
    if (src && tgt && src === tgt) selfLoopNodes.add(src);
  }
  return selfLoopNodes;
}

export function buildCycles(graph: Graph): CycleRow[] {
  const adj = buildAdjacency(graph);
  const rawSccs = tarjanSCC(adj);
  const nodeMap = buildNodeMap(graph);
  const selfLoopNodes = collectSelfLoopNodes(graph);

  const rows: CycleRow[] = [];

  for (const scc of rawSccs) {
    const isTrivial = scc.length === 1 && !selfLoopNodes.has(scc[0]);
    if (isTrivial) continue;

    const sccNodes = [...scc].sort();
    const convergenceSignal = detectConvergenceSignal(sccNodes, nodeMap);
    rows.push({ scc_nodes: sccNodes, convergence_signal: convergenceSignal });
  }

  return rows;
}
