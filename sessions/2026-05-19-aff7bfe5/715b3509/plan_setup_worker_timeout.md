# Plan

1. Centralize the explicit `--worker-timeout` check in `setup.ts`.
2. Keep override persistence gated on that explicit check for setup and resume paths.
3. Add a regression test proving settings/default-derived timeouts do not write `flags.tier_cap_override`.
4. Run the focused setup test file.
