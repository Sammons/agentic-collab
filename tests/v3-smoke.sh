#!/usr/bin/env bash
# v3 end-to-end smoke (shell-only).
#
# Exercises orchestrator + proxy machinery end-to-end without an LLM:
#   publish to topic:test-echo/echo
#   → prepare creates worktree
#   → create_session against cwd_base
#   → start hook pastes bash $WORKTREE_PATH/start.sh
#   → start.sh writes $REPLY_PATH + $STATUS_PATH and calls `collab complete`
#   → reaper / completion endpoint routes reply
#   → kill_session + cleanup
#
# Assumes the orchestrator + proxy are already running on this host.
# Real-engine validation is deferred to a human follow-up.
#
# Exit codes:
#   0  smoke passed
#   1  pre-check or setup failure (tooling issue, not a kernel bug)
#   2  assertion failure (kernel bug)

set -euo pipefail

# ── Tunables ────────────────────────────────────────────────
ORCH_URL="${ORCHESTRATOR_URL:-http://localhost:3000}"
TIMEOUT_S="${V3_SMOKE_TIMEOUT_S:-60}"
REPO="${V3_SMOKE_REPO:-/tmp/agentic-test/test-echo}"
PERSONAS_DIR_SMOKE="${V3_SMOKE_PERSONAS_DIR:-/tmp/agentic-test/personas}"

# Where the orchestrator writes its SQLite DB. The smoke needs to read the
# pending_messages table directly to assert no prefix leakage.
DB_PATH="${DB_PATH:-${HOME}/.config/agentic-collab/agentic.db}"

# ── Pre-checks ──────────────────────────────────────────────
# bin/collab must be on PATH AND inside tmux sessions the proxy spawns.
# If not, the smoke fails for a tooling reason that looks like a kernel bug.
command -v collab >/dev/null || { echo "FAIL: collab not on PATH"; exit 1; }
command -v node    >/dev/null || { echo "FAIL: node not on PATH"; exit 1; }
command -v sqlite3 >/dev/null || { echo "FAIL: sqlite3 not on PATH"; exit 1; }
command -v git     >/dev/null || { echo "FAIL: git not on PATH"; exit 1; }
command -v tmux    >/dev/null || { echo "FAIL: tmux not on PATH"; exit 1; }

# Verify orchestrator is reachable.
if ! curl -sf "${ORCH_URL}/api/orchestrator/status" >/dev/null; then
  echo "FAIL: orchestrator unreachable at ${ORCH_URL}"; exit 1
fi

# ── Throwaway repo ──────────────────────────────────────────
rm -rf "$REPO"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "init"

# Write the start script INSIDE the repo so it's available in every worktree
# git creates from this repo. Avoids long-line paste issues entirely.
cat > "$REPO/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$WORKTREE_PATH"
# Pure-Node JSON construction. Node 24 is a hard project dep — no jq.
REPLY_JSON=$(node -e '
  const fs = require("fs");
  const payload = JSON.parse(fs.readFileSync(process.env.MESSAGE_PATH, "utf8"));
  process.stdout.write(JSON.stringify({ echoed: payload }));
')
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.env.REPLY_PATH, process.argv[1]);
  fs.writeFileSync(process.env.STATUS_PATH, "ok\n");
' "$REPLY_JSON"
collab complete --reply "$REPLY_JSON"
EOF
chmod +x "$REPO/start.sh"
git -C "$REPO" add . && git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m "smoke start.sh"

# ── Template registration ───────────────────────────────────
# Q2 reads from PERSONAS_DIR; write the ephemeral template there.
mkdir -p "$PERSONAS_DIR_SMOKE"
cat > "$PERSONAS_DIR_SMOKE/test-echo.md" <<EOF
---
id: test-echo
persistent: false
engine: claude
cwd_base: $REPO
cwd_template: $REPO/wt-{{message_id}}
repo_root: $REPO
prepare: |
  git -C "\$REPO_ROOT" worktree add "\$WORKTREE_PATH" main
cleanup: |
  git -C "\$REPO_ROOT" worktree remove --force "\$WORKTREE_PATH" || true
start: |
  bash "\$WORKTREE_PATH/start.sh"
topics:
  - name: echo
    concurrency: 1
---
# test-echo

Smoke template — echoes incoming payload as the reply.
EOF

# Ask orchestrator to reload personas so the template registers in agent_templates.
curl -sf -X POST "${ORCH_URL}/api/personas/reload" >/dev/null || {
  echo "FAIL: persona reload endpoint rejected request"; exit 1
}

# ── Publish + wait ──────────────────────────────────────────
# The smoke uses the orchestrator's HTTP API directly to avoid coupling to
# bin/collab's UX.
PAYLOAD='{"msg":"hello"}'
RESP=$(curl -sf -X POST "${ORCH_URL}/api/topics/publish" \
  -H 'content-type: application/json' \
  -d "{\"to\":\"topic:test-echo/echo\",\"payload\":${PAYLOAD},\"replyTo\":\"smoke-harness\"}")
MESSAGE_ID=$(node -e "console.log(JSON.parse(process.argv[1]).messageId || process.argv[1])" "$RESP")
if [ -z "$MESSAGE_ID" ] || [ "$MESSAGE_ID" = "undefined" ]; then
  echo "FAIL: publish did not return messageId. Response: $RESP"; exit 2
fi

echo "smoke: published $MESSAGE_ID, waiting up to ${TIMEOUT_S}s for completion"

# Poll for instance row reaching terminal state.
START_T=$(date +%s)
INSTANCE_STATE=""
while [ $(( $(date +%s) - START_T )) -lt "$TIMEOUT_S" ]; do
  INSTANCE_STATE=$(sqlite3 "$DB_PATH" "SELECT state FROM agent_instances WHERE id IN (SELECT claimed_by_instance FROM topic_queue WHERE message_id='${MESSAGE_ID}') LIMIT 1" 2>/dev/null || echo "")
  case "$INSTANCE_STATE" in
    completed|failed) break ;;
  esac
  sleep 1
done

if [ "$INSTANCE_STATE" != "completed" ]; then
  echo "FAIL: instance did not reach 'completed' (state='$INSTANCE_STATE')"; exit 2
fi

# ── Assertions ──────────────────────────────────────────────
# 1. agent_instances row has completed_at set
COMPLETED_AT=$(sqlite3 "$DB_PATH" "SELECT completed_at FROM agent_instances WHERE id IN (SELECT claimed_by_instance FROM topic_queue WHERE message_id='${MESSAGE_ID}') LIMIT 1")
if [ -z "$COMPLETED_AT" ]; then
  echo "FAIL: completed_at not set on instance"; exit 2
fi

# 2. Worktree dir was cleaned up
if compgen -G "${REPO}/wt-*" >/dev/null; then
  echo "FAIL: leftover worktree directory: $(ls -d ${REPO}/wt-* 2>/dev/null)"; exit 2
fi

# 3. No tmux session left for this instance
INSTANCE_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM agent_instances WHERE id IN (SELECT claimed_by_instance FROM topic_queue WHERE message_id='${MESSAGE_ID}') LIMIT 1")
if tmux has-session -t "test-echo-${INSTANCE_ID}" 2>/dev/null; then
  echo "FAIL: leftover tmux session test-echo-${INSTANCE_ID}"; exit 2
fi

# 4. pending_messages.target_agent has no prefix leakage from this run
LEAK_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM pending_messages WHERE target_agent LIKE 'agent:%' OR target_agent LIKE 'topic:%' OR target_agent LIKE 'approval:%'")
if [ "$LEAK_COUNT" != "0" ]; then
  echo "FAIL: prefix leakage in pending_messages.target_agent (count=${LEAK_COUNT})"; exit 2
fi

# 5. agents-table schema unchanged vs BASELINE_AGENTS_SCHEMA (compare column set; ignore order)
EXPECTED_AGENT_COLS="name engine model thinking cwd persona permissions proxy_host state state_before_shutdown current_session_id tmux_session proxy_id last_activity last_context_pct reload_queued reload_task failed_at failure_reason version spawn_count created_at sort_order hook_spawn hook_start captured_vars agent_group account launch_env hook_resume hook_compact hook_exit hook_interrupt hook_submit custom_buttons indicators icon"
ACTUAL_AGENT_COLS=$(sqlite3 "$DB_PATH" "PRAGMA table_info(agents)" | cut -d'|' -f2 | sort | tr '\n' ' ')
EXPECTED_SORTED=$(echo "$EXPECTED_AGENT_COLS" | tr ' ' '\n' | sort | tr '\n' ' ')
if [ "$ACTUAL_AGENT_COLS" != "$EXPECTED_SORTED" ]; then
  echo "FAIL: agents-table column set changed"
  echo "  expected: $EXPECTED_SORTED"
  echo "  actual:   $ACTUAL_AGENT_COLS"
  exit 2
fi

# 6. Reply was routed back to smoke-harness — find the reply envelope
REPLY_ROW=$(sqlite3 "$DB_PATH" "SELECT envelope FROM pending_messages WHERE target_agent='smoke-harness' ORDER BY id DESC LIMIT 1")
if ! echo "$REPLY_ROW" | grep -q '"echoed"'; then
  echo "FAIL: reply did not contain echoed payload. Got: $REPLY_ROW"; exit 2
fi

echo "smoke: PASS (instance=${INSTANCE_ID}, message=${MESSAGE_ID})"
