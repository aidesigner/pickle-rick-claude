#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJudgeInvocation, resolveBackendFromStateFile } from '../services/backend-spawn.js';
import { isoCompactStamp } from '../services/pickle-utils.js';
import { recoverCourseCorrectionFromLedger } from '../services/transaction-ticket-ops.js';
const MAX_DISCOVERY_LENGTH = 2_000;
const DEFAULT_MODEL = 'sonnet';
const CORRECTOR_SYSTEM_PROMPT = [
    'You are morty-course-corrector.',
    'Use only read-only analysis. Do not edit files, write files, execute shell commands, or mutate session state.',
    'Return proposal markdown only.',
].join(' ');
function usage() {
    process.stderr.write('Usage: node correct-course.js "<discovery>" --session-dir <dir> [--repo-root <dir>] [--dry-run] [--auto-apply] [--force] [--recover-from-ledger] [--recover] [--ledger <path>]\n');
    process.exit(1);
}
export function parseArgs(argv) {
    const sessionDir = readFlag(argv, '--session-dir');
    if (!sessionDir)
        usage();
    const repoRoot = readFlag(argv, '--repo-root') ?? process.cwd();
    const discovery = readDiscovery(argv);
    const recoverFromLedger = argv.includes('--recover-from-ledger');
    const recover = argv.includes('--recover');
    if (!recoverFromLedger && !recover)
        validateDiscovery(discovery);
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        discovery,
        dryRun: argv.includes('--dry-run'),
        autoApply: argv.includes('--auto-apply'),
        force: argv.includes('--force'),
        recoverFromLedger,
        recover,
        ledgerPath: readFlag(argv, '--ledger'),
    };
}
function readFlag(argv, flag) {
    const index = argv.indexOf(flag);
    if (index < 0)
        return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
        usage();
    return value;
}
function readDiscovery(argv) {
    const values = [];
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value.startsWith('--')) {
            if (flagTakesValue(value))
                index += 1;
            continue;
        }
        values.push(value);
    }
    return values.join(' ').trim();
}
function flagTakesValue(flag) {
    return flag === '--session-dir' || flag === '--repo-root' || flag === '--ledger';
}
export function validateDiscovery(discovery) {
    if (discovery.trim().length === 0) {
        throw new Error('Discovery statement is required.');
    }
    if (discovery.length > MAX_DISCOVERY_LENGTH) {
        throw new Error(`Discovery statement must be ${MAX_DISCOVERY_LENGTH} characters or fewer.`);
    }
}
export function buildCorrectCourseBrief(args, createdAt) {
    validateDiscovery(args.discovery);
    return [
        '# Course Correction Brief',
        '',
        `Generated: ${createdAt.toISOString()}`,
        `Session root: ${args.sessionDir}`,
        `Repository root: ${args.repoRoot}`,
        '',
        '## Discovery Statement',
        '',
        args.discovery,
        '',
        '## Mode Flags',
        '',
        `- dry_run: ${args.dryRun}`,
        `- auto_apply: ${args.autoApply}`,
        `- force: ${args.force}`,
        `- recover_from_ledger: ${args.recoverFromLedger}`,
        `- recover: ${args.recover}`,
        '',
        '## Corrector Contract',
        '',
        '- Read-only analysis only.',
        '- Use the morty-course-corrector agent instructions.',
        '- The corrector produces proposal content only; the manager performs any later apply, ledger, ticket, or state changes.',
        '- Actual worker invocation must use buildJudgeInvocation(backend, ...) so codex runs with `-s read-only` and Claude runs with `--allowedTools Read,Glob,Grep`.',
        '',
        '## Expected Proposal Sections',
        '',
        '1. Discovery Summary',
        '2. Impact Map',
        '3. Artifact Diffs',
        '4. Restart Point',
        '5. Confidence Metadata',
        '',
    ].join('\n');
}
function planCorrectCourse(args, now) {
    const backend = resolveBackendFromStateFile(path.join(args.sessionDir, 'state.json'));
    const briefPath = path.join(args.sessionDir, `change_proposal_${isoCompactStamp(now)}_brief.md`);
    const briefContent = buildCorrectCourseBrief(args, now);
    const invocation = buildJudgeInvocation(backend, {
        prompt: briefContent,
        addDirs: [args.repoRoot, args.sessionDir],
        model: DEFAULT_MODEL,
        systemPrompt: CORRECTOR_SYSTEM_PROMPT,
    });
    return { backend, briefPath, briefContent, invocation };
}
export function runCorrectCourse(input, opts = {}) {
    const now = opts.now ?? (() => new Date());
    const out = opts.stdout ?? ((message) => process.stdout.write(`${message}\n`));
    const backend = resolveBackendFromStateFile(path.join(input.sessionDir, 'state.json'));
    if (input.recoverFromLedger || input.recover) {
        if (input.recoverFromLedger && input.recover) {
            throw new Error('Choose either --recover-from-ledger or --recover, not both.');
        }
        if (input.recover && !input.force) {
            throw new Error('--recover requires --force.');
        }
        const recovery = recoverCourseCorrectionFromLedger({
            sessionRoot: input.sessionDir,
            ledgerPath: input.ledgerPath,
            mode: input.recoverFromLedger ? 'reverse' : 'forward',
            force: input.force,
            now: now(),
        });
        out(`RECOVERY_LEDGER=${recovery.ledgerPath}`);
        out(`RECOVERY_MODE=${recovery.mode}`);
        out(`RECOVERED_STEPS=${recovery.recoveredSteps.join(',')}`);
        return { exitCode: 0, backend, recovery };
    }
    const plan = planCorrectCourse(input, now());
    if (input.dryRun) {
        out(JSON.stringify({
            brief_path: plan.briefPath,
            backend: plan.backend,
            invocation: plan.invocation,
            brief: plan.briefContent,
        }, null, 2));
        return { exitCode: 0, briefPath: plan.briefPath, backend: plan.backend, invocation: plan.invocation };
    }
    fs.mkdirSync(path.dirname(plan.briefPath), { recursive: true });
    fs.writeFileSync(plan.briefPath, plan.briefContent, 'utf8');
    out(`BRIEF_PATH=${plan.briefPath}`);
    return { exitCode: 0, briefPath: plan.briefPath, backend: plan.backend, invocation: plan.invocation };
}
export function main(argv = process.argv.slice(2)) {
    try {
        const result = runCorrectCourse(parseArgs(argv));
        process.exitCode = result.exitCode;
    }
    catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
