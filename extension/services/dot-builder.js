// DOT pipeline codegen builder — no process.exit() (eslint-plugin-pickle rule)
import { BuildError } from '../types/index.js';
export { BuildError } from '../types/index.js';
// ---------------------------------------------------------------------------
// BUILD_ERROR_CODES — runtime constant, mirrors BuildErrorCode union
// ---------------------------------------------------------------------------
export const BUILD_ERROR_CODES = [
    'EMPTY_SLUG', 'EMPTY_GOAL', 'DUPLICATE_PHASE', 'INVALID_RATCHET',
    'NON_NUMERIC_TARGET', 'ALREADY_BUILT', 'INVALID_STRUCTURE', 'START_HAS_INCOMING',
    'UNREACHABLE_NODE', 'DIAMOND_MISSING_EDGES', 'GOAL_GATE_NO_MAX_VISITS',
    'MISSING_AC_MAPPING', 'MISSING_TIMEOUT', 'PROMPT_PATH_MISMATCH',
    'REVIEW_MISSING_READONLY', 'COMPONENT_NO_MERGE', 'FAN_OUT_SCOPE_LEAK',
    'WORKSPACE_NO_HTTPS', 'WORKSPACE_NO_PUSH', 'PLAN_MODE_DEADLOCK',
    'MISSING_ALLOWED_PATHS', 'INVALID_SPEC', 'INVALID_TIMEOUT', 'INVALID_ALLOWED_PATHS',
];
// Alias for JS consumers
export const BuildErrorCode = BUILD_ERROR_CODES;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function mkDiag(rule, severity, message, nodeId) {
    const d = { rule, severity, message };
    if (nodeId !== undefined)
        d.nodeId = nodeId;
    return d;
}
function pass() { return { valid: true, diagnostics: [] }; }
function fail(diagnostics) { return { valid: false, diagnostics }; }
/** Escape a string for use inside DOT double-quoted attribute values. */
function escapeAttr(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}
/** Format a key-value map into DOT attribute syntax: key="val", key2="val2" */
function fmtAttrs(map) {
    return Object.keys(map)
        .sort()
        .map(k => `${k}="${escapeAttr(map[k])}"`)
        .join(', ');
}
/** DOT reserved words that cannot be used as bare node identifiers. */
const DOT_RESERVED = new Set([
    'graph', 'digraph', 'subgraph', 'edge', 'node', 'strict',
]);
/** Sanitize a phase name into a valid DOT node identifier. */
function sanitizeId(name) {
    let id = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (/^\d/.test(id))
        id = '_' + id;
    // Prevent collision with DOT reserved words
    if (DOT_RESERVED.has(id))
        id = `phase_${id}`;
    return id;
}
// ---------------------------------------------------------------------------
// Structural validation helpers
// ---------------------------------------------------------------------------
const RESERVED_IDS = new Set([
    'start', 'exit', 'setup_deps', 'capture_baseline',
    // Endgame structural nodes
    'verify_typecheck', 'verify_lint', 'verify_tests',
    'audit', 'regression_check', 'quality_review',
    'fix_types', 'fix_lint', 'fix_tests', 'fix_quality', 'fix_all', 'fix_review',
]);
/** Extract path-like tokens (containing '/') from a prompt string. */
function extractPromptPaths(prompt) {
    return (prompt.match(/\b[\w.-]+(?:\/[\w.-]+)+/g) ?? []);
}
// ---------------------------------------------------------------------------
// Pre-flight spec validation — runs before emission; throws on first error
// ---------------------------------------------------------------------------
function preflightReservedIds(phases) {
    const diags = [];
    for (const phase of phases) {
        const id = sanitizeId(phase.name);
        if (RESERVED_IDS.has(id)) {
            diags.push(mkDiag('INVALID_STRUCTURE', 'error', `phase "${phase.name}" sanitizes to reserved node id "${id}"`, id));
        }
    }
    return diags;
}
function preflightDanglingDeps(phases) {
    const knownIds = new Set([
        ...phases.map(p => sanitizeId(p.name)),
        ...phases.map(p => p.name),
    ]);
    const diags = [];
    for (const phase of phases) {
        if (!phase.dependsOn || phase.dependsOn.length === 0)
            continue;
        for (const dep of phase.dependsOn) {
            if (!knownIds.has(dep) && !knownIds.has(sanitizeId(dep))) {
                diags.push(mkDiag('UNREACHABLE_NODE', 'error', `phase "${phase.name}" depends on "${dep}" which does not exist`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightTimeoutFormat(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.timeout)
            continue;
        const match = /^(\d+)([mhd])$/.exec(phase.timeout);
        if (!match) {
            diags.push(mkDiag('INVALID_TIMEOUT', 'error', `phase "${phase.name}" timeout "${phase.timeout}" must match <number><m|h|d> (e.g. "30m")`, sanitizeId(phase.name)));
        }
        else if (parseInt(match[1], 10) === 0) {
            diags.push(mkDiag('INVALID_TIMEOUT', 'error', `phase "${phase.name}" timeout "${phase.timeout}" must be > 0`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightAllowedPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.allowedPaths)
            continue;
        for (const ap of phase.allowedPaths) {
            if (ap.startsWith('/') || ap.startsWith('..')) {
                diags.push(mkDiag('INVALID_ALLOWED_PATHS', 'error', `phase "${phase.name}" allowedPaths contains "${ap}" — must be relative, no absolute or traversal paths`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightStartIncoming(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.retryTarget === 'start') {
            diags.push(mkDiag('START_HAS_INCOMING', 'error', `phase "${phase.name}" retryTarget "start" would create an incoming edge to the start node`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightGoalGateEdges(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.goalGate && !phase.specFirst && !phase.retryTarget) {
            diags.push(mkDiag('DIAMOND_MISSING_EDGES', 'error', `goalGate phase "${phase.name}" requires retryTarget to provide ≥2 outgoing edges`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightFanOutScope(phases) {
    const independent = phases.filter(p => !p.dependsOn || p.dependsOn.length === 0);
    if (independent.length < 2)
        return [];
    const indIds = new Set(independent.map(p => sanitizeId(p.name)));
    const diags = [];
    for (const phase of independent) {
        if (!phase.retryTarget)
            continue;
        const thisId = sanitizeId(phase.name);
        for (const otherId of indIds) {
            if (otherId !== thisId && phase.retryTarget.includes(otherId)) {
                diags.push(mkDiag('FAN_OUT_SCOPE_LEAK', 'error', `phase "${phase.name}" retryTarget "${phase.retryTarget}" escapes fan-out scope into branch "${otherId}"`, thisId));
                break;
            }
        }
    }
    return diags;
}
function preflightWorkspaceHttps(workspace, workspaceOpts) {
    if (workspace !== 'isolated')
        return [];
    const repoUrl = workspaceOpts?.repoUrl;
    if (!repoUrl)
        return [];
    if (!repoUrl.startsWith('https://')) {
        return [mkDiag('WORKSPACE_NO_HTTPS', 'error', `workspace="isolated" requires HTTPS repo_url; got: "${repoUrl}"`)];
    }
    return [];
}
function preflightPlanDeadlock(phases) {
    return phases
        .filter(p => p.specFirst && p.goalGate)
        .map(p => mkDiag('PLAN_MODE_DEADLOCK', 'error', `phase "${p.name}" combines specFirst+goalGate, producing plan-mode deadlock in headless pipeline`, sanitizeId(p.name)));
}
function preflightWorkspacePush(workspace, phases) {
    if (workspace !== 'isolated')
        return [];
    const hasCommitPush = phases.some(p => {
        const id = sanitizeId(p.name);
        return id === 'commit_and_push' || (id.includes('commit') && id.includes('push'));
    });
    if (!hasCommitPush) {
        return [mkDiag('WORKSPACE_NO_PUSH', 'error', 'workspace="isolated" requires a commit_and_push phase in the pipeline')];
    }
    return [];
}
function preflightPromptPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (!phase.allowedPaths || phase.allowedPaths.length === 0)
            continue;
        for (const p of extractPromptPaths(phase.prompt)) {
            const covered = phase.allowedPaths.some(ap => p.startsWith(ap) || ap.startsWith(p + '/'));
            if (!covered) {
                diags.push(mkDiag('PROMPT_PATH_MISMATCH', 'error', `phase "${phase.name}" prompt references path "${p}" outside allowedPaths`, sanitizeId(phase.name)));
                break;
            }
        }
    }
    return diags;
}
function preflightMissingAllowedPaths(phases) {
    const diags = [];
    for (const phase of phases) {
        if (phase.securityScan || phase.docOnly)
            continue;
        if (!phase.allowedPaths || phase.allowedPaths.length === 0) {
            diags.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', `phase "${phase.name}" requires non-empty allowedPaths`, sanitizeId(phase.name)));
        }
    }
    return diags;
}
function preflightCircularDeps(phases) {
    const adj = new Map();
    const ids = new Set();
    for (const p of phases) {
        const id = sanitizeId(p.name);
        ids.add(id);
        adj.set(id, []);
    }
    for (const p of phases) {
        const id = sanitizeId(p.name);
        if (!p.dependsOn)
            continue;
        for (const dep of p.dependsOn) {
            const depId = ids.has(dep) ? dep : sanitizeId(dep);
            if (ids.has(depId))
                adj.get(depId).push(id);
        }
    }
    const inDeg = new Map();
    for (const id of ids)
        inDeg.set(id, 0);
    for (const [, targets] of adj) {
        for (const t of targets)
            inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
    const queue = [...ids].filter(id => inDeg.get(id) === 0);
    let visited = 0;
    while (queue.length > 0) {
        const node = queue.shift();
        visited++;
        for (const next of (adj.get(node) ?? [])) {
            const d = inDeg.get(next) - 1;
            inDeg.set(next, d);
            if (d === 0)
                queue.push(next);
        }
    }
    if (visited < ids.size) {
        const cycle = [...ids].filter(id => (inDeg.get(id) ?? 0) > 0);
        return [mkDiag('INVALID_STRUCTURE', 'error', `circular dependency detected among phases: ${cycle.join(', ')}`)];
    }
    return [];
}
// ---------------------------------------------------------------------------
// 15 structural validation rules — run sequentially on the complete graph.
// ---------------------------------------------------------------------------
function grRule1(nodeMap) {
    const diamonds = [...nodeMap.entries()].filter(([, a]) => a['shape'] === 'Mdiamond');
    const squares = [...nodeMap.entries()].filter(([, a]) => a['shape'] === 'Msquare');
    const diags = [];
    if (diamonds.length !== 1) {
        diags.push(mkDiag('INVALID_STRUCTURE', 'error', `graph must have exactly 1 Mdiamond (start) node; found ${diamonds.length}`));
    }
    if (squares.length !== 1) {
        diags.push(mkDiag('INVALID_STRUCTURE', 'error', `graph must have exactly 1 Msquare (exit) node; found ${squares.length}`));
    }
    return diags;
}
function grRule2(nodeMap, edgeList) {
    const startEntry = [...nodeMap.entries()].find(([, a]) => a['shape'] === 'Mdiamond');
    if (!startEntry)
        return [];
    const startId = startEntry[0];
    const incoming = edgeList.filter(e => e.to === startId);
    if (incoming.length > 0) {
        return [mkDiag('START_HAS_INCOMING', 'error', `start node "${startId}" has ${incoming.length} incoming edge(s); must have 0`, startId)];
    }
    return [];
}
function grRule3(nodeMap, edgeList, standaloneNodeIds) {
    const startEntry = [...nodeMap.entries()].find(([, a]) => a['shape'] === 'Mdiamond');
    if (!startEntry)
        return [];
    const startId = startEntry[0];
    const adj = new Map();
    for (const id of nodeMap.keys())
        adj.set(id, []);
    for (const e of edgeList) {
        const neighbors = adj.get(e.from);
        if (neighbors)
            neighbors.push(e.to);
    }
    const visited = new Set();
    const queue = [startId];
    while (queue.length > 0) {
        const node = queue.shift();
        if (visited.has(node))
            continue;
        visited.add(node);
        for (const next of (adj.get(node) ?? []))
            queue.push(next);
    }
    return [...nodeMap.keys()]
        .filter(id => !visited.has(id) && !standaloneNodeIds.has(id))
        .map(id => mkDiag('UNREACHABLE_NODE', 'error', `node "${id}" is not reachable from the start node`, id));
}
function grRule4(nodeMap, edgeList) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['shape'] !== 'diamond')
            continue;
        const outCount = edgeList.filter(e => e.from === id).length;
        if (outCount < 2) {
            diags.push(mkDiag('DIAMOND_MISSING_EDGES', 'error', `diamond node "${id}" has ${outCount} outgoing edge(s); must have ≥2`, id));
        }
    }
    return diags;
}
function grRule5(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['retry_target'] && !attrs['max_visits']) {
            diags.push(mkDiag('GOAL_GATE_NO_MAX_VISITS', 'error', `node "${id}" has retry_target but no max_visits — unbounded retry loop`, id));
        }
    }
    return diags;
}
function grRule6(nodeMap, acceptanceCriteria) {
    const acKeys = Object.keys(acceptanceCriteria);
    if (acKeys.length === 0)
        return [];
    const mapped = new Set();
    for (const attrs of nodeMap.values()) {
        if (attrs['context_on_success']) {
            for (const k of attrs['context_on_success'].split(','))
                mapped.add(k.trim());
        }
    }
    return acKeys
        .filter(k => !mapped.has(k))
        .map(k => mkDiag('MISSING_AC_MAPPING', 'error', `acceptanceCriteria key "${k}" has no node with context_on_success mapping it`));
}
function grRule7(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] === 'codergen' && !attrs['timeout']) {
            diags.push(mkDiag('MISSING_TIMEOUT', 'error', `codergen node "${id}" is missing a timeout attribute`, id));
        }
    }
    return diags;
}
function grRule8(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const label = attrs['label'];
        const apStr = attrs['allowed_paths'];
        if (!label || !apStr)
            continue;
        const allowedPaths = apStr.split(',').filter(Boolean);
        if (allowedPaths.length === 0)
            continue;
        for (const p of extractPromptPaths(label)) {
            const covered = allowedPaths.some(ap => p.startsWith(ap) || ap.startsWith(p + '/'));
            if (!covered) {
                diags.push(mkDiag('PROMPT_PATH_MISMATCH', 'error', `node "${id}" label references path "${p}" outside allowed_paths`, id));
                break;
            }
        }
    }
    return diags;
}
function grRule9(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] !== 'review')
            continue;
        if (attrs['read_only'] !== 'true' || !attrs['label']?.includes('STATUS')) {
            diags.push(mkDiag('REVIEW_MISSING_READONLY', 'error', `review node "${id}" must have read_only=true and STATUS in label`, id));
        }
    }
    return diags;
}
function grRule10(nodeMap, _edgeList) {
    const hasComponent = [...nodeMap.values()].some(a => a['shape'] === 'component');
    if (!hasComponent)
        return [];
    const hasTripleOctagon = [...nodeMap.values()].some(a => a['shape'] === 'tripleoctagon');
    if (!hasTripleOctagon) {
        return [mkDiag('COMPONENT_NO_MERGE', 'warning', 'component nodes present but no tripleoctagon merge node found — builder will auto-emit one (Pattern 4)')];
    }
    return [];
}
function grRule11(nodeMap) {
    const componentIds = new Set([...nodeMap.entries()]
        .filter(([, a]) => a['shape'] === 'component')
        .map(([id]) => id));
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const retryTarget = attrs['retry_target'];
        if (!retryTarget || !componentIds.has(id))
            continue;
        const otherBranches = [...componentIds].filter(cid => cid !== id && !cid.includes('merge') && !cid.includes('split'));
        for (const otherId of otherBranches) {
            if (retryTarget.includes(otherId)) {
                diags.push(mkDiag('FAN_OUT_SCOPE_LEAK', 'error', `node "${id}" retry_target "${retryTarget}" escapes fan-out scope into branch "${otherId}"`, id));
                break;
            }
        }
    }
    return diags;
}
function grRule12(nodeMap, graphAttrs) {
    if (graphAttrs['workspace'] !== 'isolated')
        return [];
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        const repoUrl = attrs['repo_url'];
        if (repoUrl && !repoUrl.startsWith('https://')) {
            diags.push(mkDiag('WORKSPACE_NO_HTTPS', 'error', `node "${id}" workspace=isolated requires HTTPS repo_url; got "${repoUrl}"`, id));
        }
    }
    return diags;
}
function grRule13(nodeMap, graphAttrs) {
    if (graphAttrs['workspace'] !== 'isolated')
        return [];
    const hasCommitPush = [...nodeMap.keys()].some(id => id === 'commit_and_push' || (id.includes('commit') && id.includes('push')));
    if (!hasCommitPush) {
        return [mkDiag('WORKSPACE_NO_PUSH', 'error', 'workspace=isolated requires a commit_and_push node in the pipeline')];
    }
    return [];
}
function grRule14(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['permission_mode'] === 'plan') {
            diags.push(mkDiag('PLAN_MODE_DEADLOCK', 'error', `node "${id}" uses permission_mode=plan — deadlock in headless pipeline`, id));
        }
    }
    return diags;
}
function grRule15(nodeMap) {
    const diags = [];
    for (const [id, attrs] of nodeMap.entries()) {
        if (attrs['class'] === 'codergen') {
            const ap = attrs['allowed_paths'];
            if (!ap || ap.trim() === '') {
                diags.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', `codergen node "${id}" requires non-empty allowed_paths`, id));
            }
        }
    }
    return diags;
}
// ---------------------------------------------------------------------------
// Runtime validator namespace objects
// ---------------------------------------------------------------------------
export const DiagnosticNs = {
    create(data) {
        if (!isRecord(data))
            throw new Error('Diagnostic.create requires an object');
        const { rule, severity, message, nodeId, edge, fix } = data;
        if (typeof rule !== 'string' || !rule)
            throw new Error('Diagnostic requires a non-empty rule');
        if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
            throw new Error(`Diagnostic severity must be error, warning, or info; got: ${String(severity)}`);
        }
        if (typeof message !== 'string')
            throw new Error('Diagnostic requires a message string');
        if (edge !== undefined) {
            if (!Array.isArray(edge) || edge.length !== 2 || typeof edge[0] !== 'string' || typeof edge[1] !== 'string') {
                throw new Error('Diagnostic edge must be a tuple of exactly two strings');
            }
        }
        const result = { rule, severity, message };
        if (typeof nodeId === 'string')
            result.nodeId = nodeId;
        if (Array.isArray(edge) && edge.length === 2)
            result.edge = edge;
        if (typeof fix === 'string')
            result.fix = fix;
        return result;
    },
};
// Alias: compiled JS exports as both `Diagnostic` and `DiagnosticNs`
export { DiagnosticNs as Diagnostic };
export const ValidationResultNs = {
    validate(vr) {
        if (!isRecord(vr))
            return fail([mkDiag('INVALID_SPEC', 'error', 'ValidationResult must be an object')]);
        const diagnostics = [];
        if (typeof vr['valid'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'valid must be a boolean'));
        }
        if (!Array.isArray(vr['diagnostics'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'diagnostics must be an array'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { ValidationResultNs as ValidationResult };
const VALID_SPEC_DRIVEN = [
    'NONE', 'conformance', 'BDD + conformance',
    'spec_file + conformance', 'spec_file + BDD + conformance',
];
export const DefenseMatrixNs = {
    validate(dm) {
        if (!isRecord(dm))
            return fail([mkDiag('INVALID_SPEC', 'error', 'DefenseMatrix must be an object')]);
        const diagnostics = [];
        if (typeof dm['competitive'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'competitive must be a boolean'));
        }
        if (typeof dm['adversarial'] !== 'boolean') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'adversarial must be a boolean'));
        }
        if (!Array.isArray(dm['guardrails']) || !dm['guardrails'].every((g) => typeof g === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'guardrails must be a string array'));
        }
        if (!Array.isArray(dm['permissions']) || !dm['permissions'].every((p) => typeof p === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'permissions must be a string array'));
        }
        if (!VALID_SPEC_DRIVEN.includes(dm['specDriven'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', `specDriven must be one of: ${VALID_SPEC_DRIVEN.join(', ')}`));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { DefenseMatrixNs as DefenseMatrix };
export const BuildResultNs = {
    validate(result) {
        if (!isRecord(result))
            return fail([mkDiag('INVALID_SPEC', 'error', 'BuildResult must be an object')]);
        const diagnostics = [];
        if (typeof result['dot'] !== 'string' || !result['dot']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'dot must be a non-empty string'));
        }
        if (typeof result['slug'] !== 'string') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'slug must be a string'));
        }
        if (!Array.isArray(result['patternsApplied']) || !result['patternsApplied'].every((p) => typeof p === 'string')) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'patternsApplied must be a string array'));
        }
        if (!Array.isArray(result['diagnostics'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'diagnostics must be an array'));
        }
        if (!result['defenseMatrix'] || typeof result['defenseMatrix'] !== 'object' || Array.isArray(result['defenseMatrix'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'defenseMatrix must be an object'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
// Alias for CLI test compatibility
export { BuildResultNs as BuildResult };
export const MicroverseOptsNs = {
    validate(opts) {
        if (!isRecord(opts))
            return fail([mkDiag('INVALID_SPEC', 'error', 'MicroverseOpts must be an object')]);
        const diagnostics = [];
        if (typeof opts['prompt'] !== 'string' || !opts['prompt']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'prompt is required'));
        }
        if (typeof opts['measureCommand'] !== 'string' || !opts['measureCommand']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'measureCommand is required'));
        }
        if (typeof opts['target'] !== 'number') {
            diagnostics.push(mkDiag('NON_NUMERIC_TARGET', 'error', 'target must be a number'));
        }
        if (opts['direction'] !== 'reduce' && opts['direction'] !== 'improve') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'direction must be "reduce" or "improve"'));
        }
        if (!Array.isArray(opts['allowedPaths'])) {
            diagnostics.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', 'allowedPaths is required'));
        }
        if (opts['maxVisits'] !== undefined) {
            const mv = opts['maxVisits'];
            if (typeof mv !== 'number' || !Number.isInteger(mv) || mv < 1) {
                diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'maxVisits must be a positive integer >= 1'));
            }
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { MicroverseOptsNs as MicroverseOpts };
export const WorkspaceOptsNs = {
    validate(opts) {
        if (!isRecord(opts))
            return fail([mkDiag('INVALID_SPEC', 'error', 'WorkspaceOpts must be an object')]);
        const diagnostics = [];
        const cleanup = opts['cleanup'];
        if (cleanup !== undefined && cleanup !== 'delete' && cleanup !== 'preserve') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'cleanup must be "delete" or "preserve"'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { WorkspaceOptsNs as WorkspaceOpts };
export const StylesheetConfigNs = {
    validate(config) {
        if (!isRecord(config))
            return fail([mkDiag('INVALID_SPEC', 'error', 'StylesheetConfig must be an object')]);
        const diagnostics = [];
        if (typeof config['defaultModel'] !== 'string' || !config['defaultModel']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'defaultModel is required'));
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { StylesheetConfigNs as StylesheetConfig };
export const PhaseSpecNs = {
    validate(phase) {
        if (!isRecord(phase))
            return fail([mkDiag('INVALID_SPEC', 'error', 'PhaseSpec must be an object')]);
        const diagnostics = [];
        if (typeof phase['name'] !== 'string' || !phase['name']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'name is required'));
        }
        if (typeof phase['prompt'] !== 'string' || !phase['prompt']) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'prompt is required'));
        }
        if (!Array.isArray(phase['allowedPaths'])) {
            diagnostics.push(mkDiag('MISSING_ALLOWED_PATHS', 'error', 'allowedPaths is required'));
        }
        if (phase['dependsOn'] !== undefined) {
            if (!Array.isArray(phase['dependsOn']) || !phase['dependsOn'].every((d) => typeof d === 'string')) {
                diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'dependsOn must be an array of strings'));
            }
        }
        const valid = diagnostics.length === 0;
        const result = { valid, diagnostics };
        if (phase['docOnly'] === true)
            result.docOnly = true;
        return result;
    },
};
export { PhaseSpecNs as PhaseSpec };
export const BuilderSpecNs = {
    validate(spec) {
        if (!isRecord(spec)) {
            return fail([
                mkDiag('EMPTY_SLUG', 'error', 'slug is required'),
                mkDiag('EMPTY_GOAL', 'error', 'goal is required'),
                mkDiag('INVALID_SPEC', 'error', 'phases is required'),
            ]);
        }
        const diagnostics = [];
        if (typeof spec['slug'] !== 'string') {
            diagnostics.push(mkDiag('EMPTY_SLUG', 'error', 'slug is required'));
        }
        else if (!spec['slug'].trim()) {
            diagnostics.push(mkDiag('EMPTY_SLUG', 'error', 'slug cannot be empty'));
        }
        if (typeof spec['goal'] !== 'string') {
            diagnostics.push(mkDiag('EMPTY_GOAL', 'error', 'goal is required'));
        }
        else if (!spec['goal'].trim()) {
            diagnostics.push(mkDiag('EMPTY_GOAL', 'error', 'goal cannot be empty'));
        }
        if (!Array.isArray(spec['phases'])) {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'phases is required and must be an array'));
        }
        if (spec['workspace'] !== undefined && spec['workspace'] !== 'isolated') {
            diagnostics.push(mkDiag('INVALID_SPEC', 'error', 'workspace must be "isolated" or undefined'));
        }
        if (spec['reviewRatchet'] !== undefined) {
            const rr = spec['reviewRatchet'];
            if (typeof rr !== 'number' || rr < 2) {
                diagnostics.push(mkDiag('INVALID_RATCHET', 'error', 'reviewRatchet must be >= 2'));
            }
        }
        return diagnostics.length === 0 ? pass() : fail(diagnostics);
    },
};
export { BuilderSpecNs as BuilderSpec };
export class DotBuilder {
    _slug;
    _goal;
    _phases = [];
    _seenIds = new Set();
    _spec;
    _built = false;
    static fromSpec(raw) {
        if (!isRecord(raw)) {
            throw new BuildError('INVALID_SPEC', 'spec must be a non-null object');
        }
        const spec = raw;
        if (!Array.isArray(spec['phases'])) {
            throw new BuildError('INVALID_SPEC', 'spec.phases must be an array');
        }
        const base = {
            slug: spec['slug'],
            goal: spec['goal'],
            phases: [],
            acceptanceCriteria: (isRecord(spec['acceptanceCriteria']) ? spec['acceptanceCriteria'] : {}),
            workingDir: typeof spec['workingDir'] === 'string' ? spec['workingDir'] : undefined,
            label: typeof spec['label'] === 'string' ? spec['label'] : undefined,
            defaultMaxRetry: typeof spec['defaultMaxRetry'] === 'number' ? spec['defaultMaxRetry'] : undefined,
            specFile: typeof spec['specFile'] === 'string' ? spec['specFile'] : undefined,
        };
        const builder = new DotBuilder(base);
        for (const p of spec['phases']) {
            if (!isRecord(p) || typeof p['name'] !== 'string') {
                throw new BuildError('INVALID_SPEC', 'each phase must be an object with a string "name" field');
            }
            builder.phase(p);
        }
        if (spec['workspace'] === 'isolated') {
            builder.workspace(isRecord(spec['workspaceOpts']) ? spec['workspaceOpts'] : undefined);
        }
        if (isRecord(spec['microverse'])) {
            const mv = spec['microverse'];
            if (typeof mv['name'] === 'string' && isRecord(mv['opts'])) {
                builder.microverse(mv['name'], mv['opts']);
            }
        }
        if (typeof spec['reviewRatchet'] === 'number') {
            builder.reviewRatchet(spec['reviewRatchet']);
        }
        if (isRecord(spec['modelStylesheet'])) {
            builder.modelStylesheet(spec['modelStylesheet']);
        }
        return builder;
    }
    constructor(spec) {
        if (typeof spec.slug !== 'string' || !spec.slug.trim()) {
            throw new BuildError('EMPTY_SLUG', 'slug cannot be empty');
        }
        if (typeof spec.goal !== 'string' || !spec.goal.trim()) {
            throw new BuildError('EMPTY_GOAL', 'goal cannot be empty');
        }
        if (spec.reviewRatchet !== undefined && spec.reviewRatchet < 2) {
            throw new BuildError('INVALID_RATCHET', 'reviewRatchet must be >= 2');
        }
        this._spec = spec;
        this._slug = spec.slug.trim();
        this._goal = spec.goal.trim();
        for (const p of spec.phases) {
            this.phase(p);
        }
    }
    phase(first, opts) {
        if (this._built) {
            throw new BuildError('ALREADY_BUILT', 'cannot add phases after build() has been called');
        }
        const phaseSpec = typeof first === 'string' ? { name: first, ...opts } : first;
        const id = sanitizeId(phaseSpec.name);
        if (!id) {
            throw new BuildError('EMPTY_SLUG', `phase name "${phaseSpec.name}" sanitizes to empty string — must contain ASCII alphanumeric characters`);
        }
        if (this._seenIds.has(id)) {
            throw new BuildError('DUPLICATE_PHASE', `duplicate phase id after sanitization: "${id}"`);
        }
        this._seenIds.add(id);
        this._phases.push(phaseSpec);
        return this;
    }
    microverse(name, opts) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call microverse() after build()');
        this._spec = { ...this._spec, microverse: { name, opts } };
        return this;
    }
    reviewRatchet(passes) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call reviewRatchet() after build()');
        if (passes < 2)
            throw new BuildError('INVALID_RATCHET', 'reviewRatchet must be >= 2');
        this._spec = { ...this._spec, reviewRatchet: passes };
        return this;
    }
    acceptanceCriteria(criteria) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call acceptanceCriteria() after build()');
        this._spec = { ...this._spec, acceptanceCriteria: criteria };
        return this;
    }
    workspace(opts) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call workspace() after build()');
        this._spec = { ...this._spec, workspace: 'isolated', workspaceOpts: opts };
        return this;
    }
    modelStylesheet(config) {
        if (this._built)
            throw new BuildError('ALREADY_BUILT', 'cannot call modelStylesheet() after build()');
        this._spec = { ...this._spec, modelStylesheet: config };
        return this;
    }
    build() {
        if (this._built) {
            throw new BuildError('ALREADY_BUILT', 'build() has already been called');
        }
        this._built = true;
        const phases = this._phases;
        // Pre-flight spec validation
        const preflightDiags = [
            ...preflightReservedIds(phases),
            ...preflightDanglingDeps(phases),
            ...preflightTimeoutFormat(phases),
            ...preflightAllowedPaths(phases),
            ...preflightCircularDeps(phases),
            ...preflightStartIncoming(phases),
            ...preflightGoalGateEdges(phases),
            ...preflightFanOutScope(phases),
            ...preflightWorkspaceHttps(this._spec.workspace, this._spec.workspaceOpts),
            ...preflightWorkspacePush(this._spec.workspace, phases),
            ...preflightPlanDeadlock(phases),
            ...preflightPromptPaths(phases),
            ...preflightMissingAllowedPaths(phases),
        ];
        const preflightError = preflightDiags.find(d => d.severity === 'error');
        if (preflightError) {
            throw new BuildError(preflightError.rule, preflightError.message, preflightDiags);
        }
        // Emit the complete graph
        const { dot, nodeMap, edgeList, graphAttrs, standaloneNodeIds, patternsApplied, defenseMatrix } = this._emitDot();
        // Run all 15 structural validation rules
        const { acceptanceCriteria = {} } = this._spec;
        const diagnostics = [
            ...grRule1(nodeMap),
            ...grRule2(nodeMap, edgeList),
            ...grRule3(nodeMap, edgeList, standaloneNodeIds),
            ...grRule4(nodeMap, edgeList),
            ...grRule5(nodeMap),
            ...grRule6(nodeMap, acceptanceCriteria),
            ...grRule7(nodeMap),
            ...grRule8(nodeMap),
            ...grRule9(nodeMap),
            ...grRule10(nodeMap, edgeList),
            ...grRule11(nodeMap),
            ...grRule12(nodeMap, graphAttrs),
            ...grRule13(nodeMap, graphAttrs),
            ...grRule14(nodeMap),
            ...grRule15(nodeMap),
        ];
        const firstError = diagnostics.find(d => d.severity === 'error');
        if (firstError) {
            throw new BuildError(firstError.rule, firstError.message, diagnostics);
        }
        return { dot, slug: this._slug, patternsApplied, defenseMatrix, diagnostics };
    }
    // ---------------------------------------------------------------------------
    // Pattern emission
    // ---------------------------------------------------------------------------
    _buildStylesheet(config) {
        const sc = config;
        const parts = [];
        const universalProps = [];
        if (sc.defaultModel)
            universalProps.push(`llm_model: ${sc.defaultModel};`);
        const effort = sc.defaultEffort ?? sc.reasoningEffort;
        if (effort)
            universalProps.push(`reasoning_effort: ${effort};`);
        if (universalProps.length > 0)
            parts.push(`* { ${universalProps.join(' ')} }`);
        if (sc.overrides && sc.overrides.length > 0) {
            for (const ov of sc.overrides) {
                const sel = ov.selector.startsWith('.') || ov.selector === '*' ? ov.selector : `.${ov.selector}`;
                const props = [`llm_model: ${ov.model};`];
                if (ov.effort)
                    props.push(`reasoning_effort: ${ov.effort};`);
                parts.push(`${sel} { ${props.join(' ')} }`);
            }
        }
        else {
            if (sc.criticalModel)
                parts.push(`.critical { llm_model: ${sc.criticalModel}; }`);
            if (sc.reviewModel)
                parts.push(`.review { llm_model: ${sc.reviewModel}; }`);
        }
        return parts.join(' ');
    }
    _emitDot() {
        const spec = this._spec;
        const phases = this._phases;
        const graphId = sanitizeId(this._slug) || 'pipeline';
        const applied = new Set();
        const isCommitPushPhase = (p) => {
            const id = sanitizeId(p.name);
            return id === 'commit_and_push' || (id.includes('commit') && id.includes('push'));
        };
        const independent = phases.filter(p => {
            if (p.securityScan)
                return false;
            if (p.docOnly)
                return false;
            if (spec.workspace === 'isolated' && isCommitPushPhase(p))
                return false;
            return !p.dependsOn || p.dependsOn.length === 0;
        });
        const isFanOut = independent.length >= 2 && !phases.some(p => p.competing);
        const hasCompeting = phases.some(p => p.competing);
        const hasRedTeam = phases.some(p => p.redTeam);
        const hasBDD = phases.some(p => p.bddScenarios);
        const hasSpecFile = Boolean(spec.specFile);
        const hasSpecFirstAny = phases.some(p => p.specFirst === true || (p.goalGate && p.specFirst !== false));
        // Defense matrix
        let specDriven = 'NONE';
        if (hasBDD && hasSpecFile)
            specDriven = 'spec_file + BDD + conformance';
        else if (hasBDD)
            specDriven = 'BDD + conformance';
        else if (hasSpecFile)
            specDriven = 'spec_file + conformance';
        else if (hasSpecFirstAny)
            specDriven = 'conformance';
        const defenseMatrix = {
            competitive: hasCompeting,
            guardrails: [],
            specDriven,
            permissions: [],
            adversarial: hasRedTeam,
        };
        // Graph-level attrs
        const graphAttrs = {
            label: escapeAttr(`${this._slug}: ${this._goal}`),
            rankdir: 'LR',
            goal: escapeAttr(this._goal),
            retry_target: 'fix_all',
        };
        if (spec.workingDir) {
            graphAttrs['working_dir'] = escapeAttr(spec.workingDir);
        }
        if (spec.specFile) {
            graphAttrs['spec_file'] = escapeAttr(spec.specFile);
        }
        if (spec.defaultMaxRetry) {
            graphAttrs['default_max_retry'] = String(spec.defaultMaxRetry);
        }
        if (spec.workspace === 'isolated') {
            graphAttrs['workspace'] = 'isolated';
            applied.add('P0');
        }
        if (spec.modelStylesheet) {
            graphAttrs['model_stylesheet'] = this._buildStylesheet(spec.modelStylesheet);
        }
        // GL-6: acceptance_criteria as context.K=V && context.K2=V2 (sorted)
        const acKeys = Object.keys(spec.acceptanceCriteria ?? {}).sort();
        if (acKeys.length > 0) {
            graphAttrs['acceptance_criteria'] = escapeAttr(acKeys.map(k => `context.${k}=${String((spec.acceptanceCriteria ?? {})[k])}`).join(' && '));
        }
        const nodes = [];
        const edges = [];
        const nodeMap = new Map();
        const edgeList = [];
        const standaloneNodeIds = new Set();
        const emit = (id, attrs) => {
            nodes.push(`  ${id} [${fmtAttrs(attrs)}]`);
            nodeMap.set(id, { ...attrs });
        };
        const link = (from, to, attrs) => {
            if (attrs && Object.keys(attrs).length > 0) {
                edges.push(`  ${from} -> ${to} [${fmtAttrs(attrs)}]`);
                edgeList.push({ from, to, label: attrs['label'], attrs });
            }
            else {
                edges.push(`  ${from} -> ${to}`);
                edgeList.push({ from, to });
            }
        };
        const linkEdge = (from, to, attrs) => {
            edges.push(`  ${from} -> ${to} [${fmtAttrs(attrs)}]`);
            edgeList.push({ from, to, attrs });
        };
        // P0a: setup_deps
        emit('start', { label: 'start', shape: 'Mdiamond' });
        emit('setup_deps', {
            label: 'setup_deps',
            shape: 'cds',
            tool_command: 'cd ${WORKING_DIR} && npm install 2>&1 || pnpm install 2>&1 || yarn install 2>&1',
        });
        applied.add('P0a');
        // P0c: capture_baseline
        emit('capture_baseline', {
            label: 'capture_baseline',
            read_only: 'true',
            shape: 'cds',
            tool_command: "cd ${WORKING_DIR} && (npx tsc --noEmit 2>&1 | grep -c 'error TS' > /tmp/baseline_ts_errors.txt || echo 0 > /tmp/baseline_ts_errors.txt) && (npx eslint src/ 2>&1 | grep -c 'error' > /tmp/baseline_lint_errors.txt || echo 0 > /tmp/baseline_lint_errors.txt)",
        });
        applied.add('P0c');
        link('start', 'setup_deps');
        link('setup_deps', 'capture_baseline');
        const implPhases = phases.filter(p => !p.securityScan && !p.docOnly);
        const allDependentPhases = phases.filter(p => !p.securityScan);
        const unionPaths = [...new Set(allDependentPhases.flatMap(p => p.allowedPaths ?? []))].join(',');
        const unionEscalate = [...new Set(allDependentPhases.flatMap(p => p.escalateOn ?? []))].join(',');
        // Fan-out (Pattern 4)
        if (isFanOut) {
            applied.add('P4');
            emit('split_phases', { label: 'split_phases', max_parallel: '1', shape: 'component' });
            applied.add('P0b');
            link('capture_baseline', 'split_phases');
            for (const p of independent) {
                const id = sanitizeId(p.name);
                emit(id, { label: p.name, shape: 'component' });
                link('split_phases', id);
            }
            const dependent = phases.filter(p => p.dependsOn && p.dependsOn.length > 0);
            const mergeId = 'merge_phases';
            emit(mergeId, { label: 'merge_phases', shape: 'tripleoctagon' });
            for (const p of independent)
                link(sanitizeId(p.name), mergeId);
            let afterMerge = mergeId;
            for (const p of dependent) {
                const id = sanitizeId(p.name);
                emit(id, { label: p.name, shape: 'component' });
                link(afterMerge, id);
                afterMerge = id;
            }
            // P21: fix_all + verify_final
            applied.add('P21');
            const fixAllAttrs = {
                allowed_paths: unionPaths,
                class: 'codergen',
                label: 'fix_all',
                permission_mode: 'auto',
                timeout: '30m',
            };
            if (unionEscalate)
                fixAllAttrs['escalate_on'] = unionEscalate;
            emit('fix_all', fixAllAttrs);
            emit('verify_final', { label: 'verify_final' });
            link(afterMerge, 'fix_all');
            link('fix_all', 'verify_final');
            link('verify_final', 'exit');
        }
        else if (hasCompeting) {
            // Competing implementations (Pattern 18)
            applied.add('P18');
            const cp = phases.find(p => p.competing);
            const baseId = sanitizeId(cp.name);
            emit(`${baseId}_a`, { label: `${cp.name} A`, max_parallel: '1', shape: 'component' });
            emit(`${baseId}_b`, { label: `${cp.name} B`, max_parallel: '1', shape: 'component' });
            emit('competing_merge', { label: 'competing_merge', shape: 'tripleoctagon' });
            link('capture_baseline', `${baseId}_a`);
            link('capture_baseline', `${baseId}_b`);
            link(`${baseId}_a`, 'competing_merge');
            link(`${baseId}_b`, 'competing_merge');
            link('competing_merge', 'exit');
        }
        else {
            // Sequential execution
            const hasAnyPhase = phases.length > 0;
            let prevId = 'capture_baseline';
            let prevAttrs = undefined;
            for (let i = 0; i < phases.length; i++) {
                const p = phases[i];
                const id = sanitizeId(p.name);
                const emitSpec = !p.securityScan && !p.docOnly && (p.specFirst === true || (p.goalGate && p.specFirst !== false));
                const emitBDD = !p.securityScan && !p.docOnly && p.bddScenarios === true;
                const specId = `spec_file_${id}`;
                const bddId = `bdd_scenarios_${id}`;
                // securityScan: simple review pass-through
                if (p.securityScan) {
                    const phaseAttrs = {
                        class: 'review',
                        label: p.prompt,
                        read_only: 'true',
                    };
                    applied.add('P6b');
                    applied.add('P8');
                    emit(id, phaseAttrs);
                    link(prevId, id, prevAttrs);
                    prevId = id;
                    prevAttrs = undefined;
                    continue;
                }
                const implId = `impl_${id}`;
                const scopeCheckId = `scope_check_${id}`;
                const checkProgressId = `check_progress_${id}`;
                const conformanceId = `conformance_${id}`;
                // docOnly phase
                if (p.docOnly) {
                    const implAttrs = {
                        allowed_paths: (p.allowedPaths ?? []).join(','),
                        class: 'documentation',
                        label: p.prompt,
                        max_visits: '5',
                    };
                    if (p.timeout)
                        implAttrs['timeout'] = p.timeout;
                    link(prevId, implId, prevAttrs);
                    emit(implId, implAttrs);
                    applied.add('P22');
                    applied.add('P6');
                    emit(checkProgressId, {
                        label: 'check_progress',
                        max_visits: '3',
                        read_only: 'true',
                        shape: 'cds',
                        tool_command: "cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'",
                    });
                    applied.add('P0e');
                    link(implId, checkProgressId);
                    link(checkProgressId, 'exit', { condition: 'outcome=fail', label: 'fail' });
                    emit(scopeCheckId, {
                        class: 'review',
                        label: 'Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS | FAIL.',
                        read_only: 'true',
                        shape: 'cds',
                    });
                    applied.add('P10');
                    applied.add('P6b');
                    link(checkProgressId, scopeCheckId);
                    link(scopeCheckId, 'exit', { condition: 'outcome=fail', label: 'fail' });
                    const conformanceDocAttrs = {
                        class: 'review',
                        label: 'Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS | FAIL.',
                        read_only: 'true',
                        timeout: '15m',
                    };
                    emit(conformanceId, conformanceDocAttrs);
                    applied.add('P15');
                    link(scopeCheckId, conformanceId);
                    prevId = conformanceId;
                    prevAttrs = undefined;
                    continue;
                }
                // Regular impl phase
                const testId = `test_${id}`;
                const fixId = `fix_${id}`;
                const verifyLintId = `verify_lint_${id}`;
                const verifyTypesId = `verify_types_${id}`;
                // Spec-first gates (P16 / P16b)
                if (emitBDD && emitSpec) {
                    emit(bddId, { label: 'bdd_scenarios' });
                    emit(specId, { label: 'spec_file' });
                    link(prevId, bddId, prevAttrs);
                    link(bddId, specId);
                    link(specId, implId);
                    applied.add('P16b');
                    applied.add('P16');
                }
                else if (emitSpec) {
                    emit(specId, { label: 'spec_file' });
                    link(prevId, specId, prevAttrs);
                    link(specId, implId);
                    applied.add('P16');
                }
                else {
                    link(prevId, implId, prevAttrs);
                }
                // P22: impl node
                const implAttrs = {
                    allowed_paths: (p.allowedPaths ?? []).join(','),
                    class: 'codergen',
                    label: p.prompt,
                    max_visits: '5',
                    permission_mode: 'auto',
                };
                if (p.escalateOn && p.escalateOn.length > 0) {
                    implAttrs['escalate_on'] = p.escalateOn.join(',');
                }
                if (p.timeout)
                    implAttrs['timeout'] = p.timeout;
                if (p.specFirst) {
                    implAttrs['spec_first'] = 'true';
                }
                if (spec.workspace === 'isolated' && (id === 'commit_and_push' || (id.includes('commit') && id.includes('push')))) {
                    if (spec.workspaceOpts?.repoUrl)
                        implAttrs['repo_url'] = spec.workspaceOpts.repoUrl;
                    if (spec.workspaceOpts?.cleanup)
                        implAttrs['cleanup'] = spec.workspaceOpts.cleanup;
                }
                emit(implId, implAttrs);
                applied.add('P22');
                applied.add('P6');
                if (!defenseMatrix.permissions.includes('auto')) {
                    defenseMatrix.permissions.push('auto');
                }
                // P10: scope_check
                emit(scopeCheckId, {
                    class: 'review',
                    label: 'Compare git diff against phase prompt. Flag files modified outside allowed_paths. Output STATUS: SUCCESS | FAIL.',
                    read_only: 'true',
                    shape: 'cds',
                });
                applied.add('P10');
                applied.add('P6b');
                link(implId, scopeCheckId);
                // P0e: check_progress
                emit(checkProgressId, {
                    label: 'check_progress',
                    max_visits: '3',
                    read_only: 'true',
                    shape: 'cds',
                    tool_command: "cd ${WORKING_DIR} && [ $(git status --porcelain | wc -l) -gt 0 ] && echo 'STATUS: SUCCESS' || echo 'STATUS: FAIL'",
                });
                applied.add('P0e');
                link(scopeCheckId, checkProgressId);
                // P13: verify_lint
                emit(verifyLintId, {
                    label: 'verify_lint: BASELINE from cat baseline_lint_errors; CURRENT lint error count -le BASELINE',
                    shape: 'cds',
                    tool_command: '[ $(npx eslint src/ 2>&1 | grep -c error || echo 0) -le $(cat /tmp/baseline_lint_errors.txt 2>/dev/null || echo 0) ]',
                });
                applied.add('P13');
                applied.add('P0d');
                link(checkProgressId, verifyLintId);
                // P14: verify_types
                emit(verifyTypesId, {
                    label: 'verify_types: BASELINE from cat baseline_ts_errors; CURRENT TS error count -le BASELINE',
                    tool_command: '[ $(npx tsc --noEmit 2>&1 | grep -c error || echo 0) -le $(cat /tmp/baseline_ts_errors.txt 2>/dev/null || echo 0) ]',
                });
                applied.add('P14');
                link(verifyLintId, verifyTypesId);
                // P9: optional coverage gate
                const hasCoverage = typeof p.coverageTarget === 'number';
                if (hasCoverage) {
                    const testRunId = `test_run_${id}`;
                    const covId = `coverage_gate_${id}`;
                    emit(testRunId, { label: 'test' });
                    emit(covId, { coverage_target: String(p.coverageTarget), label: 'coverage_gate', shape: 'diamond' });
                    applied.add('P9');
                    link(verifyTypesId, testRunId);
                    link(testRunId, covId);
                    link(covId, conformanceId, { condition: 'outcome=success', label: 'pass' });
                    link(covId, implId, { condition: 'outcome=fail', label: 'fail' });
                }
                else {
                    link(verifyTypesId, conformanceId);
                }
                // P15: conformance
                const conformanceAttrs = {
                    class: 'review',
                    label: 'Review the implementation against the phase spec and PRD requirements. Check: correct files modified, API contracts match, no regressions. Output STATUS: SUCCESS | FAIL.',
                    read_only: 'true',
                    timeout: '15m',
                };
                if (p.contextOnSuccess) {
                    conformanceAttrs['context_on_success'] = Object.keys(p.contextOnSuccess).join(',');
                }
                if (p.goalGate) {
                    conformanceAttrs['goal_gate'] = 'true';
                    applied.add('P2');
                    conformanceAttrs['max_visits'] = String(spec.defaultMaxRetry ?? 3);
                    const acKeys = Object.keys(spec.acceptanceCriteria ?? {});
                    if (acKeys.length > 0)
                        conformanceAttrs['acceptance_criteria'] = acKeys.join(',');
                }
                emit(conformanceId, conformanceAttrs);
                applied.add('P15');
                // P1: test diamond
                const testAttrs = {
                    label: `test ${id}`,
                    retry_target: implId,
                    shape: 'diamond',
                };
                if (!p.goalGate) {
                    testAttrs['max_visits'] = '5';
                    applied.add('P6');
                }
                else if (spec.defaultMaxRetry) {
                    testAttrs['max_visits'] = String(spec.defaultMaxRetry);
                    applied.add('P6');
                }
                else {
                    testAttrs['max_visits'] = '3';
                    applied.add('P6');
                }
                emit(testId, testAttrs);
                applied.add('P1');
                applied.add('P3');
                link(conformanceId, testId);
                // P1: fix loop
                emit(fixId, { label: `fix ${id}` });
                link(testId, fixId, { condition: 'outcome=fail', label: 'fail' });
                link(fixId, implId);
                // P17: red_team after test pass
                if (p.redTeam) {
                    const rtId = `red_team_${id}`;
                    emit(rtId, { label: 'red_team', read_only: 'true' });
                    applied.add('P17');
                    link(testId, rtId, { condition: 'outcome=success', label: 'pass' });
                    prevId = rtId;
                    prevAttrs = undefined;
                }
                else {
                    prevId = testId;
                    prevAttrs = { condition: 'outcome=success', label: 'pass' };
                }
            }
            // P21: fix_all + verify_final
            if (hasAnyPhase) {
                if (unionPaths) {
                    applied.add('P21');
                    const fixAllAttrs = {
                        allowed_paths: unionPaths,
                        class: 'codergen',
                        label: 'fix_all',
                        permission_mode: 'auto',
                        timeout: '30m',
                    };
                    if (unionEscalate)
                        fixAllAttrs['escalate_on'] = unionEscalate;
                    emit('fix_all', fixAllAttrs);
                    link(prevId, 'fix_all', prevAttrs);
                    link('fix_all', 'verify_final');
                }
                else {
                    link(prevId, 'verify_final');
                }
                emit('verify_final', { label: 'verify_final' });
                link('verify_final', 'exit');
            }
            else {
                link('capture_baseline', 'exit');
            }
        }
        // P25: Catastrophic recovery loop
        if (!isFanOut && !hasCompeting && implPhases.length > 0) {
            applied.add('P25');
            linkEdge('verify_final', 'setup_deps', { loop_restart: 'true' });
        }
        // Microverse loop (Pattern 20)
        if (spec.microverse) {
            applied.add('P20');
            const mv = spec.microverse;
            const mvOpts = mv.opts;
            emit('commit_baseline', { label: 'commit_baseline', shape: 'cds' });
            emit('baseline', { label: `baseline ${mv.name}`, shape: 'cds' });
            emit('optimize', { label: `optimize ${mv.name}` });
            emit('measure', { label: `measure ${mv.name}` });
            emit('compare', {
                direction: mvOpts.direction ?? 'improve',
                label: 'compare',
                max_visits: String(mvOpts.maxVisits ?? 10),
                shape: 'diamond',
                target: String(mvOpts.target),
            });
            emit('check', { label: 'check', shape: 'diamond' });
            link('commit_baseline', 'baseline');
            link('baseline', 'optimize');
            link('optimize', 'measure');
            link('measure', 'compare');
            link('compare', 'optimize', { condition: 'outcome=miss', label: 'miss' });
            link('compare', 'check', { condition: 'outcome=hit', label: 'hit' });
            link('check', 'exit', { condition: 'outcome=accept', label: 'accept' });
            link('check', 'optimize', { condition: 'outcome=reject', label: 'reject' });
            for (const mvId of ['commit_baseline', 'baseline', 'optimize', 'measure', 'compare', 'check']) {
                standaloneNodeIds.add(mvId);
            }
        }
        // Review ratchet (Pattern 19)
        if (spec.reviewRatchet) {
            applied.add('P19');
            const n = spec.reviewRatchet;
            for (let i = 1; i <= n; i++) {
                emit(`review_pass_${i}`, { label: `review pass ${i}`, shape: 'component' });
            }
            emit('review_merge', { label: 'review_merge', ratchet_count: String(n), shape: 'tripleoctagon' });
            emit('fix_review', { label: 'fix_review', shape: 'cds' });
            for (let i = 1; i < n; i++) {
                link(`review_pass_${i}`, `review_pass_${i + 1}`);
            }
            link(`review_pass_${n}`, 'review_merge');
            link('review_merge', 'exit', { condition: 'outcome=success', label: 'pass' });
            link('review_merge', 'fix_review', { condition: 'outcome=fail', label: 'fail' });
            link('fix_review', 'review_pass_1');
            for (let ri = 1; ri <= n; ri++)
                standaloneNodeIds.add(`review_pass_${ri}`);
            standaloneNodeIds.add('review_merge');
            standaloneNodeIds.add('fix_review');
        }
        // Always emit exit last
        emit('exit', { label: 'exit', shape: 'Msquare' });
        // P23: defense matrix comment block
        const guardPatterns = ['P0c', 'P6b', 'P10', 'P13', 'P14', 'P15', 'P17', 'P25'];
        defenseMatrix.guardrails = guardPatterns.filter(pg => applied.has(pg));
        applied.add('P23');
        const lines = [
            `digraph "${graphId}" {`,
            `  graph [${fmtAttrs(graphAttrs)}]`,
            `  /* DEFENSE MATRIX`,
            `   * competitive: ${defenseMatrix.competitive}`,
            `   * adversarial: ${defenseMatrix.adversarial}`,
            `   * specDriven: ${defenseMatrix.specDriven}`,
            `   * guardrails: ${defenseMatrix.guardrails.length > 0 ? defenseMatrix.guardrails.join(', ') : 'none'}`,
            `   * permissions: ${defenseMatrix.permissions.length > 0 ? defenseMatrix.permissions.join(', ') : 'none'}`,
            `   */`,
            ...nodes,
            ...edges,
            '}',
        ];
        return { dot: lines.join('\n'), nodeMap, edgeList, graphAttrs, standaloneNodeIds, patternsApplied: [...applied], defenseMatrix };
    }
}
