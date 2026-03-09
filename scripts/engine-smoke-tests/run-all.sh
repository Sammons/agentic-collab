#!/usr/bin/env bash
# Engine CLI smoke test runner.
#
# For each engine (claude, codex, opencode):
#   1. Detect installed CLI version
#   2. Resolve the matching versioned harness (e.g., claude/2.1.x.sh)
#   3. Source and run the harness
#   4. Fail loudly if no harness matches the installed version
#
# Usage:
#   bash scripts/engine-smoke-tests/run-all.sh           # run all engines
#   bash scripts/engine-smoke-tests/run-all.sh claude     # run only claude
#   SMOKE_TIMEOUT=30 bash scripts/engine-smoke-tests/run-all.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

ENGINES=("${@:-claude codex opencode}")
# If args were passed as a single string, split them
if [ "${#ENGINES[@]}" -eq 1 ] && [[ "${ENGINES[0]}" == *" "* ]]; then
  read -ra ENGINES <<< "${ENGINES[0]}"
fi

echo "Engine CLI Smoke Tests"
echo "======================"
echo "Tests run real CLI binaries in tmux to catch drift between"
echo "adapter assumptions and actual CLI behavior."
echo ""

TOTAL_ENGINES=0
TOTAL_ENGINE_PASS=0
TOTAL_ENGINE_FAIL=0
TOTAL_ENGINE_SKIP=0
TOTAL_NO_HARNESS=0

for engine in "${ENGINES[@]}"; do
  engine_dir="$SCRIPT_DIR/$engine"

  # Check if engine is installed
  if ! require_engine "$engine"; then
    TOTAL_ENGINE_SKIP=$((TOTAL_ENGINE_SKIP + 1))
    continue
  fi

  # Detect version
  version=$(detect_version "$engine")
  if [ -z "$version" ]; then
    echo -e "  ${RED}FAIL${RESET}  $engine: could not detect version"
    TOTAL_ENGINE_FAIL=$((TOTAL_ENGINE_FAIL + 1))
    continue
  fi

  # Check harness directory exists
  if [ ! -d "$engine_dir" ]; then
    echo -e "  ${RED}FAIL${RESET}  $engine v${version}: no harness directory at $engine_dir"
    echo -e "        Create ${engine_dir}/<version>.sh to add a harness."
    TOTAL_NO_HARNESS=$((TOTAL_NO_HARNESS + 1))
    TOTAL_ENGINE_FAIL=$((TOTAL_ENGINE_FAIL + 1))
    continue
  fi

  # Resolve harness
  harness=$(resolve_harness "$engine_dir" "$version" || true)
  if [ -z "$harness" ]; then
    available=$(list_available_harnesses "$engine_dir")
    echo ""
    echo -e "  ${RED}NO HARNESS${RESET}  $engine v${version}"
    echo -e "  No harness matches version ${version}."
    echo -e "  Available harnesses in ${engine_dir}/:"
    if [ -n "$available" ]; then
      echo "$available" | while read -r h; do echo "    - $h"; done
    else
      echo "    (none)"
    fi
    echo -e "  Create ${engine_dir}/$(version_major_minor "$version").x.sh to fix this."
    echo ""
    TOTAL_NO_HARNESS=$((TOTAL_NO_HARNESS + 1))
    TOTAL_ENGINE_FAIL=$((TOTAL_ENGINE_FAIL + 1))
    continue
  fi

  # Run harness
  echo ""
  echo "══════════════════════════════════════"
  echo "  ${engine} v${version} — $(basename "$harness" .sh)"
  echo "══════════════════════════════════════"

  # Reset counters for this engine
  PASS=0
  FAIL=0
  SKIP=0

  # Source and run the harness (it defines and calls test functions).
  # Temporarily disable set -e so that non-zero returns from grep/wait helpers
  # inside test functions don't abort the entire runner.
  set +e
  source "$harness"
  set -e

  print_summary "${engine}" || true

  TOTAL_ENGINES=$((TOTAL_ENGINES + 1))
  if [ "$FAIL" -eq 0 ]; then
    TOTAL_ENGINE_PASS=$((TOTAL_ENGINE_PASS + 1))
  else
    TOTAL_ENGINE_FAIL=$((TOTAL_ENGINE_FAIL + 1))
  fi
done

echo ""
echo "══════════════════════════════════════"
echo "  All Engines: ${TOTAL_ENGINES} run, ${TOTAL_ENGINE_FAIL} with failures, ${TOTAL_ENGINE_SKIP} skipped, ${TOTAL_NO_HARNESS} missing harness"
echo "══════════════════════════════════════"

[ "$TOTAL_ENGINE_FAIL" -eq 0 ] && [ "$TOTAL_NO_HARNESS" -eq 0 ]
