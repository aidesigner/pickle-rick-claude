export interface State {
  active: boolean;
  working_dir: string;
  step: Step;
  iteration: number;
  max_iterations: number;
  max_time_minutes?: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  completion_promise: string | null;
  original_prompt: string;
  current_ticket: string | null;
  current_ticket_tier?: string;
  current_ticket_budget?: number;
  current_ticket_max_iterations?: number;
  current_ticket_worker_timeout_seconds?: number;
  current_ticket_budget_start_iteration?: number;
  history: Array<{ step: Step; ticket?: string; timestamp: string }>;
  started_at: string;
  session_dir: string;
  tmux_mode?: boolean;
  min_iterations?: number;
  command_template?: string;
  chain_meeseeks?: boolean;
  schema_version?: number;
  prd_path?: string;
  start_commit?: string;
  pid?: number;
  /** Optional launch-shell PID breadcrumb written by per-session launch.sh at startup. */
  launch_shell_pid?: number | null;
  /** Count of consecutive short manager responses (≤ DEGENERATE_MAX_LENGTH). Reset on substantive response. */
  consecutive_short_responses?: number;
  /** Pipeline phases that have invoked refreshScope. Monotonically extends; guards against duplicate refresh. */
  phases_entered?: string[];
  /** Per-session activity log entries (e.g. halt records). Append-only. */
  activity?: ActivityLogEntry[];
  /** Implementation backend for manager spawns and worker fallback. Defaults to 'claude' when absent. */
  backend?: Backend;
  /** Optional per-session worker backend override. Worker spawns prefer this over `backend` when present. */
  worker_backend?: Backend;
  /** When false, pipeline-runner halts on any non-zero non-citadel phase exit instead of continuing on recoverable failures. */
  pipeline_continue_on_phase_fail?: boolean;
  /** When true, /pickle Phase 3 spawns workers via harness team primitives (TeamCreate + Agent + TaskUpdate) instead of `claude -p` subprocesses. claude backend only. */
  teams_mode?: boolean;
  /** Concurrency cap for parallel `morty-implementer` teammates when teams_mode is true. Default 5. v1 ships sequential; this field is plumbed for the parallel-fan-out follow-up. */
  max_parallel?: number;
  /**
   * Count of consecutive false EPIC_COMPLETED emissions on the same `current_ticket`.
   * Reset to 0 whenever the manager genuinely advances to a new ticket OR succeeds.
   * When this exceeds FALSE_EPIC_THRESHOLD on the same ticket, mux-runner exits with
   * `MANAGER_PERSISTENT_HALLUCINATION` rather than continuing to retry.
   */
  false_epic_completed_count?: number;
  /** Ticket ID associated with the current `false_epic_completed_count`. Resets the counter when current_ticket diverges. */
  false_epic_completed_ticket?: string | null;
  /**
   * Reasoning effort for worker spawns. Currently honored only by the codex
   * backend (`-c reasoning.effort=<value>`); claude has no public flag and
   * silently ignores. When unset, workers inherit the CLI default.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Manager tmux_mode: count of times the runner has relaunched the backend
   * manager subprocess after a per-iteration error while tickets remained
   * Todo/In Progress. Claimed against the active backend cap.
   */
  manager_relaunch_count?: number;
  /**
   * Legacy alias for `manager_relaunch_count`. StateManager migrates this to
   * the canonical field on read for one-version backwards compatibility.
   */
  codex_manager_relaunch_count?: number;
  /** Hermes CLI toolsets persisted at setup time and passed to worker/manager spawns. */
  hermes_toolsets?: string[];
  /** Optional Hermes provider override persisted at setup time. */
  hermes_provider?: string;
  /** Optional Hermes model override persisted at setup time. */
  hermes_model?: string;
  /**
   * Optional codex model override (e.g. `gpt-5.3-codex-spark`).
   * Resolution precedence (see `resolveCodexModel` in `bin/spawn-morty.ts`):
   *   1. `state.codex_model` (trimmed, non-empty) — per-session override.
   *   2. `pickle_settings.default_codex_model` — global default.
   *   3. undefined — codex CLI uses its compiled-in default.
   * Combined with `--ignore-user-config` on codex spawn, absent values mean
   * codex never sees a `-m` flag.
   */
  codex_model?: string;
  /** Optional Hermes max-turns override persisted at setup time. */
  hermes_max_turns?: number;
  archaeology?: ProjectContext | null;
  tickets_version?: number;
  last_course_correction?: CourseCorrectionRecord | null;
  phase_personas_active?: boolean;
  flags?: StateFlags;
  readiness?: ReadinessState;
  codex_version_seen?: string | null;
  /**
   * Terminal-exit forensic marker. Set by finalize/forensic helpers in the
   * runners (mux/microverse/pipeline/jar). Values: 'success', 'limit',
   * 'circuit_open', 'stall', 'fatal', 'signal', plus microverse-specific
   * reasons ('converged', 'rate_limit_exhausted', etc.). Outside observers
   * use this to distinguish a clean exit from a forensic halt.
   */
  exit_reason?: string | null;
  pinned_branch?: string | null;
  pinned_sha?: string;
  /** Mismatch context written by mux-runner; read by pipeline-runner to surface to stderr. */
  head_pin_mismatch_detail?: { pinned_branch: string | null; observed_branch: string | null; pinned_sha: string; observed_sha: string } | null;
  /**
   * Per-pane producer liveness flags. Length 4 (pane indices 0..3). Written
   * exclusively by pipeline-runner.ts at non-citadel phase boundaries.
   * Pane 2 is the producer pane (morty-watcher in pickle, subsystem-watcher
   * in microverse). Absent or false → show the normal no-data message.
   * True → show "Producer complete" instead. Crash-recovery default: false.
   */
  monitor_panes?: { producer_done: boolean }[];
  last_error?: ErrorRecord | null;
  last_subprocess_error?: ErrorRecord | null;
  last_between_ticket_gate?: {
    ts: number;
    ok: boolean;
    failures: Array<{
      name: string;
      file: string;
    }>;
  };
}

/**
 * Threshold for consecutive false EPIC_COMPLETED emissions on the same ticket
 * before mux-runner gives up and exits with MANAGER_PERSISTENT_HALLUCINATION.
 * Recovery is the default; this guards against a manager stuck in a permanent
 * hallucination loop.
 */
export const FALSE_EPIC_THRESHOLD = 3;

export type Backend = 'claude' | 'codex' | 'hermes';
export type BackendResolutionSource = 'state' | 'env' | 'settings' | 'default' | 'refinement-lock' | 'cli-flag-override';
export type WorkerBackendResolutionSource = 'worker_backend' | 'backend' | 'env_lock';

export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'hermes'] as const;

export interface ProjectContext {
  project_context_path: string;
  last_run_iso: string;
  file_count: number;
  project_type: string;
}

export interface CourseCorrectionRecord {
  proposal_path: string;
  applied_iso: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
}

export interface StateFlags {
  strict_teams?: boolean;
  /**
   * If set, mux-runner forwards `--skip-readiness <reason>` to check-readiness
   * on iter 0 of every pickle phase, bypassing the readiness gate. The reason
   * is recorded as a `readiness_skipped` activity event for audit. Used when a
   * bundle has already been validated by the refinement team or other
   * out-of-band review.
   */
  skip_readiness_reason?: string;
  /**
   * If set, mux-runner bypasses the ticket audit gate (audit-ticket-bundle.js)
   * on iter 0 and emits a `ticket_audit_bypassed` activity event with this reason.
   */
  skip_ticket_audit_reason?: string;
  /**
   * If set to a recognized bundle ID (e.g. "2026-05-08-mega"), and the current
   * session hash is in BUNDLE_BOOTSTRAP_ALLOWLIST for that bundle ID, mux-runner
   * auto-applies both skip_readiness_reason and skip_ticket_audit_reason on iter 0
   * and emits a `bundle_bootstrap_exemption_applied` activity event.
   */
  bundle_bootstrap_mode?: string;
  [key: string]: unknown;
}

export interface ReadinessCycleHistoryEntry {
  cycle: number;
  status: string;
  suggested_analyst: string | null;
  user_action: string | null;
  timestamp: string;
}

export interface ReadinessState {
  cycle_history: ReadinessCycleHistoryEntry[];
  [key: string]: unknown;
}

export interface PhasePersona {
  phase: string;
  subagent_type: string;
  model?: string;
  [key: string]: unknown;
}

export interface ChangeProposal {
  proposal_path: string;
  restart_ticket_id: string | null;
  before_count: number;
  after_count: number;
  [key: string]: unknown;
}

export interface ErrorRecord {
  iteration: number;
  timestamp: string;
  completion: IterationOutcome['completion'];
  timedOut: boolean;
  wallSeconds: number;
}

export interface DebateRound {
  round: number;
  participants: string[];
  result_path?: string;
  [key: string]: unknown;
}

export interface ActivityLogEntry {
  event: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// StateManager Types & Errors
// ---------------------------------------------------------------------------

export interface StateManagerOptions {
  maxLockRetries: number;
  baseLockDelayMs: number;
  lockJitter: boolean;
  staleLockTimeoutMs: number;
  schemaVersion: number;
}

export const STATE_MANAGER_DEFAULTS: StateManagerOptions = {
  maxLockRetries: 10,
  baseLockDelayMs: 100,
  lockJitter: true,
  staleLockTimeoutMs: 30_000,
  schemaVersion: 3,
};

/** Latest schema_version that this code knows how to write/read. Must match the latest migration target in state-manager.ts. */
export const LATEST_SCHEMA_VERSION = 3;

export type StateErrorCode = 'MISSING' | 'CORRUPT' | 'SCHEMA_MISMATCH' | 'SCHEMA_DEPLOY_DRIFT' | 'LOCK_FAILED' | 'WRITE_FAILED';

export class StateError extends Error {
  readonly code: StateErrorCode;
  constructor(code: StateErrorCode, message: string) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class LockError extends StateError {
  kind?: 'LockError';
  key?: string;
  timeout_ms?: number;
  waited_ms?: number;
  constructor(message: string) {
    super('LOCK_FAILED', message);
    this.name = 'LockError';
  }
}

export class TransactionError extends StateError {
  readonly rollbackErrors: Error[];
  constructor(message: string, rollbackErrors: Error[] = []) {
    super('WRITE_FAILED', message);
    this.name = 'TransactionError';
    this.rollbackErrors = rollbackErrors;
  }
}

export class SchemaVersionMismatchError extends StateError {
  readonly statePath: string;
  readonly onDiskVersion: number;
  readonly cachedVersion: number;

  constructor(statePath: string, onDiskVersion: number, cachedVersion: number) {
    super(
      'SCHEMA_MISMATCH',
      `State file ${statePath} schema_version ${onDiskVersion} is newer than transaction snapshot schema_version ${cachedVersion}`,
    );
    this.name = 'SchemaVersionMismatchError';
    this.statePath = statePath;
    this.onDiskVersion = onDiskVersion;
    this.cachedVersion = cachedVersion;
  }
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /** @deprecated Claude Code uses last_assistant_message instead */
  prompt_response?: string;
}

export interface PostToolUseFailureInput {
  session_id?: string;
  hook_event_name?: 'PostToolUseFailure' | string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  is_interrupt?: boolean;
  tool_use_id?: string;
  cwd?: string;
  transcript_path?: string;
}

export interface LastToolErrorState {
  ts: string;
  tool: string;
  error_signature: string;
  retry_count: number;
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
} as const;

// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------

export const VALID_STEPS = [
  'prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review', 'completed',
  'pickle', 'citadel', 'anatomy-park', 'szechuan-sauce',
] as const;
export type Step = typeof VALID_STEPS[number];

// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------

export { PROMISE_TOKENS, type PromiseToken } from '../services/promise-tokens.js';

export const PromiseTokens = {
  EPIC_COMPLETED: 'EPIC_COMPLETED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  WORKER_DONE: 'I AM DONE',
  PRD_COMPLETE: 'PRD_COMPLETE',
  TICKET_SELECTED: 'TICKET_SELECTED',
  ANALYSIS_DONE: 'ANALYSIS_DONE',
  EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
  THE_CITADEL_APPROVES: 'THE_CITADEL_APPROVES',
} as const;

/** Returns true if `text` contains `<promise>TOKEN</promise>`, tolerating whitespace inside tags. */
export function hasToken(text: string, token: string): boolean {
  if (!text || !token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<promise>\\s*${escaped}\\s*</promise>`).test(text);
}

/** Wraps `token` in promise XML tags. */
export function wrapToken(token: string): string {
  return `<promise>${token}</promise>`;
}

// ---------------------------------------------------------------------------
// Lifecycle Artifacts
// ---------------------------------------------------------------------------

export type WorkerRole = 'implementation' | 'review';

// Prefixes written by the Morty worker prompts (send-to-morty.md and
// send-to-morty-review.md). A ticket with at least one matching `.md` file in
// its directory is evidence the lifecycle actually ran.
export const ARTIFACT_PREFIXES: Record<WorkerRole, readonly string[]> = {
  implementation: ['research', 'plan', 'conformance', 'code_review'],
  review: ['review_scope', 'review_findings', 'spec_conformance'],
};

/**
 * True when `files` contains at least one lifecycle artifact for `role`.
 * Matches exact `${prefix}.md` (e.g. `review_scope.md`) or `${prefix}_*.md`
 * (e.g. `research_2026-04-18.md`, `plan_review.md`). Pure — caller does readdir.
 */
export function hasLifecycleArtifact(files: readonly string[], role: WorkerRole): boolean {
  const prefixes = ARTIFACT_PREFIXES[role];
  return files.some(f =>
    prefixes.some(p => f === `${p}.md` || f.startsWith(`${p}_`))
  );
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
  'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
  'judge_unreachable',
  'judge_timeout',
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
  'readiness_delta_requested',
  'phase_transition',
  'extension_dir_fallback',
  'halt',
  'pkgjson_only_revert_detected',
  'pkgjson_full_drift_detected',
  'pkgjson_dep_or_src_missing',
  'paused_session_orphan_demoted',
  'phantom_session_demoted',
  'worker_spawn_backend_resolved',
  'worker_spawn_backend_override',
  'worker_spawn_backend_mismatch',
  'subtool_backend_override',
  'pipeline_auto_resumed',
  'smoke_gate_bypassed',
  'codex_unhealthy_consecutive_failures',
  'ticket_audit_bypassed',
  'ticket_audit_failed',
  'worker_partial_lifecycle_exit',
  'cap_check_skipped_stale_cache',
  'ticket_cache_cleared',
  'orphan_map_entry_pruned',
  'install_sh_parity_check',
  'worker_backend_resolved',
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
  'bundle_preflight_failed',
  'judge_violation_ledger_advanced',
  'judge_legacy_shape_inferred',
  'judge_json_parse_failed',
  'consecutive_no_progress_warning',
  'monitor_respawn_started',
  'monitor_respawn_failed',
  'monitor_mode_swapped',
  'setup_resume_ticket_status_preserved',
  'setup_resume_overrode_ticket_status',
  'head_mismatch_detected',
  'stale_index_lock_cleaned',
  'stale_index_lock_held_by_live_process',
] as const;

export type ActivityEventType = typeof VALID_ACTIVITY_EVENTS[number];
export type ActivityEventSource = 'pickle' | 'hook' | 'persona' | 'force_flag' | BackendResolutionSource | WorkerBackendResolutionSource;

export enum PipelineRunnerExitCode {
  Success = 0,
  Failure = 1,
  AuditFailure = 2,
  PhaseIncomplete = 3,
}

export type IterationExitType = 'success' | 'error' | 'api_limit' | 'inactive' | 'timeout';

export interface RateLimitInfo {
  limited: boolean;
  sawEvents?: boolean;     // true if structured rate_limit_event lines were found (even if not rejected)
  resetsAt?: number;       // Unix epoch seconds from API
  rateLimitType?: string;  // 'five_hour' | 'seven_day' etc.
}

export type IterationExitResult =
  | { type: 'inactive' }
  | { type: 'error' }
  | { type: 'success' }
  | { type: 'api_limit'; rateLimitInfo?: RateLimitInfo }
  | { type: 'timeout'; exitCode: number | null; wallSeconds: number };

export interface IterationOutcome {
  completion: 'task_completed' | 'review_clean' | 'continue' | 'error' | 'inactive';
  timedOut: boolean;
  exitCode: number | null;
  wallSeconds: number;
  stallReason?: 'wall_clock' | 'output_stall';
}

export interface RateLimitAction {
  action: 'wait' | 'bail';
  waitMs: number;
  waitSource: 'api' | 'config';
  resetCounter: boolean;
  hasResetsAt: boolean;
}

export interface ActivityEvent {
  ts: string;
  event: ActivityEventType;
  source: ActivityEventSource;
  session?: string;
  epic?: string;
  ticket?: string;
  title?: string;
  step?: string;
  mode?: string;
  pass?: number;
  commit_hash?: string;
  commit_message?: string;
  duration_min?: number;
  duration_ms?: number;
  error?: string;
  iteration?: number;
  completion?: IterationOutcome['completion'];
  timedOut?: boolean;
  wallSeconds?: number;
  exit_type?: IterationExitType;
  runner?: 'microverse' | 'mux' | string;
  action?: string;
  wasted?: boolean;
  pre_iter_sha?: string | null;
  post_iter_sha?: string | null;
  original_prompt?: string;
  model?: string;
  backend?: Backend;
  worker_backend?: Backend | null;
  ticket_id?: string;
  project_type?: string;
  bytes_out_utf8?: number;
  tokens_in_estimated?: number;
  tokens_out_estimated?: number;
  round?: number;
  expected_tickets_version?: number;
  actual_tickets_version?: number;
  bytes_dropped?: number;
  relaunch_count?: number;
  pending_count?: number;
  cap?: number;
  last_ticket_seen?: string | null;
  gate_payload?: Record<string, unknown>;
  // AC-LPB-05: emitted by setup.ts/pipeline-runner.ts on session reconstruction
  // (resume) so monitor/standup consumers can distinguish a fresh launch from a
  // resumed run and reason about wall-clock budgets correctly.
  original_epoch?: number;
  new_epoch?: number;
  previous_phase?: string | null;
  next_phase?: string;
  previous_exit_reason?: string | null;
  exit_reason?: string;
  requested_path?: string;
  fallback_path?: string;
  session_path?: string;
  reason?: string;
  stall_category?: StallCategory;
  stall_recovery_action?: StallRecoveryAction;
  signal?: string;
  pid?: number;
  ppid?: number;
  is_tty?: boolean;
  pgid?: number | null;
  active_child_pid?: number | null;
  active_child_cmd?: string | null;
  current_phase?: string | null;
  received_at_iso?: string;
  handler_stack?: string[];
  phase?: string;
  exit_code?: number;
  fatal?: boolean;
  downstream_phases_remaining?: string[];
  decision?: 'continue' | 'abort';
  attempts?: number;
  fall_through_to_finalize_gate?: boolean;
  iteration_num?: number;
  num_turns?: number;
  max_turns?: number;
  wall_seconds?: number;
  // setup_resume_ticket_status_preserved / setup_resume_overrode_ticket_status
  observed_status?: string;
  expected_status?: string;
  prior_status?: string;
  new_status?: string;
}

// ---------------------------------------------------------------------------
// Auto-Update Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session Map Types
// ---------------------------------------------------------------------------

/** A session map entry in current_sessions.json. Stores the session path and PID of the process that created it. */
export interface SessionMapEntry {
  sessionPath: string;
  pid: number;
}

export interface UpdateCheckCache {
  last_check_epoch: number;
  latest_version: string;
  current_version: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface ReleaseInfo {
  tagName: string;
  assets: ReleaseAsset[];
}

export interface UpdateSettings {
  auto_update_enabled: boolean;
  update_check_interval_hours: number;
}

export interface PickleSettings {
  default_codex_model?: string;
  enable_complexity_tiers?: boolean;
  pipeline_continue_on_phase_fail?: boolean;
  worker_gate_tier?: 'narrow' | 'fast' | 'full';
  worker_test_gate_timeout_ms?: number;
  [key: string]: unknown;
}

export type UpdateStatus = 'up-to-date' | 'update-available' | 'error';

export interface UpdateResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export interface UpgradeResult {
  success: boolean;
  error?: string;
  exitCode?: number;
  aborted?: boolean;
}

// ---------------------------------------------------------------------------
// Microverse Types
// ---------------------------------------------------------------------------

export type MicroverseExitReason =
  | 'converged' | 'limit_reached' | 'stopped' | 'error'
  | 'rate_limit_exhausted' | 'approach_exhaustion' | 'no_progress'
  | 'judge_unreachable' | 'judge_timeout' | 'baseline_unmeasurable' | 'judge_cli_missing'
  | 'baseline_unmeasurable_transient' | 'baseline_unmeasurable_unrecoverable';

export const MICROVERSE_FATAL_REASONS = [
  'judge_cli_missing',
  'session_state_corrupted',
  'baseline_unmeasurable_unrecoverable',
] as const;

export type MicroverseFatalReason = typeof MICROVERSE_FATAL_REASONS[number];

const MICROVERSE_FAILURE_REASONS = new Set<MicroverseExitReason>([
  'error', 'rate_limit_exhausted', 'judge_unreachable',
  'baseline_unmeasurable_unrecoverable', 'judge_cli_missing',
]);

export function isMicroverseFailureExit(reason: MicroverseExitReason): boolean {
  return MICROVERSE_FAILURE_REASONS.has(reason);
}

export interface MicroverseMetric {
  description: string;
  validation: string;
  type: 'command' | 'llm' | 'none';
  timeout_seconds: number;
  tolerance: number;
  direction?: 'higher' | 'lower';
  judge_model?: string;
}

export type FailureClass = 'tool_failure' | 'approach_exhaustion' | 'regression' | 'metric_unstable' | 'no_progress';

export type StallCategory = 'worker_timeout' | 'tests_red_no_progress' | 'circular_revert' | 'external_blocker';

export type StallRecoveryAction = 'escalate_timeout' | 'prompt_guidance' | 'reset_to_baseline' | 'halt';

export interface StallClassification {
  category: StallCategory;
  recovery_action: StallRecoveryAction;
}

export interface ClassifiedFailure {
  iteration: number;
  failure_class: FailureClass;
  description: string;
  timestamp: string;
}

export interface MicroverseHistoryEntry {
  iteration: number;
  metric_value: string;
  score: number;
  action: 'accept' | 'revert';
  description: string;
  pre_iteration_sha: string;
  timestamp: string;
  classification?: 'improved' | 'held' | 'regressed';
  failure_class?: FailureClass;
}

/** Stable violation record passed to buildJudgePrompt to suppress re-reporting of known issues. */
export interface ViolationLedger {
  id: string;
  path?: string;
  line?: number;
  rule?: string;
  first_seen_iter: number;
  last_seen_iter: number;
  severity: 'high' | 'med' | 'low';
  description: string;
}

/** Single violation item returned by the LLM judge in structured output mode. */
export interface Violation {
  id: string;
  path?: string;
  line?: number;
  rule?: string;
  severity: 'high' | 'med' | 'low';
  description: string;
}

/** Return type of parseLlmJudgeOutput — discriminated by shape. */
export interface JudgeResult {
  score: number | null;
  violations: Violation[];
  resolved: string[];
  new: string[];
  remaining: string[];
  shape: 'full' | 'legacy' | 'malformed' | 'partial';
}

export interface MicroverseSessionState {
  status: 'gap_analysis' | 'iterating' | 'converged' | 'stopped';
  prd_path: string;
  key_metric: MicroverseMetric;
  convergence: {
    stall_limit: number;
    stall_counter: number;
    history: MicroverseHistoryEntry[];
  };
  gap_analysis_path: string;
  judge_context_path?: string;
  failed_approaches: string[];
  baseline_score: number;
  convergence_target?: number;
  convergence_mode?: 'metric' | 'worker';
  convergence_file?: string;
  allowed_paths?: string[];
  exit_reason?: string;
  stash_ref?: string;
  failure_history: ClassifiedFailure[];
  approach_exhaustion_fired: boolean;
  iteration_regressions?: number;
  gate_regression_threshold_warning_emitted?: boolean;
  consecutive_amnesiac_exits?: number;
  consecutive_subprocess_errors?: number;
  violation_ledger?: ViolationLedger[];
  current_subsystem?: string;
}

// ---------------------------------------------------------------------------
// Gate Types
// ---------------------------------------------------------------------------

export interface GateFailure {
  check: 'typecheck' | 'lint' | 'tests';
  file: string;
  line: number;
  ruleOrCode: string;
  message: string;
  severity: 'error' | 'warning';
  occurrence_index: number;
}

export type GateMode = 'baseline' | 'strict';

export interface GateResult {
  status: 'green' | 'red' | 'green-with-known-flake-warnings';
  failures: GateFailure[];
  baseline_used: boolean;
  allowed_paths_used: boolean;
  elapsed_ms: number;
  total_raw_failure_count: number;
  new_failures_vs_baseline: number;
}

export interface GateBaselineFile {
  schema_version: 1;
  captured_at: string;
  captured_iteration?: number;
  working_dir: string;
  project_type: 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | 'bun' | null;
  checks: ('typecheck' | 'lint' | 'tests')[];
  failures: GateFailure[];
}

export interface RemediationResult {
  iso: string;
  failures_in: number;
  failures_out: number;
  auto_fixes_applied: number;
  hand_fixes_applied: number;
  aborted: boolean;
  abort_reason: string | null;
  production_coverage_test_path: string | null;
  elapsed_ms: number;
}

export interface CreateMicroverseOpts {
  prdPath: string;
  metric: MicroverseMetric;
  stallLimit: number;
  convergenceTarget?: number;
  convergenceMode?: 'metric' | 'worker';
  convergenceFile?: string;
  allowedPaths?: string[];
}

// ---------------------------------------------------------------------------
// DOT Builder Types
// ---------------------------------------------------------------------------

export {
  AttrType,
  AttrScope,
  AttrDef,
  ATTRACTOR_SCHEMA_FALLBACK,
  ALL_ATTRS,
  AttrValidation,
  lookupAttr,
  validateAttrType,
  validateAttrs,
} from './attractor-schema.fallback.js';

export type BuildErrorCode =
  | 'EMPTY_SLUG'
  | 'EMPTY_GOAL'
  | 'DUPLICATE_PHASE'
  | 'INVALID_RATCHET'
  | 'NON_NUMERIC_TARGET'
  | 'ALREADY_BUILT'
  | 'INVALID_STRUCTURE'
  | 'START_HAS_INCOMING'
  | 'UNREACHABLE_NODE'
  | 'DIAMOND_MISSING_EDGES'
  | 'GOAL_GATE_NO_MAX_VISITS'
  | 'MISSING_AC_MAPPING'
  | 'MISSING_TIMEOUT'
  | 'PROMPT_PATH_MISMATCH'
  | 'REVIEW_MISSING_READONLY'
  | 'COMPONENT_NO_MERGE'
  | 'FAN_OUT_SCOPE_LEAK'
  | 'WORKSPACE_NO_HTTPS'
  | 'WORKSPACE_NO_PUSH'
  | 'PLAN_MODE_DEADLOCK'
  | 'MISSING_ALLOWED_PATHS'
  | 'INVALID_SPEC'
  | 'INVALID_TIMEOUT'
  | 'INVALID_ALLOWED_PATHS'
  | 'DUPLICATE_MODEL'
  | 'INVALID_CONVERGENCE_SPEC';

export interface Diagnostic {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  edge?: [string, string];
  fix?: string;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly diagnostics: Diagnostic[];
  constructor(code: BuildErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface MicroverseOpts {
  prompt: string;
  measureCommand: string;
  target: number;
  direction: 'reduce' | 'improve';
  allowedPaths: string[];
  timeout?: string;
  maxVisits?: number;
}

export interface WorkspaceOpts {
  repoUrl?: string;
  repoBranch?: string;
  cleanup?: 'delete' | 'preserve';
}

export interface StylesheetOverride {
  selector: string;
  model: string;
  effort?: string;
}

export interface StylesheetConfig {
  defaultModel: string;
  defaultEffort?: string;
  overrides?: StylesheetOverride[];
  defaultProvider?: string;
  criticalModel?: string;
  criticalProvider?: string;
  reviewModel?: string;
  reviewProvider?: string;
  reasoningEffort?: string;
}

export interface ConvergenceSpec {
  until: 'V_total == 0' | 'V_total == 0 && fixed_point' | 'V_total == 0 && fixed_point && reproducibility';
  maxVisits?: number;
  timeout?: string;
  impl: {
    harness: 'hermes' | 'claude-code';
    prompt: string;
  };
  sealedFromSource?: string;
  fixBackend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  fixFrontend?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    timeout?: string;
    maxVisits?: number;
  };
  mechanicalGates?: {
    buildApi?: string;
    testsApi?: string;
    buildUi?: string;
    lint?: string;
  };
  reviewers?: {
    be?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    fe?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
    int?: { model: string; harness: 'hermes' | 'claude-code'; prompt: string; timeout?: string; maxVisits?: number };
  };
  adversary?: {
    model: string;
    harness: 'hermes' | 'claude-code';
    prompt: string;
    sealedFromSource?: string;
    timeout?: string;
    maxVisits?: number;
  };
  fpVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  reproVerify?: {
    command: string;
    timeout?: string;
    maxVisits?: number;
  };
  convergenceEpsilon?: number;
  maxIterations?: number;
}

export interface PhaseSpec {
  name: string;
  prompt: string;
  allowedPaths: string[];
  severity?: 'error' | 'warning' | 'info';
  dependsOn?: string[];
  contextOnSuccess?: Record<string, string>;
  escalateOn?: string[];
  specFirst?: boolean;
  goalGate?: boolean;
  retryTarget?: string;
  timeout?: string;
  threadId?: string;
  securityScan?: boolean;
  coverageTarget?: number;
  competing?: boolean;
  redTeam?: boolean;
  bddScenarios?: boolean;
  deliverables?: string[];
  docOnly?: boolean;
  maxVisits?: number;
  verifyCommand?: string;
  permissionMode?: string;
  requirements?: string[];
  testExpectations?: { count: number; isolation: boolean };
  uiType?: 'crud' | 'dashboard' | 'form' | 'wizard';
}

export interface DefenseMatrix {
  competitive: boolean;
  guardrails: string[];
  specDriven: 'NONE' | 'conformance' | 'BDD + conformance' | 'spec_file + conformance' | 'spec_file + BDD + conformance';
  permissions: string[];
  adversarial: boolean;
}

export interface BuildResult {
  dot: string;
  slug: string;
  patternsApplied: string[];
  defenseMatrix: DefenseMatrix;
  diagnostics: Diagnostic[];
}

export interface BuilderSpec {
  slug: string;
  goal: string;
  phases: PhaseSpec[];
  acceptanceCriteria: Record<string, string>;
  workingDir?: string;
  label?: string;
  defaultMaxRetry?: number;
  workspace?: 'isolated';
  workspaceOpts?: WorkspaceOpts;
  microverse?: { name: string; opts: MicroverseOpts };
  reviewRatchet?: number;
  modelStylesheet?: StylesheetConfig;
  specFile?: string;
  endgame?: { broadPass?: boolean };
  convergence?: ConvergenceSpec;
}
