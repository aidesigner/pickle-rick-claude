/**
 * R-AFCC-DEEP-4A: Unified ticket completion-evidence module.
 *
 * Single conceptual entity for "is this ticket attributably done?".
 * Supersedes the divergent invariants that were split across
 * hasCompletionCommit (pickle-utils), the inlined guardCompletionCommitBeforeDone
 * upsert, and the collapsed phantom-done batch loop.
 *
 * R-AFCC-STAGE: non-repo workingDir is a legitimate state, NOT an exception.
 * R-AFCC-STALE: first-class 'inferred-stale' return variant for stored-but-
 *   unverifiable SHAs (e.g. completion_commit_inferred field present but
 *   gitCommitExists returns false because workingDir is non-repo or commit
 *   was dropped after a branch switch).
 */
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFrontmatterField, upsertFrontmatterField, normalizeCompletionCommitField, ticketFilePath, } from './pickle-utils.js';
// ---------------------------------------------------------------------------
// Private helpers (inlined from pickle-utils private scope)
// ---------------------------------------------------------------------------
function resolveTicketPath(ctx) {
    if (typeof ctx.ticketPath === 'string' && ctx.ticketPath.length > 0)
        return ctx.ticketPath;
    if (typeof ctx.sessionDir === 'string' && ctx.sessionDir.length > 0 &&
        typeof ctx.ticketId === 'string' && ctx.ticketId.length > 0) {
        return ticketFilePath(ctx.sessionDir, ctx.ticketId);
    }
    return null;
}
/**
 * 3-way git cat-file probe (R-AFCC-DEEP-3C pattern).
 * Returns 'exists' (exit 0), 'not-exists' (exit 1), or 'git-could-not-run'
 * (exit 128, ENOENT, ETIMEDOUT, SIGTERM — git produced no definitive answer).
 */
function probeCatFile(workingDir, sha) {
    try {
        execFileSync('git', ['-C', workingDir, 'cat-file', '-e', `${sha}^{commit}`], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return 'exists';
    }
    catch (err) {
        const e = err;
        if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' || e.status === 128 || e.code === 'ENOENT') {
            return 'git-could-not-run';
        }
        return 'not-exists';
    }
}
/** Boolean commit-reachability check; false for both "not found" and "git error". */
function commitExists(workingDir, sha) {
    return probeCatFile(workingDir, sha) === 'exists';
}
function extractRCodeTokens(title) {
    if (!title)
        return [];
    return [...new Set(Array.from(title.matchAll(/\bR-[A-Z0-9-]+\b/gi), m => m[0].toLowerCase()))];
}
function readFirstHeading(content) {
    const m = content.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim() || null;
}
/** R-CXOR-2: true when sha is a session baseline (start_commit or pinned_sha). */
function isBaselineSha(sha, ctx) {
    return (ctx.startCommit != null && sha === ctx.startCommit) ||
        (ctx.pinnedSha != null && sha === ctx.pinnedSha);
}
/**
 * Probes whether an explicit SHA is git-reachable, falling back to fallbackDir on
 * 'git-could-not-run'. Returns the EvidenceResult on success, or null when the
 * SHA is not reachable (caller maps null → absent).
 */
function probeExplicitSha(sha, workingDir, fallbackDir) {
    const primary = probeCatFile(workingDir, sha);
    if (primary === 'exists')
        return { kind: 'explicit', sha };
    if (primary !== 'git-could-not-run')
        return null;
    if (!fallbackDir || fallbackDir === workingDir)
        return null;
    if (probeCatFile(fallbackDir, sha) === 'exists')
        return { kind: 'explicit', sha, usedFallback: true };
    return null;
}
function parseGitLog(raw) {
    return raw
        .split('\n---pickle-commit-boundary---\n')
        .map(e => e.trim())
        .filter(Boolean)
        .map(e => {
        const [sha = '', epochRaw = '0', ...parts] = e.split('\n');
        return { sha: sha.trim(), epoch: Number(epochRaw.trim()) || 0, message: parts.join('\n').trim() };
    })
        .filter(e => /^[0-9a-f]{40}$/i.test(e.sha));
}
function scanGitLog(args) {
    const matchers = [
        ...(args.ticketId ? [args.ticketId.toLowerCase()] : []),
        ...extractRCodeTokens(args.title),
    ];
    const rCodeRe = (() => {
        if (!args.rCode)
            return null;
        const code = args.rCode.trim().toLowerCase();
        if (!code)
            return null;
        const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`);
    })();
    const allowAnyNewCommit = args.allowAnyNewCommit === true;
    if (matchers.length === 0 && !rCodeRe && !allowAnyNewCommit)
        return null;
    const startEpoch = Number(args.startTimeEpoch);
    const baselineSet = new Set((args.baselineShas ?? []).filter(Boolean).map(s => s.toLowerCase()));
    const checkEntry = (e) => {
        if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch)
            return null;
        const lower = e.message.toLowerCase();
        if (matchers.some(t => lower.includes(t)))
            return { sha: e.sha };
        if (rCodeRe && rCodeRe.test(lower))
            return { sha: e.sha };
        return null;
    };
    // Droid-direct-commit fallback: when the manager does work directly (no
    // spawn-morty worker to stamp completion_commit / include the ticket ID in
    // the commit message), accept the most recent commit beyond session start as
    // inferred evidence. Gated on allow_inferred_completion_commit so the
    // ticket-ID attribution contract is preserved for all other paths.
    const fallbackEntry = (e) => {
        if (!allowAnyNewCommit)
            return null;
        if (Number.isFinite(startEpoch) && startEpoch > 0 && e.epoch < startEpoch)
            return null;
        if (baselineSet.has(e.sha.toLowerCase()))
            return null;
        return { sha: e.sha };
    };
    const commands = [];
    if (args.ticketPath) {
        commands.push(['-C', args.workingDir, 'log', '-n', '20', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', '--', args.ticketPath]);
    }
    commands.push(['-C', args.workingDir, 'log', '-n', '50', '--format=%H%n%ct%n%B%n---pickle-commit-boundary---', 'HEAD']);
    for (const gitArgs of commands) {
        try {
            const raw = execFileSync('git', gitArgs, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            const entries = parseGitLog(raw);
            // First pass: ticket-ID / R-code attribution (strongest signal).
            for (const entry of entries) {
                const matched = checkEntry(entry);
                if (matched)
                    return matched;
            }
            // Second pass: droid-direct-commit fallback (any new commit beyond start).
            for (const entry of entries) {
                const matched = fallbackEntry(entry);
                if (matched)
                    return matched;
            }
        }
        catch {
            continue;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Entry point 1: readEvidence
// ---------------------------------------------------------------------------
/**
 * Reads completion evidence for a ticket and returns a 4-state EvidenceKind.
 *
 * Key differences from legacy hasCompletionCommit:
 *   - 'explicit-reachable' → 'explicit'
 *   - 'inferred' (from field or scan) → 'inferred-fresh'
 *   - NEW 'inferred-stale': completion_commit_inferred field present but
 *     gitCommitExists returned false (R-AFCC-STALE)
 *   - 'unreachable' (explicit SHA present, not git-reachable) → 'absent'
 */
export function readEvidence(ctx) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { kind: 'absent' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { kind: 'absent' };
    }
    // --- Explicit completion_commit field ---
    const explicit = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit'));
    if (explicit) {
        // R-CXOR-2: reject baseline SHAs — a ticket whose only "commit" is the session
        // start_commit or pinned_sha did no real work; treat it as absent evidence.
        if (isBaselineSha(explicit, ctx)) {
            process.stderr.write(`[ticket-completion-evidence] baseline sha ${explicit} rejected as completion evidence — ticket did no work beyond session start\n`);
            return { kind: 'absent' };
        }
        const r = probeExplicitSha(explicit, ctx.workingDir, ctx.fallbackDir);
        if (r)
            return r;
        // Explicit SHA present but not reachable → no usable evidence.
        return { kind: 'absent' };
    }
    // --- Inferred field (completion_commit_inferred) ---
    const inferredField = normalizeCompletionCommitField(readFrontmatterField(content, 'completion_commit_inferred'));
    if (inferredField) {
        if (commitExists(ctx.workingDir, inferredField)) {
            return { kind: 'inferred-fresh', sha: inferredField };
        }
        // R-AFCC-STALE: field present but git can't verify → inferred-stale rather
        // than falling through to scan (which would also fail for the same reason).
        return { kind: 'inferred-stale', sha: inferredField };
    }
    // --- Git log scan ---
    const allowAnyNewCommit = (ctx.flags ?? {})['allow_inferred_completion_commit'] === true;
    const baselineShas = [
        ...(ctx.startCommit ? [ctx.startCommit] : []),
        ...(ctx.pinnedSha ? [ctx.pinnedSha] : []),
    ];
    const scan = scanGitLog({
        workingDir: ctx.workingDir,
        ticketId: readFrontmatterField(content, 'id') ?? ctx.ticketId ?? null,
        title: readFrontmatterField(content, 'title') ?? readFirstHeading(content),
        startTimeEpoch: ctx.startTimeEpoch,
        ticketPath: tPath,
        rCode: readFrontmatterField(content, 'r_code'),
        allowAnyNewCommit,
        baselineShas,
    });
    if (scan)
        return { kind: 'inferred-fresh', sha: scan.sha };
    return { kind: 'absent' };
}
// ---------------------------------------------------------------------------
// Entry point 2: persistEvidence
// ---------------------------------------------------------------------------
/**
 * Writes sha into the ticket's completion_commit frontmatter field and
 * optionally git-stages the file.
 *
 * R-AFCC-STAGE: stage:'best-effort' means git-staging failure is non-fatal.
 * A non-repo workingDir is a legitimate state and MUST NOT throw.
 */
export function persistEvidence(ctx, sha, opts) {
    const tPath = resolveTicketPath(ctx);
    if (!tPath)
        return { action: 'no_file' };
    let content;
    try {
        content = fs.readFileSync(tPath, 'utf8');
    }
    catch {
        return { action: 'no_file' };
    }
    if (readFrontmatterField(content, 'completion_commit')) {
        return { action: 'already_present', sha: readFrontmatterField(content, 'completion_commit') ?? sha };
    }
    const updated = upsertFrontmatterField(content, 'completion_commit', sha);
    if (!updated)
        return { action: 'unwritable' };
    try {
        fs.writeFileSync(tPath, updated);
    }
    catch {
        return { action: 'unwritable' };
    }
    // Git-stage
    let staged = false;
    try {
        execFileSync('git', ['-C', ctx.workingDir, 'add', '--', tPath], {
            timeout: 5000,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        staged = true;
    }
    catch {
        if (opts.stage === 'required')
            throw new Error(`persistEvidence: git add failed for ${tPath}`);
        // best-effort: staged stays false
    }
    return { action: 'written', sha, staged };
}
// ---------------------------------------------------------------------------
// Entry point 3: gateForPhantomDoneRevert
// ---------------------------------------------------------------------------
/**
 * Decides whether a Done ticket should be reverted (phantom-Done watcher) or
 * kept, and if kept, whether its inferred SHA should be persisted.
 *
 * R-AFCC-STAGE: inferred-stale → action:'keep' (non-repo workingDir is
 * legitimate; a stored SHA exists even if currently unverifiable).
 *
 * Callers do all file writes based on the returned action — this function
 * only reads evidence and returns a decision.
 */
export function gateForPhantomDoneRevert(ctx, policy) {
    const evidence = readEvidence(ctx);
    const allowFlag = (policy?.flags ?? {})['allow_inferred_completion_commit'] === true;
    switch (evidence.kind) {
        case 'explicit':
            return { action: 'keep', kind: 'explicit', sha: evidence.sha, fallbackFired: evidence.usedFallback };
        case 'inferred-fresh':
            return { action: 'persist-inferred', kind: 'inferred-fresh', sha: evidence.sha };
        case 'inferred-stale':
            // R-AFCC-STAGE: non-repo workingDir is legitimate; keep Done rather than
            // reverting a ticket that has a stored (but currently unverifiable) SHA.
            return { action: 'keep', kind: 'inferred-stale', sha: evidence.sha };
        case 'absent':
            if (allowFlag)
                return { action: 'keep', kind: 'absent' };
            return { action: 'revert', kind: 'absent' };
    }
}
