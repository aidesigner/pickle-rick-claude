#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { getExtensionRoot } from '../services/pickle-utils.js';
const CACHE_FILE = 'update-check.json';
const SETTINGS_FILE = 'pickle_settings.json';
const DEBUG_LOG = 'debug.log';
function log(message) {
    try {
        const extensionRoot = getExtensionRoot();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(path.join(extensionRoot, DEBUG_LOG), `[${timestamp}] [check-update] ${message}\n`);
    }
    catch {
        /* fail-open */
    }
}
export function parseVersion(tag) {
    if (!tag)
        return null;
    const stripped = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!/^\d+\.\d+\.\d+$/.test(stripped))
        return null;
    return stripped;
}
export function compareSemver(a, b) {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] < partsB[i])
            return -1;
        if (partsA[i] > partsB[i])
            return 1;
    }
    return 0;
}
function defaultCache() {
    return { last_check_epoch: 0, latest_version: '', current_version: '' };
}
export function readCache() {
    try {
        const filePath = path.join(getExtensionRoot(), CACHE_FILE);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
            last_check_epoch: typeof raw.last_check_epoch === 'number' ? raw.last_check_epoch : 0,
            latest_version: typeof raw.latest_version === 'string' ? raw.latest_version : '',
            current_version: typeof raw.current_version === 'string' ? raw.current_version : '',
        };
    }
    catch {
        log('Cache missing or corrupted, using defaults');
        return defaultCache();
    }
}
export function writeCache(cache) {
    try {
        const filePath = path.join(getExtensionRoot(), CACHE_FILE);
        fs.writeFileSync(filePath, JSON.stringify(cache, null, 2) + '\n');
        log(`Cache written: ${cache.latest_version}`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Failed to write cache: ${msg}`);
    }
}
export function readSettings() {
    const defaults = {
        auto_update_enabled: true,
        update_check_interval_hours: 24,
    };
    try {
        const filePath = path.join(getExtensionRoot(), SETTINGS_FILE);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (typeof raw.auto_update_enabled === 'boolean') {
            defaults.auto_update_enabled = raw.auto_update_enabled;
        }
        if (typeof raw.update_check_interval_hours === 'number' && raw.update_check_interval_hours > 0) {
            defaults.update_check_interval_hours = raw.update_check_interval_hours;
        }
        return defaults;
    }
    catch {
        log('Settings missing or corrupted, using defaults');
        return defaults;
    }
}
export function isCacheStale(cache, intervalHours) {
    if (cache.last_check_epoch === 0)
        return true;
    const nowEpoch = Math.floor(Date.now() / 1000);
    const intervalSeconds = intervalHours * 3600;
    return (nowEpoch - cache.last_check_epoch) >= intervalSeconds;
}
export function getLatestRelease() {
    try {
        const result = spawnSync('gh', [
            'api', 'repos/gregorydickson/pickle-rick-claude/releases/latest',
            '--jq', '{tag_name: .tag_name, assets: [.assets[] | {name: .name, url: .browser_download_url}]}',
        ], { encoding: 'utf-8', timeout: 15_000 });
        if (result.status !== 0) {
            log(`gh api failed: ${(result.stderr || '').trim()}`);
            return null;
        }
        const parsed = JSON.parse(result.stdout);
        return {
            tagName: parsed.tag_name,
            assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`getLatestRelease error: ${msg}`);
        return null;
    }
}
function getCurrentVersion() {
    try {
        const pkgPath = path.join(getExtensionRoot(), 'extension', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    }
    catch {
        log('Could not read package.json version');
        return '0.0.0';
    }
}
export function checkForUpdate(options) {
    const currentVersion = getCurrentVersion();
    const errorResult = { status: 'error', currentVersion };
    try {
        const settings = readSettings();
        if (!settings.auto_update_enabled && !options?.force) {
            log('Auto-update disabled in settings');
            return { status: 'up-to-date', currentVersion };
        }
        const cache = readCache();
        if (!options?.force && !isCacheStale(cache, settings.update_check_interval_hours)) {
            log('Cache is fresh, using cached result');
            if (cache.latest_version && compareSemver(currentVersion, cache.latest_version) < 0) {
                return { status: 'update-available', currentVersion, latestVersion: cache.latest_version };
            }
            return { status: 'up-to-date', currentVersion };
        }
        log('Cache stale or forced, fetching latest release');
        const release = getLatestRelease();
        if (!release) {
            return { ...errorResult, error: 'Failed to fetch latest release' };
        }
        const latestVersion = parseVersion(release.tagName);
        if (!latestVersion) {
            return { ...errorResult, error: `Invalid release tag: ${release.tagName}` };
        }
        writeCache({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: latestVersion,
            current_version: currentVersion,
        });
        if (compareSemver(currentVersion, latestVersion) < 0) {
            log(`Update available: ${currentVersion} → ${latestVersion}`);
            return { status: 'update-available', currentVersion, latestVersion };
        }
        log(`Up to date: ${currentVersion}`);
        return { status: 'up-to-date', currentVersion, latestVersion };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`checkForUpdate error: ${msg}`);
        return { ...errorResult, error: msg };
    }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'check-update.js') {
    const result = checkForUpdate({ force: process.argv.includes('--force') });
    console.log(JSON.stringify(result, null, 2));
}
