# Section A RCA Followup: AC-DR-04d

## Hypothesis

Hypothesis B is the best-supported explanation: a writer outside the currently closed source writer set, or a stale deployed updater path no longer represented by current source, reverted the deployed runtime after the kill switch was already false. The reason is that current source settings disable auto-update at `pickle_settings.json:28`, deployed settings disable auto-update at `/Users/gregorydickson/.claude/pickle-rick/pickle_settings.json:39`, stop-hook skips updater spawn when the deployed flag is false at `extension/src/hooks/handlers/stop-hook.ts:366-370`, and the current source updater refuses normal upgrades when settings disable auto-update at `extension/src/bin/check-update.ts:310-313`.

Hypothesis A is not the primary explanation for the May 1 to May 2 incident window. The source setting was changed from true to false in commit `fc50aed`, whose diff changes `pickle_settings.json:28` from true to false, and the commit timestamp is 2026-04-29 19:31:15 -0500, before the May 1 to May 2 timeline in `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:42-58`.

Hypothesis C is ruled out for the current source path. The current stop-hook gate returns before spawning the updater when deployed settings contain false at `extension/src/hooks/handlers/stop-hook.ts:366-370`, and the current updater returns before downloading or installing in both `performUpgrade` and `checkForUpdate` when settings contain false and no explicit force option is present at `extension/src/bin/check-update.ts:310-313` and `extension/src/bin/check-update.ts:377-380`.

## Evidence

The source and deployed runtime disagree today: source `extension/package.json:3` is `1.67.0`, while deployed `/Users/gregorydickson/.claude/pickle-rick/extension/package.json:3` is `1.64.0`. This proves deployed code is stale relative to the source tree used for this investigation.

The parent PRD records that v1.66.0 was tagged at SHA `41528af7` before the version bump, and that `git show v1.66.0:extension/package.json | jq -r .version` returned `"1.64.0"` at `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:30-34`. The same PRD records that v1.66.0 was deployed at 2026-05-01 22:36 UTC and was reverted to 1.64.0 by about 2026-05-02 01:00 UTC at `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:46-50`.

The debug log supports that stop-hook saw the kill switch and skipped updater spawn after the redeploy window: `/Users/gregorydickson/.claude/pickle-rick/debug.log:901003` logs an auto-update skip at 2026-05-02T11:59:08Z, and `/Users/gregorydickson/.claude/pickle-rick/debug.log:901423` logs another skip at 2026-05-02T12:21:13Z.

The debug log also shows updater activity from a deployed `1.64.0` baseline before later skip entries: `/Users/gregorydickson/.claude/pickle-rick/debug.log:878062-878063` logs an available update from `1.64.0` to `2.0.0` and starts the upgrade, and the same pattern repeats at `/Users/gregorydickson/.claude/pickle-rick/debug.log:878895-878896`, `/Users/gregorydickson/.claude/pickle-rick/debug.log:879803-879804`, and `/Users/gregorydickson/.claude/pickle-rick/debug.log:884351-884352`.

The deployed updater predates the source downgrade-preinspection guard. Current source inspects the downloaded tarball's package version before install at `extension/src/bin/check-update.ts:323-341`, but deployed `/Users/gregorydickson/.claude/pickle-rick/extension/bin/check-update.js:239-251` downloads and installs without candidate version inspection.

The installer can preserve stale deployed settings over source defaults. `install.sh:167-173` uses the source settings file as the base and overlays the deployed settings file before writing back to the deployed settings path.

The deployed update cache is not a reliable current-version witness. `/Users/gregorydickson/.claude/pickle-rick/update-check.json:2-4` contains `last_check_epoch: 1`, `latest_version: "1.0.0"`, and `current_version: "1.0.0"`, while deployed `/Users/gregorydickson/.claude/pickle-rick/extension/package.json:3` is `1.64.0`.

## File:line citations

| Claim | Citation |
|---|---|
| Source settings disable auto-update. | `pickle_settings.json:28` |
| Deployed settings disable auto-update. | `/Users/gregorydickson/.claude/pickle-rick/pickle_settings.json:39` |
| Stop-hook reads deployed settings and skips updater spawn when false. | `extension/src/hooks/handlers/stop-hook.ts:366-370` |
| Source updater refuses normal `performUpgrade` when settings disable auto-update. | `extension/src/bin/check-update.ts:310-313` |
| Source updater refuses normal `checkForUpdate` when settings disable auto-update. | `extension/src/bin/check-update.ts:377-380` |
| Source package version is 1.67.0. | `extension/package.json:3` |
| Deployed package version is 1.64.0. | `/Users/gregorydickson/.claude/pickle-rick/extension/package.json:3` |
| v1.66.0 tag carried package version 1.64.0. | `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:30-34` |
| v1.66.0 deployed and then reverted to 1.64.0 in the forensic timeline. | `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:46-50` |
| Stop-hook logged auto-update skips after redeploy. | `/Users/gregorydickson/.claude/pickle-rick/debug.log:901003`, `/Users/gregorydickson/.claude/pickle-rick/debug.log:901423` |
| Updater logged upgrade attempts from a 1.64.0 baseline. | `/Users/gregorydickson/.claude/pickle-rick/debug.log:878062-878063`, `/Users/gregorydickson/.claude/pickle-rick/debug.log:878895-878896`, `/Users/gregorydickson/.claude/pickle-rick/debug.log:879803-879804`, `/Users/gregorydickson/.claude/pickle-rick/debug.log:884351-884352` |
| Current source inspects candidate tarball version before install. | `extension/src/bin/check-update.ts:323-341` |
| Deployed updater installs after download without candidate version inspection. | `/Users/gregorydickson/.claude/pickle-rick/extension/bin/check-update.js:239-251` |
| Installer overlays deployed settings over source defaults. | `install.sh:167-173` |
| Deployed update cache has fallback 1.0.0 values. | `/Users/gregorydickson/.claude/pickle-rick/update-check.json:2-4` |

## Verdict

Verdict: Hypothesis B, with a narrower description than "random external process": the observed state requires a writer outside the current source-level stop-hook and updater kill-switch path, and the strongest concrete candidate is stale deployed updater/install behavior from an older runtime lineage. Current source behavior blocks normal stop-hook-spawned updates under the false setting at `extension/src/hooks/handlers/stop-hook.ts:366-370`, `extension/src/bin/check-update.ts:310-313`, and `extension/src/bin/check-update.ts:377-380`.

Hypothesis A is downgraded to background risk, not the incident explanation, because the false source setting predates the incident window via commit `fc50aed` and because the parent timeline places the v1.66.0 reversion after that date at `prds/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md:42-58`.

Hypothesis C is ruled out for the current source path because both stop-hook and updater contain explicit early returns when settings disable auto-update at `extension/src/hooks/handlers/stop-hook.ts:366-370`, `extension/src/bin/check-update.ts:310-313`, and `extension/src/bin/check-update.ts:377-380`.

Terminal state: INCONCLUSIVE on exact process identity, but B is selected and C is eliminated by file:line evidence. The next diagnostic should capture process-level writer identity with filesystem mutation monitoring around `/Users/gregorydickson/.claude/pickle-rick/extension/` and `/Users/gregorydickson/.claude/pickle-rick/pickle_settings.json`; this report does not implement that watcher because the ticket scope excludes automated reversion detection at `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-02-ad240987/d7fe1d01/linear_ticket_d7fe1d01.md:65-66`.
