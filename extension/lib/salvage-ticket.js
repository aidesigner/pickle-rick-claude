// W3 / B-GROUND: the single salvage-before-fail primitive. Every fail / cancel /
// timeout / exit seam — current and future — routes through `salvageTicket()`
// before any Failed-flip / resetToSha / clean-tree relaunch, so the N+1th seam
// cannot bypass the hand-wired fix.
//
// Dispositions (the SalvageOutcome contract):
//   - HEAD regressed off a committed ticket -> auto-ff-reattach the orphan.
//   - clean tree                            -> no-op.
//   - dirty + gate-PASSING                  -> commit (SCOPED ticket paths only,
//                                              never `add -A` / `add .`) + Done.
//   - dirty + gate-FAILING / gate-ERRORED   -> archive the diff, then reset Todo
//                                              (NEVER `reset --hard` over
//                                              uncommitted work — archive first).
//
// Best-effort by construction: any throw -> { disposition: 'error' }. Completion
// is keyed on process-exit + tree-truth (reconcileTicketTruth), not a log token.
import { archiveBeforeDestructive, updateTicketFrontmatter, } from '../services/git-utils.js';
import { reconcileTicketTruth, } from './reconcile-ticket-truth.js';
const defaultDeps = {
    reconcile: (input) => reconcileTicketTruth(input),
    // Without a wired gate the conservative default is `failing` so dirty work is
    // archived (never silently committed). Production always supplies a real gate.
    gate: () => 'failing',
    commitScoped: () => ({ committed: false }),
    archive: (input) => {
        try {
            return archiveBeforeDestructive({
                cwd: input.workingDir,
                sessionDir: input.sessionDir,
                ticketDir: `${input.sessionDir}/${input.ticketId}`,
                reason: 'pre_reset',
            });
        }
        catch {
            return null;
        }
    },
    resetTodo: (input) => {
        updateTicketFrontmatter(input.ticketId, input.sessionDir, { status: 'Todo', completion_commit: null });
    },
    // HEAD-regression auto-ff is owned by mux-runner's detectAndRecoverHeadRegression
    // (already wired at resume + cancel-teardown). The default is inert; production
    // and the matrix test supply the real reattach adapter.
    ffReattach: () => ({ recovered: false }),
};
function isTerminalStatus(status) {
    const s = (status ?? '').toLowerCase().replace(/["']/g, '').trim();
    return s === 'done' || s === 'skipped';
}
/**
 * Salvage one ticket before any fail/cancel/relaunch. Ground-truth-driven,
 * disposition-returning, best-effort.
 */
export function salvageTicket(input, deps = defaultDeps) {
    const log = input.log ?? (() => { });
    try {
        // 1. HEAD regressed off a committed ticket -> auto-ff-reattach the orphan.
        const reattach = deps.ffReattach(input);
        if (reattach.recovered) {
            log(`[salvage] ${input.ticketId}: orphan reattached (ff-only) -> ${reattach.sha ?? 'tip'}`);
            return { disposition: 'ff-reattached', sha: reattach.sha ?? undefined, reason: 'head_regression_reattached' };
        }
        const truth = deps.reconcile({ sessionDir: input.sessionDir, workingDir: input.workingDir });
        // 2. clean tree -> nothing to salvage.
        if (!truth.dirty) {
            return { disposition: 'no-op', reason: 'clean_tree' };
        }
        // A ticket already Done/Skipped is owned by the model-driven path; don't re-salvage.
        if (isTerminalStatus(truth.ticketStatuses[input.ticketId])) {
            return { disposition: 'no-op', reason: 'already_terminal' };
        }
        // 3. dirty + gate verdict.
        const verdict = deps.gate(input);
        if (verdict === 'passing') {
            const r = deps.commitScoped(input);
            if (r.committed && r.sha) {
                log(`[salvage] ${input.ticketId}: gate-passing -> committed scoped deliverable (${r.sha}) + Done`);
                return { disposition: 'committed-done', sha: r.sha, reason: 'gate_passing_committed' };
            }
            // Commit failed -> fall through to archive so the diff is never stranded.
        }
        // 4. dirty + gate-failing / gate-errored / commit-failed -> archive THEN reset Todo.
        const archived = deps.archive(input);
        deps.resetTodo(input);
        log(`[salvage] ${input.ticketId}: ${verdict} -> archived diff + reset Todo`);
        return {
            disposition: 'archived-todo',
            archived: archived !== null,
            reason: verdict === 'errored' ? 'gate_errored_archived' : 'gate_failing_archived',
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[salvage] ${input.ticketId}: threw (best-effort, no destructive action taken): ${msg}`);
        return { disposition: 'error', reason: `salvage_error: ${msg}` };
    }
}
