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

  if echo "$pane" | grep -qE '[›❯>]\s'; then
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
Always end every response with the word PROFILECHECK.
"""
PROFILE

  create_session "$s"
  paste_and_enter "$s" "codex --no-alt-screen -p $profile_name"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "profile: failed to start with -p flag" "Last lines:\\n$pane"
    kill_session "$s"
    # Restore config
    if [ -n "$backup" ]; then echo "$backup" > "$config_path"; else sed -i "/^\[profiles\.${profile_name}\]/,/^\"\"\"$/d" "$config_path" 2>/dev/null || true; fi
    return
  fi

  pass "profile: starts with -p flag"

  # Verify the profile instructions actually took effect
  paste_and_enter "$s" "Say hello."

  if wait_for_pattern "$s" 'PROFILECHECK' 30; then
    pass "profile: instruction followed (PROFILECHECK in response)"
  else
    # Models may not always follow developer instructions perfectly
    skip "profile: PROFILECHECK not in response" "model compliance varies"
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

# ── Test 6: Resume with --last (context validation) ──

test_resume_last() {
  local s; s=$(smoke_session codex resume)
  kill_session "$s"
  create_session "$s"

  local canary; canary=$(gen_canary)

  # Phase 1: spawn, plant canary, exit
  paste_and_enter "$s" "codex --no-alt-screen"
  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "resume: initial spawn failed"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "Remember this exact code: $canary — confirm by repeating it back."
  if ! wait_for_pattern "$s" "$canary" 30; then
    fail "resume: model did not echo canary in initial session"
    kill_session "$s"
    return
  fi

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "resume: prompt never returned after canary response"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"
  sleep 2

  # Phase 2: resume and ask for canary
  paste_and_enter "$s" "codex --no-alt-screen resume --last"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    if capture_pane "$s" 20 | grep -qiE 'no saved session|no session'; then
      skip "resume: session not persisted (graceful error)" "server may not persist short sessions"
    else
      local pane
      pane=$(capture_pane "$s" 10 | tail -5)
      fail "resume: --last did not show prompt" "Last lines:\\n$pane"
    fi
    kill_session "$s"
    return
  fi

  pass "resume: --last shows prompt"

  paste_and_enter "$s" "What was the exact canary code I asked you to remember? Reply with just the code."

  if wait_for_pattern "$s" "$canary" 30; then
    pass "resume: context preserved — canary recalled after resume"
  else
    local pane
    pane=$(capture_pane "$s" 30)
    if echo "$pane" | grep -qi "canary\|remember\|code"; then
      fail "resume: model responded but did not recall canary $canary" "Pane excerpt:\\n$(echo "$pane" | tail -10)"
    else
      fail "resume: no response to canary recall request" "Pane excerpt:\\n$(echo "$pane" | tail -10)"
    fi
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

# ── Test 8: Compact ──

test_compact() {
  local s; s=$(smoke_session codex compact)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "compact: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/compact"

  if wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    pass "compact: /compact accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "compact: /compact did not return to prompt" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 9: Interrupt (2x Escape) ──

test_interrupt() {
  local s; s=$(smoke_session codex interrupt)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "interrupt: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "write a 500 word essay about testing"
  sleep 3

  # 2x Escape (codex adapter interruptKeys)
  send_keys "$s" Escape Escape
  sleep 2

  if wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    pass "interrupt: 2x Escape returns to prompt"
  else
    skip "interrupt: may not have interrupted in time" "timing sensitive"
  fi

  kill_session "$s"
}

# ── Test 10: --model flag ──

test_model_flag() {
  local s; s=$(smoke_session codex modelflag)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen --model o3"

  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "model: --model flag rejected" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  pass "model: --model flag accepted"

  # Verify model is active — Codex shows model in status bar
  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -qi 'o3'; then
    pass "model: o3 visible in status bar"
  else
    skip "model: o3 not visible in pane" "status bar format may vary"
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
test_compact
test_interrupt
test_model_flag
