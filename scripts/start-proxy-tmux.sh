#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION_NAME="${PROXY_SESSION_NAME:-agentic-proxy}"
PROXY_PORT="${PROXY_PORT:-3100}"
PROXY_HEALTH_URL="http://localhost:${PROXY_PORT}/health"
WAIT_HEALTH=false
MAX_WAIT="${PROXY_START_MAX_WAIT:-30}"

if [ "${1:-}" = "--wait-healthy" ]; then
  WAIT_HEALTH=true
fi

info() { echo "[proxy-tmux] $*"; }

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

proxy_is_healthy() {
  curl -sf "$PROXY_HEALTH_URL" >/dev/null
}

show_session_logs() {
  tmux capture-pane -pt "$SESSION_NAME" -S -40 2>/dev/null || true
}

replace_standalone_proxy() {
  if session_exists; then
    return
  fi

  if ! proxy_is_healthy; then
    return
  fi

  info "Replacing existing standalone proxy on port ${PROXY_PORT}"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -tiTCP:${PROXY_PORT} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null || true
      sleep 1
    fi
    return
  fi

  pkill -f 'src/proxy/main.ts' 2>/dev/null || true
  sleep 1
}

start_proxy_session() {
  # Agent sessions are named agent-<name>, so agentic-proxy stays in a separate namespace.
  tmux new-session -d -s "$SESSION_NAME" -c "$ROOT_DIR" 'node src/proxy/main.ts'
}

if session_exists && proxy_is_healthy; then
  info "Proxy already healthy in tmux session ${SESSION_NAME}; skipping restart"
  exit 0
fi

if session_exists; then
  info "Restarting tmux session ${SESSION_NAME}"
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  sleep 1
fi

replace_standalone_proxy
start_proxy_session

if ! session_exists; then
  info "Failed to create tmux session ${SESSION_NAME}"
  exit 1
fi

if [ "$WAIT_HEALTH" != true ]; then
  if proxy_is_healthy; then
    info "Proxy healthy in tmux session ${SESSION_NAME}"
  else
    info "Proxy tmux session ${SESSION_NAME} started; health endpoint not ready yet"
  fi
  exit 0
fi

waited=0
while [ "$waited" -lt "$MAX_WAIT" ]; do
  if proxy_is_healthy; then
    info "Proxy healthy in tmux session ${SESSION_NAME}"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

info "Proxy session ${SESSION_NAME} started but did not become healthy within ${MAX_WAIT}s"
show_session_logs
exit 1
