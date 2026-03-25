#!/bin/bash
# Shared helpers for Constellagent agent hooks
# Source this file from individual capture scripts

WS_ID="${AGENT_ORCH_WS_ID:-}"

# Legacy snapshot id (dangling stash commit or HEAD) — used only as fallback.
get_head_legacy() {
  local dir="${1:-.}"
  local stash_hash
  stash_hash=$(git -C "$dir" stash create 2>/dev/null)
  if [ -n "$stash_hash" ]; then
    echo "$stash_hash"
  else
    git -C "$dir" rev-parse HEAD 2>/dev/null || echo ""
  fi
}

# Full working-tree snapshot: temp index + add -A + write-tree + commit-tree + anchored ref.
# Stores commit hash in AgentFS; ref refs/constellagent-cp/<ts>-<rand> prevents GC.
save_checkpoint() {
  local dir="${1:-.}"
  local tmp_index tree_hash commit_hash ts suffix ref_name

  tmp_index=$(mktemp "${TMPDIR:-/tmp}/csg-cp.XXXXXX") || {
    get_head_legacy "$dir"
    return
  }

  if ! GIT_INDEX_FILE="$tmp_index" git -C "$dir" add -A 2>/dev/null; then
    rm -f "$tmp_index"
    get_head_legacy "$dir"
    return
  fi

  tree_hash=$(GIT_INDEX_FILE="$tmp_index" git -C "$dir" write-tree 2>/dev/null)
  rm -f "$tmp_index"

  if [ -z "$tree_hash" ]; then
    get_head_legacy "$dir"
    return
  fi

  ts=$(date +%s)
  suffix="${RANDOM}"
  ref_name="refs/constellagent-cp/${ts}-${suffix}"
  commit_hash=$(git -C "$dir" commit-tree -m "constellagent checkpoint ${ts}" "$tree_hash" 2>/dev/null)
  if [ -z "$commit_hash" ]; then
    get_head_legacy "$dir"
    return
  fi

  git -C "$dir" update-ref "$ref_name" "$commit_hash" >/dev/null 2>&1 || true
  echo "$commit_hash"
}

get_head() {
  save_checkpoint "${1:-.}"
}

write_pending() {
  local cwd="$1" agent="$2" sid="$3" tool="$4" input="$5" file="$6" ts="$7"
  local head_override="${8:-}"
  local repo="$cwd/.constellagent"
  [ ! -d "$repo" ] && return 0
  local pending_dir="$repo/.pending"
  mkdir -p "$pending_dir"
  local head
  if [ -n "$head_override" ]; then
    head="$head_override"
  else
    head=$(get_head "$cwd")
  fi
  # Default empty input to null so the JSON stays valid
  [ -z "$input" ] && input="null"
  local tmp out
  tmp=$(mktemp "${pending_dir}/.pending.XXXXXX.tmp") || return 0
  out="$pending_dir/$(date +%s)-$RANDOM.json"
  if jq -n \
    --arg ws "$WS_ID" \
    --arg agent "$agent" \
    --arg sid "$sid" \
    --arg tool "$tool" \
    --arg file "${file:-}" \
    --arg ts "$ts" \
    --arg head "$head" \
    --argjson input "$input" \
    '{ws:$ws, agent:$agent, sid:$sid, tool:$tool, input:$input, file:$file, ts:$ts, head:$head}' \
    > "$tmp"
  then
    mv "$tmp" "$out" || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

write_pending_full() {
  local cwd="$1" agent="$2" sid="$3" tool="$4" input="$5" file="$6" ts="$7" event_type="$8" tool_response="$9"
  local head_override="${10:-}"
  local repo="$cwd/.constellagent"
  [ ! -d "$repo" ] && return 0
  local pending_dir="$repo/.pending"
  mkdir -p "$pending_dir"
  local head
  if [ -n "$head_override" ]; then
    head="$head_override"
  else
    head=$(get_head "$cwd")
  fi
  # Default empty input/response to null so the JSON stays valid
  [ -z "$input" ] && input="null"
  [ -z "$tool_response" ] && tool_response="null"
  local tmp out
  tmp=$(mktemp "${pending_dir}/.pending.XXXXXX.tmp") || return 0
  out="$pending_dir/$(date +%s)-$RANDOM.json"
  if jq -n \
    --arg ws "$WS_ID" \
    --arg agent "$agent" \
    --arg sid "$sid" \
    --arg tool "$tool" \
    --arg file "${file:-}" \
    --arg ts "$ts" \
    --arg head "$head" \
    --arg event_type "${event_type:-}" \
    --argjson input "$input" \
    --argjson tool_response "$tool_response" \
    '{ws:$ws, agent:$agent, sid:$sid, tool:$tool, input:$input, file:$file, ts:$ts, head:$head, event_type:$event_type, tool_response:$tool_response}' \
    > "$tmp"
  then
    mv "$tmp" "$out" || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

# Read the best available sliding window context for the current workspace.
# Prefers per-workspace file, falls back to global, then activity.md.
# Usage: CONTEXT=$(read_sliding_window "$CWD")
read_sliding_window() {
  local cwd="$1"
  local repo="$cwd/.constellagent"
  local ws_file="$repo/context/sliding-window-${WS_ID}.md"
  local global_file="$repo/context/sliding-window.md"
  local activity_file="$repo/context/activity.md"

  if [ -n "$WS_ID" ] && [ -f "$ws_file" ]; then
    head -c 4000 "$ws_file"
  elif [ -f "$global_file" ]; then
    head -c 4000 "$global_file"
  elif [ -f "$activity_file" ]; then
    tail -30 "$activity_file"
  fi
}

# Read the rich agent context generated from the AgentFS database.
# Prefers per-workspace agent-context, falls back to global, then sliding window.
# Usage: CONTEXT=$(read_agent_context "$CWD")
read_agent_context() {
  local cwd="$1"
  local repo="$cwd/.constellagent"
  local ws_ctx="$repo/context/agent-context-${WS_ID}.md"
  local global_ctx="$repo/context/agent-context.md"

  if [ -n "$WS_ID" ] && [ -f "$ws_ctx" ]; then
    head -c 6000 "$ws_ctx"
  elif [ -f "$global_ctx" ]; then
    head -c 6000 "$global_ctx"
  else
    # Fall back to sliding window
    read_sliding_window "$cwd"
  fi
}
