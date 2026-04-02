import * as path from 'path';
import { createMicroverseState, writeMicroverseState } from '../services/microverse-state.js';
import { safeErrorMessage } from '../services/pickle-utils.js';
const DEFAULT_METRIC = {
    description: 'Number of coding principle violations (lower is better)',
    validation: 'Review the code at the target path for violations of established coding principles (KISS, YAGNI, DRY, SOLID, Small Functions, Guard Clauses, Cognitive Load, Self-Documenting Code, Encapsulation, Fail-Fast, etc). Count only REAL, actionable violations — not style nitpicks. A violation must be fixable and must clearly hurt readability, maintainability, or correctness. Score = number of violations found.',
    type: 'llm',
    timeout_seconds: 300,
    tolerance: 0,
    direction: 'lower',
    judge_model: 'claude-sonnet-4-6',
};
function parseFlag(args, flag) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return undefined;
    return args[idx + 1];
}
if (process.argv[1] && path.basename(process.argv[1]) === 'init-microverse.js') {
    const args = process.argv.slice(2);
    const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1]?.startsWith('--')));
    const sessionDir = positional[0];
    const targetPath = positional[1];
    if (!sessionDir || !targetPath) {
        console.error('Usage: init-microverse <session-dir> <target-path> [--stall-limit N] [--convergence-target N] [--metric-json \'...\']');
        process.exit(1);
    }
    const stallLimit = Number(parseFlag(args, '--stall-limit') ?? '5');
    const rawConvergence = parseFlag(args, '--convergence-target');
    const rawMetricJson = parseFlag(args, '--metric-json');
    const judgeContextPath = parseFlag(args, '--judge-context');
    let metric;
    if (rawMetricJson) {
        try {
            metric = JSON.parse(rawMetricJson);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Invalid --metric-json: ${msg}`);
            process.exit(1);
        }
    }
    else {
        metric = DEFAULT_METRIC;
    }
    try {
        const convergenceTarget = rawConvergence != null ? Number(rawConvergence) : undefined;
        const state = createMicroverseState({ prdPath: targetPath, metric, stallLimit, convergenceTarget });
        state.gap_analysis_path = path.join(sessionDir, 'gap_analysis.md');
        if (judgeContextPath)
            state.judge_context_path = judgeContextPath;
        writeMicroverseState(sessionDir, state);
        console.log('microverse.json created');
    }
    catch (err) {
        console.error(`Failed to init microverse: ${safeErrorMessage(err)}`);
        process.exit(1);
    }
}
