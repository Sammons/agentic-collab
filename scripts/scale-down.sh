#!/usr/bin/env bash
# Tear down an agent instance previously created by scale-up.sh.
#
# Usage:
#   ./scripts/scale-down.sh <agent-name> [--keep-branch] [--force]
#
# Examples:
#   ./scripts/scale-down.sh dev-a
#   ./scripts/scale-down.sh dev-a --keep-branch     # remove worktree + persona, keep the git branch
#   ./scripts/scale-down.sh dev-a --force            # discard uncommitted changes in the worktree
#
# What it does:
#   1. POSTs /api/agents/<name>/destroy on the orchestrator. This:
#      - Kills the tmux session
#      - Removes the agent's DB row
#      - DELETES the persona file (per /api/agents/:name/destroy contract)
#   2. Removes the git worktree at <repo>-worktrees/<name>.
#   3. Unless --keep-branch is passed, deletes the local branch the worktree was on.
#
# Safety:
#   - Refuses to run if the worktree has uncommitted changes (use --force to override).
#   - Always preserves remote branches and pushed commits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PERSONAS_DIR="${PERSONAS_DIR_OVERRIDE:-$REPO_ROOT/persistent-agents}"

KEEP_BRANCH=false
FORCE=false
AGENT_NAME=""

for arg in "$@"; do
  case "$arg" in
    --keep-branch) KEEP_BRANCH=true ;;
    --force) FORCE=true ;;
    -h|--help)
      echo "Usage: $0 <agent-name> [--keep-branch] [--force]"
      exit 0
      ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)
      if [ -z "$AGENT_NAME" ]; then AGENT_NAME="$arg"
      else echo "Unexpected positional: $arg" >&2; exit 1; fi
      ;;
  esac
done

if [ -z "$AGENT_NAME" ]; then
  echo "Usage: $0 <agent-name> [--keep-branch] [--force]" >&2
  exit 1
fi

PERSONA_FILE="$PERSONAS_DIR/${AGENT_NAME}.md"
if [ ! -f "$PERSONA_FILE" ]; then
  echo "ERROR: Persona file not found: $PERSONA_FILE" >&2
  echo "       Either the agent was already torn down, or the name is wrong." >&2
  exit 1
fi

# Pull cwd from frontmatter — we need it to find the worktree.
WORKTREE_PATH=$(awk '/^---$/{c++; next} c==1 && /^cwd:[[:space:]]+/{sub(/^cwd:[[:space:]]+/,""); print; exit}' "$PERSONA_FILE")

if [ -z "$WORKTREE_PATH" ]; then
  echo "ERROR: Could not read 'cwd:' from $PERSONA_FILE" >&2
  exit 1
fi

# Confirm this is actually a worktree we created (sibling -worktrees dir).
case "$WORKTREE_PATH" in
  *-worktrees/*) : ;;
  *)
    echo "ERROR: cwd ($WORKTREE_PATH) does not look like a scale-up worktree." >&2
    echo "       Expected path under <repo>-worktrees/. Refusing to tear down." >&2
    exit 1
    ;;
esac

# Identify the source repo (parent of -worktrees dir).
WORKTREE_PARENT="$(dirname "$WORKTREE_PATH")"
SOURCE_REPO="${WORKTREE_PARENT%-worktrees}"

if [ ! -d "$SOURCE_REPO/.git" ]; then
  echo "ERROR: Cannot locate source repo (expected $SOURCE_REPO/.git)" >&2
  exit 1
fi

# Detect the branch the worktree is on (so we can optionally delete it).
BRANCH=""
if [ -d "$WORKTREE_PATH" ]; then
  BRANCH="$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

# Safety: check for uncommitted changes.
if [ "$FORCE" = false ] && [ -d "$WORKTREE_PATH" ]; then
  if ! git -C "$WORKTREE_PATH" diff --quiet HEAD 2>/dev/null || \
     [ -n "$(git -C "$WORKTREE_PATH" status --porcelain 2>/dev/null)" ]; then
    echo "ERROR: Worktree has uncommitted changes: $WORKTREE_PATH" >&2
    echo "       Commit/push them, stash, or pass --force to discard." >&2
    exit 1
  fi
fi

# Step 1: tell orchestrator to destroy the agent.
SECRET_FILE="${SECRET_FILE_OVERRIDE:-$HOME/.config/agentic-collab/secret}"
SECRET=""
if [ -f "$SECRET_FILE" ]; then
  SECRET="$(cat "$SECRET_FILE")"
fi

PORT="${ORCHESTRATOR_PORT:-3000}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:${PORT}}"

if [ -n "$SECRET" ]; then
  echo "[scale-down] Destroying agent '$AGENT_NAME' via orchestrator..."
  HTTP_CODE=$(curl -s -o /tmp/scale-down.out -w "%{http_code}" \
    -X POST -H "Authorization: Bearer $SECRET" \
    "${ORCHESTRATOR_URL}/api/agents/${AGENT_NAME}/destroy" || echo "000")

  if [ "$HTTP_CODE" != "200" ]; then
    echo "WARNING: destroy returned HTTP $HTTP_CODE — orchestrator may not be running."
    echo "         Continuing with worktree cleanup."
  fi
else
  echo "[scale-down] No orchestrator secret found at $SECRET_FILE — skipping destroy API call."
fi

# Step 2: remove the worktree.
echo "[scale-down] Removing worktree at $WORKTREE_PATH..."
if [ -d "$WORKTREE_PATH" ]; then
  if [ "$FORCE" = true ]; then
    git -C "$SOURCE_REPO" worktree remove --force "$WORKTREE_PATH"
  else
    git -C "$SOURCE_REPO" worktree remove "$WORKTREE_PATH"
  fi
fi

# Step 3: optionally delete the local branch.
if [ "$KEEP_BRANCH" = false ] && [ -n "$BRANCH" ] && [ "$BRANCH" != "develop" ] && [ "$BRANCH" != "main" ]; then
  echo "[scale-down] Deleting local branch '$BRANCH' (pass --keep-branch to preserve)..."
  git -C "$SOURCE_REPO" branch -D "$BRANCH" 2>/dev/null || \
    echo "[scale-down] (warning) could not delete branch '$BRANCH' — possibly unmerged. Skipping."
fi

# Step 4: defensive cleanup — destroy normally removes the persona file, but if the
# orchestrator wasn't reachable, the file is still on disk. Best-effort delete.
if [ -f "$PERSONA_FILE" ]; then
  echo "[scale-down] Removing leftover persona file $PERSONA_FILE..."
  rm "$PERSONA_FILE"
fi

echo ""
echo "[scale-down] Done. '$AGENT_NAME' torn down."
