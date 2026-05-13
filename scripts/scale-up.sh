#!/usr/bin/env bash
# Spin up a new agent instance from an existing persona + a fresh git worktree.
#
# Two modes:
#
#   1. TICKET-FIRST — you know the branch in advance:
#        ./scripts/scale-up.sh <base-persona> <new-name> <branch> [<base-branch>]
#
#      Examples:
#        ./scripts/scale-up.sh dev dev-101 feature/issue-101
#        ./scripts/scale-up.sh reviewer reviewer-a hotfix/critical develop
#
#   2. POOL-FIRST — provision idle agents now, assign tickets later:
#        ./scripts/scale-up.sh <base-persona> <new-name>
#
#      Examples:
#        ./scripts/scale-up.sh dev dev-a
#        ./scripts/scale-up.sh dev dev-b
#        ./scripts/scale-up.sh dev dev-c
#
#      The agent's worktree is created on a placeholder branch `pool/<new-name>`
#      off develop. When operator/team-lead assigns it a ticket, the agent should
#      `git checkout -b feature/<ticket>` inside its worktree and begin work.
#
# What it does:
#   1. Reads <base-persona>.md to find its repo path (cwd: field).
#   2. Creates a git worktree at <repo>-worktrees/<new-name> on the requested branch
#      (or on a `pool/*` placeholder branch in pool mode), forked from <base-branch>.
#   3. Copies <base-persona>.md → <new-name>.md with cwd updated to the worktree.
#   4. The orchestrator's filesystem watcher picks up the new persona file and
#      registers the agent in `void` state — spawn it from the dashboard or via
#      `curl -X POST .../api/agents/<new-name>/spawn`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PERSONAS_DIR="${PERSONAS_DIR_OVERRIDE:-$REPO_ROOT/persistent-agents}"

if [ "$#" -lt 2 ]; then
  echo "Usage:"
  echo "  Ticket-first: $0 <base-persona> <new-name> <branch> [<base-branch>]"
  echo "  Pool-first:   $0 <base-persona> <new-name>"
  echo ""
  echo "  base-persona   Name of an existing persona (e.g. dev, reviewer)"
  echo "  new-name       Name for the new agent (e.g. dev-a, dev-issue-101)"
  echo "  branch         Git branch the new agent will work on (omit for pool mode)"
  echo "  base-branch    Branch to fork from (default: develop)"
  exit 1
fi

BASE_PERSONA="$1"
NEW_NAME="$2"
POOL_MODE=false

if [ "$#" -ge 3 ]; then
  BRANCH="$3"
  BASE_BRANCH="${4:-develop}"
else
  # Pool mode: placeholder branch, agent rebrands later via `git checkout -b`.
  POOL_MODE=true
  BRANCH="pool/$NEW_NAME"
  BASE_BRANCH="develop"
fi

# Validate inputs.
BASE_FILE="$PERSONAS_DIR/${BASE_PERSONA}.md"
NEW_FILE="$PERSONAS_DIR/${NEW_NAME}.md"

if [ ! -f "$BASE_FILE" ]; then
  echo "ERROR: Base persona not found: $BASE_FILE" >&2
  exit 1
fi

if [ -f "$NEW_FILE" ]; then
  echo "ERROR: New persona already exists: $NEW_FILE" >&2
  echo "       Pick a different <new-name> or run scale-down.sh first." >&2
  exit 1
fi

if ! [[ "$NEW_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "ERROR: New name must be alphanumeric + dashes/underscores only (got '$NEW_NAME')" >&2
  exit 1
fi

# Extract the base persona's cwd from its YAML frontmatter.
# Strict: must be the first 'cwd:' line in the frontmatter block.
SOURCE_CWD=$(awk '/^---$/{c++; next} c==1 && /^cwd:[[:space:]]+/{sub(/^cwd:[[:space:]]+/,""); print; exit}' "$BASE_FILE")

if [ -z "$SOURCE_CWD" ]; then
  echo "ERROR: Could not read 'cwd:' from $BASE_FILE frontmatter" >&2
  exit 1
fi

if [ ! -d "$SOURCE_CWD" ]; then
  echo "ERROR: Source cwd does not exist: $SOURCE_CWD" >&2
  exit 1
fi

if [ ! -d "$SOURCE_CWD/.git" ]; then
  echo "ERROR: Source cwd is not a git repo: $SOURCE_CWD" >&2
  exit 1
fi

# Worktree path: sibling directory of the source repo.
WORKTREE_ROOT="${SOURCE_CWD}-worktrees"
WORKTREE_PATH="$WORKTREE_ROOT/$NEW_NAME"

if [ -d "$WORKTREE_PATH" ]; then
  echo "ERROR: Worktree directory already exists: $WORKTREE_PATH" >&2
  echo "       Remove it manually or pick a different <new-name>." >&2
  exit 1
fi

mkdir -p "$WORKTREE_ROOT"

# Create the worktree. If the branch already exists, attach to it; otherwise create from base-branch.
echo "[scale-up] Creating worktree at $WORKTREE_PATH on branch '$BRANCH' (from $BASE_BRANCH)..."
cd "$SOURCE_CWD"

# Make sure base-branch is up to date with origin (best-effort; ignore failures for offline use).
git fetch origin "$BASE_BRANCH" >/dev/null 2>&1 || echo "[scale-up] (warning) could not fetch origin/$BASE_BRANCH; using local tip"

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "[scale-up] Branch '$BRANCH' exists — attaching worktree to it."
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  echo "[scale-up] Creating new branch '$BRANCH' from '$BASE_BRANCH'."
  git worktree add -b "$BRANCH" "$WORKTREE_PATH" "$BASE_BRANCH"
fi

# Copy persona file with cwd swapped to the worktree.
echo "[scale-up] Writing $NEW_FILE (cwd → $WORKTREE_PATH)..."
# Resolve to absolute path to keep persona deterministic regardless of where it's read from.
ABS_WORKTREE_PATH="$(cd "$WORKTREE_PATH" && pwd)"
sed -E "s|^cwd:[[:space:]]+.*$|cwd: $ABS_WORKTREE_PATH|" "$BASE_FILE" > "$NEW_FILE"

echo ""
echo "[scale-up] Done."
echo "  New agent:    $NEW_NAME"
echo "  Working dir:  $ABS_WORKTREE_PATH"
echo "  Branch:       $BRANCH (forked from $BASE_BRANCH)"
echo "  Persona file: $NEW_FILE"
if [ "$POOL_MODE" = true ]; then
  echo "  Mode:         POOL — agent will await a ticket assignment from the operator."
  echo "                When assigned, it should run inside its worktree:"
  echo "                  git checkout -b feature/<ticket-id>"
fi
echo ""
echo "Next: spawn it from the dashboard, or:"
echo "  SECRET=\$(cat ~/.config/agentic-collab/secret)"
echo "  curl -X POST -H \"Authorization: Bearer \$SECRET\" http://localhost:3000/api/agents/$NEW_NAME/spawn"
