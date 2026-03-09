#!/usr/bin/env bash
# Shared helpers for engine smoke tests.
# Source this file — do not execute directly.

SESSION_PREFIX="smoke-test"
TIMEOUT=${SMOKE_TIMEOUT:-12}
PASS=0
FAIL=0
SKIP=0

# ── Colors ──

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN='' RED='' YELLOW='' BOLD='' RESET=''
fi

# ── Prereqs ──

if ! command -v tmux &>/dev/null; then
  echo "tmux is required but not installed." >&2
  exit 1
fi

# ── Cleanup ──

cleanup() {
  # Guard against pipefail: grep returns 1 when no sessions match, which
  # under set -euo pipefail would propagate as a nonzero exit code.
  tmux list-sessions -F '#{session_name}' 2>/dev/null \
    | grep "^${SESSION_PREFIX}" \
    | while read -r s; do tmux kill-session -t "$s" 2>/dev/null; done \
    || true
}
trap cleanup EXIT

# ── Session helpers ──
# Mirror the proxy's tmux.ts implementation exactly.

smoke_session() {
  # Usage: smoke_session <engine> <test>
  echo "${SESSION_PREFIX}-${1}-${2}"
}

create_session() {
  # Usage: create_session <name> [cwd]
  # Mirrors proxy tmux.ts: -e CLAUDECODE= clears it to empty, but Claude checks for
  # the variable being unset entirely. We send 'unset CLAUDECODE' after creation.
  local name="$1" cwd="${2:-/tmp}"
  tmux new-session -d -s "$name" -c "$cwd" -x 200 -y 50 -e CLAUDECODE=
  # Unset CLAUDECODE so nested Claude Code sessions are allowed (same as proxy behavior)
  tmux send-keys -t "$name" "unset CLAUDECODE" Enter
  sleep 0.3
}

paste_and_enter() {
  # Mirrors proxy pasteText: load-buffer via stdin, paste-buffer, 500ms sleep, Enter
  local name="$1" text="$2"
  echo -n "$text" | tmux load-buffer -
  tmux paste-buffer -t "$name"
  sleep 0.5
  tmux send-keys -t "$name" Enter
}

send_keys() {
  local name="$1"
  shift
  tmux send-keys -t "$name" "$@"
}

capture_pane() {
  # Usage: capture_pane <name> [lines]
  # Normalizes non-breaking spaces (U+00A0 = 0xc2 0xa0) to regular spaces.
  # Claude Code uses NBSP after its ❯ prompt, which breaks grep patterns
  # that expect regular space. This mirrors what the adapter's detectIdleState
  # sees after tmux capture (the TS code normalizes implicitly via .trim()).
  local name="$1" lines="${2:-50}"
  tmux capture-pane -t "$name" -p -S "-${lines}" | sed "s/$(printf '\xc2\xa0')/ /g"
}

kill_session() {
  tmux kill-session -t "$1" 2>/dev/null || true
}

has_session() {
  tmux has-session -t "$1" 2>/dev/null
}

# ── Polling ──

wait_for_pattern() {
  # Usage: wait_for_pattern <session> <grep_pattern> [timeout]
  local name="$1" pattern="$2" timeout="${3:-$TIMEOUT}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if capture_pane "$name" 50 | grep -qE "$pattern"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

wait_for_no_session() {
  # Wait until the tmux session no longer exists
  local name="$1" timeout="${2:-$TIMEOUT}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if ! has_session "$name"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# ── Assertions ──

pass() {
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET}  $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET}  $1"
  if [ -n "${2:-}" ]; then
    echo -e "        ${2}"
  fi
}

skip() {
  SKIP=$((SKIP + 1))
  echo -e "  ${YELLOW}SKIP${RESET}  $1 — $2"
}

assert_pattern() {
  # Usage: assert_pattern <session> <label> <pattern> [timeout]
  local name="$1" label="$2" pattern="$3" timeout="${4:-$TIMEOUT}"
  if wait_for_pattern "$name" "$pattern" "$timeout"; then
    pass "$label"
  else
    local pane
    pane=$(capture_pane "$name" 10 2>/dev/null | tail -5)
    fail "$label" "pattern /$pattern/ not found. Last 5 lines:\\n$pane"
  fi
}

assert_no_pattern() {
  # Verify pattern does NOT appear within timeout
  local name="$1" label="$2" pattern="$3" timeout="${4:-3}"
  sleep "$timeout"
  if capture_pane "$name" 50 | grep -qE "$pattern"; then
    fail "$label"
  else
    pass "$label"
  fi
}

# ── Summary ──

print_summary() {
  local engine="${1:-}"
  echo ""
  echo -e "${BOLD}${engine:+$engine }Summary: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped${RESET}"
  [ "$FAIL" -eq 0 ]
}

# ── Utility ──

gen_uuid() {
  # Generate a random UUID v4 for session IDs. Works on Linux (uuidgen) or fallback.
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    # /proc/sys/kernel/random/uuid on Linux
    cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())'
  fi
}

# ── Engine check ──

require_engine() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${YELLOW}$1 not installed — skipping${RESET}"
    return 1
  fi
  return 0
}
