#!/usr/bin/env node
import * as path from 'path';
import * as os from 'os';
import { scanSessionFiles, scanGitRepos, buildReport, formatNumber, shortenSlug, scanSkipFlagEvents, buildSkipFlagBudgetReport, SKIP_FLAG_BUDGETS, } from '../services/metrics-utils.js';
import { printMinimalPanel, Style, formatLocalDateKey, getDataRoot, } from '../services/pickle-utils.js';
import { getActivityDir } from '../services/activity-logger.js';
import { BACKENDS } from '../types/index.js';
function parseExactLocalDate(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
        return null;
    const [yearRaw, monthRaw, dayRaw] = dateStr.split('-');
    const year = Number(yearRaw);
    const monthIndex = Number(monthRaw) - 1;
    const day = Number(dayRaw);
    if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day))
        return null;
    const parsed = new Date(year, monthIndex, day);
    if (parsed.getFullYear() !== year ||
        parsed.getMonth() !== monthIndex ||
        parsed.getDate() !== day) {
        return null;
    }
    parsed.setHours(0, 0, 0, 0);
    return parsed;
}
function consumeArg(argv, i, flag, hint) {
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
        console.error(`Error: ${flag} requires ${hint}.`);
        process.exit(1);
    }
    return val;
}
export function parseMetricsArgs(argv) {
    let days = null;
    let since = null;
    let weekly = false;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--days') {
            const val = consumeArg(argv, i, '--days', 'a numeric value');
            i++;
            days = Number(val);
            if (!Number.isFinite(days) || days < 0 || Math.floor(days) !== days) {
                console.error(`Error: --days must be a non-negative integer, got "${val}".`);
                process.exit(1);
            }
        }
        else if (arg === '--since') {
            since = consumeArg(argv, i, '--since', 'a YYYY-MM-DD date');
            i++;
        }
        else if (arg === '--weekly') {
            weekly = true;
        }
        else if (arg === '--json') {
            json = true;
        }
        else {
            console.error(`Error: unknown flag "${arg}".`);
            process.exit(1);
        }
    }
    // --weekly alone defaults to 28 days
    if (weekly && days === null && since === null) {
        days = 28;
    }
    return { days: days ?? 7, since, weekly, json };
}
// ---------------------------------------------------------------------------
// Date Computation
// ---------------------------------------------------------------------------
function toDateStr(d) {
    return formatLocalDateKey(d);
}
function computeDateRange(args) {
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const until = toDateStr(todayMidnight);
    if (args.since !== null) {
        const parsed = parseExactLocalDate(args.since);
        if (parsed === null) {
            console.error(`Error: invalid date "${args.since}". Use YYYY-MM-DD format.`);
            process.exit(1);
        }
        if (parsed > todayMidnight) {
            console.error(`Error: --since date "${args.since}" is in the future.`);
            process.exit(1);
        }
        return { since: toDateStr(parsed), until };
    }
    const sinceDate = new Date(todayMidnight);
    if (args.days === 0) {
        return { since: toDateStr(todayMidnight), until };
    }
    sinceDate.setDate(sinceDate.getDate() - args.days);
    return { since: toDateStr(sinceDate), until };
}
function printTable(columns) {
    const widths = columns.map((col) => {
        const maxVal = Math.max(...col.values.map((v) => v.length), 0);
        return Math.max(col.header.length, maxVal);
    });
    const d = Style.DIM;
    const r = Style.RESET;
    const b = Style.BOLD;
    // Header
    const headerCells = columns.map((col, i) => col.align === 'right' ? col.header.padStart(widths[i]) : col.header.padEnd(widths[i]));
    process.stdout.write(`  ${b}${headerCells.join('   ')}${r}\n`);
    // Separator
    const sep = widths.map((w) => '─'.repeat(w)).join('───');
    process.stdout.write(`  ${d}${sep}${r}\n`);
    // Rows
    const rowCount = columns[0]?.values.length ?? 0;
    for (let row = 0; row < rowCount; row++) {
        const cells = columns.map((col, i) => {
            const val = col.values[row] ?? '';
            return col.align === 'right' ? val.padStart(widths[i]) : val.padEnd(widths[i]);
        });
        process.stdout.write(`  ${cells.join('   ')}\n`);
    }
}
function emptyBackendOutputs() {
    return Object.fromEntries(BACKENDS.map((backend) => [backend, 0]));
}
function aggregateRowBackendOutputs(row) {
    const outputs = emptyBackendOutputs();
    for (const tokens of Object.values(row.projects)) {
        for (const backend of BACKENDS) {
            outputs[backend] += tokens.tokens_per_backend?.[backend]?.output ?? 0;
        }
    }
    return outputs;
}
function backendColumnLabel(backend) {
    return backend.charAt(0).toUpperCase() + backend.slice(1);
}
/**
 * One output column per backend that has non-zero output across the window.
 * Driven by BACKENDS so a new backend is never silently dropped from the
 * per-backend breakdown; backends with no activity are omitted to keep the
 * table readable.
 */
function buildBackendColumns(perEntryOutputs) {
    return BACKENDS.filter((backend) => perEntryOutputs.some((outputs) => outputs[backend] > 0)).map((backend) => ({
        header: backendColumnLabel(backend),
        align: 'right',
        values: perEntryOutputs.map((outputs) => formatNumber(outputs[backend])),
    }));
}
function printDailyTable(report) {
    printMinimalPanel(`Metrics — ${report.since} to ${report.until}`, {
        Projects: String(report.projects.length),
        Turns: formatNumber(report.totals.turns),
        'Output Tokens': formatNumber(report.totals.output),
        Commits: formatNumber(report.totals.commits),
        'Lines (+/-)': `+${formatNumber(report.totals.added)} / -${formatNumber(report.totals.removed)}`,
    }, 'CYAN', '📊');
    if (report.rows.length === 0)
        return;
    const rowBackendOutputs = report.rows.map(aggregateRowBackendOutputs);
    const dates = [];
    const turns = [];
    const input = [];
    const output = [];
    const added = [];
    const removed = [];
    const net = [];
    for (const row of report.rows) {
        dates.push(row.date);
        const rowTotals = aggregateRow(row);
        turns.push(formatNumber(rowTotals.turns));
        input.push(formatNumber(rowTotals.input));
        output.push(formatNumber(rowTotals.output));
        added.push('+' + formatNumber(rowTotals.added));
        removed.push('-' + formatNumber(rowTotals.removed));
        net.push(formatNumber(rowTotals.added - rowTotals.removed));
    }
    printTable([
        { header: 'Date', align: 'left', values: dates },
        { header: 'Turns', align: 'right', values: turns },
        { header: 'Input', align: 'right', values: input },
        { header: 'Output', align: 'right', values: output },
        ...buildBackendColumns(rowBackendOutputs),
        { header: '+Lines', align: 'right', values: added },
        { header: '-Lines', align: 'right', values: removed },
        { header: 'Net', align: 'right', values: net },
    ]);
    process.stdout.write('\n');
}
function aggregateRow(row) {
    const t = { turns: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, commits: 0, added: 0, removed: 0 };
    for (const tokens of Object.values(row.projects)) {
        t.turns += tokens.turns;
        t.input += tokens.input;
        t.output += tokens.output;
        t.cache_read += tokens.cache_read;
        t.cache_create += tokens.cache_create;
    }
    for (const loc of Object.values(row.loc)) {
        t.commits += loc.commits;
        t.added += loc.added;
        t.removed += loc.removed;
    }
    return t;
}
function getISOWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day; // Monday = 1
    const monday = new Date(d);
    monday.setDate(d.getDate() + diff);
    return monday;
}
function formatWeekLabel(monday) {
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mDay = monday.getDate();
    const sDay = sunday.getDate();
    const mMonth = months[monday.getMonth()];
    const sMonth = months[sunday.getMonth()];
    if (mMonth === sMonth) {
        return `${mMonth} ${mDay}-${sDay}`;
    }
    return `${mMonth} ${mDay}-${sMonth} ${sDay}`;
}
function buildWeekBuckets(report) {
    const buckets = new Map();
    for (const row of report.rows) {
        const monday = getISOWeekMonday(row.date);
        const key = toDateStr(monday);
        if (!buckets.has(key)) {
            buckets.set(key, {
                label: formatWeekLabel(monday),
                turns: 0,
                output: 0,
                backendOutput: emptyBackendOutputs(),
                added: 0,
                removed: 0,
                projectOutput: new Map(),
            });
        }
        const bucket = buckets.get(key);
        const rowTotals = aggregateRow(row);
        const backendOutputs = aggregateRowBackendOutputs(row);
        bucket.turns += rowTotals.turns;
        bucket.output += rowTotals.output;
        for (const backend of BACKENDS) {
            bucket.backendOutput[backend] += backendOutputs[backend];
        }
        bucket.added += rowTotals.added;
        bucket.removed += rowTotals.removed;
        for (const [slug, tokens] of Object.entries(row.projects)) {
            bucket.projectOutput.set(slug, (bucket.projectOutput.get(slug) ?? 0) + tokens.output);
        }
    }
    return [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, bucket]) => bucket);
}
function topProjectForWeek(week) {
    let maxSlug = '';
    let maxOut = 0;
    for (const [slug, out] of week.projectOutput) {
        if (out > maxOut) {
            maxSlug = slug;
            maxOut = out;
        }
    }
    return maxSlug ? shortenSlug(maxSlug) : '—';
}
function formatWeeklyDelta(weeks, i) {
    if (i === 0)
        return '—';
    const diff = weeks[i].output - weeks[i - 1].output;
    const sign = diff >= 0 ? '+' : '';
    return sign + formatNumber(diff);
}
function buildWeeklyColumns(weeks) {
    const cols = {
        labels: [], turns: [], output: [], added: [], removed: [], delta: [], topProject: [],
    };
    for (let i = 0; i < weeks.length; i++) {
        const w = weeks[i];
        cols.labels.push(w.label);
        cols.turns.push(formatNumber(w.turns));
        cols.output.push(formatNumber(w.output));
        cols.added.push('+' + formatNumber(w.added));
        cols.removed.push('-' + formatNumber(w.removed));
        cols.delta.push(formatWeeklyDelta(weeks, i));
        cols.topProject.push(topProjectForWeek(w));
    }
    return cols;
}
function printWeeklyTable(report) {
    printMinimalPanel(`Metrics (Weekly) — ${report.since} to ${report.until}`, {
        Weeks: String(new Set(report.rows.map((r) => toDateStr(getISOWeekMonday(r.date)))).size),
        Turns: formatNumber(report.totals.turns),
        'Output Tokens': formatNumber(report.totals.output),
        Commits: formatNumber(report.totals.commits),
    }, 'CYAN', '📊');
    const weeks = buildWeekBuckets(report);
    if (weeks.length === 0)
        return;
    const cols = buildWeeklyColumns(weeks);
    printTable([
        { header: 'Week', align: 'left', values: cols.labels },
        { header: 'Turns', align: 'right', values: cols.turns },
        { header: 'Output', align: 'right', values: cols.output },
        ...buildBackendColumns(weeks.map((w) => w.backendOutput)),
        { header: '+Lines', align: 'right', values: cols.added },
        { header: '-Lines', align: 'right', values: cols.removed },
        { header: 'Δ Output', align: 'right', values: cols.delta },
        { header: 'Top Project', align: 'left', values: cols.topProject },
    ]);
    process.stdout.write('\n');
}
// ---------------------------------------------------------------------------
// Skip-flag Budget Table (W5c)
// ---------------------------------------------------------------------------
function printSkipFlagBudgetTable(budget) {
    const overCount = budget.entries.filter((e) => e.over_budget).length;
    printMinimalPanel('Skip-flag budgets', {
        'Skip-flag uses': formatNumber(budget.total_uses),
        Gates: String(budget.entries.length),
        'Over budget': String(overCount),
    }, overCount > 0 ? 'YELLOW' : 'CYAN', '🛑');
    if (budget.entries.length === 0) {
        process.stdout.write('  No skip-flag uses in window.\n\n');
        return;
    }
    printTable([
        { header: 'Source', align: 'left', values: budget.entries.map((e) => e.source) },
        { header: 'Reason', align: 'left', values: budget.entries.map((e) => e.reason) },
        { header: 'Uses', align: 'right', values: budget.entries.map((e) => formatNumber(e.uses)) },
        { header: 'Budget', align: 'right', values: budget.entries.map((e) => formatNumber(e.budget)) },
        {
            header: 'Status',
            align: 'left',
            values: budget.entries.map((e) => (e.over_budget ? 'OVER — removal candidate' : 'ok')),
        },
    ]);
    process.stdout.write('\n');
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    const args = parseMetricsArgs(process.argv.slice(2));
    const { since, until } = computeDateRange(args);
    const projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
    const repoRoot = process.env.METRICS_REPO_ROOT || path.join(os.homedir(), 'loanlight');
    const cachePath = path.join(getDataRoot(), 'metrics-cache.json');
    const tokens = scanSessionFiles(projectsDir, since, until, cachePath);
    const loc = scanGitRepos(repoRoot, since, until);
    const grouping = args.weekly ? 'weekly' : 'daily';
    const report = buildReport(tokens, loc, since, until, grouping);
    const skipFlagEvents = scanSkipFlagEvents(getActivityDir(), since, until);
    const skipFlagBudget = buildSkipFlagBudgetReport(skipFlagEvents, SKIP_FLAG_BUDGETS, since, until);
    if (args.json) {
        console.log(JSON.stringify({ ...report, skip_flag_budget: skipFlagBudget }, null, 2));
        return;
    }
    if (report.rows.length === 0 && skipFlagBudget.total_uses === 0) {
        console.log(`No metrics data found for ${since} to ${until}.`);
        return;
    }
    if (report.rows.length > 0) {
        if (args.weekly) {
            printWeeklyTable(report);
        }
        else {
            printDailyTable(report);
        }
    }
    printSkipFlagBudgetTable(skipFlagBudget);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'metrics.js') {
    main();
}
