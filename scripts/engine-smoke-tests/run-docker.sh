#!/usr/bin/env bash
# Run engine smoke tests inside a Docker container.
#
# The container has its own tmux server (no nesting), a clean env (no
# CLAUDECODE), and mounts $HOME so all host CLI binaries, auth, and
# config resolve at the same paths — no per-tool mount plumbing needed.
#
# Usage:
#   bash scripts/engine-smoke-tests/run-docker.sh              # all engines
#   bash scripts/engine-smoke-tests/run-docker.sh claude        # single engine
#   SMOKE_TIMEOUT=30 bash scripts/engine-smoke-tests/run-docker.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="engine-smoke-tests"

# ── Build image ──

echo "Building smoke test container..."
docker build -q \
  --build-arg "HOST_UID=$(id -u)" \
  --build-arg "HOST_GID=$(id -g)" \
  -t "$IMAGE_NAME" \
  "$SCRIPT_DIR" >/dev/null

# ── Run ──

echo "Running smoke tests in container..."
echo ""
exec docker run --rm \
  --network host \
  -v "$HOME:$HOME" \
  -v "$SCRIPT_DIR:/smoke-tests:ro" \
  -e "HOME=$HOME" \
  -e "PATH=$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e "SMOKE_TIMEOUT=${SMOKE_TIMEOUT:-25}" \
  "$IMAGE_NAME" \
  "$@"
