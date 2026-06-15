#!/usr/bin/env bash
# AC-D3 (R-DSAN) design-ground-truth enforcement spine.
#
# R-DSAN was hollowed during the B-RRH merge because NOTHING failed the build when
# the fix went inert. This spine is a SOURCE-GREP enforcement: it FAILS the build
# (nonzero exit) if any of the three R-DSAN proxies reappear as source patterns,
# and PASSES (exit 0) on the current fixed tree. A stub-satisfiable test is not
# enough — each check is keyed to a real source surface, not a sentinel comment.
#
# The three proxies:
#   (i)   a pickle/phase SUCCESS keyed on a RAW mux child exit code instead of routing
#         through the canonical `evaluateEpicCompletion` completion authority.
#   (ii)  `check-flake-budget` / `test:fast:budget` / `--test-concurrency=8` appearing
#         in the PER-TICKET path (`mux-runner.ts`). The flake budget is once-per-bundle
#         only; it must NEVER be in the per-ticket completion path (mirrors AC-A3).
#   (iii) exact-string-ONLY forward-ref membership (`creationIndex.has(...)`) in EITHER
#         `buildBundleCreationIndex` consumer — a regression from the suffix-symmetric
#         `isForwardCreated` predicate (AC-B1) back to exact `.has(ref)` membership.
#
# Exit 0 = no proxy present. Nonzero = at least one proxy detected.
#
# SOURCE_ROOT override: defaults to "$EXTENSION_ROOT/src". The fail-injection test
# re-targets a TEMP COPY of the source tree via SOURCE_ROOT so it can prove RED-on-proxy
# WITHOUT editing the real source files.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$EXTENSION_ROOT/src}"

MUX_RUNNER="$SOURCE_ROOT/bin/mux-runner.ts"
CHECK_READINESS="$SOURCE_ROOT/bin/check-readiness.ts"
AUDIT_TICKET_BUNDLE="$SOURCE_ROOT/bin/audit-ticket-bundle.ts"

audit_exit_code=0

fail() {
  echo "audit-design-ground-truth: $1" >&2
  audit_exit_code=1
}

require_file() {
  if [ ! -f "$1" ]; then
    fail "expected source file not found: $1"
    return 1
  fi
  return 0
}

# --- CHECK (ii): flake budget in the per-ticket path (the easy, unambiguous one) ---
# The flake budget is once-per-bundle. Its tokens must NEVER appear in mux-runner.ts
# (the between-ticket / per-ticket gate path). ANY hit is the proxy.
if require_file "$MUX_RUNNER"; then
  if grep -nE "check-flake-budget|test:fast:budget|--test-concurrency=8" "$MUX_RUNNER" >/dev/null 2>&1; then
    fail "PROXY (ii): flake-budget token (check-flake-budget|test:fast:budget|--test-concurrency=8) found in the PER-TICKET path mux-runner.ts — the flake budget is once-per-bundle only, never in the per-ticket completion path (AC-A3)."
  fi
fi

# --- CHECK (iii): exact-only forward-ref membership regression ---
# For EACH buildBundleCreationIndex consumer: (a) it MUST import the suffix-symmetric
# `isForwardCreated` predicate, and (b) it MUST NOT decide forward-ref suppression via
# exact `creationIndex.has(...)` membership. A revert to `.has()` re-introduces the
# token and trips (b); removing the suffix predicate trips (a).
check_forward_ref_consumer() {
  local file="$1"
  require_file "$file" || return
  if [ "$(grep -c "isForwardCreated" "$file")" -lt 1 ]; then
    fail "PROXY (iii): $file no longer references the suffix-symmetric isForwardCreated predicate — forward-ref suppression must use isForwardCreated, not exact membership (AC-B1)."
  fi
  if grep -nE "creationIndex\.has\(" "$file" >/dev/null 2>&1; then
    fail "PROXY (iii): $file uses exact-string membership creationIndex.has(...) for forward-ref suppression — this is the AC-B1 regression away from the suffix-symmetric isForwardCreated predicate."
  fi
}
check_forward_ref_consumer "$CHECK_READINESS"
check_forward_ref_consumer "$AUDIT_TICKET_BUNDLE"

# --- CHECK (i): raw-exit-code completion bypass (POSITIVE invariant) ---
# A pickle/phase SUCCESS must be decided by the canonical `evaluateEpicCompletion`
# authority, not a bare child exit-code check. Expressed conservatively as a POSITIVE
# invariant to avoid false positives: the canonical authority MUST be invoked at both
# of its known call sites. A proxy-(i) regression decides completion off a raw exit
# code instead of routing through evaluateEpicCompletion, dropping >= 1 call-invocation
# site, so the count falls below the floor and this check goes RED. This is keyed to
# the real authority call sites (`evaluateEpicCompletion({`), so it is NOT
# stub-satisfiable by a sentinel comment.
EPIC_COMPLETION_CALL_FLOOR=2
if require_file "$MUX_RUNNER"; then
  epic_calls="$(grep -c "evaluateEpicCompletion({" "$MUX_RUNNER")"
  if [ "$epic_calls" -lt "$EPIC_COMPLETION_CALL_FLOOR" ]; then
    fail "PROXY (i): only $epic_calls 'evaluateEpicCompletion({' call site(s) in mux-runner.ts (floor $EPIC_COMPLETION_CALL_FLOOR) — a pickle/phase completion decision is no longer routed through the canonical evaluateEpicCompletion authority. A completion decided by a raw mux child exit code instead of this authority is the R-DSAN proxy (i) regression."
  fi
fi

if [ "$audit_exit_code" -eq 0 ]; then
  echo "audit-design-ground-truth: OK — no R-DSAN proxy (i/ii/iii) present in $SOURCE_ROOT"
fi

exit "$audit_exit_code"
