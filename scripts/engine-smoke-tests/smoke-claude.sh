#!/usr/bin/env bash
# Smoke tests for Claude CLI — validates adapter assumptions match reality.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_engine claude || exit 0

echo ""
echo "══════════════════════════════════════"
echo "  Claude CLI Smoke Tests"
echo "══════════════════════════════════════"

# ── Test 1: Spawn ──

test_spawn() {
  local s; s=$(smoke_session claude spawn)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  # Claude shows ❯ or > prompt after init (claude.ts:73-75)
  # Also skip status bar lines: tokens, bypass permissions, current/latest
  assert_pattern "$s" "spawn: Claude starts and shows prompt" '[❯>] '

  assert_no_pattern "$s" "spawn: no 'command not found'" 'command not found'

  kill_session "$s"
}

# ── Test 2: Idle detection ──

test_idle_detection() {
  local s; s=$(smoke_session claude idle)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "idle: Claude never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  # Prompt character (claude.ts:73-75)
  if echo "$pane" | grep -qE '^[❯>]\s*$|^[❯>] '; then
    pass "idle: prompt character detected"
  else
    fail "idle: prompt character not found in pane"
  fi

  # Status bar: token count (claude.ts:113-119)
  if echo "$pane" | grep -qE '[0-9]+\s+tokens'; then
    pass "idle: token count in status bar"
  else
    skip "idle: token count" "may not appear immediately"
  fi

  # Separator lines (claude.ts:68): ── or ▪▪▪
  if echo "$pane" | grep -qE '^[─━═▪]{3,}'; then
    pass "idle: separator line detected"
  else
    skip "idle: separator line" "may depend on terminal width"
  fi

  kill_session "$s"
}

# ── Test 3: Paste delivery ──

test_paste_delivery() {
  local s; s=$(smoke_session claude paste)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "paste: Claude never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "echo SMOKE_TEST_MARKER_67890"

  assert_pattern "$s" "paste: text appears in pane" 'SMOKE_TEST_MARKER_67890'

  kill_session "$s"
}

# ── Test 4: --session-id flag ──

test_session_id() {
  local s; s=$(smoke_session claude sessid)
  kill_session "$s"
  create_session "$s"

  local test_uuid; test_uuid=$(gen_uuid)
  paste_and_enter "$s" "claude --session-id $test_uuid"

  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "session-id: Claude accepts --session-id flag"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "session-id: Claude failed to start with --session-id" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 5: Exit via /exit ──

test_exit() {
  local s; s=$(smoke_session claude exit)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "exit: Claude never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"

  if wait_for_pattern "$s" '[\$%#] ?$' "$TIMEOUT"; then
    pass "exit: /exit returns to shell"
  elif ! has_session "$s" 2>/dev/null; then
    pass "exit: /exit terminated session"
  else
    fail "exit: /exit did not return to shell or close session"
  fi

  kill_session "$s"
}

# ── Test 6: Resume with --resume ──

test_resume() {
  local s; s=$(smoke_session claude resume)
  kill_session "$s"
  create_session "$s"

  local test_uuid; test_uuid=$(gen_uuid)

  # Spawn with session ID
  paste_and_enter "$s" "claude --session-id $test_uuid"
  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "resume: initial spawn failed"
    kill_session "$s"
    return
  fi

  # Exit
  paste_and_enter "$s" "/exit"
  sleep 2

  # Resume (claude.ts:47-55)
  paste_and_enter "$s" "claude --resume $test_uuid"

  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "resume: --resume shows prompt"
  elif capture_pane "$s" 20 | grep -qiE 'session.*not found|no session|error'; then
    pass "resume: --resume gives graceful error"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "resume: --resume neither resumed nor gave graceful error" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 7: Context percent parsing ──

test_context_parsing() {
  local s; s=$(smoke_session claude ctx)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "context: Claude never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  # Token count format (claude.ts:113-119): "15048 tokens"
  if echo "$pane" | grep -qE '[0-9]+\s+tokens'; then
    local tokens
    tokens=$(echo "$pane" | grep -oE '[0-9]+\s+tokens' | head -1 | grep -oE '^[0-9]+')
    pass "context: parsed ${tokens} tokens from status bar"
  else
    skip "context: token count not visible" "may need active conversation"
  fi

  # Percentage format (claude.ts:106-112): "45% context remaining"
  if echo "$pane" | grep -qE '[0-9]+%\s+context\s+remaining'; then
    pass "context: percentage format detected"
  else
    skip "context: percentage format" "may only appear after context usage"
  fi

  kill_session "$s"
}

# ── Test 8: --append-system-prompt ──

test_append_system_prompt() {
  local s; s=$(smoke_session claude sysprompt)
  kill_session "$s"
  create_session "$s"

  # This is how the orchestrator injects persona system prompts for Claude
  paste_and_enter "$s" "claude --append-system-prompt 'You are a smoke test assistant.'"

  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "system-prompt: --append-system-prompt accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "system-prompt: Claude rejected --append-system-prompt" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Run ──

test_spawn
test_idle_detection
test_paste_delivery
test_session_id
test_exit
test_resume
test_context_parsing
test_append_system_prompt

print_summary "Claude"
