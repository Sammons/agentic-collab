#!/usr/bin/env bash
# Run smoke tests for all available engine CLIs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Engine CLI Smoke Tests"
echo "======================"
echo "Tests run real CLI binaries in tmux to catch drift between"
echo "adapter assumptions and actual CLI behavior."
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0
ENGINES_RUN=0

for engine in codex claude opencode; do
  script="$SCRIPT_DIR/smoke-${engine}.sh"
  [ -f "$script" ] || continue

  if bash "$script"; then
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
  ENGINES_RUN=$((ENGINES_RUN + 1))
done

echo ""
echo "══════════════════════════════════════"
echo "  All Engines: $ENGINES_RUN run, $TOTAL_FAIL with failures"
echo "══════════════════════════════════════"

[ "$TOTAL_FAIL" -eq 0 ]
