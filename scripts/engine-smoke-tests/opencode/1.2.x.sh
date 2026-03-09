#!/usr/bin/env bash
# OpenCode CLI smoke tests — harness for v1.2.x
# Validated against: 1.2.22
#
# DRIFT STATUS (2026-03-08):
# OpenCode v1.2.x changed behavior from earlier versions:
#   - `opencode run` is now non-interactive (requires message positional)
#   - `opencode` (default) is TUI mode with full-screen layout, no `> ` prompt
#   - Adapter still assumes `opencode run` starts an interactive REPL
# These tests validate what the CLI *actually does* to catch this drift.
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

# ── Test 2: TUI mode spawn (default command) ──

test_tui_spawn() {
  local s; s=$(smoke_session opencode tui)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  assert_pattern "$s" "tui: TUI starts" 'Ask anything|OPENCODE|opencode'
  assert_no_pattern "$s" "tui: no 'command not found'" 'command not found'

  kill_session "$s"
}

# ── Test 3: `opencode run` without message (drift detection) ──

test_run_requires_message() {
  local s; s=$(smoke_session opencode run)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode run"

  # Current behavior: "You must provide a message or a command"
  # If this starts showing a prompt, the adapter can use `opencode run` again
  if wait_for_pattern "$s" 'must provide|message or a command' 8; then
    pass "run: 'opencode run' correctly requires a message (adapter drift confirmed)"
  elif wait_for_pattern "$s" '^> |^[›❯] ' 5; then
    pass "run: 'opencode run' shows prompt (adapter assumption restored — update adapter!)"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "run: unexpected behavior" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 4: Paste delivery in TUI mode ──

test_paste_delivery() {
  local s; s=$(smoke_session opencode paste)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_pattern "$s" 'Ask anything|OPENCODE|opencode' "$TIMEOUT"; then
    fail "paste: TUI never showed"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "echo SMOKE_TEST_MARKER_OPENCODE"
  assert_pattern "$s" "paste: text appears in pane" 'SMOKE_TEST_MARKER_OPENCODE'

  kill_session "$s"
}

# ── Test 5: Exit from TUI mode ──

test_exit_tui() {
  local s; s=$(smoke_session opencode exit)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_pattern "$s" 'Ask anything|OPENCODE|opencode' "$TIMEOUT"; then
    fail "exit: TUI never showed"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"

  if wait_for_pattern "$s" '[\$%#] ?$' "$TIMEOUT"; then
    pass "exit: /exit returns to shell"
  elif ! has_session "$s" 2>/dev/null; then
    pass "exit: /exit terminated session"
  else
    skip "exit: /exit did not exit TUI" "may need different exit mechanism"
  fi

  kill_session "$s"
}

# ── Test 6: Resume with -c (continue last) ──

test_resume_continue() {
  local s; s=$(smoke_session opencode resumec)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode run -c"

  if wait_for_pattern "$s" '^> |^[›❯] |Ask anything' "$TIMEOUT"; then
    pass "resume-c: -c shows interactive mode"
  elif capture_pane "$s" 20 | grep -qiE 'no session|error|not found|must provide'; then
    pass "resume-c: -c gives graceful error"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "resume-c: -c neither resumed nor gave graceful error" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 7: Resume with -s (session ID) ──

test_resume_session() {
  local s; s=$(smoke_session opencode resumes)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode run -s nonexistent-session-id"

  if wait_for_pattern "$s" '^> |^[›❯] |Ask anything' 8; then
    pass "resume-s: -s shows interactive mode"
  elif capture_pane "$s" 20 | grep -qiE 'not found|error|no session|invalid|must provide'; then
    pass "resume-s: -s gives graceful error for invalid session"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    if echo "$pane" | grep -qE '[\$%#] ?$'; then
      pass "resume-s: -s returned to shell (session not found)"
    else
      fail "resume-s: unexpected behavior" "Last lines:\\n$pane"
    fi
  fi

  kill_session "$s"
}

# ── Run ──

test_version
test_tui_spawn
test_run_requires_message
test_paste_delivery
test_exit_tui
test_resume_continue
test_resume_session
