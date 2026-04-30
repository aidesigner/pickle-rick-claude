#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWorkerInvocation, resolveBackendFromStateFile } from '../services/backend-spawn.js';
import { extractAssistantContent } from '../services/classifier-utils.js';
import { logActivity } from '../services/activity-logger.js';
import { classifyProjectType, PROJECT_TYPE_CATEGORIES } from '../services/project-type-classifier.js';
import { getExtensionRoot, safeErrorMessage } from '../services/pickle-utils.js';
import { StateManager } from '../services/state-manager.js';
const REQUIRED_SECTIONS = [
    'Architecture',
    'Trap Doors',
    'Unobvious Constraints',
    'Key Entry Points',
    'Conventions',
    'Data Model',
];
const DEFAULT_MODEL = 'sonnet';
function usage() {
    process.stderr.write('Usage: node archaeology.js --session-dir <dir> [--repo-root <dir>] [--extension-root <dir>] [--project-type <category>] [--force] [--dry-run]\n');
    process.exit(1);
}
export function parseArgs(argv) {
    const sessionDir = readFlag(argv, '--session-dir');
    if (!sessionDir)
        usage();
    const repoRoot = readFlag(argv, '--repo-root') ?? process.cwd();
    const extensionRoot = readFlag(argv, '--extension-root') ?? getExtensionRoot();
    const rawProjectType = readFlag(argv, '--project-type');
    const projectType = rawProjectType ? parseProjectType(rawProjectType) : undefined;
    return {
        sessionDir: path.resolve(sessionDir),
        repoRoot: path.resolve(repoRoot),
        extensionRoot: path.resolve(extensionRoot),
        projectType,
        dryRun: argv.includes('--dry-run'),
        force: argv.includes('--force'),
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
function parseProjectType(value) {
    if (PROJECT_TYPE_CATEGORIES.includes(value))
        return value;
    throw new Error(`Unknown project type ${JSON.stringify(value)}. Valid categories: ${PROJECT_TYPE_CATEGORIES.join(', ')}`);
}
export function buildArchaeologyPrompt(repoRoot, classification, registryPath) {
    return [
        'You are performing persistent project archaeology for future implementation workers.',
        `Repository root: ${repoRoot}`,
        `Detected project type: ${classification.category}`,
        `Classifier confidence: ${classification.confidence}`,
        `Classifier reason: ${classification.reason}`,
        `Registry: ${registryPath}`,
        '',
        'Read the repository and produce concise markdown with exactly these headings, in this order:',
        ...REQUIRED_SECTIONS.map((section) => `## ${section}`),
        '',
        'Focus on durable facts that help future workers avoid mistakes. Do not include a title, preamble, completion token, or fenced code block around the whole response.',
    ].join('\n');
}
export function normalizeProjectContext(rawContent, classification) {
    const sections = extractSections(rawContent);
    const firstLine = `> Project type: ${classification.category} — see ${classification.registryPath} for category definition`;
    const lines = [firstLine, ''];
    for (const section of REQUIRED_SECTIONS) {
        lines.push(`## ${section}`);
        lines.push('');
        lines.push(sections.get(section) ?? '- Not identified by archaeology worker.');
        lines.push('');
    }
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
function extractSections(content) {
    const sections = new Map();
    const headingRe = /^##\s+(Architecture|Trap Doors|Unobvious Constraints|Key Entry Points|Conventions|Data Model)\s*$/gm;
    const matches = [...content.matchAll(headingRe)];
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const next = matches[index + 1];
        const heading = match[1];
        const start = (match.index ?? 0) + match[0].length;
        const end = next?.index ?? content.length;
        const body = content.slice(start, end).trim();
        if (body)
            sections.set(heading, body);
    }
    return sections;
}
function planArchaeology(args) {
    const statePath = path.join(args.sessionDir, 'state.json');
    const backend = resolveBackendFromStateFile(statePath);
    const detected = classifyProjectType(args.repoRoot, { extensionRoot: args.extensionRoot });
    const classification = args.projectType ? { ...detected, category: args.projectType, reason: 'project-type override' } : detected;
    const contextPath = path.join(args.sessionDir, 'project-context.md');
    const prompt = buildArchaeologyPrompt(args.repoRoot, classification, classification.registryPath);
    const invocation = buildWorkerInvocation(backend, {
        prompt,
        addDirs: [args.repoRoot, args.extensionRoot, args.sessionDir],
        model: DEFAULT_MODEL,
        outputFormat: 'stream-json',
        effort: 'medium',
    });
    return { args, backend, classification, contextPath, prompt, invocation };
}
export function runArchaeology(input, opts = {}) {
    const plan = planArchaeology(input);
    const out = opts.stdout ?? ((message) => process.stdout.write(`${message}\n`));
    if (input.dryRun) {
        return completeDryRun(plan, out);
    }
    if (fs.existsSync(plan.contextPath) && !input.force) {
        out(`[archaeology] already exists — written: ${plan.contextPath}`);
        return { exitCode: 0, contextPath: plan.contextPath, invocation: plan.invocation, projectType: plan.classification.category, backend: plan.backend };
    }
    const now = opts.now ?? (() => new Date());
    const started = now();
    const result = runWorker(plan.invocation, opts.spawn ?? spawnSync);
    const durationMs = Math.max(0, now().getTime() - started.getTime());
    if (result.status !== 0 || result.error) {
        return completeSkipped(plan, result, durationMs, opts);
    }
    return completeSuccess(plan, result.stdout, durationMs, opts);
}
function completeDryRun(plan, out) {
    out(JSON.stringify({
        backend: plan.backend,
        project_type: plan.classification.category,
        confidence: plan.classification.confidence,
        reason: plan.classification.reason,
        cmd: plan.invocation.cmd,
        args: plan.invocation.args,
        context_path: plan.contextPath,
    }));
    return { exitCode: 0, contextPath: plan.contextPath, invocation: plan.invocation, projectType: plan.classification.category, backend: plan.backend };
}
function completeSkipped(plan, result, durationMs, opts) {
    const err = opts.stderr ?? ((message) => process.stderr.write(`${message}\n`));
    const now = opts.now ?? (() => new Date());
    const message = result.error ? result.error.message : firstNonEmpty(result.stderr) || `worker exited ${result.status}`;
    recordActivity(plan.args.sessionDir, opts.stateManager ?? new StateManager(), opts.logActivityFn ?? logActivity, {
        event: 'archaeology_skipped',
        ts: now().toISOString(),
        duration_ms: durationMs,
        project_type: plan.classification.category,
        backend: plan.backend,
        error: message,
    });
    err(`[archaeology] skipped — ${message}`);
    return { exitCode: result.status ?? 1, contextPath: plan.contextPath, invocation: plan.invocation, projectType: plan.classification.category, backend: plan.backend };
}
function completeSuccess(plan, workerStdout, durationMs, opts) {
    const out = opts.stdout ?? ((message) => process.stdout.write(`${message}\n`));
    const now = opts.now ?? (() => new Date());
    const assistant = extractAssistantContent(workerStdout);
    const context = normalizeProjectContext(assistant, plan.classification);
    fs.writeFileSync(plan.contextPath, context, 'utf8');
    const bytes = Buffer.byteLength(context, 'utf8');
    const completedAt = now().toISOString();
    const payload = {
        event: 'archaeology_complete',
        ts: completedAt,
        bytes_out_utf8: bytes,
        tokens_in_estimated: estimateTokens(plan.prompt),
        tokens_out_estimated: estimateTokens(context),
        duration_ms: durationMs,
        project_type: plan.classification.category,
        backend: plan.backend,
    };
    recordActivity(plan.args.sessionDir, opts.stateManager ?? new StateManager(), opts.logActivityFn ?? logActivity, payload, {
        project_context_path: plan.contextPath,
        last_run_iso: completedAt,
        file_count: countProjectFiles(plan.args.repoRoot),
        project_type: plan.classification.category,
    });
    out(`[archaeology] complete — project type: ${plan.classification.category} (confidence: ${plan.classification.confidence}, ${plan.classification.reason}); duration: ${Math.round(durationMs / 1000)}s; bytes: ${bytes.toLocaleString('en-US')}; written: ${plan.contextPath}`);
    return { exitCode: 0, contextPath: plan.contextPath, invocation: plan.invocation, projectType: plan.classification.category, backend: plan.backend };
}
function runWorker(invocation, spawnFn) {
    return spawnFn(invocation.cmd, invocation.args, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
    });
}
function recordActivity(sessionDir, sm, logActivityFn, payload, archaeology) {
    const statePath = path.join(sessionDir, 'state.json');
    try {
        sm.update(statePath, (state) => {
            state.activity ??= [];
            state.activity.push(payload);
            if (archaeology)
                state.archaeology = archaeology;
        });
    }
    catch {
        // State updates are best-effort here; archaeology should degrade without
        // blocking the caller from continuing without context.
    }
    logActivityFn({ ...payload, source: 'pickle', session: path.basename(sessionDir) });
}
function estimateTokens(content) {
    return Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4));
}
function countProjectFiles(projectRoot) {
    let count = 0;
    const stack = [projectRoot];
    const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
    while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir)
            continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!ignored.has(entry.name))
                    stack.push(path.join(dir, entry.name));
            }
            else if (entry.isFile()) {
                count += 1;
            }
        }
    }
    return count;
}
function firstNonEmpty(value) {
    const text = typeof value === 'string' ? value : value?.toString('utf8');
    return text?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}
function main() {
    try {
        const result = runArchaeology(parseArgs(process.argv.slice(2)));
        process.exit(result.exitCode);
    }
    catch (err) {
        process.stderr.write(`archaeology failed: ${safeErrorMessage(err)}\n`);
        process.exit(1);
    }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main();
}
