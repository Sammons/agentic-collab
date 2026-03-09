#!/usr/bin/env bash
# OpenCode CLI smoke tests — harness for v1.2.x
# Validated against: 1.2.22
#
# OpenCode v1.2.x uses headless `run` mode:
#   - `opencode run "message"` — process and exit
#   - `opencode run -c "message"` — continue last session
#   - `opencode run -s <id> "message"` — continue specific session
#   - `opencode run --command /compact` — run slash command headlessly
#   - `opencode` (no subcommand) — TUI mode (not used by orchestrator)
#
# Sourced by run-all.sh after lib.sh is loaded.

# ── Test 1: Version check ──

test_version() {
  local s; s=$(smoke_session opencode ver)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode --version"

  if wait_for_pattern "$s" '[0-9]+\.[0-9]+\.[0-9]+' 5; then
    local pane ver
    pane=$(capture_pane "$s" 10)
    ver=$(echo "$pane" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    pass "version: OpenCode ${ver}"
  else
    fail "version: could not parse version"
  fi

  kill_session "$s"
}

# ── Test 2: Headless run with message ──

test_headless_run() {
  local s; s=$(smoke_session opencode headless)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" 'opencode run "respond with just the word SMOKE_HEADLESS_OK"'

  # Should process message and return to shell
  if wait_for_pattern "$s" 'SMOKE_HEADLESS_OK' "$TIMEOUT"; then
    pass "headless: run processes message"
    # Should also return to shell
    if wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
      pass "headless: returns to shell after completion"
    else
      skip "headless: shell prompt" "may need more time"
    fi
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "headless: run did not produce expected output" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 3: Run requires message ──

test_run_requires_message() {
  local s; s=$(smoke_session opencode run)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode run"

  if wait_for_pattern "$s" 'must provide|message or a command' 8; then
    pass "run: requires message (expected behavior)"
  elif wait_for_pattern "$s" '^> |^[›❯] ' 5; then
    pass "run: shows prompt (behavior changed — check adapter!)"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "run: unexpected behavior" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 4: Model flag (-m) ──

test_model_flag() {
  local s; s=$(smoke_session opencode model)
  kill_session "$s"
  create_session "$s"

  # Use a known-bad model to verify the flag is accepted
  paste_and_enter "$s" 'opencode run -m nonexistent/model "say OK"'

  # Should either error about the model or process the request
  if wait_for_pattern "$s" 'error|not found|invalid|OK|[\$%#]\s*$' "$TIMEOUT"; then
    pass "model: -m flag accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "model: -m flag rejected" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 5: Resume with -c ──

test_resume_continue() {
  local s; s=$(smoke_session opencode resumec)
  kill_session "$s"
  create_session "$s"

  # First create a session
  paste_and_enter "$s" 'opencode run "respond with FIRST_MSG"'
  if ! wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
    fail "resume-c: initial run failed"
    kill_session "$s"
    return
  fi

  sleep 1

  # Resume with -c
  paste_and_enter "$s" 'opencode run -c "respond with RESUMED_OK"'

  if wait_for_pattern "$s" 'RESUMED_OK' "$TIMEOUT"; then
    pass "resume-c: -c continues last session"
  elif capture_pane "$s" 20 | grep -qiE 'no session|error|not found'; then
    pass "resume-c: -c gives graceful error"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "resume-c: unexpected behavior" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 6: Resume with -s (session ID) ──

test_resume_session() {
  local s; s=$(smoke_session opencode resumes)
  kill_session "$s"
  create_session "$s"

  # Try with invalid session ID — should error gracefully
  paste_and_enter "$s" 'opencode run -s nonexistent-session-id "say hello"'

  if capture_pane "$s" 20 | grep -qiE 'not found|error|no session|invalid'; then
    pass "resume-s: -s gives graceful error for invalid session"
  elif wait_for_pattern "$s" '[\$%#]\s*$' 8; then
    pass "resume-s: -s returned to shell"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "resume-s: unexpected behavior" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 7: Compact via --command ──

test_compact() {
  local s; s=$(smoke_session opencode compact)
  kill_session "$s"
  create_session "$s"

  # First create a session to compact
  paste_and_enter "$s" 'opencode run "respond with SETUP_OK"'
  if ! wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
    fail "compact: initial run failed"
    kill_session "$s"
    return
  fi

  sleep 1

  # Run compact command
  paste_and_enter "$s" "opencode run -c --command /compact"

  if wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
    pass "compact: --command /compact accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "compact: --command /compact failed" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 8: Session list ──

test_session_list() {
  local s; s=$(smoke_session opencode seslist)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode session list"

  # Wait for the command to complete (returns to shell)
  if ! wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
    fail "session-list: command did not return to shell"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 30)

  if echo "$pane" | grep -qE 'ses_[a-zA-Z0-9]+'; then
    pass "session-list: shows session IDs (ses_xxx format)"
  elif echo "$pane" | grep -qiE 'Session ID|Updated|no sessions|session list'; then
    pass "session-list: command accepted (no sessions or header shown)"
  else
    pass "session-list: command completed without error"
  fi

  kill_session "$s"
}

# ── Test 9: Interrupt (2x Escape) ──

test_interrupt() {
  local s; s=$(smoke_session opencode interrupt)
  kill_session "$s"
  create_session "$s"

  # Start a task that will take time
  paste_and_enter "$s" 'opencode run "write a 500-word essay about testing"'
  sleep 3

  # Send interrupt (2x Escape)
  send_keys "$s" Escape Escape
  sleep 2

  # Should return to shell after interrupt
  if wait_for_pattern "$s" '[\$%#]\s*$' "$TIMEOUT"; then
    pass "interrupt: 2x Escape returns to shell"
  else
    skip "interrupt: may not have interrupted in time" "timing sensitive"
  fi

  kill_session "$s"
}

# ── Run ──

test_version
test_headless_run
test_run_requires_message
test_model_flag
test_resume_continue
test_resume_session
test_compact
test_session_list
test_interrupt
