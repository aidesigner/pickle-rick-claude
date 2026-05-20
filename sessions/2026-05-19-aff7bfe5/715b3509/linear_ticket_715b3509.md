---
id: 715b3509
title: Persist worker-timeout overrides during setup and default resolution
status: Done
priority: High
order: 10
created: 2026-05-20
updated: 2026-05-20
links:
  - url: ../linear_ticket_parent.md
    title: Parent Ticket
---
# Description
## Problem to solve
Session setup does not yet guarantee that an explicit `--worker-timeout` persists in both the top-level timeout field and the authoritative medium-tier override path, while default setup must remain clean when no explicit flag is provided.

## Solution
Update setup-time state construction so explicit overrides write both required fields and default flows continue to rely on documented defaults without emitting unnecessary override state.

## Implementation Details
- Audit setup/session initialization paths that populate `worker_timeout_seconds` and `flags.tier_cap_override.medium.worker_timeout_seconds`.
- Ensure explicit `--worker-timeout` writes both the public top-level field and the precedence-driving medium-tier override.
- Preserve default behavior when no explicit timeout is supplied by keeping override state empty unless another explicit limit requires it.
- Add or adjust focused tests that prove setup persistence and default-state behavior.
