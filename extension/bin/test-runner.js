#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const VALID_TIERS = new Set(['fast', 'integration', 'expensive', 'contract']);
const QUARANTINED_TIER_EXCLUSIONS = new Set(['fast', 'integration']);
function exitWithError(message, code) {
    process.stderr.write(`${message}\n`);
    process.exit(code);
}
function parseArgs(args) {
    const runnerArgs = [];
    const testFiles = [];
    let dryRun = false;
    let grepPattern = null;
    let tier = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--grep') {
            const pattern = args[index + 1];
            if (!pattern)
                exitWithError('Missing value for --grep', 1);
            grepPattern = pattern;
            runnerArgs.push('--test-name-pattern', pattern);
            index += 1;
            continue;
        }
        if (arg === '--tier') {
            const tierName = args[index + 1];
            if (!tierName)
                exitWithError('Missing value for --tier', 2);
            if (!VALID_TIERS.has(tierName))
                exitWithError(`Unknown tier: ${tierName}`, 2);
            tier = tierName;
            index += 1;
            continue;
        }
        if (arg === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (arg.startsWith('--'))
            runnerArgs.push(arg);
        else
            testFiles.push(arg);
    }
    if (tier && testFiles.length > 0) {
        exitWithError('--tier cannot be combined with positional test files', 2);
    }
    return { dryRun, grepPattern, runnerArgs, testFiles, tier };
}
function normalizeTestPath(filePath) {
    return filePath.split(path.sep).join('/');
}
function discoverTestFiles(dir, rootDir) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory())
            return discoverTestFiles(fullPath, rootDir);
        if (!entry.isFile() || !entry.name.endsWith('.test.js'))
            return [];
        return [normalizeTestPath(path.relative(rootDir, fullPath))];
    })
        .sort();
}
function firstMeaningfulLine(filePath) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith('#!'))
            continue;
        if (line.trim() === '')
            continue;
        return line.trim();
    }
    return '';
}
function tierForTestFile(filePath) {
    const match = firstMeaningfulLine(filePath).match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
    return match?.[1] ?? null;
}
function normalizeQuarantineEntry(rawEntry) {
    const withoutDotSlash = rawEntry.replace(/^\.\//, '');
    if (withoutDotSlash.startsWith('tests/'))
        return withoutDotSlash;
    return `tests/${withoutDotSlash}`;
}
function readQuarantineSet(rootDir) {
    const manifestPath = path.join(rootDir, 'tests', 'QUARANTINE.md');
    if (!existsSync(manifestPath))
        return new Set();
    const entries = new Set();
    const manifest = readFileSync(manifestPath, 'utf8');
    const entryPattern = /((?:\.\/)?(?:tests\/)?[A-Za-z0-9._/@+-]+\.test\.js)/g;
    for (const line of manifest.split(/\r?\n/)) {
        let match;
        while ((match = entryPattern.exec(line)) !== null) {
            entries.add(normalizeQuarantineEntry(match[1].trim()));
        }
    }
    return entries;
}
function discoverTierFiles(rootDir, tier) {
    const testsDir = path.join(rootDir, 'tests');
    const quarantineSet = QUARANTINED_TIER_EXCLUSIONS.has(tier)
        ? readQuarantineSet(rootDir)
        : new Set();
    return discoverTestFiles(testsDir, rootDir).filter((relativePath) => {
        if (quarantineSet.has(relativePath))
            return false;
        return tierForTestFile(path.join(rootDir, relativePath)) === tier;
    });
}
function main() {
    const { dryRun, grepPattern, runnerArgs, testFiles, tier } = parseArgs(process.argv.slice(2));
    const rootDir = process.cwd();
    if (tier === 'expensive' && process.env.RUN_EXPENSIVE_TESTS !== '1') {
        process.stderr.write('[skipped: RUN_EXPENSIVE_TESTS unset]\n');
        process.exit(0);
    }
    const selectedFiles = tier
        ? discoverTierFiles(rootDir, tier)
        : grepPattern
            ? testFiles.filter((file) => readFileSync(file, 'utf8').includes(grepPattern))
            : testFiles;
    if (grepPattern && !tier && selectedFiles.length === 0) {
        exitWithError(`No tests matched --grep ${grepPattern}`, 1);
    }
    if (tier && selectedFiles.length === 0) {
        process.stderr.write(`[no files for tier ${tier}]\n`);
        process.exit(0);
    }
    if (dryRun) {
        if (selectedFiles.length > 0)
            process.stdout.write(`${selectedFiles.join('\n')}\n`);
        process.exit(0);
    }
    const nodeArgs = ['--test', ...runnerArgs, ...selectedFiles];
    const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' });
    if (result.error) {
        exitWithError(result.error.message, 1);
    }
    process.exit(result.status ?? 1);
}
main();
