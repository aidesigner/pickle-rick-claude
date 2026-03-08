import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// ---------------------------------------------------------------------------
// Default Runtime Registry
// ---------------------------------------------------------------------------
export const VERIFIED_RUNTIMES = {
    claude: {
        bin: 'claude',
        prompt_flag: '-p',
        extra_flags: ['--dangerously-skip-permissions'],
        json_output_flag: '--output-format',
        auto_approve_flag: '--dangerously-skip-permissions',
        detected: false,
        add_dir_flag: '--add-dir',
        max_turns_flag: '--max-turns',
        model_flag: '--model',
        verbose_flag: '--verbose',
        no_session_flag: '--no-session-persistence',
        env_set: {},
        env_delete: [],
        tier: 'verified',
    },
};
export const PENDING_RUNTIMES = {
    gemini: {
        bin: 'gemini',
        prompt_flag: '-p',
        extra_flags: ['--sandbox=none'],
        json_output_flag: null,
        auto_approve_flag: '--sandbox=none',
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: '--model',
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'pending',
    },
    codex: {
        bin: 'codex',
        prompt_flag: 'exec',
        extra_flags: ['--full-auto'],
        json_output_flag: null,
        auto_approve_flag: '--full-auto',
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: '--model',
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'pending',
    },
    aider: {
        bin: 'aider',
        prompt_flag: '--message',
        extra_flags: ['--yes-always'],
        json_output_flag: null,
        auto_approve_flag: '--yes-always',
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: '--model',
        verbose_flag: '--verbose',
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'pending',
    },
};
export const COMMUNITY_RUNTIMES = {
    hermes: {
        bin: 'hermes',
        prompt_flag: '--prompt',
        extra_flags: [],
        json_output_flag: null,
        auto_approve_flag: null,
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: null,
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'community',
    },
    goose: {
        bin: 'goose',
        prompt_flag: '--prompt',
        extra_flags: [],
        json_output_flag: null,
        auto_approve_flag: null,
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: null,
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'community',
    },
    amp: {
        bin: 'amp',
        prompt_flag: '--prompt',
        extra_flags: [],
        json_output_flag: null,
        auto_approve_flag: null,
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: null,
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'community',
    },
    kilo: {
        bin: 'kilo',
        prompt_flag: '--prompt',
        extra_flags: [],
        json_output_flag: null,
        auto_approve_flag: null,
        detected: false,
        add_dir_flag: null,
        max_turns_flag: null,
        model_flag: null,
        verbose_flag: null,
        no_session_flag: null,
        env_set: {},
        env_delete: [],
        tier: 'community',
    },
};
export const ALL_DEFAULT_RUNTIMES = {
    ...VERIFIED_RUNTIMES,
    ...PENDING_RUNTIMES,
    ...COMMUNITY_RUNTIMES,
};
// ---------------------------------------------------------------------------
// Default Config Values (20 keys)
// ---------------------------------------------------------------------------
export const DEFAULT_CONFIG_DEFAULTS = {
    max_iterations: 100,
    max_time_minutes: 120,
    worker_timeout_seconds: 1200,
    tmux_max_turns: 200,
    manager_max_turns: 50,
    refinement_cycles: 3,
    refinement_max_turns: 100,
    refinement_worker_timeout_seconds: 600,
    meeseeks_min_passes: 10,
    meeseeks_max_passes: 50,
    meeseeks_model: 'sonnet',
    rate_limit_wait_minutes: 60,
    max_rate_limit_retries: 3,
    rate_limit_poll_ms: 10_000,
    sigkill_grace_seconds: 5,
    cb_enabled: true,
    cb_no_progress_threshold: 5,
    cb_half_open_after: 3,
    cb_error_threshold: 3,
    chain_meeseeks: false,
};
// ---------------------------------------------------------------------------
// Config Loading
// ---------------------------------------------------------------------------
export function getExtensionRoot() {
    return process.env['EXTENSION_DIR'] || path.join(os.homedir(), '.pickle-rick-skills');
}
export function getDefaultConfigPath() {
    return path.join(getExtensionRoot(), 'config.json');
}
export function loadConfig(configPath) {
    const filePath = configPath || getDefaultConfigPath();
    let raw = {};
    try {
        if (fs.existsSync(filePath)) {
            raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    }
    catch {
        // Use defaults on parse error
    }
    const rawDefaults = (raw['defaults'] ?? {});
    const defaults = { ...DEFAULT_CONFIG_DEFAULTS };
    for (const key of Object.keys(DEFAULT_CONFIG_DEFAULTS)) {
        if (key in rawDefaults && rawDefaults[key] !== undefined) {
            defaults[key] = rawDefaults[key];
        }
    }
    const rawRuntimes = (raw['runtimes'] ?? {});
    const runtimes = { ...ALL_DEFAULT_RUNTIMES, ...rawRuntimes };
    const primaryCli = typeof raw['primary_cli'] === 'string' ? raw['primary_cli'] : 'claude';
    return {
        primary_cli: primaryCli,
        runtimes,
        defaults: defaults,
    };
}
