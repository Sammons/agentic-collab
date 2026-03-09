#!/usr/bin/env bash
# Smoke tests for Codex CLI — validates adapter assumptions match reality.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

require_engine codex || exit 0

echo ""
echo "══════════════════════════════════════"
echo "  Codex CLI Smoke Tests"
echo "══════════════════════════════════════"

# ── Test 1: Spawn with --no-alt-screen ──

test_spawn() {
  local s; s=$(smoke_session codex spawn)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  # Should see the Codex TUI prompt (› or ❯ or >), NOT bash PS2
  # Adapter pattern: /^[›❯>]\s/ (codex.ts:97)
  assert_pattern "$s" "spawn: Codex starts and shows prompt" '[›❯>] '

  # Negative: no bash errors
  assert_no_pattern "$s" "spawn: no 'command not found'" 'command not found'

  kill_session "$s"
}

# ── Test 2: Idle detection patterns ──

test_idle_detection() {
  local s; s=$(smoke_session codex idle)
  kill_session "$s"
  create_session "$s"

  paste_and_enter "$s" "codex --no-alt-screen"

  # Wait for prompt
  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "idle: Codex never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  # Status bar should show "% left" (codex.ts:82)
  if echo "$pane" | grep -qE '[0-9]+%\s+(context\s+)?left'; then
    pass "idle: status bar shows % left"
  else
    # May not appear immediately on fresh session with no context used
    skip "idle: status bar % left" "not visible on fresh session"
  fi

  # Prompt character should be present
  if echo "$pane" | grep -qE '^[›❯>]\s'; then
    pass "idle: prompt character detected"
  else
    fail "idle: prompt character not found"
  fi

  # Working indicator should NOT be present when idle
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
    fail "paste: Codex never showed prompt"
    kill_session "$s"
    return
  fi

  # Paste a recognizable string
  paste_and_enter "$s" "echo SMOKE_TEST_MARKER_12345"

  # The text should appear in the pane (either in the prompt or as submitted input)
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

  # Backup existing config if present
  if [ -f "$config_path" ]; then
    backup=$(cat "$config_path")
  fi

  # Write test profile using same TOML triple-quoted format as proxy
  mkdir -p "$(dirname "$config_path")"
  local existing=""
  [ -f "$config_path" ] && existing=$(cat "$config_path")

  # Append profile (same approach as writeCodexProfile in proxy/main.ts)
  cat >> "$config_path" <<'PROFILE'

[profiles.smoke-test-profile]
developer_instructions = """
You are a smoke test assistant. Respond with SMOKE_PROFILE_OK.
"""
PROFILE

  create_session "$s"
  paste_and_enter "$s" "codex --no-alt-screen -p $profile_name"

  # Should start with the profile loaded (shows prompt, not an error)
  if wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    pass "profile: Codex starts with -p flag"
  else
    local pane
    pane=$(capture_pane "$s" 10 | tail -5)
    fail "profile: Codex failed to start with -p flag" "Last lines:\\n$pane"
  fi

  # Cleanup: restore config
  kill_session "$s"
  if [ -n "$backup" ]; then
    echo "$backup" > "$config_path"
  else
    # Remove the profile section we added
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
    fail "exit: Codex never showed prompt"
    kill_session "$s"
    return
  fi

  # Send /exit (codex.ts buildExitCommand)
  paste_and_enter "$s" "/exit"

  # Should return to shell prompt ($ or %)
  if wait_for_pattern "$s" '[\$%#] ?$' "$TIMEOUT"; then
    pass "exit: /exit returns to shell"
  else
    # Codex may just close the session entirely
    if ! has_session "$s"; then
      pass "exit: /exit terminated session"
    else
      fail "exit: /exit did not return to shell or close session"
    fi
  fi

  kill_session "$s"
}

# ── Test 6: Resume with --last ──

test_resume_last() {
  local s; s=$(smoke_session codex resume)
  kill_session "$s"
  create_session "$s"

  # First spawn a session so there's something to resume
  paste_and_enter "$s" "codex --no-alt-screen"
  if ! wait_for_pattern "$s" '[›❯>] ' "$TIMEOUT"; then
    fail "resume: initial spawn failed"
    kill_session "$s"
    return
  fi

  # Exit it
  paste_and_enter "$s" "/exit"
  sleep 2

  # Resume with --last (codex.ts:55-57)
  paste_and_enter "$s" "codex --no-alt-screen resume --last"

  # Should either resume successfully (prompt) or show a graceful error
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
    fail "context: Codex never showed prompt"
    kill_session "$s"
    return
  fi

  local pane
  pane=$(capture_pane "$s" 50)

  # Pattern from parseContextPercent (codex.ts:111): /(\d+)%\s+(?:context\s+)?left/
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

print_summary "Codex"
