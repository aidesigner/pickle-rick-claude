#!/usr/bin/env bash
# R-TFP-C3 — 3× consecutive test:fast + test:integration regression loop
#
# Runs the full test:fast + test:integration chain 3× in sequence, each at
# the gate's actual concurrency settings (test:fast --test-concurrency=8,
# test:integration parallel + serial). Exits non-zero on any failure.
#
# Expected wall-clock: ~10–15 min × 3 = 30–45 min total.
#
# Usage: RUN_REGRESSION_3X=1 npm run test:regression-3x
# Or:   RUN_REGRESSION_3X=1 bash scripts/regression-test-fast-integration-3x.sh
#
# Appends JSONL run records to ~/.claude/pickle-rick/r-tfp-regression-log.jsonl
# for consecutive-green tracking.
#
# Environment variables:
#   RUN_REGRESSION_3X=1  (required — absent/empty exits 0 with skip message)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${HOME}/.claude/pickle-rick/r-tfp-regression-log.jsonl"
TOTAL_RUNS=3

if [[ -z "${RUN_REGRESSION_3X:-}" ]]; then
  echo "[r-tfp-c3] SKIP: RUN_REGRESSION_3X not set — regression loop disabled (too slow for fast/integration tier)" >&2
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

overall_fail=0
pass_count=0

for i in $(seq 1 "$TOTAL_RUNS"); do
  echo "[r-tfp-c3] === Run $i/$TOTAL_RUNS ==="
  run_start_ms=$(node -e "process.stdout.write(String(Date.now()))")
  fast_exit=0
  integration_exit=0

  echo "[r-tfp-c3] Run $i: test:fast"
  (cd "$EXTENSION_DIR" && npm run test:fast) || fast_exit=$?

  if [[ $fast_exit -ne 0 ]]; then
    echo "[r-tfp-c3] FAIL: test:fast exited $fast_exit on run $i" >&2
    overall_fail=1
  fi

  echo "[r-tfp-c3] Run $i: test:integration"
  (cd "$EXTENSION_DIR" && npm run test:integration) || integration_exit=$?

  if [[ $integration_exit -ne 0 ]]; then
    echo "[r-tfp-c3] FAIL: test:integration exited $integration_exit on run $i" >&2
    overall_fail=1
  fi

  run_end_ms=$(node -e "process.stdout.write(String(Date.now()))")
  duration_ms=$((run_end_ms - run_start_ms))
  ts=$(node -e "process.stdout.write(new Date().toISOString())")

  if [[ $fast_exit -eq 0 && $integration_exit -eq 0 ]]; then
    run_status="pass"
    pass_count=$((pass_count + 1))
  else
    run_status="fail"
  fi

  echo '{"ts":"'"$ts"'","run":'"$i"',"status":"'"$run_status"'","fast_exit":'"$fast_exit"',"integration_exit":'"$integration_exit"',"duration_ms":'"$duration_ms"'}' >> "$LOG_FILE"
  echo "[r-tfp-c3] Run $i complete: status=$run_status fast_exit=$fast_exit integration_exit=$integration_exit duration_ms=$duration_ms"

  if [[ $overall_fail -ne 0 ]]; then
    echo "[r-tfp-c3] Aborting after run $i failure." >&2
    exit 1
  fi
done

echo "[r-tfp-c3] === DONE: $pass_count/$TOTAL_RUNS runs passed ==="
if [[ $overall_fail -ne 0 ]]; then
  exit 1
fi
