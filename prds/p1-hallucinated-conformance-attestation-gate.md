# P1 — R-HCAG · Hallucinated Conformance Attestation Gate

**Status**: Filed 2026-05-18 AM (CDT) — successor to Finding #2 (codex Done-without-commit) class.
**Trigger**: B-SJET ticket `f00097e8` (session `2026-05-17-6ff53ea2` iter 7) marked Done with PASS conformance citing `readJudgeBackendSettings()` at `extension/src/services/backend-spawn.ts:511-585`, `JudgeBackend` types at `extension/src/types/index.ts:146-149`, and shipped defaults at `pickle_settings.json:30-37` — **none of those symbols/lines exist at HEAD**, zero commits attributed to the ticket. Finding #47 R-SJET stayed OPEN despite the bundle reporting ALL_PASS. The worker either hallucinated entirely, did the work in an uncommitted worktree, or fabricated the line numbers.

**Root cause**: The mux-runner between-ticket gate trusts the worker's `conformance_YYYY-MM-DD.md` self-attestation. There is no mechanical check that the citations in the conformance file correspond to symbols that actually exist in the diff between `state.start_commit` (or the previous ticket's `completion_commit`) and HEAD. PASS prose is sufficient to flip ticket status to Done.

**Class history**: Finding #2 (R-CCPL successor) closed the codex-specific Done-without-commit incident in 2026-05-15. The 2/3 occurrence on B-CCPM-1b (2026-05-17 PM) and 1/3 occurrence on B-SJET (2026-05-17 PM, the **highest-stakes ticket**) demonstrates the prose-only safeguard is insufficient. The B-CCPM-1b wrap-up noted "B-DWC followup may be warranted" — this PRD is that followup.

## Reproducer

1. Start a session targeting any P1 bundle.
2. Worker writes a minimally-plausible `conformance_2026-05-XX.md` with `## Verdict\nALL_PASS` and prose citations to symbols that don't exist.
3. Worker exits without `git commit`.
4. Manager treats `## Verdict ALL_PASS` as sufficient evidence; mux-runner flips ticket status to Done; epic completes.
5. PRD reproducer still fails at HEAD; bookkeeping reports ✅ SHIPPED.

## Goal

Mechanical gate between worker exit and ticket-Done that proves the conformance citations correspond to actual diff content. Worker self-attestation alone never closes a ticket. Closure requires (a) a non-null `completion_commit` on the ticket frontmatter AND (b) every cited file/symbol resolving against the diff window.

## Proposed fix (R-HCAG-1..6)

### R-HCAG-1 — Conformance citation parser (`extension/src/services/conformance-citations.ts`)

New service. `parseConformanceCitations(text: string): { filePath: string; lineHint?: number; symbols: string[] }[]`. Extracts:

- Backticked file paths matching `extension/<...>` or `src/<...>` or top-level repo paths.
- Optional `:<line>` or `:<line>-<line>` ranges.
- Symbol names from surrounding prose ("`<symbol>`" backticked tokens within the same sentence/cell).

Cap citation count per file to avoid pathological inputs. Treat absent citations as a hard failure (PASS verdict without citations is invalid).

ENFORCE: `extension/tests/services/conformance-citations.test.js` with fixtures including the f00097e8 conformance text.

### R-HCAG-2 — Citation/diff verifier (`extension/src/services/citation-diff-verifier.ts`)

`verifyCitationsAgainstDiff({ sessionDir, ticketId, citations, baseRef, headRef }): { ok: boolean; missing: Citation[]; reason: string }`.

For each citation:
1. `git diff --name-only <baseRef>..<headRef>` MUST include the cited file.
2. `git show <headRef>:<file>` MUST exist (file present at HEAD).
3. For each symbol: `git show <headRef>:<file>` content MUST grep-match the symbol (case-sensitive, word-boundary).
4. If `lineHint` provided: `git show <headRef>:<file>` MUST have ≥`lineHint` lines.

`baseRef` resolution precedence: previous ticket's `completion_commit` → `state.start_commit` → `HEAD~10` fallback. `headRef` is `HEAD` at gate time.

ENFORCE: `extension/tests/services/citation-diff-verifier.test.js`.

### R-HCAG-3 — mux-runner between-ticket gate integration (`extension/src/bin/mux-runner.ts`)

After worker exits but BEFORE flipping `ticket.status = "Done"`:
1. Read `conformance_*.md` from ticket dir.
2. Call `parseConformanceCitations` + `verifyCitationsAgainstDiff`.
3. On failure:
   - Emit `conformance_citation_drift` activity event with `gate_payload: { ticket_id, missing_files, missing_symbols, base_ref, head_ref }`.
   - Halt mux-runner with `recordExitReason('conformance_citation_drift') + safeDeactivate`.
   - Print operator-readable stderr line: `[fatal] ticket <id> conformance cited <N> file(s)/symbol(s) absent from diff <baseRef>..HEAD: <list> — see <session_dir>/<id>/conformance_*.md`.
4. On success: proceed to existing Done-transition path.

`state.flags.skip_conformance_citation_audit_reason='<reason>'` (non-empty trimmed string) bypasses, emits `conformance_citation_audit_bypassed` exactly once per session via closure flag.

Both events registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts` + deployed mirror).
`conformance_citation_drift` registered in `ExitReason` + `isFailureExit` so auto-resume.sh stops per R-CNAR-4(c).

ENFORCE: `extension/tests/mux-runner-conformance-citation-gate.test.js` (citation-present-and-valid → Done; citation-missing-file → halt; citation-present-but-symbol-absent → halt; bypass-flag → skip-with-event).

### R-HCAG-4 — Completion-commit enforcement (`extension/src/services/git-utils.ts`)

`ticket.status = "Done"` MUST require non-null `completion_commit`. Worker `git commit` writes `completion_commit` via `updateTicketFrontmatter`. The mux-runner gate refuses to flip status to Done if `completion_commit === null` regardless of worker prose. `completion_commit_inferred` does not satisfy the requirement.

ENFORCE: `extension/tests/git-utils-ticket-frontmatter.test.js` (existing) plus new `extension/tests/mux-runner-done-requires-completion-commit.test.js`.

### R-HCAG-5 — Conformance template hardening (`.claude/commands/send-to-morty.md` + worker conformance template prose)

Update the worker conformance template + manager send-to-morty prompt so workers know:
- PASS verdict is conditional on `git commit` having landed AND every citation surviving `R-HCAG-2` verification.
- Workers MUST run `git diff --stat <state.start_commit>..HEAD` and paste the file list as a `## Diff Evidence` section of conformance.
- Workers MUST NOT cite line numbers they did not personally observe in their own diff this iteration.
- Hallucinated citations are a halt condition, not a retry condition.

ENFORCE: doc-only regression test `extension/tests/send-to-morty-conformance-citation-guidance.test.js` checking the template prose contains the new requirements.

### R-HCAG-6 — Integration test against f00097e8 reproducer fixture

End-to-end test: spawn a fake worker that writes f00097e8-style hallucinated conformance, exits without commit, and assert mux-runner halts with `conformance_citation_drift` and does NOT flip ticket to Done.

ENFORCE: `extension/tests/integration/conformance-citation-gate-e2e.test.js`.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| AC-HCAG-01 | `parseConformanceCitations` extracts file/line/symbol triples from prose; the f00097e8 conformance text yields ≥3 distinct file citations. | Unit test against fixture. |
| AC-HCAG-02 | `verifyCitationsAgainstDiff` returns `ok: false` with `missing: [...]` when cited file is absent from `git diff --name-only`. | Unit test. |
| AC-HCAG-03 | `verifyCitationsAgainstDiff` returns `ok: false` when cited symbol is absent from cited file at HEAD. | Unit test. |
| AC-HCAG-04 | mux-runner emits `conformance_citation_drift` + sets `exit_reason='conformance_citation_drift'` when verifier returns `ok: false`. | Integration test. |
| AC-HCAG-05 | mux-runner refuses to flip `ticket.status = "Done"` when `completion_commit === null`. | Unit test. |
| AC-HCAG-06 | `state.flags.skip_conformance_citation_audit_reason='<reason>'` bypasses the gate and emits `conformance_citation_audit_bypassed` exactly once per session. | Integration test. |
| AC-HCAG-07 | f00097e8 fixture replay halts mux-runner with `conformance_citation_drift` and leaves ticket status as In Progress. | E2E integration test. |
| AC-HCAG-08 | auto-resume.sh halts on `conformance_citation_drift` exit reason (per R-CNAR-4(c)). | `extension/tests/auto-resume-stop-conditions.test.js` extension. |

## Bundle sizing

Single-PRD bundle. **≤6 atomic + 3 hardening.** Codex backend.

Sequencing:
- R-HCAG-1 first (parser is foundational; small).
- R-HCAG-2 second (verifier depends on parser).
- R-HCAG-4 in parallel with R-HCAG-1/2 (completion-commit enforcement is independent).
- R-HCAG-3 after R-HCAG-1/2/4 land (wires the gate into mux-runner).
- R-HCAG-5 in parallel with R-HCAG-3 (docs change, no code dependency).
- R-HCAG-6 last (e2e proves the bundle works against the f00097e8 reproducer).

Hardening tickets:
- Lint + tsc + `npm run test:fast` post each implementation.
- Activity-event schema registration in `extension/src/types/activity-events.schema.json`.
- Closer (manager-owned): version bump, `bash install.sh`, MD5 parity, MASTER_PLAN edit, `gh release create`.

## Adversarial review notes

This bundle exists because workers fabricated PASS conformance. The bundle implementing the fix MUST NOT itself fall to the same failure mode. Mitigations:

- **Refinement gate**: refinement analyst MUST verify R-HCAG-1's parser against the literal f00097e8 conformance text in `<session-dir>/f00097e8/conformance_2026-05-17.md` and confirm the fixture is included in the implementation ticket.
- **Closer verify-then-close**: closer MUST replay the f00097e8 fixture against the deployed gate before tagging the release. Output `e2e_replay_passed` activity event.
- **Citation self-audit**: at refinement+plan time, every cited file/symbol in R-HCAG-1..6 plans MUST be verified by the analyst against HEAD before approval (the `path_not_verified` annotation lane already exists in refinement; reuse it).

## Out of scope

- Replacing worker self-attestation entirely with an LLM judge of the conformance prose (different bundle; this fix is mechanical only).
- B-SJET-2 (re-attempt of R-SJET-1/2/3/4 LLM judge fix). B-HCAG ships FIRST so B-SJET-2's refinement + closer can use the hardened gate.
- Auto-rollback of hallucinated commits (out of scope; halt is sufficient — operator decides recovery path).
- Cross-session citation auditing (Citadel territory).

## Related findings / bundles

- Finding #2 (codex Done-without-commit) — closed 2026-05-15, recurred 2026-05-17 PM × 2 bundles (B-CCPM-1b 2/3, B-SJET 1/3). This bundle definitively closes the **hallucinated-acceptance** subclass; the **uncommitted-but-real-work** subclass is partially covered by R-HCAG-4 (completion_commit enforcement).
- Finding #47 R-SJET — still OPEN; B-SJET-2 launches AFTER B-HCAG ships so the re-attempt runs under the hardened gate.
- R-CTSF `docs/closer-ticket-manager-handoff.md` — extended by R-HCAG-5 closer guidance.
