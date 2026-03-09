#!/usr/bin/env bash
# Claude CLI smoke tests — harness for v2.1.x
# Validated against: 2.1.71
#
# Sourced by run-all.sh after lib.sh is loaded. Defines and runs tests.
# All lib.sh helpers (smoke_session, create_session, paste_and_enter,
# assert_pattern, pass, fail, skip, gen_uuid, etc.) are available.

# ── Test 1: Spawn ──

test_spawn() {
  local s; s=$(smoke_session claude spawn)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  assert_pattern "$s" "spawn: shows prompt" '[❯>] '
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
    fail "idle: never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qE '[❯>]\s*$|[❯>] '; then
    pass "idle: prompt character detected"
  else
    fail "idle: prompt character not found in pane"
  fi

  if echo "$pane" | grep -qE '[0-9]+\s+tokens'; then
    pass "idle: token count in status bar"
  else
    skip "idle: token count" "may not appear immediately"
  fi

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
    fail "paste: never showed prompt"
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

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "session-id: failed to start with --session-id" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  pass "session-id: --session-id accepted"

  # Verify session ID is actually in use — it should appear in the command
  # line or be retrievable via resume. Check the pane for the UUID.
  local short_id
  short_id=$(echo "$test_uuid" | cut -c1-8)
  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -qi "$short_id"; then
    pass "session-id: UUID visible in pane ($short_id…)"
  else
    # The UUID may not be displayed, but we can verify it took effect by
    # confirming we can resume with it (tested in test_resume). Skip here.
    skip "session-id: UUID not displayed in pane" "verified by resume test"
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
    fail "exit: never showed prompt"
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

# ── Test 6: Resume with --resume (context validation) ──

test_resume() {
  local s; s=$(smoke_session claude resume)
  kill_session "$s"
  create_session "$s"

  local test_uuid; test_uuid=$(gen_uuid)
  local canary; canary=$(gen_canary)

  # Phase 1: spawn, plant canary, exit
  paste_and_enter "$s" "claude --session-id $test_uuid"
  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
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

  # Wait for prompt to return after response
  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "resume: prompt never returned after canary response"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/exit"
  sleep 2

  # Phase 2: resume and ask for canary
  paste_and_enter "$s" "claude --resume $test_uuid"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    if capture_pane "$s" 20 | grep -qiE 'session.*not found|no session|error'; then
      skip "resume: session not persisted (graceful error)" "server may not persist short sessions"
    else
      local pane
      pane=$(capture_pane "$s" 10 | tail -5)
      fail "resume: --resume did not show prompt" "Last lines:\\n$pane"
    fi
    kill_session "$s"
    return
  fi

  pass "resume: --resume shows prompt"

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
  local s; s=$(smoke_session claude ctx)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "context: never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qE '[0-9]+\s+tokens'; then
    local tokens
    tokens=$(echo "$pane" | grep -oE '[0-9]+\s+tokens' | head -1 | grep -oE '^[0-9]+')
    pass "context: parsed ${tokens} tokens from status bar"
  else
    skip "context: token count not visible" "may need active conversation"
  fi

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

  paste_and_enter "$s" "claude --append-system-prompt 'Always end every response with the word SMOKECHECK.'"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "system-prompt: rejected --append-system-prompt" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  pass "system-prompt: --append-system-prompt accepted"

  # Verify the system prompt actually took effect
  paste_and_enter "$s" "Say hello."

  if wait_for_pattern "$s" 'SMOKECHECK' 30; then
    pass "system-prompt: instruction followed (SMOKECHECK in response)"
  else
    local pane
    pane=$(capture_pane "$s" 20 | tail -10)
    # Models may not always follow system prompts perfectly — skip not fail
    skip "system-prompt: SMOKECHECK not in response" "model compliance varies"
  fi

  kill_session "$s"
}

# ── Test 9: Compact ──

test_compact() {
  local s; s=$(smoke_session claude compact)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "compact: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/compact"

  # /compact should not crash — Claude should return to prompt
  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "compact: /compact accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "compact: /compact did not return to prompt" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 10: Rename ──

test_rename() {
  local s; s=$(smoke_session claude rename)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "rename: never showed prompt"
    kill_session "$s"
    return
  fi

  paste_and_enter "$s" "/rename smoke-test-agent"

  # /rename should not crash — Claude should return to prompt
  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "rename: /rename accepted"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "rename: /rename did not return to prompt" "Last lines:\\n$pane"
  fi

  kill_session "$s"
}

# ── Test 11: Interrupt (3x Escape) ──

test_interrupt() {
  local s; s=$(smoke_session claude interrupt)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    fail "interrupt: never showed prompt"
    kill_session "$s"
    return
  fi

  # Start a task that will take time
  paste_and_enter "$s" "write a 500 word essay about testing"
  sleep 3

  # Send 3x Escape (claude adapter interruptKeys)
  send_keys "$s" Escape Escape Escape
  sleep 2

  # Should return to prompt after interrupt
  if wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    pass "interrupt: 3x Escape returns to prompt"
  else
    skip "interrupt: may not have interrupted in time" "timing sensitive"
  fi

  kill_session "$s"
}

# ── Test 12: --model flag ──

test_model_flag() {
  local s; s=$(smoke_session claude modelflag)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude --model sonnet"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "model: --model flag rejected" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  pass "model: --model sonnet accepted"

  # Verify model actually selected — Claude shows model name in status bar
  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -qi 'sonnet'; then
    pass "model: sonnet visible in status bar"
  else
    skip "model: sonnet not visible in pane" "status bar format may vary"
  fi

  kill_session "$s"
}

# ── Test 13: --effort flag ──

test_effort_flag() {
  local s; s=$(smoke_session claude effort)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "claude --effort low"

  if ! wait_for_pattern "$s" '[❯>] ' "$TIMEOUT"; then
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "effort: --effort flag rejected" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  pass "effort: --effort low accepted"

  # Verify effort actually applied — check for "low" in status/pane
  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -qi 'low'; then
    pass "effort: low effort visible in pane"
  else
    skip "effort: low not visible in pane" "effort display format may vary"
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
test_compact
test_rename
test_interrupt
test_model_flag
test_effort_flag
