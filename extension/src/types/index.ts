export interface State {
  active: boolean;
  working_dir: string;
  step: Step;
  iteration: number;
  max_iterations: number;
  max_time_minutes: number;
  worker_timeout_seconds: number;
  start_time_epoch: number;
  completion_promise: string | null;
  original_prompt: string;
  current_ticket: string | null;
  history: Array<{ step: Step; ticket?: string; timestamp: string }>;
  started_at: string;
  session_dir: string;
  tmux_mode?: boolean;
  min_iterations?: number;
  command_template?: string;
  chain_meeseeks?: boolean;
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

// ---------------------------------------------------------------------------
// Default Configuration Values
// ---------------------------------------------------------------------------

export const Defaults = {
  WORKER_TIMEOUT_SECONDS: 1200,
  MANAGER_MAX_TURNS: 50,
} as const;

// ---------------------------------------------------------------------------
// Lifecycle Steps
// ---------------------------------------------------------------------------

export const VALID_STEPS = ['prd', 'breakdown', 'research', 'plan', 'implement', 'refactor', 'review'] as const;
export type Step = typeof VALID_STEPS[number];

// ---------------------------------------------------------------------------
// Promise Tokens
// ---------------------------------------------------------------------------

export const PromiseTokens = {
  EPIC_COMPLETED: 'EPIC_COMPLETED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  WORKER_DONE: 'I AM DONE',
  PRD_COMPLETE: 'PRD_COMPLETE',
  TICKET_SELECTED: 'TICKET_SELECTED',
  ANALYSIS_DONE: 'ANALYSIS_DONE',
  EXISTENCE_IS_PAIN: 'EXISTENCE_IS_PAIN',
} as const;

type PromiseToken = typeof PromiseTokens[keyof typeof PromiseTokens];

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
// Activity Events
// ---------------------------------------------------------------------------

export const VALID_ACTIVITY_EVENTS = [
  'session_start', 'session_end', 'ticket_completed', 'epic_completed',
  'meeseeks_pass', 'commit', 'research', 'bug_fix', 'feature',
  'refactor', 'review', 'jar_start', 'jar_end',
  'circuit_open', 'circuit_recovery',
  'iteration_start', 'iteration_end',
  'rate_limit_wait', 'rate_limit_resume', 'rate_limit_exhausted',
] as const;

export type ActivityEventType = typeof VALID_ACTIVITY_EVENTS[number];

export type IterationExitType = 'success' | 'error' | 'api_limit' | 'inactive';

export interface RateLimitInfo {
  limited: boolean;
  resetsAt?: number;       // Unix epoch seconds from API
  rateLimitType?: string;  // 'five_hour' | 'seven_day' etc.
}

export interface IterationExitResult {
  type: IterationExitType;
  rateLimitInfo?: RateLimitInfo;
}

export interface ActivityEvent {
  ts: string;
  event: ActivityEventType;
  source: 'pickle' | 'hook' | 'persona';
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
  error?: string;
  iteration?: number;
  exit_type?: IterationExitType;
  original_prompt?: string;
}
