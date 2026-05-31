/**
 * Threshold for consecutive false EPIC_COMPLETED emissions on the same ticket
 * before mux-runner gives up and exits with MANAGER_PERSISTENT_HALLUCINATION.
 * Recovery is the default; this guards against a manager stuck in a permanent
 * hallucination loop.
 */
export const FALSE_EPIC_THRESHOLD = 3;
export const BACKENDS = ['claude', 'codex', 'hermes'];
export const STATE_MANAGER_DEFAULTS = {
    maxLockRetries: 10,
    baseLockDelayMs: 100,
    lockJitter: true,
    staleLockTimeoutMs: 30_000,
    schemaVersion: 5,
};
/** Latest schema_version that this code knows how to write/read. Must match the latest migration target in state-manager.ts. */
export const LATEST_SCHEMA_VERSION = 5;
export class StateError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'StateError';
        this.code = code;
    }
}
export class LockError extends StateError {
    kind;
    key;
    timeout_ms;
    waited_ms;
    constructor(message) {
        super('LOCK_FAILED', message);
        this.name = 'LockError';
    }
}
export class TransactionError extends StateError {
    rollbackErrors;
    constructor(message, rollbackErrors = []) {
        super('WRITE_FAILED', message);
        this.name = 'TransactionError';
        this.rollbackErrors = rollbackErrors;
    }
}
export class SchemaVersionMismatchError extends StateError {
    statePath;
    onDiskVersion;
    cachedVersion;
    constructor(statePath, onDiskVersion, cachedVersion) {
        super('SCHEMA_MISMATCH', `State file ${statePath} schema_version ${onDiskVersion} is newer than transaction snapshot schema_version ${cachedVersion}`);
        this.name = 'SchemaVersionMismatchError';
        this.statePath = statePath;
        this.onDiskVersion = onDiskVersion;
        this.cachedVersion = cachedVersion;
    }
}
// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------
export const Defaults = {
    WORKER_TIMEOUT_SECONDS: 1200,
    /** Worker-convergence-mode: bail after N consecutive subprocess errors. */
    WORKER_CONSECUTIVE_ERROR_CAP: 3,
    /** Absolute ceiling for a single iteration when per-iteration timeout is disabled (4h). */
    MAX_ITERATION_SECONDS: 14_400,
    /** Separate guard for subprocesses that stop producing stdout/stderr progress (30m). */
    OUTPUT_STALL_SECONDS: 1800,
    /** Startup stale-state guard for wedged mux-runner sessions (30m). */
    MUX_RUNNER_STALL_SECONDS: 1800,
    MANAGER_MAX_TURNS: 50,
    RATE_LIMIT_POLL_MS: 10_000,
    /**
     * Maximum number of times mux-runner will relaunch the codex or hermes manager
     * subprocess after a per-iteration error while pending tickets remain.
     * Codex and hermes tmux_mode runs ONE long-lived manager that loops across many
     * tickets internally; the 4h `MAX_ITERATION_SECONDS` hang-guard SIGTERMs
     * that subprocess and resolves `{ completion: 'error', timedOut: true }`,
     * which the loop would otherwise treat as terminal. Past this cap, fall
     * back to the legacy exit-on-error so a genuinely broken backend cannot
     * loop forever.
     */
    CODEX_MANAGER_RELAUNCH_CAP: 10,
    /** Claude manager relaunch cap, primarily for `--max-turns` exhaustion recovery. */
    CLAUDE_MANAGER_RELAUNCH_CAP: 20,
};
// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------
export const VALID_STEPS = [
    'prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review', 'completed',
    'pickle', 'citadel', 'anatomy-park', 'szechuan-sauce',
];
// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------
export { PROMISE_TOKENS } from '../services/promise-tokens.js';
export const PromiseTokens = {
    EPIC_COMPLETED: 'EPIC_COMPLETED',
    TASK_COMPLETED: 'TASK_COMPLETED',
    WORKER_DONE: 'I AM DONE',
    PRD_COMPLETE: 'PRD_COMPLETE',
    TICKET_SELECTED: 'TICKET_SELECTED',
    ANALYSIS_DONE: 'ANALYSIS_DONE',
    EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
    THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
};
/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text, token) {
    if (!text || !token)
        return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}
/** Wraps `token` in promise XML tags. */
export function wrapToken(token) {
    return `<promise>${token}</promise>`;
}
// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES = {
    implementation: ['research', 'plan', 'conformance', 'code_review'],
    review: ['review_scope', 'review_findings', 'spec_conformance'],
};
/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Matches exact `${prefix}.md` (e.g. `review_scope.md`) or `${prefix}_*.md`
 * (e.g. `research_2026-04-18.md`, `plan_review.md`). Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files, role) {
    const prefixes = ARTIFACT_PREFIXES[role];
    return files.some(f => prefixes.some(p => f === `${p}.md` || f.startsWith(`${p}_`)));
}
// ---------------------------------------------------------------------------
// Activity Events
// ---------------------------------------------------------------------------
export const VALID_ACTIVITY_EVENTS = [
    'session_start', 'session_end', 'ticket_completed', 'epic_completed',
    'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
    'refactor', 'review', 'jar_start', 'jar_end',
    'circuit_open', 'circuit_recovery',
    'tool_retry_circuit_open',
    'iteration_start', 'iteration_end', 'wasted_iter',
    'manager_turn_progress',
    'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
    'judge_unreachable',
    'judge_timeout',
    'judge_measurement_attempted',
    'baseline_attempt_timeout',
    'baseline_unmeasurable',
    'judge_cli_missing',
    'multi_repo_warning',
    'meeseeks_model_select',
    'pending_tickets_on_completion',
    'manager_false_epic_completed',
    'manager_persistent_hallucination',
    'gate_baseline_captured',
    'gate_baseline_disk_check',
    'gate_baseline_init_failed',
    'baseline_recapture_attempted',
    'baseline_recapture_succeeded',
    'baseline_recapture_failed',
    'gate_run_complete',
    'gate_skipped',
    'gate_unsafe_test_command_blocked',
    'gate_remediation_complete',
    'gate_remediation_aborted_unverified_production_change',
    'gate_autofix_reverted',
    'gate_workingdir_drift_detected',
    'gate_lock_acquired',
    'gate_lock_timeout',
    'gate_diff_scope_fallback',
    'gate_preexisting_tests_baselined',
    'iteration_left_regression',
    'coverage_exception',
    'strict_mode_red',
    'gate_regression_threshold_warning',
    'gate_out_of_scope_failures_present',
    'commit_pending_probe_fired',
    'codex_manager_relaunch',
    'readiness_failed_post_correction',
    'readiness_skipped',
    'readiness_skipped_for_manifest',
    'archaeology_complete',
    'archaeology_skipped',
    'phase_personas_disabled_seen',
    'debate_solo_auto',
    'debate_user_declined_auto_promote',
    'debate_invalidated_by_correction',
    'debate_round_truncated',
    'session_reconstructed_epoch_reset',
    'cap_check_failed_schema_mismatch',
    'course_corrected',
    'course_correct_apply_failed',
    'course_correct_recovered',
    'current_ticket_redirected_to_new',
    'ticket_auto_skip_no_evidence',
    'ticket_phantom_done_corrected',
    'phantom_done_detected',
    'phantom_done_backfilled',
    'ticket_state_desync_detected',
    'stall_classified',
    'mux_runner_stall_detected',
    'child_mux_runner_wedge_detected',
    'readiness_delta_requested',
    'phase_transition',
    'extension_dir_fallback',
    'halt',
    'pkgjson_only_revert_detected',
    'pkgjson_full_drift_detected',
    'pkgjson_dep_or_src_missing',
    'paused_session_orphan_demoted',
    'paused_session_orphan_precleaned',
    'phantom_session_demoted',
    'orphan_phantom_demoted',
    'worker_spawn_backend_resolved',
    'worker_spawn_backend_override',
    'worker_spawn_backend_mismatch',
    'subtool_backend_override',
    'pipeline_auto_resumed',
    'smoke_gate_bypassed',
    'tsc_gate_failed',
    'tsc_gate_override_used',
    'tsc_gate_override_consumed',
    'tsc_gate_crashed',
    'skip_flag_legacy_used',
    'codex_unhealthy_consecutive_failures',
    'ticket_audit_bypassed',
    'ticket_audit_failed',
    'worker_partial_lifecycle_exit',
    'cap_check_skipped_stale_cache',
    'ticket_cache_cleared',
    'orphan_map_entry_pruned',
    'install_sh_parity_check',
    'worker_backend_resolved',
    'tier_phase_skipped',
    'tier_diff_envelope_exceeded',
    'between_ticket_gate_timeout',
    'cross_ticket_regression_detected',
    'worker_gate_failed',
    'worker_lint_gate_passed',
    'worker_lint_gate_failed',
    'worker_lint_autofix_applied',
    'completion_commit_auto_filled',
    'completion_commit_inferred_from_git',
    'worker_completion_commit_announced',
    'recoverable_phase_failure',
    'subprocess_error',
    'time_cap_disabled_default',
    'manager_max_turns_relaunch',
    'iteration_classified_at_max_turns',
    'bundle_bootstrap_exemption_applied',
    'signal_received',
    'manager_idle_backoff_engaged',
    'manager_idle_backoff_released',
    'standup_session_dropped',
    'worker_edit_outside_scope',
    'pkgjson_revert_forensic_captured',
    'pipeline_judge_timeout_recovery_attempted',
    'pipeline_all_backends_exhausted_recovery_attempted',
    'bundle_preflight_failed',
    'judge_violation_ledger_advanced',
    'judge_legacy_shape_inferred',
    'judge_json_parse_failed',
    'consecutive_no_progress_warning',
    'monitor_respawn_started',
    'monitor_respawn_failed',
    'monitor_mode_swapped',
    'monitor_stderr_rotated',
    'setup_resume_ticket_status_preserved',
    'setup_resume_overrode_ticket_status',
    'head_mismatch_detected',
    'stale_index_lock_cleaned',
    'stale_index_lock_held_by_live_process',
    'setup_resume_chdir_applied',
    'ticket_runnability_resolved',
    'codex_manager_self_bootstrap_attempted',
    'orphan_test_runner_reaped',
    'orphan_manager_reaped',
    'orphan_session_detected',
    'session_map_collision_blocked',
    'state_write_override_used',
    'state_write_schema_version_violation',
    'install_sh_override_used',
    'anatomy_park_empty_scope_skip',
    'szechuan_sauce_empty_scope_skip',
    'monitor_respawn_session_dir_invalid',
    'spawn_morty_invalid_ticket_path',
    'ticket_preskipped_already_terminal',
    'closer_expensive_node_test_blocked',
    'ticket_timeout_progress_extension',
    'ticket_timeout_halted_no_progress',
    'graph_preflight_completed',
    'graph_preflight_degraded',
    'worker_artifact_progress_zero',
    'worker_auto_skip_oversized',
    'codex_manager_no_progress',
];
/** Recoverable reasons a ticket can be flipped to Failed by the auto-skip guard (R-WSWA-3). */
export const FAILURE_REASONS = ['oversized_no_progress'];
export var PipelineRunnerExitCode;
(function (PipelineRunnerExitCode) {
    PipelineRunnerExitCode[PipelineRunnerExitCode["Success"] = 0] = "Success";
    PipelineRunnerExitCode[PipelineRunnerExitCode["Failure"] = 1] = "Failure";
    PipelineRunnerExitCode[PipelineRunnerExitCode["AuditFailure"] = 2] = "AuditFailure";
    PipelineRunnerExitCode[PipelineRunnerExitCode["PhaseIncomplete"] = 3] = "PhaseIncomplete";
})(PipelineRunnerExitCode || (PipelineRunnerExitCode = {}));
export const MICROVERSE_FATAL_REASONS = [
    'judge_cli_missing',
    'session_state_corrupted',
    'baseline_unmeasurable_unrecoverable',
];
const MICROVERSE_FAILURE_REASONS = new Set([
    'error', 'rate_limit_exhausted', 'judge_unreachable',
    'baseline_unmeasurable_unrecoverable', 'judge_cli_missing',
]);
export function isMicroverseFailureExit(reason) {
    return MICROVERSE_FAILURE_REASONS.has(reason);
}
/**
 * R-WSRC-2 — Forward-schema state.json exit reason consumed by mux-runner.
 * Written by `recordExitReason(statePath, STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON)`
 * when `sm.read()` throws `SchemaVersionAheadError`/`SCHEMA_MISMATCH`. Listed
 * in the mux-runner `ExitReason` union and `isFailureExit` set, but
 * intentionally NOT in `MICROVERSE_FAILURE_REASONS` above (it is a fatal-but-
 * operator-recoverable state, not a microverse-class failure). auto-resume.sh
 * R-CNAR-4(c) stops on this exit reason because it is in `isFailureExit`.
 */
export const STATE_SCHEMA_VERSION_AHEAD_EXIT_REASON = 'state_schema_version_ahead';
// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------
export { ATTRACTOR_SCHEMA_FALLBACK, ALL_ATTRS, lookupAttr, validateAttrType, validateAttrs, } from './attractor-schema.fallback.js';
export class BuildError extends Error {
    code;
    diagnostics;
    constructor(code, message, diagnostics = []) {
        super(message);
        this.name = 'BuildError';
        this.code = code;
        this.diagnostics = diagnostics;
    }
}
