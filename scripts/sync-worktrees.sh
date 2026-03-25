#!/usr/bin/env sh
# Sync all git worktrees: stash, rebase onto origin default branch, stash pop.
# Usage: sync-worktrees.sh <repo-path>
# Exit 0 on success; non-zero if any rebase fails.

set -e

REPO="${1:?Usage: sync-worktrees.sh <repo-path>}"
cd "$REPO" || exit 1

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository: $REPO" >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No origin remote; nothing to sync" >&2
  exit 0
fi

git fetch --prune origin || true

DEFAULT_REF=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -n "$DEFAULT_REF" ]; then
  REBASE_ONTO=$(echo "$DEFAULT_REF" | sed 's#^refs/remotes/##')
else
  REBASE_ONTO=""
  for c in origin/main origin/master; do
    if git rev-parse --verify -q "refs/remotes/$c" >/dev/null 2>&1; then
      REBASE_ONTO=$c
      break
    fi
  done
  REBASE_ONTO=${REBASE_ONTO:-origin/main}
fi

FAILED=0
path=""
bare=0

flush_worktree() {
  wt="$1"
  [ -z "$wt" ] && return 0
  [ "$bare" -eq 1 ] && return 0

  echo "==> $wt"
  if ! cd "$wt"; then
    FAILED=1
    cd "$REPO" || exit 1
    return 0
  fi

  STASHED=0
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    if git stash push -u -m "constellagent-sync-worktrees"; then
      STASHED=1
    fi
  fi

  if ! git rebase "$REBASE_ONTO"; then
    echo "Rebase failed in $wt" >&2
    git rebase --abort 2>/dev/null || true
    if [ "$STASHED" -eq 1 ]; then
      git stash pop 2>/dev/null || true
    fi
    FAILED=1
    cd "$REPO" || exit 1
    return 0
  fi

  if [ "$STASHED" -eq 1 ]; then
    if ! git stash pop; then
      echo "stash pop had conflicts in $wt" >&2
      FAILED=1
    fi
  fi

  cd "$REPO" || exit 1
}

# shellcheck disable=SC2162
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    worktree\ *)
      flush_worktree "$path"
      path="${line#worktree }"
      bare=0
      ;;
    bare)
      bare=1
      ;;
    "")
      flush_worktree "$path"
      path=""
      bare=0
      ;;
  esac
done <<EOF
$(git worktree list --porcelain)
EOF

flush_worktree "$path"

exit "$FAILED"
