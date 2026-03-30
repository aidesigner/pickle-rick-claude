/**
 * Fallback attractor schema — used when $ATTRACTOR_ROOT schema is unavailable.
 * Defines all builder-emitted attributes with name, type, and scope.
 */
export const ATTRACTOR_SCHEMA_FALLBACK = {
    // -------------------------------------------------------------------------
    // Node attributes (17)
    // -------------------------------------------------------------------------
    node: {
        class: { name: 'class', type: 'string', scope: 'node' },
        shape: { name: 'shape', type: 'string', scope: 'node' },
        goal_gate: { name: 'goal_gate', type: 'boolean', scope: 'node' },
        retry_target: { name: 'retry_target', type: 'string', scope: 'node' },
        max_visits: { name: 'max_visits', type: 'number', scope: 'node' },
        thread_id: { name: 'thread_id', type: 'string', scope: 'node' },
        timeout: { name: 'timeout', type: 'string', scope: 'node' },
        allowed_paths: { name: 'allowed_paths', type: 'string', scope: 'node' },
        read_only: { name: 'read_only', type: 'boolean', scope: 'node' },
        context_on_success: { name: 'context_on_success', type: 'string', scope: 'node' },
        prompt: { name: 'prompt', type: 'string', scope: 'node' },
        tool_command: { name: 'tool_command', type: 'string', scope: 'node' },
        max_parallel: { name: 'max_parallel', type: 'number', scope: 'node' },
        escalate_on: { name: 'escalate_on', type: 'string', scope: 'node' },
        permission_mode: { name: 'permission_mode', type: 'string', scope: 'node' },
        auto_status: { name: 'auto_status', type: 'boolean', scope: 'node' },
        allow_partial: { name: 'allow_partial', type: 'boolean', scope: 'node' },
    },
    // -------------------------------------------------------------------------
    // Graph attributes (12)
    // -------------------------------------------------------------------------
    graph: {
        goal: { name: 'goal', type: 'string', scope: 'graph' },
        working_dir: { name: 'working_dir', type: 'string', scope: 'graph' },
        default_max_retry: { name: 'default_max_retry', type: 'number', scope: 'graph' },
        label: { name: 'label', type: 'string', scope: 'graph' },
        acceptance_criteria: { name: 'acceptance_criteria', type: 'string', scope: 'graph' },
        model_stylesheet: { name: 'model_stylesheet', type: 'string', scope: 'graph' },
        spec_file: { name: 'spec_file', type: 'string', scope: 'graph' },
        workspace: { name: 'workspace', type: 'string', scope: 'graph' },
        repo_url: { name: 'repo_url', type: 'string', scope: 'graph' },
        repo_branch: { name: 'repo_branch', type: 'string', scope: 'graph' },
        workspace_cleanup: { name: 'workspace_cleanup', type: 'string', scope: 'graph' },
        retry_target: { name: 'retry_target', type: 'string', scope: 'graph' },
    },
    // -------------------------------------------------------------------------
    // Edge attributes (2)
    // -------------------------------------------------------------------------
    edge: {
        outcome: { name: 'outcome', type: 'string', scope: 'edge' },
        loop_restart: { name: 'loop_restart', type: 'boolean', scope: 'edge' },
    },
};
/** Flat list of all attribute definitions across all scopes. */
export const ALL_ATTRS = [
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.node),
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.graph),
    ...Object.values(ATTRACTOR_SCHEMA_FALLBACK.edge),
];
/** Flat lookup: attribute name → definition (first match wins; retry_target exists in both node+graph). */
export function lookupAttr(name, scope) {
    const bucket = ATTRACTOR_SCHEMA_FALLBACK[scope];
    return bucket[name];
}
/** Returns true if `value` is assignable to `def.type`. */
export function validateAttrType(def, value) {
    return typeof value === def.type;
}
