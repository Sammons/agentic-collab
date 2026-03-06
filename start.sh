#!/usr/bin/env bash
set -euo pipefail

# ── Agentic Collab Start Script ──
# Starts the orchestrator (Docker) and proxy (host) with zero configuration.
# Detects OS, package managers, and available tools to give targeted guidance.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors (if terminal supports it)
if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  DIM='\033[0;90m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' DIM='' RESET=''
fi

info()  { echo -e "${GREEN}[start]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[start]${RESET} $*"; }
fail()  { echo -e "${RED}[start]${RESET} $*"; exit 1; }
step()  { echo -e "${BOLD}──── $* ────${RESET}"; }

# ── Platform Detection ──

OS="$(uname -s)"
HAS_MISE=false
HAS_BREW=false
HAS_APT=false

command -v mise &>/dev/null && HAS_MISE=true
command -v brew &>/dev/null && HAS_BREW=true
command -v apt &>/dev/null && HAS_APT=true

# Build install hint for a given tool
# Priority: mise > brew/apt > generic
install_hint() {
  local tool="$1"
  local mise_cmd="${2:-}"
  local brew_cmd="${3:-}"
  local apt_cmd="${4:-}"
  local generic="${5:-}"

  if [ "$HAS_MISE" = true ] && [ -n "$mise_cmd" ]; then
    echo "$mise_cmd"
  elif [ "$OS" = "Darwin" ] && [ "$HAS_BREW" = true ] && [ -n "$brew_cmd" ]; then
    echo "$brew_cmd"
  elif [ "$OS" = "Linux" ] && [ "$HAS_APT" = true ] && [ -n "$apt_cmd" ]; then
    echo "sudo $apt_cmd"
  elif [ -n "$generic" ]; then
    echo "$generic"
  else
    echo "Install $tool using your preferred method"
  fi
}

# ── Prerequisite Checks ──

step "Checking prerequisites ($OS)"

MISSING=()

# Node 24+
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 24 ]; then
    hint=$(install_hint "Node 24" "mise use node@24" "brew install node@24" "" "https://nodejs.org")
    fail "Node.js 24+ required (found $(node -v)). Upgrade: $hint"
  fi
  info "Node.js $(node -v)"
else
  hint=$(install_hint "Node.js" "mise use node@24" "brew install node@24" "apt install nodejs" "https://nodejs.org")
  fail "Node.js 24+ not found. Install: $hint"
fi

# Docker (optional but preferred)
if command -v docker &>/dev/null; then
  info "Docker $(docker --version | grep -oP '\d+\.\d+\.\d+' | head -1)"
else
  hint=$(install_hint "Docker" "" "brew install --cask docker" "apt install docker.io" "https://docs.docker.com/get-docker/")
  warn "Docker not found (optional). Install: $hint"
  warn "Without Docker, the orchestrator runs directly via Node."
fi

# tmux
if command -v tmux &>/dev/null; then
  info "tmux $(tmux -V)"
else
  hint=$(install_hint "tmux" "" "brew install tmux" "apt install tmux" "")
  fail "tmux not found. Install: $hint"
fi

# At least one AI CLI
AI_FOUND=false
for cli in claude codex opencode; do
  if command -v "$cli" &>/dev/null; then
    info "$cli CLI found"
    AI_FOUND=true
  fi
done
if [ "$AI_FOUND" = false ]; then
  warn "No AI CLI found (claude, codex, or opencode). Agents won't be able to spawn."
  if [ "$OS" = "Darwin" ]; then
    warn "  Install Claude: brew install claude"
  else
    warn "  Install Claude: npm install -g @anthropic-ai/claude-code"
  fi
fi

# mise (recommend if missing)
if [ "$HAS_MISE" = true ]; then
  info "mise $(mise --version 2>/dev/null | head -1)"
else
  echo -e "${DIM}  tip: install mise for automatic Node version management: https://mise.jdx.dev${RESET}"
fi

# ── Prepare Config Directory ──

# Pre-create config dir so Docker bind-mount inherits host user ownership.
# Without this, Docker creates it as root and the secret file becomes unreadable.
mkdir -p "${HOME}/.config/agentic-collab"

# ── Activate collab CLI ──

COLLAB_BIN="$SCRIPT_DIR/bin"
if [ -f "$COLLAB_BIN/collab" ]; then
  SHELL_NAME="$(basename "$SHELL")"
  MARKER="# agentic-collab CLI"
  FISH_MARKER="# agentic-collab CLI"

  case "$SHELL_NAME" in
    zsh)
      RC_FILE="$HOME/.zshrc"
      ;;
    bash)
      # macOS login shells source .bash_profile, not .bashrc.
      # Most Linux .bash_profile / .profile sources .bashrc, but not always.
      # Write to .bashrc and ensure .bash_profile sources it on macOS.
      RC_FILE="$HOME/.bashrc"
      if [ "$OS" = "Darwin" ] && [ -f "$HOME/.bash_profile" ]; then
        if ! grep -qF '.bashrc' "$HOME/.bash_profile" 2>/dev/null; then
          echo "" >> "$HOME/.bash_profile"
          echo '# Source .bashrc for login shells' >> "$HOME/.bash_profile"
          echo '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"' >> "$HOME/.bash_profile"
          info "Added .bashrc sourcing to .bash_profile (macOS login shell fix)"
        fi
      fi
      ;;
    fish)
      FISH_CONF="$HOME/.config/fish/config.fish"
      mkdir -p "$(dirname "$FISH_CONF")"
      if ! grep -qF "$FISH_MARKER" "$FISH_CONF" 2>/dev/null; then
        echo "" >> "$FISH_CONF"
        echo "$FISH_MARKER" >> "$FISH_CONF"
        echo "fish_add_path $COLLAB_BIN" >> "$FISH_CONF"
        info "Added collab CLI to PATH in $FISH_CONF"
      else
        info "collab CLI already in $FISH_CONF"
      fi
      RC_FILE=""  # already handled
      ;;
    *)
      RC_FILE=""
      warn "Unknown shell '$SHELL_NAME' — add $COLLAB_BIN to your PATH manually"
      ;;
  esac

  if [ -n "${RC_FILE:-}" ]; then
    if ! grep -qF "$MARKER" "$RC_FILE" 2>/dev/null; then
      echo "" >> "$RC_FILE"
      echo "$MARKER" >> "$RC_FILE"
      echo "export PATH=\"$COLLAB_BIN:\$PATH\"" >> "$RC_FILE"
      info "Added collab CLI to PATH in $RC_FILE"
      info "  Run 'source $RC_FILE' or start a new shell to activate"
    else
      info "collab CLI already in $RC_FILE"
    fi
  fi

  # Also activate for this session
  export PATH="$COLLAB_BIN:$PATH"
fi

# ── Start Orchestrator ──

step "Starting orchestrator"

if command -v docker &>/dev/null; then
  if docker compose version &>/dev/null 2>&1; then
    # Export UID/GID so docker-compose.yml user: "${UID}:${GID}" runs as the host user.
    # This ensures secret files created inside the container are owned by the host user.
    export UID GID="$(id -g)"
    if docker compose ps --status running 2>/dev/null | grep -q orchestrator; then
      info "Orchestrator already running"
    else
      docker compose up -d --build
      info "Orchestrator starting via Docker Compose"
    fi
  else
    hint=$(install_hint "Docker Compose" "" "brew install docker-compose" "apt install docker-compose-v2" "")
    fail "Docker Compose not available. Install: $hint"
  fi
else
  warn "Running orchestrator directly (no Docker)."
  node src/orchestrator/main.ts &
  ORCH_PID=$!
  info "Orchestrator PID: $ORCH_PID"
fi

# ── Wait for Orchestrator Health ──

step "Waiting for orchestrator"

MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf http://localhost:3000/api/orchestrator/status &>/dev/null; then
    info "Orchestrator healthy"
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
  if [ $((WAITED % 5)) -eq 0 ]; then
    echo -e "${DIM}  ... waiting ($WAITED/${MAX_WAIT}s)${RESET}"
  fi
done

if [ $WAITED -ge $MAX_WAIT ]; then
  fail "Orchestrator did not become healthy within ${MAX_WAIT}s"
fi

# ── Start Proxy ──

step "Starting proxy"

info "Dashboard: http://localhost:3000/dashboard"
info "Press Ctrl+C to stop the proxy"
echo ""

# Prefer mise if it has the proxy task available (requires trusted config).
# Fall back to direct node invocation otherwise.
if [ "$HAS_MISE" = true ] && mise task ls 2>/dev/null | grep -q '^proxy '; then
  exec mise run proxy
else
  exec node src/proxy/main.ts
fi
