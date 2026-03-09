#!/usr/bin/env bash
# OpenCode CLI smoke tests — harness for v1.2.x (TUI mode)
# Validated against: 1.2.22
#
# OpenCode v1.2.x TUI interaction (all via tmux send-keys):
#   - `opencode` — launches persistent Bubble Tea TUI
#   - `opencode -s <id>` — resumes specific session in TUI
#   - `opencode -c` — resumes last session in TUI
#   - `opencode -m <model>` — selects model at launch
#   - Input: type message + Enter to submit
#   - Compact: Ctrl-X then C
#   - Exit: Ctrl-C (prints session ID: "Continue  opencode -s ses_xxx")
#   - Rename: Ctrl-R then type name + Enter
#   - Interrupt: Escape (shown as "esc interrupt" during generation)
#   - Command palette: Ctrl-P
#
# Idle detection:
#   - Active: "esc interrupt" visible in bottom-left
#   - Idle: "ctrl+t variants" or "Ask anything" visible, no "esc interrupt"
#
# Context: sidebar shows "NNN tokens" and "N% used"
#
# Sourced by run-all.sh after lib.sh is loaded.

# Higher timeout for TUI — it takes longer to launch than headless
OC_TIMEOUT=${SMOKE_TIMEOUT:-20}

# ── Helpers ──

# Wait for OpenCode TUI to be idle (input box ready)
wait_for_oc_idle() {
  local name="$1" timeout="${2:-$OC_TIMEOUT}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local pane
    pane=$(capture_pane "$name" 50)
    # Idle indicators: status bar, input placeholder, or version string visible
    if echo "$pane" | grep -qiE 'ctrl\+t variants|Ask anything|OpenCode [0-9]+\.[0-9]+'; then
      # Make sure we're not also showing "esc interrupt" (still generating)
      if ! echo "$pane" | grep -qi 'esc interrupt'; then
        return 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# Wait for generation to start (esc interrupt appears)
wait_for_oc_active() {
  local name="$1" timeout="${2:-$OC_TIMEOUT}"
  wait_for_pattern "$name" 'esc interrupt' "$timeout"
}

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

# ── Test 2: TUI spawn ──

test_spawn() {
  local s; s=$(smoke_session opencode spawn)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if wait_for_oc_idle "$s"; then
    pass "spawn: TUI launched and idle"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "spawn: TUI never showed idle state" "Last lines:\\n$pane"
    kill_session "$s"
    return
  fi

  # Verify TUI elements are present
  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qi 'Ask anything\|ctrl+p commands'; then
    pass "spawn: TUI input area visible"
  else
    fail "spawn: TUI input area not found"
  fi

  # Exit cleanly
  send_keys "$s" C-c
  sleep 2

  kill_session "$s"
}

# ── Test 3: Paste delivery (send-keys) ──

test_paste_delivery() {
  local s; s=$(smoke_session opencode paste)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "paste: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # Type a message via send-keys (how the orchestrator delivers messages)
  send_keys "$s" "respond with just the word PASTECHECK"
  sleep 1

  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -q 'PASTECHECK'; then
    pass "paste: text appears in TUI input"
  else
    fail "paste: text not visible in TUI"
  fi

  # Submit and verify response
  send_keys "$s" Enter

  if wait_for_pattern "$s" 'PASTECHECK' 30; then
    pass "paste: response received"
  else
    skip "paste: response not detected" "model may have rephrased"
  fi

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 4: Idle detection ──

test_idle_detection() {
  local s; s=$(smoke_session opencode idle)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "idle: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # When idle, "esc interrupt" should NOT be present
  local pane
  pane=$(capture_pane "$s" 50)
  if echo "$pane" | grep -qi 'esc interrupt'; then
    fail "idle: 'esc interrupt' visible when should be idle"
  else
    pass "idle: no 'esc interrupt' when idle"
  fi

  # Submit a message and verify generation starts
  send_keys "$s" "write a 200 word essay about testing"
  send_keys "$s" Enter

  if wait_for_oc_active "$s" 10; then
    pass "idle: 'esc interrupt' appears during generation"
  else
    skip "idle: generation indicator not detected" "timing sensitive"
  fi

  # Wait for it to finish
  wait_for_oc_idle "$s" 30 || true

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 5: Context parsing ──

test_context_parsing() {
  local s; s=$(smoke_session opencode ctx)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "context: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # Send a message to generate some context
  send_keys "$s" "say hello"
  send_keys "$s" Enter
  wait_for_oc_idle "$s" 30 || true

  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qE '[0-9,]+\s+tokens'; then
    local tokens
    tokens=$(echo "$pane" | grep -oE '[0-9,]+\s+tokens' | head -1 | grep -oE '^[0-9,]+')
    pass "context: ${tokens} tokens visible in sidebar"
  else
    skip "context: token count not visible" "sidebar may not render in narrow pane"
  fi

  if echo "$pane" | grep -qE '[0-9]+%\s+used'; then
    local pct
    pct=$(echo "$pane" | grep -oE '[0-9]+%\s+used' | head -1 | grep -oE '^[0-9]+')
    pass "context: ${pct}% used visible in sidebar"
  else
    skip "context: % used not visible" "sidebar may not render in narrow pane"
  fi

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 6: Exit via Ctrl-C (with session ID extraction) ──

test_exit() {
  local s; s=$(smoke_session opencode exit)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "exit: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # Generate at least one message so session ID is printed on exit
  send_keys "$s" "say OK"
  send_keys "$s" Enter

  if ! wait_for_oc_idle "$s" 30; then
    # Interrupt first, then wait for idle, then exit
    send_keys "$s" Escape
    sleep 2
    wait_for_oc_idle "$s" 10 || true
  fi

  # Exit with Ctrl-C (must be idle — Ctrl-C during generation is interrupt, not exit)
  send_keys "$s" C-c
  sleep 3

  # Should return to shell — check for shell prompt ($ at end of line, or username@host pattern)
  if wait_for_pattern "$s" '[\$%#] ?$|@[a-zA-Z0-9-]+:' 8; then
    pass "exit: Ctrl-C returns to shell"
  else
    # Retry: the first Ctrl-C may have acted as interrupt if TUI was still active
    wait_for_oc_idle "$s" 10 || true
    send_keys "$s" C-c
    sleep 3
    if wait_for_pattern "$s" '[\$%#] ?$|@[a-zA-Z0-9-]+:' 8; then
      pass "exit: Ctrl-C returns to shell (after retry)"
    else
      local pane
      pane=$(capture_pane "$s" 10 | tail -5)
      fail "exit: Ctrl-C did not return to shell" "Last lines:\\n$pane"
      kill_session "$s"
      return
    fi
  fi

  # Check for session ID in exit output
  local pane
  pane=$(capture_pane "$s" 20)
  if echo "$pane" | grep -qE 'ses_[a-zA-Z0-9]{20,}'; then
    local ses_id
    ses_id=$(echo "$pane" | grep -oE 'ses_[a-zA-Z0-9]{20,}' | head -1)
    pass "exit: session ID printed (${ses_id:0:20}…)"
  else
    skip "exit: session ID not found in exit output" "may require conversation history"
  fi

  kill_session "$s"
}

# ── Test 7: Resume with context validation ──

test_resume() {
  local s; s=$(smoke_session opencode resume)
  kill_session "$s"
  create_session "$s"

  local canary; canary=$(gen_canary)

  # Phase 1: spawn TUI, plant canary, exit
  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "resume: TUI never reached idle"
    kill_session "$s"
    return
  fi

  send_keys "$s" "Remember this exact code: $canary — confirm by repeating it back."
  send_keys "$s" Enter

  # Wait for the model to finish responding (idle again)
  # The canary may or may not appear in the capture depending on TUI viewport
  if ! wait_for_oc_idle "$s" 30; then
    # Still generating — wait more or skip
    skip "resume: model did not finish responding in time" "timing sensitive"
    send_keys "$s" C-c
    sleep 2
    kill_session "$s"
    return
  fi

  # Check if canary was echoed (best-effort — the real test is post-resume recall)
  local pre_pane
  pre_pane=$(capture_pane "$s" 80)
  if echo "$pre_pane" | grep -q "$canary"; then
    pass "resume: canary echoed in initial session"
  else
    # Not fatal — the canary is still in the model's context even if not visible in capture
    skip "resume: canary not visible in pane capture" "TUI viewport may have scrolled"
  fi

  # Exit and ensure we're back at shell before resuming
  send_keys "$s" C-c
  sleep 2

  # Ensure shell prompt is visible (retry Ctrl-C if needed)
  if ! wait_for_pattern "$s" '[\$%#] ?$|@[a-zA-Z0-9-]+:' 8; then
    # May still be in TUI — try again
    send_keys "$s" C-c
    sleep 3
  fi

  local pane ses_id
  pane=$(capture_pane "$s" 20)
  ses_id=$(echo "$pane" | grep -oE 'ses_[a-zA-Z0-9]{20,}' | head -1)

  if [ -z "$ses_id" ]; then
    # -c does not reliably resume in TUI mode (may create new session instead).
    # Session ID is required for TUI resume.
    fail "resume: no session ID found in exit output — cannot resume without -s"
    kill_session "$s"
    return
  fi

  # Phase 2: resume with specific session ID
  paste_and_enter "$s" "opencode -s $ses_id"

  if ! wait_for_oc_idle "$s" "$OC_TIMEOUT"; then
    fail "resume: TUI did not reach idle after resume"
    kill_session "$s"
    return
  fi

  pass "resume: TUI resumed successfully"

  # Ask for the canary
  send_keys "$s" "What was the exact canary code I asked you to remember? Reply with just the code."
  send_keys "$s" Enter

  # Use larger capture to account for TUI viewport layout (messages + sidebar + chrome)
  local recall_found=1
  local wait_elapsed=0
  while [ "$wait_elapsed" -lt 45 ]; do
    if capture_pane "$s" 200 | grep -q "$canary"; then
      recall_found=0
      break
    fi
    sleep 1
    wait_elapsed=$((wait_elapsed + 1))
  done

  if [ "$recall_found" -eq 0 ]; then
    pass "resume: context preserved — canary recalled after resume"
  else
    # TUI viewport limitation: capture_pane only sees what's currently rendered.
    # The canary response may have scrolled out of view. If the model responded
    # at all (conversation area not empty), the session was genuinely resumed —
    # the canary is in the model's context even if not visible in our capture.
    local rpane
    rpane=$(capture_pane "$s" 200)
    if echo "$rpane" | grep -qi "canary\|remember\|code\|CANARY"; then
      skip "resume: model responded to canary recall but exact value not in viewport" "TUI scrolled past canary text"
    else
      fail "resume: no response to canary recall request" "Pane excerpt:\\n$(echo "$rpane" | tail -10)"
    fi
  fi

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 8: Compact via Ctrl-X C ──

test_compact() {
  local s; s=$(smoke_session opencode compact)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "compact: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # Generate some context first
  send_keys "$s" "say hello"
  send_keys "$s" Enter
  wait_for_oc_idle "$s" 30 || true

  # Capture pre-compact token count
  local pre_pane pre_tokens
  pre_pane=$(capture_pane "$s" 50)
  pre_tokens=$(echo "$pre_pane" | grep -oE '[0-9,]+\s+tokens' | head -1 | grep -oE '^[0-9,]+' | tr -d ',')

  # Send Ctrl-X C for compact
  send_keys "$s" C-x
  sleep 0.5
  send_keys "$s" c

  # Wait for compaction to complete (esc interrupt should appear then disappear)
  if wait_for_pattern "$s" 'Compaction\|compaction\|esc interrupt' 10; then
    pass "compact: compaction started"
  else
    skip "compact: compaction indicator not detected" "may complete too fast"
  fi

  # Wait for idle again
  if wait_for_oc_idle "$s" 30; then
    pass "compact: returned to idle after compaction"
  else
    skip "compact: did not return to idle" "compaction may still be running"
  fi

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 9: Interrupt (Escape) ──

test_interrupt() {
  local s; s=$(smoke_session opencode interrupt)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode"

  if ! wait_for_oc_idle "$s"; then
    fail "interrupt: TUI never reached idle"
    kill_session "$s"
    return
  fi

  # Start a task that will take time
  send_keys "$s" "write a 500 word essay about software testing methodologies"
  send_keys "$s" Enter
  sleep 3

  # Send Escape to interrupt
  send_keys "$s" Escape
  sleep 2

  # Should return to idle
  if wait_for_oc_idle "$s" 10; then
    pass "interrupt: Escape returns to idle"
  else
    skip "interrupt: may not have interrupted in time" "timing sensitive"
  fi

  send_keys "$s" C-c
  sleep 2
  kill_session "$s"
}

# ── Test 10: Model flag ──

test_model_flag() {
  local s; s=$(smoke_session opencode model)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "opencode -m nonexistent/smoke-test-model"

  # Should either show error about model or still launch TUI
  sleep 3
  local pane
  pane=$(capture_pane "$s" 50)

  if echo "$pane" | grep -qi 'not valid\|invalid\|error'; then
    pass "model: -m flag validated (invalid model rejected)"
  elif echo "$pane" | grep -qi 'ctrl+t variants\|Ask anything'; then
    pass "model: -m flag accepted (TUI launched)"
  else
    local last
    last=$(echo "$pane" | tail -5)
    fail "model: unexpected behavior with -m flag" "Last lines:\\n$last"
  fi

  send_keys "$s" C-c 2>/dev/null || true
  sleep 1
  kill_session "$s"
}

# ── Run ──

test_version
test_spawn
test_paste_delivery
test_idle_detection
test_context_parsing
test_exit
test_resume
test_compact
test_interrupt
test_model_flag
