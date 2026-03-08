export interface RuntimeConfig {
    bin: string;
    prompt_flag: string;
    extra_flags: string[];
    json_output_flag: string | null;
    auto_approve_flag: string | null;
    detected: boolean;
    add_dir_flag: string | null;
    max_turns_flag: string | null;
    model_flag: string | null;
    verbose_flag: string | null;
    no_session_flag: string | null;
    env_set: Record<string, string>;
    env_delete: string[];
    tier: 'verified' | 'pending' | 'community';
}
export interface PickleRickSkillsConfig {
    primary_cli: string;
    runtimes: Record<string, RuntimeConfig>;
    defaults: {
        max_iterations: number;
        max_time_minutes: number;
        worker_timeout_seconds: number;
        tmux_max_turns: number;
        manager_max_turns: number;
        refinement_cycles: number;
        refinement_max_turns: number;
        refinement_worker_timeout_seconds: number;
        meeseeks_min_passes: number;
        meeseeks_max_passes: number;
        meeseeks_model: string;
        rate_limit_wait_minutes: number;
        max_rate_limit_retries: number;
        rate_limit_poll_ms: number;
        sigkill_grace_seconds: number;
        cb_enabled: boolean;
        cb_no_progress_threshold: number;
        cb_half_open_after: number;
        cb_error_threshold: number;
        chain_meeseeks: boolean;
    };
}
export interface SpawnManagerArgs {
    prompt: string;
    runtime: string;
    cwd: string;
    logFile: string;
    timeout: number;
    sessionDir: string;
    extensionRoot: string;
    maxTurns: number;
    model?: string;
    env?: Record<string, string>;
}
export interface SpawnWorkerArgs {
    prompt: string;
    runtime: string;
    cwd: string;
    logFile: string;
    timeout: number;
    ticketPath: string;
    extensionRoot: string;
    env?: Record<string, string>;
}
export interface SpawnResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
