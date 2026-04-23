#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { safeErrorMessage } from '../services/pickle-utils.js';
export class CouncilPublishError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CouncilPublishError';
    }
}
function slugify(branch) {
    return branch.replace(/\//g, '__');
}
/**
 * Scans the council-of-ricks-summary.md for `## Pass N:` headers and returns
 * a clean bullet list reflecting every pass outcome this session — so reviewers
 * see the full rotation (clean / skipped / issues), not just the final state.
 */
function extractPassOutcomes(summaryPath) {
    if (!fs.existsSync(summaryPath))
        return [];
    try {
        const content = fs.readFileSync(summaryPath, 'utf-8');
        const lines = content.split('\n');
        const passes = [];
        for (const line of lines) {
            const m = line.match(/^##\s+Pass\s+(\d+)\s*:\s*(.+?)\s*$/i);
            if (m) {
                passes.push(`- Pass ${m[1]}: ${m[2].trim()}`);
            }
        }
        return passes;
    }
    catch {
        return [];
    }
}
/**
 * Reads council-directive.md if present and returns the full text of the
 * LATEST directive. Directives are append-only; each block starts with
 * `# Council Directive` — we take the last one.
 */
function readLatestDirective(directivePath) {
    if (!fs.existsSync(directivePath))
        return '';
    try {
        const content = fs.readFileSync(directivePath, 'utf-8');
        const markers = [];
        const rx = /^# Council Directive/gm;
        let m;
        while ((m = rx.exec(content)) !== null)
            markers.push(m.index);
        if (markers.length === 0)
            return content;
        return content.slice(markers[markers.length - 1]);
    }
    catch {
        return '';
    }
}
/**
 * Extracts per-branch findings rows from the latest directive. Findings tables
 * follow `### Findings` (or `## Findings`) and have a `Branch` column. We scan
 * every markdown-table-looking line and keep rows whose `Branch` cell matches.
 */
function findingsForBranch(directive, branch) {
    if (!directive)
        return [];
    const lines = directive.split('\n');
    // Find any table with a Branch column. A table ends at a non-pipe line; when
    // a new table starts we reset the header but keep the last one we used to
    // emit rows, so we can reconstruct output even if row collection spans blocks.
    const rows = [];
    let header = null;
    let usedHeader = null;
    let branchCol = -1;
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('|')) {
            header = null;
            branchCol = -1;
            continue;
        }
        const cells = line.split('|').slice(1, -1).map(s => s.trim());
        if (!header) {
            const idx = cells.findIndex(c => c.toLowerCase() === 'branch');
            if (idx >= 0) {
                header = cells;
                usedHeader = cells;
                branchCol = idx;
            }
            continue;
        }
        // Skip separator row like |---|---|
        if (cells.every(c => /^:?-+:?$/.test(c)))
            continue;
        if (branchCol >= 0 && branchCol < cells.length && cells[branchCol] === branch) {
            rows.push(line);
        }
    }
    if (rows.length === 0 || !usedHeader)
        return [];
    const sep = '| ' + usedHeader.map(() => '---').join(' | ') + ' |';
    return ['| ' + usedHeader.join(' | ') + ' |', sep, ...rows];
}
/**
 * Extracts the "## Trap Doors" section text from the directive, filtering
 * lines that mention the branch (best-effort). Returns empty string if none.
 */
function trapDoorsForBranch(directive, branch) {
    if (!directive)
        return '';
    const lines = directive.split('\n');
    let inSection = false;
    const collected = [];
    for (const line of lines) {
        if (/^##\s+Trap Doors/i.test(line)) {
            inSection = true;
            continue;
        }
        if (inSection && /^##\s+/.test(line))
            break;
        if (inSection)
            collected.push(line);
    }
    const body = collected.join('\n').trim();
    if (!body)
        return '';
    // Filter to lines that mention the branch, keep list items without a branch ref too? Conservative: keep all.
    const kept = body
        .split('\n')
        .filter(l => l.trim().length > 0 && (l.includes(branch) || !/\bfeat\/|\bfix\/|\bchore\//.test(l)));
    return kept.join('\n').trim();
}
function composeBody(params) {
    const { sessionRoot, branch: _branch, finalPass, codexEnabled, findings, trapDoors, passOutcomes } = params;
    const sessionName = path.basename(sessionRoot);
    const codexLine = codexEnabled ? 'enabled: ran on this branch' : 'disabled: not available';
    const findingsBlock = findings.length > 0
        ? findings.join('\n')
        : 'No findings for this branch at session close.';
    const trapBlock = trapDoors.length > 0 ? trapDoors : 'None catalogued.';
    const passBlock = passOutcomes.length > 0 ? passOutcomes.join('\n') : '- (no passes recorded)';
    return [
        '## Council of Ricks — Stack Review',
        '',
        '_Posted at session end. See the [Council skill](https://github.com/gregorydickson/pickle-rick-claude) for the multi-pass review protocol._',
        '',
        `**Session:** \`${sessionName}\``,
        `**Final pass:** ${finalPass}`,
        `**Codex adversarial:** ${codexLine}`,
        '',
        '### Findings for this branch',
        '',
        findingsBlock,
        '',
        '### Trap Doors',
        '',
        trapBlock,
        '',
        '### Pass outcomes (this session)',
        '',
        passBlock,
        '',
    ].join('\n');
}
function appendPublishLog(logPath, result) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...result }) + '\n';
    fs.appendFileSync(logPath, line);
}
export default function publishCouncilStack(sessionRoot, opts = {}) {
    const ghCommand = opts.ghCommand || 'gh';
    const dryRun = !!opts.dryRun;
    if (!fs.existsSync(sessionRoot)) {
        throw new CouncilPublishError(`session_root does not exist: ${sessionRoot}`);
    }
    const stackPath = path.join(sessionRoot, 'council-stack.json');
    if (!fs.existsSync(stackPath)) {
        throw new CouncilPublishError(`not a council session: council-stack.json missing at ${stackPath}`);
    }
    let stack;
    try {
        stack = JSON.parse(fs.readFileSync(stackPath, 'utf-8'));
    }
    catch (err) {
        throw new CouncilPublishError(`failed to parse council-stack.json: ${safeErrorMessage(err)}`);
    }
    const { branches, trunk, repo_path, codex_enabled } = stack;
    if (!Array.isArray(branches) || typeof trunk !== 'string' || typeof repo_path !== 'string') {
        throw new CouncilPublishError('council-stack.json missing required fields (branches, trunk, repo_path)');
    }
    const commentsDir = path.join(sessionRoot, 'council-comments');
    fs.mkdirSync(commentsDir, { recursive: true });
    const publishedDir = path.join(sessionRoot, '.published');
    fs.mkdirSync(publishedDir, { recursive: true });
    const logPath = path.join(sessionRoot, 'publish.log');
    // gh availability check
    let ghAvailable = true;
    try {
        execFileSync(ghCommand, ['auth', 'status'], { stdio: 'pipe' });
    }
    catch {
        ghAvailable = false;
    }
    const passOutcomes = extractPassOutcomes(path.join(sessionRoot, 'council-of-ricks-summary.md'));
    const finalPass = passOutcomes.length;
    const directive = readLatestDirective(path.join(sessionRoot, 'council-directive.md'));
    const results = [];
    let posted = 0;
    let skipped = 0;
    let failed = 0;
    for (const branch of branches) {
        if (branch === trunk)
            continue;
        const slug = slugify(branch);
        const bodyPath = path.join(commentsDir, `${slug}.md`);
        const markerPath = path.join(publishedDir, slug);
        const body = composeBody({
            sessionRoot,
            branch,
            finalPass,
            codexEnabled: !!codex_enabled,
            findings: findingsForBranch(directive, branch),
            trapDoors: trapDoorsForBranch(directive, branch),
            passOutcomes,
        });
        fs.writeFileSync(bodyPath, body);
        if (!ghAvailable) {
            const r = { branch, outcome: 'skipped_no_gh', body_path: bodyPath };
            results.push(r);
            skipped++;
            appendPublishLog(logPath, r);
            continue;
        }
        if (fs.existsSync(markerPath)) {
            const r = { branch, outcome: 'skipped_already_published', body_path: bodyPath };
            results.push(r);
            skipped++;
            appendPublishLog(logPath, r);
            continue;
        }
        // Resolve PR number
        let prNumber;
        try {
            const out = execFileSync(ghCommand, ['pr', 'list', '--head', branch, '--json', 'number', '--jq', '.[0].number'], { cwd: repo_path, stdio: 'pipe', encoding: 'utf8' }).trim();
            if (!out) {
                const r = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
                results.push(r);
                skipped++;
                appendPublishLog(logPath, r);
                continue;
            }
            const n = Number(out);
            if (!Number.isFinite(n) || n <= 0) {
                const r = { branch, outcome: 'skipped_no_pr', body_path: bodyPath };
                results.push(r);
                skipped++;
                appendPublishLog(logPath, r);
                continue;
            }
            prNumber = n;
        }
        catch (err) {
            const r = {
                branch,
                outcome: 'failed',
                error: `pr list: ${safeErrorMessage(err)}`,
                body_path: bodyPath,
            };
            results.push(r);
            failed++;
            appendPublishLog(logPath, r);
            continue;
        }
        if (dryRun) {
            const r = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
            results.push(r);
            posted++;
            appendPublishLog(logPath, r);
            continue;
        }
        // Post the comment
        try {
            execFileSync(ghCommand, ['pr', 'comment', String(prNumber), '--body-file', bodyPath], { cwd: repo_path, stdio: 'pipe' });
            fs.writeFileSync(markerPath, new Date().toISOString());
            const r = { branch, outcome: 'posted', pr_number: prNumber, body_path: bodyPath };
            results.push(r);
            posted++;
            appendPublishLog(logPath, r);
        }
        catch (err) {
            const r = {
                branch,
                outcome: 'failed',
                pr_number: prNumber,
                error: `pr comment: ${safeErrorMessage(err)}`,
                body_path: bodyPath,
            };
            results.push(r);
            failed++;
            appendPublishLog(logPath, r);
        }
    }
    return { session_root: sessionRoot, results, posted, skipped, failed };
}
if (process.argv[1] && path.basename(process.argv[1]) === 'council-publish.js') {
    const sessionRoot = process.argv[2];
    if (!sessionRoot) {
        console.error('Usage: council-publish <SESSION_ROOT>');
        process.exit(1);
    }
    const dryRun = process.argv.includes('--dry-run');
    try {
        const report = publishCouncilStack(sessionRoot, { dryRun });
        console.log(JSON.stringify(report, null, 2));
    }
    catch (err) {
        console.error(`council-publish: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
