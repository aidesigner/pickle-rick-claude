function resolveRuntime(runtimeName, config) {
    const runtime = config.runtimes[runtimeName];
    if (!runtime) {
        const available = Object.keys(config.runtimes).join(', ');
        throw new Error(`Unknown runtime "${runtimeName}". Available: ${available}`);
    }
    return runtime;
}
function buildCommandCore(runtime, prompt) {
    const cmd = [runtime.bin];
    // For runtimes like codex where prompt_flag is a subcommand (e.g. 'exec'),
    // the prompt follows the subcommand directly
    if (runtime.prompt_flag === 'exec') {
        cmd.push('exec', prompt);
    }
    else {
        cmd.push(runtime.prompt_flag, prompt);
    }
    cmd.push(...runtime.extra_flags);
    return cmd;
}
function appendFlagIfNotNull(cmd, flag, value) {
    if (flag !== null) {
        cmd.push(flag, value);
    }
}
export function buildManagerSpawnCommand(runtimeName, config, args) {
    const runtime = resolveRuntime(runtimeName, config);
    const cmd = buildCommandCore(runtime, args.prompt);
    // Manager-specific: add-dir for extensionRoot and sessionDir
    appendFlagIfNotNull(cmd, runtime.add_dir_flag, args.extensionRoot);
    appendFlagIfNotNull(cmd, runtime.add_dir_flag, args.sessionDir);
    // Manager-specific: max-turns, model, json output, verbose, no-session
    appendFlagIfNotNull(cmd, runtime.max_turns_flag, String(args.maxTurns));
    if (args.model) {
        appendFlagIfNotNull(cmd, runtime.model_flag, args.model);
    }
    appendFlagIfNotNull(cmd, runtime.json_output_flag, 'stream-json');
    if (runtime.verbose_flag)
        cmd.push(runtime.verbose_flag);
    if (runtime.no_session_flag)
        cmd.push(runtime.no_session_flag);
    return cmd;
}
export function buildWorkerSpawnCommand(runtimeName, config, args) {
    const runtime = resolveRuntime(runtimeName, config);
    const cmd = buildCommandCore(runtime, args.prompt);
    // Worker-specific: add-dir for extensionRoot and ticketPath (NOT sessionDir)
    appendFlagIfNotNull(cmd, runtime.add_dir_flag, args.extensionRoot);
    appendFlagIfNotNull(cmd, runtime.add_dir_flag, args.ticketPath);
    return cmd;
}
export function buildSpawnCommand(runtimeName, config, args) {
    if ('sessionDir' in args) {
        return buildManagerSpawnCommand(runtimeName, config, args);
    }
    return buildWorkerSpawnCommand(runtimeName, config, args);
}
export function formatDryRun(cmd) {
    return cmd.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
}
export function listRuntimes(config) {
    const lines = ['Available runtimes:', ''];
    for (const [name, rt] of Object.entries(config.runtimes)) {
        const detected = rt.detected ? 'detected' : 'not detected';
        lines.push(`  ${name} (${rt.tier}) — ${detected}`);
    }
    return lines.join('\n');
}
