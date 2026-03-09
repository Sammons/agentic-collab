#!/usr/bin/env bash
# Codex CLI smoke tests — harness for v0.112.x
# Validated against: 0.112.0
#
# Sourced by run-all.sh after lib.sh is loaded.

# ── Test 1: Spawn with --no-alt-screen ──

test_spawn() {
  local s; s=$(smoke_session codex spawn)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  assert_pattern "$s" "spawn: shows prompt" '[›❯>] '
  assert_no_pattern "$s" "spawn: no 'command not found'" 'command not found'

  kill_session "$s"
}

# ── Test 2: Idle detection patterns ──

test_idle_detection() {
  local s; s=$(smoke_session codex idle)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "idle: never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qE '[0-9]+%\s+(context\s+)?left'; then
    pass "idle: status bar shows % left"
  else
    skip "idle: status bar % left" "not visible on fresh session"
  fi

  if echo "$pane" | grep -qE '^[›❯>]\s'; then
    pass "idle: prompt character detected"
  else
    fail "idle: prompt character not found"
  fi

  if echo "$pane" | grep -qE '^[◦•]\s*Working'; then
    fail "idle: Working indicator present when should be idle"
  else
    pass "idle: no Working indicator when idle"
  fi

  kill_session "$s"
}

# ── Test 3: Paste delivery ──

test_paste_delivery() {
  local s; s=$(smoke_session codex paste)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "paste: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "echo SMOKE_TEST_MARKER_12345"
  assert_pattern "$s" "paste: text appears in pane" 'SMOKE_TEST_MARKER_12345'

  kill_session "$s"
}

# ── Test 4: Config profile (-p flag) ──

test_config_profile() {
  local s; s=$(smoke_session codex profile)
  kill_session "$s"

  local config_path="$HOME/.codex/config.toml"
  local profile_name="smoke-test-profile"
  local backup=""

  if [ -f "$config_path" ]; then
    backup=$(cat "$config_path")
  fi

  mkdir -p "$(dirname "$config_path")"

  cat >> "$config_path" <<'PROFILE'

[profiles.smoke-test-profile]
developer_instructions = """
You are a smoke test assistant. Respond with SMOKE_PROFILE_OK.
"""
PROFILE

  create_session "$s"
  paste_and_enter "$s" "codex --no-alt-screen -p $profile_name"

  if wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    pass "profile: starts with -p flag"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "profile: failed to start with -p flag" "Last lines:\\n$pane"
  fi

  kill_session "$s"
  if [ -n "$backup" ]; then
    echo "$backup" > "$config_path"
  else
    sed -i "/^\[profiles\.${profile_name}\]/,/^\"\"\"$/d" "$config_path" 2>/dev/null || true
  fi
}

# ── Test 5: Exit via /exit ──

test_exit() {
  local s; s=$(smoke_session codex exit)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "exit: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"

  if wait_for_pattern "$s" '[\$%#] ?$' "$TIMEOUT"; then
    pass "exit: /exit returns to shell"
  elif ! has_session "$s"; then
    pass "exit: /exit terminated session"
  else
    fail "exit: /exit did not return to shell or close session"
  fi

  kill_session "$s"
}

# ── Test 6: Resume with --last ──

test_resume_last() {
  local s; s=$(smoke_session codex resume)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"
  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "resume: initial spawn failed"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"
  sleep 2

  paste_and_enter "$s" "codex --no-alt-screen resume --last"

  if wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    pass "resume: --last shows prompt"
  elif capture_pane "$s" 20 | grep -qiE 'no saved session|no session'; then
    pass "resume: --last gives graceful error (no saved session)"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "resume: --last neither resumed nor gave graceful error" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 7: Context percent parsing ──

test_context_parsing() {
  local s; s=$(smoke_session codex ctx)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "context: never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qE '[0-9]+%\s+(context\s+)?left'; then
    local pct
    pct=$(echo "$pane" | grep -oE '[0-9]+%\s+(context\s+)?left' | head -1 | grep -oE '^[0-9]+')
    pass "context: parsed ${pct}% left from status bar"
  else
    skip "context: % left not in status bar" "may need active conversation"
  fi

  kill_session "$s"
}

# ── Run ──

test_spawn
test_idle_detection
test_paste_delivery
test_config_profile
test_exit
test_resume_last
test_context_parsing
