---
title: P2 Bundle — deploy-reversion lockdown + gate-baseline runtime diagnostic
status: Draft
date: 2026-05-02
priority: P0
backend: codex-required
type: manifest
peer_prds:
  related:
    - prds/schema-version-deploy-reversion-rca.md  # F7 was deferred; THIS is what makes it P0 now
    - prds/anatomy-park-gate-baseline-missing.md  # SHIPPED v1.66.0 but invisible because of deploy-reversion
    - prds/pipeline-runner-state-active-not-claimed-on-relaunch.md  # P3, still open
    - prds/readiness-gate-manifest-prd-bundle-mismatch.md  # P2, still open
---

# PRD — P2 Bundle: Deploy-reversion lockdown + gate-baseline runtime diagnostic

**Promoted to P0** from P2 because the deploy-reversion meta-bug has now silently undone two consecutive releases (v1.66.0 → v1.64.0 reverted within ~minutes of `bash install.sh`), and every shipped fix that depends on deployed-source parity is invisible to the running pipeline. Until F7 lands, every release is a coin flip — install.sh deploys cleanly, then auto-updater reverts it, then the next pipeline runs against stale code, then anatomy-park hits the bug the release was supposed to fix.

## Forensic timeline (2026-05-01 → 2026-05-02)

| Time (UTC) | Event | Source | Deployed |
|---|---|---|---|
| 2026-05-01 22:35 | v1.66.0 tagged via `gh release create` | 1.66.0 | 1.66.0 (verified) |
| 2026-05-01 22:36 | `bash install.sh` deployed v1.66.0 | 1.66.0 | 1.66.0 (verified) |
| 2026-05-01 23:48 | Bundle session `325ccb80` created via setup.js | 1.66.0 | 1.66.0 |
| 2026-05-02 00:20 | First pipeline launch — readiness halt at 00:26:55 | 1.66.0 | **REVERTED to 1.64.0** by ~01:00 |
| 2026-05-02 01:26 | Pipeline relaunched, ran 144m, shipped 5 of 15 pickle tickets, false-epic exit | 1.66.0 | 1.64.0 |
| 2026-05-02 03:09 | Pipeline advanced to anatomy-park | 1.66.0 | 1.64.0 |
| 2026-05-02 03:30 | Anatomy-park exit 1 (gate-baseline missing — same bug v1.66.0 was supposed to fix) | 1.66.0 | 1.64.0 |
| 2026-05-02 11:18 | Manual `bash install.sh` re-deployed v1.66.0 | 1.66.0 | 1.66.0 (verified) |
| 2026-05-02 11:46 | Pipeline relaunched | 1.66.0 | **REVERTED to 1.64.0** before 14:11 |
| 2026-05-02 14:11 | Pickle phase ✓ shipped all 15 + 4 hardening + closer (v1.67.0 bump committed) | 1.67.0 | 1.64.0 |
| 2026-05-02 14:25 | Anatomy-park exit 1 — same gate-baseline bug, deployed v1.64.0 still has no recapture code | 1.67.0 | 1.64.0 |

**Pattern**: deployed code reverts from v1.66.0 → v1.64.0 within ~30-60 minutes of `bash install.sh`. Source ↔ deployed parity is invisible to the running pipeline because mux-runner and microverse-runner subprocesses load the deployed JS at spawn time.

## Source PRDs (authoritative)

| Section | Source PRD | Tickets | LOC | Refinement narrowing |
|---|---|---|---|---|
| **A** | `prds/schema-version-deploy-reversion-rca.md` (F7 lockdown) | F7 from that PRD = ~3-5 atomic tickets | ~150 | F7 was deferred at v1.62.0 ship time; promote to mandatory |
| **B** | (NEW) gate-baseline runtime diagnostic | NEW: 2-3 atomic tickets | ~60 | After deployed v1.66.0 lands and persists, run anatomy-park and assert recapture log line fires |
| **C** | `prds/pipeline-runner-state-active-not-claimed-on-relaunch.md` | All ACs from that PRD | ~150 | Already drafted; pull forward from P3 backlog |
| **D** | `prds/readiness-gate-manifest-prd-bundle-mismatch.md` | All ACs from that PRD | ~430 | Already drafted; pull forward from P2 backlog |

**Bundle total**: ~12-15 atomic tickets + 4 hardening + 1 closer (v1.67.0 → v1.68.0). ~800 LOC.

## Bundle-level Acceptance Criteria

| ID | Phase | Owner | Verification artifact | Check |
|---|---|---|---|---|
| AC-DR-01 | bundle-end | post-bundle-audit | `bundle/ac-dr-01.json` | All Section A (F7) ACs from `prds/schema-version-deploy-reversion-rca.md` pass |
| AC-DR-02 | bundle-end | pipeline-runner-instrumentation | `bundle/ac-dr-02.json` | After Section A ships, the bundle's own anatomy-park phase reaches Phase 4/4 — i.e. v1.66.0+'s recapture fix actually fires; mlog contains literal `"attempting one recapture from pre-iteration tree"` |
| AC-DR-03 | bundle-end | post-bundle-audit | `bundle/ac-dr-03.json` | After 24h soak post-release, `~/.claude/pickle-rick/extension/package.json:version` matches source `extension/package.json:version`. AC-RVN-11 from `schema-version-deploy-reversion-rca.md`. |
| AC-DR-04 | bundle-end | post-bundle-audit | `bundle/ac-dr-04.json` | install.sh + check-update.js BOTH refuse to deploy a tarball whose `package.json:version` is older than the currently-deployed version (lockdown invariant). |
| AC-DR-05 | per-phase | pipeline-runner-instrumentation | `bundle/ac-dr-05.json` | Section C: log-watcher + raw-morty stay alive across full pipeline run (no `◤ FEED TERMINATED ◢` between iterations) |
| AC-DR-06 | per-phase | pipeline-runner-instrumentation | `bundle/ac-dr-06.json` | Section D: bundle PRD's tickets (with no `source_prd` frontmatter) clear readiness without `--skip-readiness` |
| AC-DR-07 | bundle-end | closer-commit-gate | `bundle/ac-dr-07.json` | Closer commit bumps 1.67.0 → 1.68.0; release gate clean; tag published; install.sh deploys; deployed parity holds for ≥1 hour post-release |

## Sequencing (refinement-locked)

1. **Section A first (F7 lockdown)** — until install.sh is locked down, the rest of the bundle's fixes vanish into the deployed-vs-source gap.
2. **Section B (gate-baseline diagnostic)** — assert that the v1.66.0 recapture fix actually fires now that A guarantees deploy parity. If it doesn't fire even with deployed v1.66.0, gate-baseline has a deeper bug than recapture (probably H2 from the original gate-baseline PRD).
3. **Section C (state.active claim)** — independent fix; can land in parallel with A but makes monitor reliable for D's testing.
4. **Section D (readiness manifest gate)** — final piece; closes the workaround that's currently masking the bug shape.
5. **Closer**: 1.67.0 → 1.68.0, tag, install, **wait 1 hour, verify deployed still matches source**, only then call success.

## Cross-cutting risks

| ID | Risk | Mitigation |
|---|---|---|
| BR-1 | Section A's F7 lockdown breaks legitimate downgrade paths (e.g., user wants to roll back) | F7 should require `--allow-downgrade` flag for explicit rollback; default-blocks |
| BR-2 | The deploy-reversion mechanism may not be `check-update.js` alone — could be a hook or a brew/npm-style external auto-updater | Section A's diagnostic ticket must `lsof`/`ps` watch deployed file mutations during a soak window; identify ALL writers |
| BR-3 | `gh release latest` returning v1.64.0 tarball despite v1.66.0 being marked Latest is a github API edge case | Verify `gh api repos/.../releases/latest` returns the actual v1.66.0 tarball URL; confirm download integrity via `tar -tzf` |
| BR-4 | After F7 ships, install.sh still permits the auto-updater path that bypasses lockdown | Section A audit must enumerate ALL `extension/{services,bin,types,hooks}/*` write sites and either funnel them through install.sh or add lockdown guards |

## Reproducer

Pre-fix: every `bash install.sh && tail -F microverse-runner.log` shows `attempting one recapture` line ABSENT after ~30-60 min, despite source containing it. Cause: deployed JS reverts to v1.64.0.

Post-fix: deployed JS persists at v1.66.0+ across 24h soak. Anatomy-park phase reaches Phase 4/4 of any `/pickle-pipeline` run.

## Operator workaround (until bundle ships)

Manually `bash install.sh` BEFORE every pipeline launch AND verify deployed version matches source via:

```bash
SRC_V=$(jq -r .version /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/package.json)
DEP_V=$(jq -r .version $HOME/.claude/pickle-rick/extension/package.json)
[ "$SRC_V" = "$DEP_V" ] || { echo "DEPLOY DRIFT: src=$SRC_V deployed=$DEP_V — re-run install.sh"; exit 1; }
```

Then launch the pipeline within ~5 min of install.sh to minimize the reversion window.

## Cross-references

- Forensic evidence: bundle session `2026-05-01-325ccb80` ran 2026-05-01 23:48 → 2026-05-02 14:25; pickle ✓ both runs (5+15 tickets, 29 commits including v1.67.0 closer); anatomy-park ✗ on both runs because deployed JS = v1.64.0
- v1.66.0 release: https://github.com/gregorydickson/pickle-rick-claude/releases/tag/v1.66.0
- v1.67.0 closer: commit `2c814e8` (NOT tagged on GitHub — pending operator decision after deploy-reversion lockdown ships)
- Source PRDs (above table) — canonical detail.

— Pickle Rick out. *belch*
