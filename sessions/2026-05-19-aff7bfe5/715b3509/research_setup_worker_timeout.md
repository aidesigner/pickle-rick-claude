# Research

- `extension/src/bin/setup.ts` already resolves `worker_timeout_seconds` during initial setup and resume.
- The medium-tier override writer is `persistMediumWorkerTimeoutOverride(state, workerTimeout)`.
- The intended contract is explicit-only persistence: CLI `--worker-timeout` should write both the top-level timeout and `flags.tier_cap_override.medium.worker_timeout_seconds`.
- Non-explicit defaults, including `pickle_settings.json` values, should set the top-level timeout only and leave override state clean.
